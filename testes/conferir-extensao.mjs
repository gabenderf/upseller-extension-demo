/**
 * Teste de ponta a ponta da extensão (versão com fallback) contra o projeto Supabase de TESTE.
 * Chrome do sistema, perfil temporário, headless, extensão carregada sem empacotar.
 * Nunca imprime token, senha, segredo de consulta nem chave.
 *
 *   node testes/conferir-extensao.mjs
 *
 * Prints em <tmp>/upseller-testes-prints. Ver CLAUDE.md, "Credencial própria por máquina".
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Caminhos relativos a esta pasta (testes/ dentro da extensão).
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..').split('\\').join('/');
const SAAS = resolve(EXT, '../hope-saas');
const PUPPETEER = process.env.PUPPETEER_CORE_DIR ?? resolve(EXT, '../../criador-de-posts/ferramentas/node_modules/puppeteer-core');
const puppeteer = createRequire(import.meta.url)(PUPPETEER);
const SHOTS = join(tmpdir(), 'upseller-testes-prints');
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BANCADA = 'Bancada Teste Ext';

// Serve o test_upseller.html em localhost (o content script roda em http://localhost/*).
const servidor = createServer((req, res) => {
  if (!req.url.startsWith('/test_upseller.html')) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(readFileSync(join(EXT, 'test_upseller.html')));
});
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const PAGINA = `http://localhost:${servidor.address().port}/test_upseller.html`;

const lib = await import(pathToFileURL(`${SAAS}/scripts/lib-teste.mjs`).href);
const { BASE, CHAVE, entrar, comMfa, rest, claims } = lib;

const marca = `TESTE-EXT-${Date.now()}`;
const resultados = [];
const checar = (nome, ok, detalhe = '') => {
  resultados.push({ ok: Boolean(ok), nome, detalhe });
  console.log(`${ok ? 'ok    ' : 'FALHOU'}  ${nome}${detalhe ? `  (${detalhe})` : ''}`);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 8) : null);

async function ate(fn, ms = 15000, passo = 500) {
  const fim = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fim) return v;
    await esperar(passo);
  }
}

// ---------------- Admin (MFA) para aprovar, revogar e conferir o banco ----------------
const admin = await comMfa('ADMIN', await entrar('ADMIN'));
const linhaBipagem = async (rastreio) => {
  const r = await rest(admin.access_token, 'GET', `pedidos_separados?codigo_rastreio=eq.${encodeURIComponent(rastreio)}&select=codigo_rastreio,registrado_por,bancada,id_operador`);
  return r.negado ? null : r.dados?.[0] ?? null;
};

// ---------------- Chrome com a extensão ----------------
const perfil = mkdtempSync(join(tmpdir(), 'upseller-e2e-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: true,
  userDataDir: perfil,
  args: ['--no-first-run', '--no-default-browser-check'],
  protocolTimeout: 30000,
});

const rede = [];
let sw, swCdp;
try {
  const extId = await browser.installExtension(EXT);
  console.log(`extensão carregada: ${extId}`);
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`),
  );
  sw = await swTarget.worker();
  swCdp = await swTarget.createCDPSession();
  await swCdp.send('Network.enable');
  swCdp.on('Network.requestWillBeSent', (e) => {
    const u = e.request.url;
    if (!u.startsWith(BASE) || e.request.method === 'OPTIONS') return; // preflight CORS não leva credencial
    const h = e.request.headers;
    const auth = h.Authorization || h.authorization || '';
    let quem = 'sem-authorization';
    if (auth === `Bearer ${CHAVE}`) quem = 'chave-compartilhada';
    else if (auth.startsWith('Bearer ')) {
      try {
        quem = `conta:${claims(auth.slice(7)).sub}`;
      } catch {
        quem = 'bearer-invalido';
      }
    }
    rede.push({ t: Date.now(), metodo: e.request.method, caminho: u.slice(BASE.length).split('?')[0], quem });
  });
  await swCdp.send('Runtime.enable');
  swCdp.on('Runtime.consoleAPICalled', (e) => {
    if (e.type === 'warning' || e.type === 'error') {
      console.log(`   [sw ${e.type}] ${e.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 220)}`);
    }
  });

  const lerSessaoSw = () =>
    sw.evaluate(async () => {
      const { sessao_bancada: s } = await chrome.storage.local.get('sessao_bancada');
      return s ? { ...s } : null;
    });
  const resumoSessao = (s) =>
    s && {
      user_id: s.user_id,
      dispositivo_id: s.dispositivo_id,
      refresh: s.refresh_token ? createHash('sha256').update(s.refresh_token).digest('hex').slice(0, 8) : null,
      access: s.access_token ? createHash('sha256').update(s.access_token).digest('hex').slice(0, 8) : null,
      expira_em_s: Math.round((s.expires_at - Date.now()) / 1000),
      renovada_em: s.renovada_em,
      desconectada: s.desconectada,
    };

  // Aponta esta instalação de desenvolvimento para o projeto de TESTE (sem mexer no config.js).
  await sw.evaluate(
    async (url, key, bancada) => {
      await chrome.storage.local.set({ supabase_url: url, supabase_key: key, bancada });
    },
    BASE,
    CHAVE,
    BANCADA,
  );

  // ---------------- Popup ----------------
  const popup = await browser.newPage();
  popup.on('dialog', (d) => d.accept());
  await popup.setViewport({ width: 352, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const pill = () => popup.$eval('#pair-pill', (e) => e.innerText).catch(() => '');
  const shotPopup = async (nome) => {
    await popup.bringToFront();
    const el = await popup.$('#popup-root');
    await el.screenshot({ path: `${SHOTS}/${nome}.png` });
  };

  // ---------------- Página de teste ----------------
  const pagina = await browser.newPage();
  await pagina.setViewport({ width: 1400, height: 900 });
  await pagina.goto(PAGINA);
  await pagina.waitForSelector('#ext-operator-id', { timeout: 15000 });
  await pagina.type('#ext-operator-id', '901');
  await pagina.keyboard.press('Enter');
  await pagina.waitForSelector('#upseller-ext-floating-panel', { timeout: 15000 });
  checar('operador 901 entra pela tela de login da extensão', true);

  const bipar = async (rastreio) => {
    await pagina.bringToFront();
    await pagina.type('#barcode-input', rastreio);
    await pagina.keyboard.press('Enter');
    await pagina.evaluate(() => {
      // Confere todos os SKUs do pedido simulado e confirma a separação.
      document.querySelectorAll('#sku-table-body tr').forEach((_, i) => {
        const total = Number(document.querySelectorAll('#sku-table-body tr')[i].children[1].innerText.replace(/\D/g, ''));
        window.updateQty(i, total);
      });
      document.getElementById('btn-confirmar-separacao').click();
    });
  };
  const toast = () => pagina.$eval('.upseller-ext-toast', (e) => e.innerText).catch(() => '');
  const avisoVisivel = () => pagina.$eval('#ext-ui-desconectada', (e) => !e.hidden && e.offsetParent !== null).catch(() => false);

  // ===== A. Não pareada: igual a hoje =====
  console.log('\n== A. não pareada');
  checar('popup mostra "Chave compartilhada"', (await ate(pill, 5000)) === 'Chave compartilhada', await pill());
  await shotPopup('1-nao-pareada');
  const tA = Date.now();
  await bipar(`${marca}-A`);
  const rowA = await ate(() => linhaBipagem(`${marca}-A`));
  checar('bipagem não pareada grava', Boolean(rowA));
  checar('bipagem não pareada sai sem registrado_por', rowA && rowA.registrado_por === null, `registrado_por=${rowA?.registrado_por}`);
  const redeA = rede.filter((r) => r.t >= tA && r.caminho.startsWith('/rest/v1/'));
  checar('não pareada: toda chamada REST usa a chave compartilhada', redeA.length > 0 && redeA.every((r) => r.quem === 'chave-compartilhada'), redeA.map((r) => `${r.metodo} ${r.caminho} ${r.quem}`).join('; '));

  // ===== B. Parear =====
  console.log('\n== B. parear');
  await popup.bringToFront();
  await popup.click('#pair-btn-start');
  const codigo = (await ate(() => popup.$eval('#pair-code', (e) => e.innerText.trim()).catch(() => ''), 10000)).replace('-', '');
  checar('popup mostra o código de 8 caracteres', /^[A-HJKMNP-Z2-9]{8}$/.test(codigo), codigo ? `${codigo.slice(0, 4)}-${codigo.slice(4)}` : 'vazio');
  const contagem = await popup.$eval('#pair-countdown', (e) => e.innerText);
  checar('popup mostra "Pareando" e a contagem de até 10:00', (await pill()) === 'Pareando' && /^(10:00|[0-9]:[0-5]\d)$/.test(contagem), contagem);
  await shotPopup('2-codigo');
  const pendenteSemSegredo = await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'PAIR_STATUS' }, r)));
  checar('PAIR_STATUS não entrega segredo nem token ao popup', !JSON.stringify(pendenteSemSegredo).includes('segredo') && !JSON.stringify(pendenteSemSegredo).includes('token_hash'));

  await esperar(6000); // pelo menos uma consulta "aguardando"
  checar('antes de aprovar, segue aguardando', (await pill()) === 'Pareando');
  const aprovado = await rest(admin.access_token, 'POST', 'rpc/aprovar_pareamento', {
    p_codigo: codigo,
    p_nome: 'Bancada Teste Extensão',
    p_validade_dias: 365,
    p_local: BANCADA,
  });
  checar('admin aprova o código (rpc aprovar_pareamento)', !aprovado.negado, aprovado.negado ? `negado ${aprovado.status}` : '');
  const tAprov = Date.now();
  const virouPareada = await ate(async () => (await pill()) === 'Pareada', 25000);
  checar('popup passa a "Pareada" sozinho', virouPareada, `${Math.round((Date.now() - tAprov) / 1000)} s`);
  await shotPopup('3-pareada');
  const s1 = await lerSessaoSw();
  console.log('   sessão:', JSON.stringify(resumoSessao(s1)));
  checar('sessão gravada em storage.local com refresh token', Boolean(s1?.refresh_token && s1?.user_id && s1?.dispositivo_id));
  const syncTem = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)));
  checar('nada em storage.sync', syncTem.length === 0, syncTem.join(','));
  if (!s1) throw new Error('sem sessão depois de aprovar');
  const papel = claims(s1.access_token).app_metadata?.hope?.papel;
  checar('token é de bancada', papel === 'bancada', papel);
  const maquina = `conta:${s1.user_id}`;

  // ===== C. Bipar pareada =====
  console.log('\n== C. bipar pareada');
  const tC = Date.now();
  await bipar(`${marca}-B`);
  const rowB = await ate(() => linhaBipagem(`${marca}-B`));
  checar('bipagem pareada grava', Boolean(rowB));
  checar('bipagem sai com registrado_por da máquina', rowB?.registrado_por === s1.user_id, `registrado_por=${rowB?.registrado_por}`);
  await esperar(1000);
  const redeC = rede.filter((r) => r.t >= tC && r.caminho.startsWith('/rest/v1/'));
  checar('pareada: toda chamada REST usa a conta da máquina', redeC.length > 0 && redeC.every((r) => r.quem === maquina), redeC.map((r) => `${r.metodo} ${r.caminho} ${r.quem === maquina ? 'máquina' : r.quem}`).join('; '));

  // ===== D. Renovação =====
  console.log('\n== D. renovação');
  // D1: faltando menos de 60 s, renova antes de chamar e grava o refresh novo.
  await sw.evaluate(async () => {
    const { sessao_bancada: s } = await chrome.storage.local.get('sessao_bancada');
    await chrome.storage.local.set({ sessao_bancada: { ...s, expires_at: Date.now() + 30_000 } });
  });
  const tD1 = Date.now();
  await sw.evaluate(() => supabaseRequest('configuracoes_gerais?id=eq.1&select=meta_horaria_global'));
  const s2 = await lerSessaoSw();
  const renovou1 = rede.some((r) => r.t >= tD1 && r.caminho === '/auth/v1/token');
  checar('vencendo em < 60 s: renova antes da chamada', renovou1 && hash(s2.refresh_token) !== hash(s1.refresh_token) && hash(s2.access_token) !== hash(s1.access_token), JSON.stringify(resumoSessao(s2)));
  checar('token novo vale de novo por ~1 h', s2.expires_at - Date.now() > 50 * 60_000);

  // D2: refresh antigo deixou de valer depois do prazo de reuso? (rotativo) - só conferimos que mudou.
  // D3: 401 com token ruim: renova e repete a chamada, sem marcar desconectada.
  await sw.evaluate(async () => {
    const { sessao_bancada: s } = await chrome.storage.local.get('sessao_bancada');
    await chrome.storage.local.set({ sessao_bancada: { ...s, access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalido' } });
  });
  const tD3 = Date.now();
  const metaD3 = await sw.evaluate(() => supabaseRequest('configuracoes_gerais?id=eq.1&select=meta_horaria_global').then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })));
  const s3 = await lerSessaoSw();
  const caminhosD3 = rede.filter((r) => r.t >= tD3).map((r) => `${r.metodo} ${r.caminho} ${r.quem.startsWith('conta:') ? 'máquina' : r.quem}`);
  checar('token recusado (401): renova e repete, sem desconectar', metaD3.ok && !s3.desconectada, caminhosD3.join('; '));
  checar('nenhuma chamada cai para a chave compartilhada no 401', !rede.some((r) => r.t >= tD3 && r.quem === 'chave-compartilhada'));

  // D4: alarme de 30 min (aqui disparado em ~6 s, mesmo nome e mesmo handler).
  const antesAlarme = await lerSessaoSw();
  await sw.evaluate(() => chrome.alarms.create('renovar-sessao-bancada', { delayInMinutes: 0.1, periodInMinutes: 30 }));
  const s4 = await ate(async () => {
    const s = await lerSessaoSw();
    return s.renovada_em !== antesAlarme.renovada_em ? s : null;
  }, 40000, 1000);
  checar('alarme renova sem nenhuma bipagem', Boolean(s4) && hash(s4.refresh_token) !== hash(antesAlarme.refresh_token));
  const alarme = await sw.evaluate(async () => chrome.alarms.get('renovar-sessao-bancada'));
  checar('alarme fica a cada 30 min', alarme?.periodInMinutes === 30, JSON.stringify(alarme && { periodInMinutes: alarme.periodInMinutes }));

  // D5: o banco recusa UM registro (RLS da bancada só cria operador ativo). Com a sessão boa, isso é
  // recusa do registro, não credencial caída: erro com o motivo e a bancada continua conectada.
  const tD5 = Date.now();
  const idD5 = `9${String(Date.now()).slice(-7)}`;
  const recusa = await sw.evaluate(
    (id) =>
      supabaseRequest('operadores_metas', 'POST', { id_operador: id, nome_colaborador: 'Teste recusa 403', meta_horaria: 35, status: 'inativo' }).then(
        () => ({ ok: true }),
        (e) => ({ ok: false, msg: e.message, desconectada: e instanceof BancadaDesconectadaError }),
      ),
    idD5,
  );
  const s5a = await lerSessaoSw();
  checar(
    '403 de um registro recusado: erro com o motivo, sem "Bancada desconectada"',
    !recusa.ok && !recusa.desconectada && recusa.msg.startsWith('O banco recusou este registro (403)'),
    JSON.stringify(recusa).slice(0, 200),
  );
  checar('depois do 403 de registro, a sessão não fica marcada como desconectada', !s5a.desconectada, s5a.desconectada?.motivo);
  checar('o 403 de registro não cai para a chave compartilhada', !rede.some((r) => r.t >= tD5 && r.quem === 'chave-compartilhada'));
  const metaD5 = await sw.evaluate(() => supabaseRequest('configuracoes_gerais?id=eq.1&select=meta_horaria_global').then(() => true, () => false));
  checar('a próxima chamada segue normal', metaD5);

  // ===== E. Revogar =====
  console.log('\n== E. revogar');
  const rev = await rest(admin.access_token, 'POST', 'rpc/revogar_dispositivo', { p_id: s1.dispositivo_id });
  checar('admin revoga a bancada (rpc revogar_dispositivo)', !rev.negado, rev.negado ? `negado ${rev.status}` : '');
  const tE = Date.now();
  await bipar(`${marca}-C`);
  const msg = await ate(async () => {
    const t = await toast();
    return t.includes('Bancada desconectada') ? t : null;
  }, 15000, 250);
  checar('bipagem depois de revogar mostra "Bancada desconectada…"', Boolean(msg), msg || (await toast()));
  checar('aviso fixo aparece no painel', await ate(avisoVisivel, 5000));
  await pagina.bringToFront();
  await pagina.screenshot({ path: `${SHOTS}/4-pagina-desconectada.png` });
  await esperar(1500);
  const rowC = await linhaBipagem(`${marca}-C`);
  checar('bipagem depois de revogar não grava nada', rowC === null);
  const redeE = rede.filter((r) => r.t >= tE);
  checar('depois de revogar, nada vai pela chave compartilhada', !redeE.some((r) => r.quem === 'chave-compartilhada'), redeE.map((r) => `${r.metodo} ${r.caminho} ${r.quem.startsWith('conta:') ? 'máquina' : r.quem}`).join('; '));
  const s5 = await lerSessaoSw();
  checar('sessão marcada como desconectada', Boolean(s5?.desconectada), s5?.desconectada?.motivo);
  await popup.bringToFront();
  checar('popup mostra "Desconectada"', (await ate(async () => ((await pill()) === 'Desconectada' ? 'Desconectada' : null), 5000)) === 'Desconectada');
  await shotPopup('5-desconectada');
  const tE2 = Date.now();
  const leitura = await sw.evaluate(() => supabaseRequest('operadores_metas?id_operador=eq.901&select=*').then(() => 'leu', (e) => e.message));
  checar('qualquer chamada recusa com a mensagem, sem cair para a chave', leitura.startsWith('Bancada desconectada') && !rede.some((r) => r.t >= tE2 && r.quem === 'chave-compartilhada'), leitura);

  // ===== F. Parear de novo =====
  console.log('\n== F. parear de novo');
  await popup.click('#pair-btn-repair');
  const codigo2 = ((await ate(async () => {
    const c = await popup.$eval('#pair-code', (e) => (e.offsetParent ? e.innerText.trim().replace('-', '') : '')).catch(() => '');
    return c && c !== codigo ? c : '';
  }, 10000)) || '');
  if (!codigo2) console.log('   popup:', await popup.$eval('#pair-card', (e) => e.innerText).catch(() => ''), '| toast:', await popup.$eval('#toast', (e) => e.innerText).catch(() => ''));
  checar('"Parear de novo" mostra um código novo', /^[A-HJKMNP-Z2-9]{8}$/.test(codigo2) && codigo2 !== codigo);
  const tF = Date.now();
  await bipar(`${marca}-D`); // durante o pareamento novo, continua sem cair para a chave
  await esperar(2500);
  checar('enquanto pareia de novo, bipagem não vai pela chave', !rede.some((r) => r.t >= tF && r.quem === 'chave-compartilhada') && (await linhaBipagem(`${marca}-D`)) === null);
  await rest(admin.access_token, 'POST', 'rpc/aprovar_pareamento', { p_codigo: codigo2, p_nome: 'Bancada Teste Extensão 2', p_validade_dias: 365, p_local: BANCADA });
  checar('popup volta a "Pareada"', (await ate(async () => ((await pill()) === 'Pareada' ? 'Pareada' : null), 20000)) === 'Pareada');
  const s6 = await lerSessaoSw();
  checar('conta nova, outra que a revogada', s6.user_id !== s1.user_id && !s6.desconectada);
  checar('aviso fixo some do painel', !(await ate(async () => !(await avisoVisivel()), 5000)) === false);
  await bipar(`${marca}-E`);
  const rowE = await ate(() => linhaBipagem(`${marca}-E`));
  checar('bipagem volta a gravar com a conta nova', rowE?.registrado_por === s6.user_id, `registrado_por=${rowE?.registrado_por}`);

  // ===== G. Desparear =====
  console.log('\n== G. desparear');
  await popup.bringToFront();
  await popup.click('#pair-btn-unpair');
  checar('popup volta a "Chave compartilhada"', (await ate(async () => ((await pill()) === 'Chave compartilhada' ? 1 : null), 5000)) === 1);
  checar('sessão apagada do storage', (await lerSessaoSw()) === null);
  const tG = Date.now();
  await bipar(`${marca}-F`);
  const rowF = await ate(() => linhaBipagem(`${marca}-F`));
  checar('despareada: grava pela chave compartilhada, como antes', rowF && rowF.registrado_por === null && rede.filter((r) => r.t >= tG && r.caminho.startsWith('/rest/v1/')).every((r) => r.quem === 'chave-compartilhada'));
  // A conta despareada fez logout: o refresh dela não vale mais.
  const refreshMorto = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: CHAVE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s6.refresh_token }),
  });
  checar('desparear encerra a sessão no Auth', refreshMorto.status >= 400, `refresh depois do logout: ${refreshMorto.status}`);

  // Revoga também o segundo dispositivo, como o admin faria na tela.
  const rev2 = await rest(admin.access_token, 'POST', 'rpc/revogar_dispositivo', { p_id: s6.dispositivo_id });
  checar('segundo dispositivo revogado na limpeza', !rev2.negado);
  await shotPopup('6-despareada');
} catch (e) {
  checar('roteiro terminou', false, e.stack || e.message);
} finally {
  await browser.close();
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {}
  servidor.close();
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} de ${resultados.length} conferências passaram.`);
console.log(`marca dos dados de teste: ${marca}`);
console.log(`prints: ${SHOTS}`);
process.exit(falhas.length ? 1 : 0);
