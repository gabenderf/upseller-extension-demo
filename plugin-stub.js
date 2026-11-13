// ====================================================================
// Simulador do "Plugin de Impressão UpSeller"
// ====================================================================
//
// Roda no contexto da própria página (world MAIN, document_start) para
// substituir o WebSocket que o UpSeller abre em ws://localhost:21319.
//
// Por que existe: a tela de checkout abre por padrão no modo "Verificar e
// Imprimir" e, ao focar o campo de rastreio, cria a conexão com o plugin.
// Depois de criada, cada foco no campo tenta reconectar — inclusive no modo
// "Verificar Somente" — e sem o plugin aparece o modal "Você ainda não baixou
// o plugin de impressão". Nós não imprimimos por ali (as etiquetas já vêm
// impressas), então o plugin só ocupa memória. Ver CLAUDE.md.
//
// Protocolo (lido de bundle.printUtils.*.js do UpSeller): JSON
// { method, params } -> { code: 'SUCCESS' | 'FAIL', method, data, message, version }.

(function () {
  const PLUGIN_URL = /^wss?:\/\/(localhost|127\.0\.0\.1):21319\/?$/i;

  // Acima da versão mínima que o UpSeller exige (/api/print/plug/web/get-version)
  const FAKE_VERSION = '99.0.0';

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__upsellerPluginStub) return;

  function reply(msg) {
    switch (msg && msg.method) {
      case 'getPrinter':
        // Lista de impressoras vazia: o modo "Verificar Somente" não usa
        return { code: 'SUCCESS', method: 'getPrinter', data: [], message: '', version: FAKE_VERSION };
      case 'changePrinter':
        return { code: 'SUCCESS', method: 'changePrinter', data: null, message: '' };
      case 'printMany':
        return {
          code: 'FAIL',
          method: 'printMany',
          data: null,
          message: 'Impressão indisponível: o plugin de impressão está sendo simulado pela extensão de produtividade. Use "Verificar Somente".'
        };
      case 'setPluginToken':
        // Só é pedido quando o UpSeller liga a "evidência em vídeo" (gravação
        // da conferência), que depende do plugin de verdade. Recusar faz a
        // página mostrar um erro e seguir, em vez de ficar esperando para sempre.
        return {
          code: 'FAIL',
          method: 'setPluginToken',
          data: { success: false },
          message: 'Evidência em vídeo indisponível: o plugin de impressão está sendo simulado pela extensão de produtividade.'
        };
      default:
        // setPuid e afins: o plugin real não responde nada que a página espere
        return null;
    }
  }

  class FakePluginSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakePluginSocket.CONNECTING;
      this.protocol = '';
      this.extensions = '';
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      setTimeout(() => {
        if (this.readyState !== FakePluginSocket.CONNECTING) return;
        this.readyState = FakePluginSocket.OPEN;
        this._emit('open', new Event('open'));
      }, 0);
    }

    send(raw) {
      if (this.readyState !== FakePluginSocket.OPEN) {
        throw new DOMException('WebSocket is not open', 'InvalidStateError');
      }
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      const res = reply(msg);
      if (!res) return;
      setTimeout(() => {
        if (this.readyState !== FakePluginSocket.OPEN) return;
        this._emit('message', new MessageEvent('message', { data: JSON.stringify(res) }));
      }, 0);
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= FakePluginSocket.CLOSING) return;
      this.readyState = FakePluginSocket.CLOSED;
      setTimeout(() => {
        this._emit('close', new CloseEvent('close', { code, reason, wasClean: true }));
      }, 0);
    }

    _emit(type, event) {
      this.dispatchEvent(event);
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, event);
    }
  }

  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((name, value) => {
    FakePluginSocket[name] = value;
    FakePluginSocket.prototype[name] = value;
  });

  function PatchedWebSocket(url, protocols) {
    if (PLUGIN_URL.test(String(url))) {
      console.log('UpSeller Extension: plugin de impressão simulado (' + url + ')');
      return new FakePluginSocket(String(url));
    }
    return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((name) => {
    PatchedWebSocket[name] = NativeWebSocket[name];
  });
  PatchedWebSocket.__upsellerPluginStub = true;

  window.WebSocket = PatchedWebSocket;
})();
