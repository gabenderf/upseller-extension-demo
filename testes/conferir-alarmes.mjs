/**
 * Prova sem depurador de que os alarmes acordam o service worker encerrado:
 *   1. renovação ('renovar-sessao-bancada'): bancada pareada, worker encerrado, ninguém conectado;
 *      o alarme dispara e o refresh token muda;
 *   2. pareamento ('consultar-pareamento'): código pedido, worker encerrado, ninguém conectado,
 *      admin aprova; o worker acorda pelo alarme e consome o código.
 * Edge do sistema (mesmo motor de MV3 do Chrome), porque o Chrome de marca ignora --load-extension.
 * Conecta pela porta de depuração e DESCONECTA de verdade (Edge segue aberto, sem depurador).
 *
 *   node testes/conferir-alarmes.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Caminhos relativos a esta pasta (testes/ dentro da extensão).
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..').split('\\').join('/');
const SAAS = resolve(EXT, '../hope-saas');
const PUPPETEER = process.env.PUPPETEER_CORE_DIR ?? resolve(EXT, '../../criador-de-posts/ferramentas/node_modules/puppeteer-core');
const puppeteer = createRequire(import.meta.url)(PUPPETEER);
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORTA = 9335;
const { BASE, CHAVE, entrar, comMfa, rest } = await import(pathToFileURL(`${SAAS}/scripts/lib-teste.mjs`).href);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 8) : null);
const resultados = [];
const checar = (nome, ok, detalhe = '') => {
  resultados.push(Boolean(ok));
  console.log(`${ok ? 'ok    ' : 'FALHOU'}  ${nome}${detalhe ? `  (${detalhe})` : ''}`);
};

const admin = await comMfa('ADMIN', await entrar('ADMIN'));
const perfil = mkdtempSync(join(tmpdir(), 'upseller-e2e-edge-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORTA}`, `--user-data-dir=${perfil}`,
  `--load-extension=${EXT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

async function conectar() {
  for (let i = 0; i < 30; i++) {
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORTA}`, protocolTimeout: 20000 });
    } catch {
      await esperar(500);
    }
  }
  throw new Error('não conectou no Edge');
}

/** Encerra o worker da extensão por uma aba na origem dela (o SVG não roda script) e fecha a aba. */
async function encerrarWorker(browser, extId) {
  const aba = await browser.newPage();
  await aba.goto(`chrome-extension://${extId}/logo-hope-white.svg`);
  const cdp = await aba.createCDPSession();
  const estados = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
    for (const v of e.versions) if (v.scriptURL.startsWith(`chrome-extension://${extId}/`)) estados.set(v.versionId, v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await esperar(800);
  for (const id of estados.keys()) await cdp.send('ServiceWorker.stopWorker', { versionId: id });
  for (let i = 0; i < 20 && ![...estados.values()].every((s) => s === 'stopped'); i++) await esperar(250);
  const parou = estados.size > 0 && [...estados.values()].every((s) => s === 'stopped');
  await aba.close();
  return parou;
}

/** Abas abertas que não são about:blank (nenhuma página da extensão pode ficar aberta). */
const abasAbertas = async (browser) => (await browser.pages()).map((p) => p.url()).filter((u) => u !== 'about:blank');

const lerSessaoPelaPagina = (pagina) =>
  pagina.evaluate(async () => {
    const { sessao_bancada: s } = await chrome.storage.local.get('sessao_bancada');
    return s ? { ...s } : null;
  });

const dispositivos = [];
let browser;
try {
  browser = await conectar();
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  await sw.evaluate(async (url, key) => chrome.storage.local.set({ supabase_url: url, supabase_key: key, bancada: 'Bancada Teste Ext' }), BASE, CHAVE);

  // Pareia de verdade (com o worker vivo).
  let popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('#pair-btn-start');
  await popup.waitForFunction(() => document.getElementById('pair-code').offsetParent && document.getElementById('pair-code').innerText.length === 9, { timeout: 10000 });
  let codigo = (await popup.$eval('#pair-code', (e) => e.innerText)).replace('-', '');
  await rest(admin.access_token, 'POST', 'rpc/aprovar_pareamento', { p_codigo: codigo, p_nome: `Bancada Teste Extensão edge ${Date.now()}`, p_validade_dias: 30, p_local: 'Bancada Teste Ext' });
  await popup.waitForFunction(() => document.getElementById('pair-pill').innerText === 'Pareada', { timeout: 25000 });
  const s0 = await lerSessaoPelaPagina(popup);
  dispositivos.push(s0.dispositivo_id);
  checar('Edge: bancada pareada', Boolean(s0?.refresh_token));

  // ===== 1. Renovação pelo alarme, sem ninguém conectado =====
  console.log('\n== 1. alarme de renovação com o worker encerrado');
  await sw.evaluate(() => chrome.alarms.create('renovar-sessao-bancada', { delayInMinutes: 0.5, periodInMinutes: 30 }));
  await popup.close();
  const parou1 = await encerrarWorker(browser, extId);
  checar('worker encerrado', parou1);
  checar('nenhuma página da extensão aberta', (await abasAbertas(browser)).length === 0, (await abasAbertas(browser)).join(','));
  const tParou1 = Date.now();
  await browser.disconnect();
  await esperar(55_000); // alarme em ~30 s
  browser = await conectar();
  popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const s1 = await lerSessaoPelaPagina(popup);
  const renovadaEm = Date.parse(s1.renovada_em);
  checar(
    'o alarme acordou o worker e renovou sozinho',
    hash(s1.refresh_token) !== hash(s0.refresh_token) && renovadaEm > tParou1,
    `renovada ${Math.round((renovadaEm - tParou1) / 1000)} s depois de encerrar o worker; refresh ${hash(s0.refresh_token)} → ${hash(s1.refresh_token)}`,
  );
  checar('sessão segue conectada', !s1.desconectada);

  // ===== 2. Pareamento retomado pelo alarme, sem ninguém conectado =====
  console.log('\n== 2. alarme do pareamento com o worker encerrado');
  const nome2 = `Bancada Teste Extensão edge alarme ${Date.now()}`;
  const ini = await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'PAIR_START' }, r)));
  codigo = ini?.pendente?.codigo;
  checar('código novo pedido', /^[A-HJKMNP-Z2-9]{8}$/.test(codigo ?? ''));
  await popup.close();
  const parou2 = await encerrarWorker(browser, extId);
  checar('worker encerrado', parou2);
  checar('nenhuma página da extensão aberta', (await abasAbertas(browser)).length === 0, (await abasAbertas(browser)).join(','));
  await browser.disconnect();
  const tAprov = Date.now();
  const ap = await rest(admin.access_token, 'POST', 'rpc/aprovar_pareamento', { p_codigo: codigo, p_nome: nome2, p_validade_dias: 30, p_local: 'Bancada Teste Ext' });
  checar('admin aprova com ninguém conectado', !ap.negado);
  let disp = null;
  for (let i = 0; i < 45 && !disp; i++) {
    const lista = await rest(admin.access_token, 'POST', 'rpc/listar_dispositivos', {});
    disp = (lista.dados ?? []).find((x) => x.nome === nome2) ?? null;
    if (!disp) await esperar(2000);
  }
  if (disp) dispositivos.push(disp.id);
  checar('o alarme acordou o worker e ele consumiu o código sozinho', Boolean(disp), `${Math.round((Date.now() - tAprov) / 1000)} s depois de aprovar`);
  await esperar(4000);
  browser = await conectar();
  popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const s2 = await lerSessaoPelaPagina(popup);
  checar('a sessão gravada é a do dispositivo novo', disp && s2?.dispositivo_id === disp.id);
  const alarmes = await popup.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name).sort().join(','));
  checar('alarme do pareamento encerrado, renovação continua', alarmes === 'renovar-sessao-bancada', alarmes);
} catch (e) {
  checar('roteiro terminou', false, e.stack || e.message);
} finally {
  for (const id of dispositivos) {
    const r = await rest(admin.access_token, 'POST', 'rpc/revogar_dispositivo', { p_id: id });
    console.log(`limpeza: dispositivo ${r.negado ? 'NÃO revogado' : 'revogado'}`);
  }
  try {
    await browser?.close();
  } catch {}
  try {
    edge.kill();
  } catch {}
  await esperar(1500);
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {}
}
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} conferências passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
