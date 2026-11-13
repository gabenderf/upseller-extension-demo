// Importar configurações e constantes globais
importScripts('config.js');

// ====================================================================
// Credencial própria por máquina (Hope SaaS, versão de TRANSIÇÃO com fallback)
//
// Não pareada: usa a chave do config.js / storage como sempre (fallback de transição).
// Pareada: manda `Authorization: Bearer <access_token>` da conta da máquina e NUNCA volta para a
// chave compartilhada, nem quando a sessão morre. Só "Desparear" (ação manual no popup) devolve a
// máquina ao acesso antigo enquanto o fallback existir.
//
// Plano: ../hope-saas/docs/seguranca.md §5.2 e §8. Modelo do fluxo:
// ../hope-saas/scripts/conferir-pareamento.mjs.
// ====================================================================

const MSG_DESCONECTADA = 'Bancada desconectada, chame a liderança para parear de novo.';
/** Renova o access token antes de usar se faltar menos que isso para vencer (§5.2 item 3). */
const RENOVAR_ANTES_MS = 60 * 1000;
/** Com a credencial vencida ou desativada, reconfere no máximo a cada 5 min (ver sessaoParaUsar). */
const RECONFERIR_CREDENCIAL_MS = 5 * 60 * 1000;
/** Consulta da aprovação do código (§5.2 item 1). */
const CONSULTA_MS = 5 * 1000;
/** Validade do código de pareamento na Edge Function `dispositivos` (JANELA_MS lá). */
const VALIDADE_CODIGO_MS = 10 * 60 * 1000;
const ALARME_RENOVAR = 'renovar-sessao-bancada';
const ALARME_PAREAMENTO = 'consultar-pareamento';
/**
 * chrome.storage.local (nunca sync): { url, access_token, refresh_token, expires_at (ms),
 * user_id, dispositivo_id, pareada_em, renovada_em, desconectada: null | { em, motivo } }
 */
const CHAVE_SESSAO = 'sessao_bancada';
/**
 * chrome.storage.session (só memória, some ao fechar o navegador): { url, codigo, segredo,
 * expira_em, status: 'aguardando' | 'verificando' | 'expirado' | 'erro', token_hash?, erro? }
 */
const CHAVE_PAREAMENTO = 'pareamento_pendente';

class BancadaDesconectadaError extends Error {
  constructor() {
    super(MSG_DESCONECTADA);
    this.name = 'BancadaDesconectadaError';
  }
}

// Função auxiliar para recuperar a configuração atual do Supabase
async function getSupabaseConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['supabase_url', 'supabase_key'], (result) => {
      const url = result.supabase_url || (self.UPSELLER_CONFIG ? self.UPSELLER_CONFIG.SUPABASE_URL : '');
      const key = result.supabase_key || (self.UPSELLER_CONFIG ? self.UPSELLER_CONFIG.SUPABASE_ANON_KEY : '');
      resolve({ url, key });
    });
  });
}

function limparUrl(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function getConfigLimpa() {
  const { url, key } = await getSupabaseConfig();
  if (!url || !key) {
    throw new Error('Supabase não configurado. Adicione a URL e a Anon Key nas configurações.');
  }
  return { url: limparUrl(url), key };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lerClaims(token) {
  const parte = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const b64 = parte + '='.repeat((4 - (parte.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** null = a conta da máquina pode registrar; senão, o motivo para mostrar no diagnóstico. */
function motivoCredencialInvalida(accessToken) {
  let hope;
  try {
    hope = lerClaims(accessToken)?.app_metadata?.hope;
  } catch {
    return 'token ilegível depois de renovar';
  }
  if (!hope) return 'conta da máquina sem perfil';
  if (hope.papel !== 'bancada') return `conta com papel ${hope.papel}, não bancada`;
  if (hope.status !== 'ativo') return 'credencial vencida ou desativada';
  return null;
}

function venceEm(respostaAuth) {
  if (respostaAuth.expires_at) return respostaAuth.expires_at * 1000;
  return Date.now() + (respostaAuth.expires_in || 3600) * 1000;
}

// ---------------- Sessão da máquina ----------------

async function lerSessao() {
  const r = await chrome.storage.local.get(CHAVE_SESSAO);
  return r[CHAVE_SESSAO] || null;
}

async function gravarSessao(sessao) {
  await chrome.storage.local.set({ [CHAVE_SESSAO]: sessao });
}

/** Mesma sessão = mesma conta e mesmo refresh token. Evita que uma resposta atrasada ressuscite uma
 *  sessão que foi trocada ou despareada enquanto a chamada estava no ar. */
function mesmaSessao(a, b) {
  return Boolean(a && b && a.user_id === b.user_id && a.refresh_token === b.refresh_token);
}

async function marcarDesconectada(sessaoUsada, motivo) {
  const atual = await lerSessao();
  if (!mesmaSessao(atual, sessaoUsada)) return;
  if (atual.desconectada && atual.desconectada.motivo === motivo) return;
  console.warn('UpSeller Extension: bancada desconectada:', motivo);
  await gravarSessao({ ...atual, desconectada: { em: new Date().toISOString(), motivo } });
}

async function limparDesconectada(sessaoUsada) {
  const atual = await lerSessao();
  if (!mesmaSessao(atual, sessaoUsada) || !atual.desconectada) return;
  await gravarSessao({ ...atual, desconectada: null });
}

let renovacaoEmCurso = null;

/**
 * Renova a sessão com o refresh token e grava o refresh novo (é rotativo: o antigo deixa de valer).
 * Uma renovação por vez: duas chamadas juntas usariam o mesmo refresh token.
 * Recusa do Auth (sessão revogada, refresh inválido) marca a bancada como desconectada.
 * Falha de rede, 429 ou 5xx é temporária: não marca nada.
 */
function renovarSessao() {
  if (!renovacaoEmCurso) {
    renovacaoEmCurso = renovarAgora().finally(() => {
      renovacaoEmCurso = null;
    });
  }
  return renovacaoEmCurso;
}

async function renovarAgora() {
  const { url, key } = await getConfigLimpa();
  const sessao = await lerSessao();
  if (!sessao) return null;
  if (sessao.url !== url) {
    await marcarDesconectada(sessao, 'pareada com outro projeto Supabase');
    throw new BancadaDesconectadaError();
  }

  let resposta;
  try {
    resposta = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: sessao.refresh_token }),
    });
  } catch (e) {
    throw new Error(`Sem conexão para renovar o acesso da bancada: ${e.message}`);
  }
  const corpo = await resposta.json().catch(() => ({}));

  if (resposta.ok && corpo.access_token && corpo.refresh_token) {
    const atual = await lerSessao();
    // Despareada ou trocada enquanto renovava: não grava por cima.
    if (!mesmaSessao(atual, sessao)) return atual;
    // Credencial vencida (`expira_em`) ou desativada não é recusada pelo Auth: a renovação passa, e o
    // hook marca `status: 'desativado'` no token. Sem esta checagem, as leituras voltam vazias e
    // só a próxima gravação acusaria. Ver ../hope-saas/supabase/migrations/0003.
    // ⚠️ Por isso a bancada pareada DEPENDE do hook: desligado, todo token vem sem perfil e as
    // bancadas pareadas ficam desconectadas em até 10 min.
    const motivo = motivoCredencialInvalida(corpo.access_token);
    // Uma gravação só, já com a marca: o refresh é rotativo (o par novo tem que ser guardado de
    // qualquer jeito) e o aviso do painel escuta o storage (duas gravações o fariam piscar).
    const nova = {
      ...atual,
      access_token: corpo.access_token,
      refresh_token: corpo.refresh_token,
      expires_at: venceEm(corpo),
      renovada_em: new Date().toISOString(),
      desconectada: motivo
        ? { em: new Date().toISOString(), motivo, credencial: true }
        : null,
    };
    await gravarSessao(nova);
    if (motivo) {
      console.warn('UpSeller Extension: bancada desconectada:', motivo);
      throw new BancadaDesconectadaError();
    }
    return nova;
  }

  if (resposta.status >= 400 && resposta.status < 500 && resposta.status !== 429) {
    const detalhe = corpo.error_code || corpo.msg || corpo.error_description || corpo.error || '';
    await marcarDesconectada(sessao, `renovação recusada (${resposta.status} ${detalhe})`.trim());
    throw new BancadaDesconectadaError();
  }
  throw new Error(`Falha temporária ao renovar o acesso da bancada (${resposta.status}).`);
}

/**
 * Sessão pronta para usar, ou null quando a máquina não está pareada (fallback de transição).
 * Pareada e marcada como desconectada: tenta renovar antes; se o Auth recusar, lança o erro de
 * bancada desconectada. Nunca devolve null para máquina pareada.
 */
async function sessaoParaUsar(url) {
  const sessao = await lerSessao();
  if (!sessao) return null;
  if (sessao.url !== url) {
    await marcarDesconectada(sessao, 'pareada com outro projeto Supabase');
    throw new BancadaDesconectadaError();
  }
  // Credencial vencida ou desativada: o Auth aceita a renovação, então renovar a cada chamada só
  // gastaria rotações (o painel consulta a meta a cada 60 s). Tenta de novo a cada 5 min, para
  // voltar sozinha se a liderança reativar.
  if (sessao.desconectada && sessao.desconectada.credencial && Date.now() - Date.parse(sessao.desconectada.em) < RECONFERIR_CREDENCIAL_MS) {
    throw new BancadaDesconectadaError();
  }
  if (sessao.desconectada || sessao.expires_at - Date.now() < RENOVAR_ANTES_MS) {
    return renovarSessao();
  }
  return sessao;
}

// Helper para fazer requisições à API REST do Supabase
async function supabaseRequest(endpoint, method = 'GET', body = null, customHeaders = {}) {
  const { url, key } = await getConfigLimpa();
  const targetUrl = `${url}/rest/v1/${endpoint}`;

  let sessao = await sessaoParaUsar(url);

  const chamar = (bearer) => {
    const headers = {
      'apikey': key,
      'Authorization': `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...customHeaders
    };
    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
      // Exigir retorno da representação inserida no POST
      if (method === 'POST' && !headers['Prefer']) {
        headers['Prefer'] = 'return=representation';
      }
    }
    return fetch(targetUrl, options);
  };

  try {
    // Não pareada: a chave compartilhada, exatamente como antes do pareamento existir.
    let response = await chamar(sessao ? sessao.access_token : key);

    if (sessao && (response.status === 401 || response.status === 403)) {
      // Token vencido ou recusado: renova uma vez e tenta de novo. Se o Auth recusar a renovação,
      // renovarSessao já marca a bancada e lança o erro de desconectada.
      sessao = await renovarSessao();
      if (!sessao) throw new BancadaDesconectadaError(); // despareada no meio da chamada
      response = await chamar(sessao.access_token);
      // 401 com a sessão recém-renovada: o servidor não aceita o próprio token. É credencial caída.
      if (response.status === 401) {
        const detalhe = (await response.text()).slice(0, 200);
        await marcarDesconectada(sessao, `401 em ${endpoint.split('?')[0]} depois de renovar: ${detalhe}`);
        throw new BancadaDesconectadaError();
      }
      // 403 com a sessão recém-renovada e o perfil ativo (renovarSessao conferiu o token) NÃO é
      // credencial caída: o banco recusou ESTE registro (RLS, como meta fora de 1 a 300, ou GRANT
      // faltando). Marcar desconectada faria a liderança parear de novo sem resolver nada, e
      // pararia a bancada. Mesmo critério do coletor (revisão de 08/11/2026).
      if (response.status === 403) {
        const bruto = await response.text();
        let detalhe = bruto;
        try {
          detalhe = JSON.parse(bruto).message || bruto;
        } catch {
          /* não era JSON: fica o texto */
        }
        console.warn('UpSeller Extension: 403 de registro, sessão boa:', endpoint.split('?')[0], bruto.slice(0, 300));
        throw new Error(`O banco recusou este registro (403). Avise a liderança: ${String(detalhe).slice(0, 160)}`);
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro Supabase (${response.status}): ${errText}`);
    }
    if (sessao) await limparDesconectada(sessao);
    // Para POST/PUT com Prefer representation, ou GET comum, lemos o JSON
    if (response.status === 204) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`Falha na chamada Supabase (${endpoint}):`, error);
    throw error;
  }
}

// ---------------- Pareamento por código (Edge Function `dispositivos`) ----------------

async function chamarDispositivos(url, key, corpo) {
  const resposta = await fetch(`${url}/functions/v1/dispositivos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key },
    body: JSON.stringify(corpo),
  });
  const json = await resposta.json().catch(() => null);
  if (resposta.status === 404) {
    throw new Error('O pareamento ainda não está disponível neste projeto Supabase.');
  }
  if (!resposta.ok) {
    throw new Error((json && json.erro) || `Falha no pareamento (${resposta.status}).`);
  }
  return json;
}

async function lerPendente() {
  const r = await chrome.storage.session.get(CHAVE_PAREAMENTO);
  return r[CHAVE_PAREAMENTO] || null;
}

async function gravarPendente(p) {
  await chrome.storage.session.set({ [CHAVE_PAREAMENTO]: p });
}

async function encerrarPendente() {
  await chrome.storage.session.remove(CHAVE_PAREAMENTO);
  await chrome.alarms.clear(ALARME_PAREAMENTO);
}

async function iniciarPareamento() {
  const { url, key } = await getConfigLimpa();
  const r = await chamarDispositivos(url, key, { acao: 'iniciar', tipo: 'bancada' });
  await gravarPendente({
    url,
    codigo: r.codigo,
    segredo: r.segredo,
    // Prazo contado no relógio desta máquina, não no `expira_em` do servidor: PC de bancada com
    // relógio adiantado desistiria de um código ainda válido. Quem decide de verdade é a função,
    // que responde "expirado".
    expira_em: new Date(Date.now() + VALIDADE_CODIGO_MS).toISOString(),
    status: 'aguardando',
  });
  // Rede de segurança: se o service worker for encerrado, o alarme retoma a consulta.
  await chrome.alarms.create(ALARME_PAREAMENTO, { periodInMinutes: 0.5 });
  retomarConsulta();
}

let consultaEmCurso = false;

function retomarConsulta() {
  consultarPareamento().catch((e) => console.warn('UpSeller Extension: consulta do pareamento parou:', e.message));
}

/** Consulta a cada 5 s até aprovar, expirar ou dar erro. Roda no service worker, não no popup:
 *  o popup fecha quando perde o foco e a consulta não pode parar junto. */
async function consultarPareamento() {
  if (consultaEmCurso) return;
  consultaEmCurso = true;
  try {
    for (;;) {
      const p = await lerPendente();
      if (!p) return;

      if (p.status === 'verificando') {
        await concluirPareamento(p);
        return;
      }
      if (p.status !== 'aguardando') {
        await chrome.alarms.clear(ALARME_PAREAMENTO);
        return;
      }
      if (Date.parse(p.expira_em) <= Date.now()) {
        await gravarPendente({ ...p, status: 'expirado', segredo: null });
        await chrome.alarms.clear(ALARME_PAREAMENTO);
        return;
      }

      let r = null;
      try {
        const { key } = await getConfigLimpa();
        r = await chamarDispositivos(p.url, key, { acao: 'consultar', codigo: p.codigo, segredo: p.segredo });
      } catch (e) {
        console.warn('UpSeller Extension: consulta do pareamento falhou, tentando de novo:', e.message);
      }

      const atual = await lerPendente();
      if (!atual || atual.codigo !== p.codigo) return; // cancelado ou trocado durante a consulta

      if (r && r.status === 'aprovado' && r.token_hash) {
        // O token_hash vem uma vez só: guarda antes de trocar por sessão, para retomar se cair.
        const verificando = { ...atual, status: 'verificando', token_hash: r.token_hash, segredo: null };
        await gravarPendente(verificando);
        await concluirPareamento(verificando);
        return;
      }
      if (r && r.status === 'expirado') {
        await gravarPendente({ ...atual, status: 'expirado', segredo: null });
        await chrome.alarms.clear(ALARME_PAREAMENTO);
        return;
      }
      await esperar(CONSULTA_MS);
    }
  } finally {
    consultaEmCurso = false;
  }
}

/** Troca o token_hash (uso único) por sessão em /auth/v1/verify e grava a sessão da máquina. */
async function concluirPareamento(p) {
  const { url, key } = await getConfigLimpa();
  if (url !== p.url) {
    await gravarPendente({ ...p, status: 'erro', token_hash: null, erro: 'A configuração do Supabase mudou durante o pareamento. Peça outro código.' });
    await chrome.alarms.clear(ALARME_PAREAMENTO);
    return;
  }

  let ultimoErro = '';
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    if (tentativa > 0) await esperar(2000 * tentativa);
    let resposta;
    try {
      resposta = await fetch(`${url}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'magiclink', token_hash: p.token_hash }),
      });
    } catch (e) {
      ultimoErro = e.message;
      continue;
    }
    const corpo = await resposta.json().catch(() => ({}));

    if (resposta.ok && corpo.access_token && corpo.refresh_token) {
      const claims = lerClaims(corpo.access_token);
      const hope = (claims.app_metadata && claims.app_metadata.hope) || {};
      if (hope.tipo !== 'dispositivo' || hope.papel !== 'bancada') {
        ultimoErro = `a conta recebida não é de bancada (papel: ${hope.papel || 'nenhum'})`;
        break;
      }
      // Revogada entre a aprovação e o /verify: não grava como pareada.
      const invalida = motivoCredencialInvalida(corpo.access_token);
      if (invalida) {
        ultimoErro = invalida;
        break;
      }
      const anterior = await lerSessao();
      if (anterior) await sairDaSessao(anterior, key);
      const agora = new Date().toISOString();
      await gravarSessao({
        url,
        access_token: corpo.access_token,
        refresh_token: corpo.refresh_token,
        expires_at: venceEm(corpo),
        user_id: claims.sub,
        dispositivo_id: hope.dispositivo_id || null,
        pareada_em: agora,
        renovada_em: agora,
        desconectada: null,
      });
      await encerrarPendente();
      await garantirAlarmeRenovacao();
      console.log('UpSeller Extension: bancada pareada.');
      return;
    }

    ultimoErro = `${resposta.status} ${corpo.error_code || corpo.msg || ''}`.trim();
    if (resposta.status >= 400 && resposta.status < 500 && resposta.status !== 429) break;
  }

  await gravarPendente({
    ...p,
    status: 'erro',
    token_hash: null,
    erro: `Não foi possível concluir o pareamento (${ultimoErro}). Revogue o dispositivo criado em Configurações > Dispositivos e peça outro código.`,
  });
  await chrome.alarms.clear(ALARME_PAREAMENTO);
}

/** Encerra a sessão no Auth, se ainda der (melhor esforço). A revogação de verdade é do admin. */
async function sairDaSessao(sessao, key) {
  if (!sessao || !sessao.access_token || sessao.expires_at <= Date.now()) return;
  try {
    await fetch(`${sessao.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${sessao.access_token}` },
    });
  } catch {
    /* sem rede: o admin revoga em Configurações > Dispositivos */
  }
}

async function desparear() {
  const sessao = await lerSessao();
  await encerrarPendente();
  if (!sessao) return;
  await chrome.storage.local.remove(CHAVE_SESSAO);
  const { key } = await getSupabaseConfig();
  await sairDaSessao(sessao, key);
}

async function estadoPareamento() {
  const sessao = await lerSessao();
  const p = await lerPendente();
  if (p && (p.status === 'aguardando' || p.status === 'verificando')) retomarConsulta(); // retoma se o service worker reiniciou
  return {
    estado: !sessao ? 'nao_pareada' : sessao.desconectada ? 'desconectada' : 'pareada',
    sessao: sessao
      ? {
          pareada_em: sessao.pareada_em,
          renovada_em: sessao.renovada_em,
          expires_at: sessao.expires_at,
          dispositivo_id: sessao.dispositivo_id,
          desconectada: sessao.desconectada,
        }
      : null,
    // Nunca o segredo nem o token_hash: o popup só precisa do código e do prazo.
    pendente: p ? { codigo: p.codigo, expira_em: p.expira_em, status: p.status, erro: p.erro || null } : null,
  };
}

// ---------------- Renovação periódica (§5.2 item 4) ----------------

async function garantirAlarmeRenovacao() {
  const alarme = await chrome.alarms.get(ALARME_RENOVAR);
  if (!alarme) await chrome.alarms.create(ALARME_RENOVAR, { periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener(() => { garantirAlarmeRenovacao(); });
chrome.runtime.onStartup.addListener(() => { garantirAlarmeRenovacao(); });
garantirAlarmeRenovacao();

chrome.alarms.onAlarm.addListener(async (alarme) => {
  if (alarme.name === ALARME_RENOVAR) {
    // Renova mesmo sem bipagem: fim de semana parado não derruba a sessão.
    if (!(await lerSessao())) return;
    try {
      await renovarSessao();
    } catch (e) {
      console.warn('UpSeller Extension: renovação periódica falhou:', e.message);
    }
  } else if (alarme.name === ALARME_PAREAMENTO) {
    retomarConsulta();
  }
});

// Escutar mensagens vindas do content script e do popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Lógica assíncrona requer retornar true
  handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(message, sendResponse) {
  try {
    switch (message.type) {
      case 'TEST_CONNECTION': {
        const { url, key } = message.data;
        // Testar conexão fazendo um GET simples na tabela de metas (limite 1)
        const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const testUrl = `${cleanUrl}/rest/v1/operadores_metas?limit=1`;
        const res = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`
          }
        });
        if (res.ok) {
          sendResponse({ success: true });
        } else {
          const errText = await res.text();
          sendResponse({ success: false, error: `Status ${res.status}: ${errText}` });
        }
        break;
      }

      case 'GET_OPERATOR': {
        const id = message.data.id_operador;
        const operators = await supabaseRequest(`operadores_metas?id_operador=eq.${id}&select=*`);
        if (operators && operators.length > 0) {
          sendResponse({ success: true, operator: operators[0] });
        } else {
          sendResponse({ success: true, operator: null });
        }
        break;
      }

      case 'CREATE_OPERATOR': {
        const { id_operador, nome_colaborador, meta_horaria } = message.data;
        const body = {
          id_operador,
          nome_colaborador,
          meta_horaria: meta_horaria || 35,
          status: 'ativo'
        };
        const result = await supabaseRequest('operadores_metas', 'POST', body);
        sendResponse({ success: true, operator: result[0] });
        break;
      }

      case 'REGISTER_SCAN': {
        const { id_operador, codigo_rastreio, num_pedido, bancada, itens } = message.data;
        const body = {
          id_operador,
          codigo_rastreio,
          // Nº do pedido UpSeller. Usado por ../previsao-expedicao para
          // casar a bipagem com a fila — o rastreio sozinho não serve para
          // pedidos ainda na etapa "Para Enviar". Pode vir null.
          num_pedido: num_pedido || null,
          quantidade_pedidos: 1,
          bancada,
          itens
          // Sem registrado_por: o banco preenche com auth.uid() quando a bancada está pareada.
        };
        const result = await supabaseRequest(
          'pedidos_separados?on_conflict=codigo_rastreio',
          'POST',
          body,
          { 'Prefer': 'resolution=ignore-duplicates,return=representation' }
        );
        const inserted = result && result.length > 0;
        sendResponse({ success: true, inserted, data: result ? result[0] : null });
        break;
      }

      case 'GET_OPERATOR_STATS': {
        const { id_operador, start_date } = message.data;
        // Obter todos os registros de hoje do operador para somar localmente (ordenados por data_hora crescente)
        const query = `pedidos_separados?id_operador=eq.${id_operador}&data_hora=gte.${encodeURIComponent(start_date)}&select=quantidade_pedidos,data_hora&order=data_hora.asc`;
        const records = await supabaseRequest(query, 'GET');

        const totalPedidos = records ? records.reduce((acc, row) => acc + row.quantidade_pedidos, 0) : 0;
        const firstScanTime = (records && records.length > 0) ? records[0].data_hora : null;
        const lastScanTime = (records && records.length > 0) ? records[records.length - 1].data_hora : null;
        sendResponse({ success: true, total: totalPedidos, first_scan_time: firstScanTime, last_scan_time: lastScanTime });
        break;
      }

      case 'GET_GLOBAL_META': {
        const rows = await supabaseRequest('configuracoes_gerais?id=eq.1&select=meta_horaria_global');
        const metaGlobal = (rows && rows.length > 0) ? rows[0].meta_horaria_global : null;
        sendResponse({ success: true, meta_horaria_global: metaGlobal });
        break;
      }

      case 'LOG_ACCESS': {
        const { id_anterior, id_novo, justificativa, bancada } = message.data;
        const body = {
          bancada,
          id_anterior: id_anterior || null,
          id_novo: id_novo || null,
          justificativa
        };
        const result = await supabaseRequest('logs_acesso', 'POST', body);
        sendResponse({ success: true, data: result });
        break;
      }

      // ---- Pareamento da bancada (popup) ----

      case 'PAIR_STATUS': {
        sendResponse({ success: true, ...(await estadoPareamento()) });
        break;
      }

      case 'PAIR_START': {
        await iniciarPareamento();
        sendResponse({ success: true, ...(await estadoPareamento()) });
        break;
      }

      case 'PAIR_CANCEL': {
        await encerrarPendente();
        sendResponse({ success: true, ...(await estadoPareamento()) });
        break;
      }

      case 'UNPAIR': {
        await desparear();
        sendResponse({ success: true, ...(await estadoPareamento()) });
        break;
      }

      default:
        sendResponse({ success: false, error: 'Ação não suportada' });
    }
  } catch (error) {
    sendResponse({
      success: false,
      error: error.message,
      desconectada: error instanceof BancadaDesconectadaError
    });
  }
}
