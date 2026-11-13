// ====================================================================
// Content Script - UpSeller Produtividade e Checkout
// ====================================================================

(function () {
  let activeOperator = null;
  let currentBancada = '';
  let loginTimestamp = null;
  let totalOrdersToday = 0;
  let firstScanTime = null;
  let lastScanTime = null;
  let metaGlobal = null;
  let observer = null;
  let statsInterval = null;

  let currentUrl = '';
  let isInitialized = false;
  const processedTrackings = new Set();
  const activeOrderCache = new Map(); // cache do pedido ativo: tracking -> [{ sku, quantidade }]

  // Obter meta horária a partir das configurações globais do código
  const META_HORARIA = (window.UPSELLER_CONFIG && window.UPSELLER_CONFIG.META_PEDIDOS_POR_HORA) || 35;

  // Inicializar Extensão
  async function init() {
    console.log('UpSeller Extension: Inicializando...');
    
    // 1. Verificar Configurações do Supabase
    const supabaseConfigured = await checkSupabaseConfig();
    if (!supabaseConfigured) {
      showSupabaseConfigOverlay();
      return;
    }

    // 2. Verificar Configuração de Bancada
    const bancadaConfigured = await checkBancadaConfig();
    if (!bancadaConfigured) {
      showBancadaConfigOverlay();
      return;
    }

    // 3. Verificar Login de Operador
    const loggedIn = await checkOperatorSession();
    if (!loggedIn) {
      showLoginOverlay();
      return;
    }

    // 4. Iniciar Interface do Operador e Monitoramento
    setupOperatorWorkspace();
  }

  // ====================================================================
  // Funções de Verificação de Configuração e Estado
  // ====================================================================

  async function checkSupabaseConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['supabase_url', 'supabase_key'], (result) => {
        const url = result.supabase_url || (window.UPSELLER_CONFIG ? window.UPSELLER_CONFIG.SUPABASE_URL : '');
        const key = result.supabase_key || (window.UPSELLER_CONFIG ? window.UPSELLER_CONFIG.SUPABASE_ANON_KEY : '');
        resolve(!!(url && key));
      });
    });
  }

  async function checkBancadaConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get('bancada', (result) => {
        if (result.bancada) {
          currentBancada = result.bancada;
          resolve(true);
        } else {
          // Se houver uma bancada padrão nas constantes do código, podemos usar
          const defaultBancada = (window.UPSELLER_CONFIG && window.UPSELLER_CONFIG.BANCADA_PADRAO) || '';
          if (defaultBancada) {
            chrome.storage.local.set({ bancada: defaultBancada }, () => {
              currentBancada = defaultBancada;
              resolve(true);
            });
          } else {
            resolve(false);
          }
        }
      });
    });
  }

  async function checkOperatorSession() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['active_operator', 'login_timestamp', 'first_scan_time', 'last_scan_time', 'meta_global'], (result) => {
        // Carregar último valor conhecido da meta global (evita "piscar" a meta padrão até a 1ª busca terminar)
        metaGlobal = (typeof result.meta_global !== 'undefined') ? result.meta_global : null;

        if (result.active_operator && result.login_timestamp) {
          // Validar se o login é de hoje. Se for outro dia, força logout.
          const loginDate = new Date(result.login_timestamp).toLocaleDateString();
          const currentDate = new Date().toLocaleDateString();

          if (loginDate !== currentDate) {
            console.log('UpSeller Extension: Sessão antiga expirada. Solicitando novo login.');
            chrome.storage.local.remove(['active_operator', 'login_timestamp', 'first_scan_time', 'last_scan_time'], () => {
              resolve(false);
            });
          } else {
            activeOperator = result.active_operator;
            loginTimestamp = result.login_timestamp;
            firstScanTime = result.first_scan_time || null;
            lastScanTime = result.last_scan_time || null;
            resolve(true);
          }
        } else {
          resolve(false);
        }
      });
    });
  }

  // Buscar a meta global remota (definida pelo Dashboard). Quando preenchida, substitui a
  // meta individual do operador para todos. Chamada no início e periodicamente durante o turno,
  // então uma mudança feita no Dashboard reflete na extensão sem precisar reinstalar/atualizar nada.
  function fetchGlobalMeta() {
    chrome.runtime.sendMessage({ type: 'GET_GLOBAL_META' }, (response) => {
      if (response && response.success) {
        metaGlobal = response.meta_horaria_global;
        chrome.storage.local.set({ meta_global: metaGlobal });
        updatePanelUI();
      } else {
        console.warn('UpSeller Extension: Falha ao buscar meta global:', response ? response.error : 'Erro de rede');
      }
    });
  }

  // ====================================================================
  // Renderização de Overlays de Configuração e Login (UI Premium)
  // ====================================================================

  function getContainer() {
    let container = document.getElementById('upseller-ext-root');
    if (!container) {
      container = document.createElement('div');
      container.id = 'upseller-ext-root';
      container.className = 'upseller-ext-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function clearOverlays() {
    const overlay = document.querySelector('.upseller-ext-overlay');
    if (overlay) overlay.remove();
  }

  function cleanup() {
    console.log('UpSeller Extension: Saindo da página monitorada. Limpando recursos...');
    const panel = document.getElementById('upseller-ext-floating-panel');
    if (panel) panel.remove();
    
    clearOverlays();
    
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }

    processedTrackings.clear();
    activeOrderCache.clear();
  }

  // Overlay 1: Configuração das Credenciais do Supabase
  function showSupabaseConfigOverlay() {
    const root = getContainer();
    clearOverlays();

    const overlay = document.createElement('div');
    overlay.className = 'upseller-ext-overlay';
    overlay.innerHTML = `
      <div class="upseller-ext-card">
        <h2 class="upseller-ext-title">Supabase Requerido</h2>
        <p class="upseller-ext-subtitle">Insira as credenciais do seu projeto Supabase para ativar a extensão.</p>
        
        <div class="upseller-ext-form-group">
          <label class="upseller-ext-label">Supabase URL</label>
          <input type="text" id="ext-supabase-url" class="upseller-ext-input" placeholder="https://xxxx.supabase.co">
        </div>
        
        <div class="upseller-ext-form-group">
          <label class="upseller-ext-label">Supabase Anon Key</label>
          <input type="password" id="ext-supabase-key" class="upseller-ext-input" placeholder="Chave Pública (Anon Key)">
        </div>
        
        <button id="ext-btn-save-supabase" class="upseller-ext-btn">
          <span>Salvar e Prosseguir</span>
        </button>
      </div>
    `;
    root.appendChild(overlay);

    document.getElementById('ext-btn-save-supabase').addEventListener('click', () => {
      const url = document.getElementById('ext-supabase-url').value.trim();
      const key = document.getElementById('ext-supabase-key').value.trim();

      if (!url || !key) {
        showToast('Preencha todos os campos do Supabase!', 'error');
        return;
      }

      // Testar conexão
      document.getElementById('ext-btn-save-supabase').innerText = 'Testando conexão...';
      chrome.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        data: { url, key }
      }, (response) => {
        if (response && response.success) {
          chrome.storage.local.set({ supabase_url: url, supabase_key: key }, () => {
            showToast('Supabase conectado com sucesso!', 'success');
            init(); // Recomeça o ciclo
          });
        } else {
          document.getElementById('ext-btn-save-supabase').innerText = 'Salvar e Prosseguir';
          showToast('Falha na conexão: Verifique os dados e tente novamente.', 'error');
        }
      });
    });
  }

  // Overlay 2: Configuração de Bancada (Uma vez por computador)
  function showBancadaConfigOverlay() {
    const root = getContainer();
    clearOverlays();

    const overlay = document.createElement('div');
    overlay.className = 'upseller-ext-overlay';
    overlay.innerHTML = `
      <div class="upseller-ext-card">
        <h2 class="upseller-ext-title">Configurar Terminal</h2>
        <p class="upseller-ext-subtitle">Defina o nome ou identificador desta bancada/computador de trabalho.</p>
        
        <div class="upseller-ext-form-group">
          <label class="upseller-ext-label">Identificador da Bancada</label>
          <input type="text" id="ext-bancada-name" class="upseller-ext-input" placeholder="Ex: Bancada 4" value="">
        </div>
        
        <button id="ext-btn-save-bancada" class="upseller-ext-btn">
          <span>Salvar Bancada</span>
        </button>
      </div>
    `;
    root.appendChild(overlay);

    document.getElementById('ext-btn-save-bancada').addEventListener('click', () => {
      const name = document.getElementById('ext-bancada-name').value.trim();
      if (!name) {
        showToast('Defina um identificador para a bancada!', 'error');
        return;
      }
      chrome.storage.local.set({ bancada: name }, () => {
        currentBancada = name;
        showToast(`Bancada configurada como: ${name}`, 'success');
        init();
      });
    });
  }

  // Overlay 3: Login Obrigatório e Autocadastro de Operador
  function showLoginOverlay() {
    const root = getContainer();
    clearOverlays();

    chrome.storage.local.get('pending_logout', (res) => {
      const pending = res.pending_logout;
      const subtitleText = pending 
        ? `Troca de operador iniciada.<br><strong>Motivo:</strong> ${pending.justificativa}` 
        : 'Insira o seu ID numérico para liberar a tela e iniciar os trabalhos.';

      const overlay = document.createElement('div');
      overlay.className = 'upseller-ext-overlay';
      overlay.innerHTML = `
        <div class="upseller-ext-card">
          <div class="upseller-ext-badge-bancada">💻 ${currentBancada}</div>
          <h2 class="upseller-ext-title">Identificação do Operador</h2>
          <p class="upseller-ext-subtitle">${subtitleText}</p>
          
          <div id="login-form-container">
            <div class="upseller-ext-form-group">
              <label class="upseller-ext-label">Código (ID) do Operador</label>
              <input type="number" id="ext-operator-id" class="upseller-ext-input" placeholder="Digite seu ID numérico..." required>
            </div>
            
            <button id="ext-btn-login" class="upseller-ext-btn">
              <span>Entrar no Sistema</span>
            </button>
          </div>

          <div id="register-form-container" style="display: none;">
            <p class="upseller-ext-subtitle" style="color: #fbbf24; margin-top: 10px;">
              Este ID não está cadastrado. Vamos cadastrá-lo agora?
            </p>
            <div class="upseller-ext-form-group">
              <label class="upseller-ext-label">Nome Completo do Colaborador</label>
              <input type="text" id="ext-operator-name" class="upseller-ext-input" placeholder="Digite o nome completo...">
            </div>
            
            <div style="display: flex; gap: 8px;">
              <button id="ext-btn-confirm-register" class="upseller-ext-btn" style="flex: 1;">
                <span>Cadastrar e Entrar</span>
              </button>
              <button id="ext-btn-cancel-register" class="upseller-ext-btn upseller-ext-btn-secondary" style="flex: 1;">
                <span>Voltar</span>
              </button>
            </div>
          </div>
        </div>
      `;
      root.appendChild(overlay);

      // Auto focus no input de ID
      setTimeout(() => {
        const inputId = document.getElementById('ext-operator-id');
        if (inputId) inputId.focus();
      }, 200);

      const inputId = document.getElementById('ext-operator-id');
      if (inputId) {
        inputId.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            document.getElementById('ext-btn-login').click();
          }
        });
      }

      // Evento de Login
      document.getElementById('ext-btn-login').addEventListener('click', () => {
        const opId = document.getElementById('ext-operator-id').value.trim();
        if (!opId) {
          showToast('Insira um ID válido!', 'error');
          return;
        }

        document.getElementById('ext-btn-login').innerText = 'Consultando...';
        chrome.runtime.sendMessage({
          type: 'GET_OPERATOR',
          data: { id_operador: opId }
        }, (response) => {
          if (response && response.success) {
            if (response.operator) {
              // Operador existe, prossegue com o login
              completeLogin(response.operator, pending);
            } else {
              // Operador não existe, abre tela de cadastro rápido
              document.getElementById('login-form-container').style.display = 'none';
              document.getElementById('register-form-container').style.display = 'block';
              document.getElementById('ext-operator-name').focus();
            }
          } else {
            document.getElementById('ext-btn-login').innerText = 'Entrar no Sistema';
            showToast(`Erro ao consultar operador: ${response ? response.error : 'Erro de rede'}`, 'error');
          }
        });
      });

      // Confirmar Cadastro de Operador
      document.getElementById('ext-btn-confirm-register').addEventListener('click', () => {
        const opId = document.getElementById('ext-operator-id').value.trim();
        const opName = document.getElementById('ext-operator-name').value.trim();

        if (!opName) {
          showToast('Digite o nome do colaborador!', 'error');
          return;
        }

        document.getElementById('ext-btn-confirm-register').innerText = 'Cadastrando...';
        chrome.runtime.sendMessage({
          type: 'CREATE_OPERATOR',
          data: {
            id_operador: opId,
            nome_colaborador: opName,
            meta_horaria: META_HORARIA
          }
        }, (response) => {
          if (response && response.success) {
            showToast('Operador cadastrado com sucesso!', 'success');
            completeLogin(response.operator, pending);
          } else {
            document.getElementById('ext-btn-confirm-register').innerText = 'Cadastrar e Entrar';
            showToast(`Falha ao cadastrar: ${response ? response.error : 'Erro desconhecido'}`, 'error');
          }
        });
      });

      // Cancelar cadastro e voltar
      document.getElementById('ext-btn-cancel-register').addEventListener('click', () => {
        document.getElementById('login-form-container').style.display = 'block';
        document.getElementById('register-form-container').style.display = 'none';
        document.getElementById('ext-operator-id').focus();
      });
    });
  }

  // Concluir Login e registrar log de acesso
  function completeLogin(operator, pendingLogout) {
    const timestampStr = new Date().toISOString();
    
    chrome.storage.local.set({
      active_operator: operator,
      login_timestamp: timestampStr
    }, () => {
      activeOperator = operator;
      loginTimestamp = timestampStr;

      // Registrar log de acesso no Supabase
      const logData = {
        bancada: currentBancada,
        id_novo: operator.id_operador
      };

      if (pendingLogout) {
        logData.id_anterior = pendingLogout.id_anterior;
        logData.justificativa = pendingLogout.justificativa;
      } else {
        logData.id_anterior = null;
        logData.justificativa = 'Login Inicial / Abertura de Tela';
      }

      chrome.runtime.sendMessage({
        type: 'LOG_ACCESS',
        data: logData
      });

      // Remover logout pendente se existir
      chrome.storage.local.remove('pending_logout', () => {
        showToast(`Olá, ${operator.nome_colaborador}! Bom trabalho.`, 'success');
        clearOverlays();
        setupOperatorWorkspace();
      });
    });
  }

  // ====================================================================
  // Área de Trabalho do Operador e Monitoramento DOM
  // ====================================================================

  function setupOperatorWorkspace() {
    console.log('UpSeller Extension: Carregando painel e monitoramento...');
    
    // 1. Carregar contagem acumulada inicial
    fetchTodayStats();

    // 1b. Carregar meta global remota (definida no Dashboard)
    fetchGlobalMeta();

    // 2. Injetar painel flutuante
    renderFloatingPanel();

    // 3. Inicializar rastreios pré-existentes na tela para evitar re-registro
    initializeProcessedTrackings();

    // 4. Iniciar observação da tela de checkout
    initCheckoutObserver();

    // 5. Iniciar atualização periódica da média e da meta global (a cada 1 minuto)
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(() => {
      fetchGlobalMeta();
      updatePanelUI();
    }, 60000);
  }

  function initializeProcessedTrackings() {
    processedTrackings.clear();
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      if (headers.includes('Nº de Rastreio') && headers.includes('Nº de Pedido')) {
        const trackingColIndex = headers.indexOf('Nº de Rastreio');
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
          if (row.textContent.includes('Nenhum') || !row.querySelector('td')) return;
          const cells = row.querySelectorAll('td');
          if (cells.length > trackingColIndex) {
            const tracking = cells[trackingColIndex].textContent.trim();
            if (tracking && tracking !== '-' && tracking !== '') {
              processedTrackings.add(tracking);
            }
          }
        });
      }
    }
    console.log('UpSeller Extension: Rastreios pré-existentes ignorados:', Array.from(processedTrackings));
  }

  // Coletar dados do pedido ativo (SKUs e quantidades totais esperadas)
  function scrapeActiveOrder() {
    // Helper para extrair o primeiro nó de texto significativo (ignora imagens/svgs/botões)
    function getFirstTextNodeValue(node) {
      if (node.nodeType === 3) {
        const val = node.textContent.trim();
        if (val && val.length >= 2) return val;
      }
      if (node.nodeName === 'IMG' || node.nodeName === 'BUTTON' || node.nodeName === 'SVG') {
        return null;
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        const found = getFirstTextNodeValue(node.childNodes[i]);
        if (found) return found;
      }
      return null;
    }

    let tracking = null;
    const allLabels = Array.from(document.querySelectorAll('span, div, p, strong, td, th'));
    const trackingLabel = allLabels.find(el => {
      const text = el.textContent.trim();
      return text === 'Nº de Rastreio' || text.startsWith('Nº de Rastreio:');
    });

    if (trackingLabel) {
      const parent = trackingLabel.parentElement;
      if (parent) {
        // Encontrar descendentes que contêm o valor (ignorar elementos que são ou contêm o próprio label "Nº de Rastreio")
        const candidates = Array.from(parent.querySelectorAll('span, div, p, strong, td'));
        const valElement = candidates.find(el => {
          const text = el.textContent.trim();
          return text !== '' && text !== '--' && text !== '-' && !text.includes('Nº de Rastreio');
        });

        if (valElement) {
          tracking = valElement.textContent.trim();
        } else {
          // Tentar os irmãos da tag do label
          let sibling = trackingLabel.nextElementSibling;
          while (sibling) {
            const text = sibling.textContent.trim();
            if (text && text !== '--' && text !== '-') {
              tracking = text;
              break;
            }
            sibling = sibling.nextElementSibling;
          }
          // Fallback de texto no elemento pai
          if (!tracking) {
            const parentText = parent.textContent.replace('Nº de Rastreio:', '').replace('Nº de Rastreio', '').trim();
            if (parentText && parentText !== '--' && parentText !== '-') {
              tracking = parentText.split('\n')[0].trim();
            }
          }
        }
      }
    }

    if (!tracking || tracking === '--' || tracking === '-') {
      return;
    }

    const tables = document.querySelectorAll('table');
    let skuTable = null;

    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      if (headers.includes('SKU') && headers.includes('Total')) {
        skuTable = table;
        break;
      }
    }

    const items = [];
    if (skuTable) {
      const headers = Array.from(skuTable.querySelectorAll('th')).map(th => th.textContent.trim());
      const skuColIndex = headers.indexOf('SKU');
      const totalColIndex = headers.indexOf('Total');

      if (skuColIndex !== -1 && totalColIndex !== -1) {
        const rows = skuTable.querySelectorAll('tbody tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length > skuColIndex && cells.length > totalColIndex) {
            const skuCell = cells[skuColIndex];
            let sku = '';
            // Tentar pegar primeiro o valor de um strong/b ou classe bold específica
            const strongEl = skuCell.querySelector('strong, b, [class*="bold"]');
            if (strongEl) {
              sku = strongEl.textContent.trim();
            } else {
              // Fallback para o primeiro nó de texto significativo da célula
              sku = getFirstTextNodeValue(skuCell);
            }

            const totalText = cells[totalColIndex].textContent.trim();
            const qtyMatch = totalText.match(/x\s*(\d+)/i) || totalText.match(/(\d+)/);
            const quantidade = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

            if (sku && sku !== 'SKU') {
              items.push({
                sku: sku,
                quantidade: quantidade
              });
            }
          }
        });
      }
    }

    if (items.length > 0) {
      const cacheKey = tracking.trim();
      const existing = activeOrderCache.get(cacheKey);
      
      if (!existing || JSON.stringify(existing) !== JSON.stringify(items)) {
        activeOrderCache.set(cacheKey, items);
        console.log(`UpSeller Extension: SKUs cacheados para o rastreio ${cacheKey}:`, items);
      }
    }
  }

  function processTableScans() {
    // Map rastreio -> nº do pedido. Antes era um Set só de rastreios; o nº
    // do pedido passou a ser capturado junto porque ele é a ÚNICA chave que
    // existe em todas as etapas do UpSeller. Ver a nota em
    // registerIndividualScan().
    const currentOnPage = new Map();
    const tables = document.querySelectorAll('table');
    
    // 1. Coletar todos os rastreios atualmente na tabela
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      if (headers.includes('Nº de Rastreio') && headers.includes('Nº de Pedido')) {
        const trackingColIndex = headers.indexOf('Nº de Rastreio');
        const orderColIndex = headers.indexOf('Nº de Pedido');
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
          if (row.textContent.includes('Nenhum') || !row.querySelector('td')) return;
          
          const cells = row.querySelectorAll('td');
          if (cells.length > trackingColIndex) {
            const tracking = cells[trackingColIndex].textContent.trim();
            if (tracking && tracking !== '-' && tracking !== '') {
              // O nº do pedido é opcional: se a coluna sumir num deploy do
              // UpSeller, o registro continua acontecendo sem ele — nunca
              // deixar de gravar a bipagem por causa de um campo extra.
              let orderNumber = null;
              if (orderColIndex >= 0 && cells.length > orderColIndex) {
                const bruto = cells[orderColIndex].textContent.trim();
                if (bruto && bruto !== '-' && bruto !== '') {
                  orderNumber = bruto.replace(/^#/, '');   // "#UP209K..." -> "UP209K..."
                }
              }
              currentOnPage.set(tracking, orderNumber);
            }
          }
        });
      }
    }

    // 2. Para cada rastreio na página, se não foi processado ainda, registra no banco
    currentOnPage.forEach((orderNumber, tracking) => {
      if (!processedTrackings.has(tracking)) {
        processedTrackings.add(tracking);
        registerIndividualScan(tracking, orderNumber);
      }
    });

    // 3. Limpar de processedTrackings os rastreios que não estão mais na página (para permitir re-escaneio se for limpo)
    processedTrackings.forEach(tracking => {
      if (!currentOnPage.has(tracking)) {
        processedTrackings.delete(tracking);
      }
    });
  }

  /**
   * @param {string} tracking      Nº de Rastreio (chave primária do registro)
   * @param {string|null} orderNumber Nº do Pedido UpSeller, ex "UP209K410061"
   *
   * ⚠️ Por que o nº do pedido é gravado junto (adicionado em 18/08/2026):
   * o projeto ../previsao-expedicao cruza a fila do UpSeller com o que foi
   * bipado aqui. Só o rastreio não basta — ele nasce quando a liderança
   * processa o pedido, então pedidos vistos na etapa "Para Enviar" não têm
   * rastreio e nunca casavam. Medido: de 102 bipagens, 46 casavam; a fila
   * pendente aparecia ~10% maior do que era, e o erro crescia durante o dia.
   * O nº do pedido existe em TODAS as etapas e fecha esse buraco.
   */
  async function registerIndividualScan(tracking, orderNumber) {
    if (!activeOperator) return;

    const cacheKey = tracking.trim();
    const itens = activeOrderCache.get(cacheKey) || null;

    console.log('UpSeller Extension: Registrando escaneio individual do pacote:', tracking, 'Pedido:', orderNumber, 'Itens:', itens);

    chrome.runtime.sendMessage({
      type: 'REGISTER_SCAN',
      data: {
        id_operador: activeOperator.id_operador,
        codigo_rastreio: tracking,
        num_pedido: orderNumber || null,
        bancada: currentBancada,
        itens: itens
      }
    }, (response) => {
      if (response && response.success) {
        // Remover do cache local
        activeOrderCache.delete(cacheKey);

        if (response.inserted) {
          showToast(`Pedido registrado! Rastreio: ${tracking}`, 'success');
          // Incrementar o contador local e reatualizar a UI
          totalOrdersToday += 1;
          const nowISO = new Date().toISOString();
          lastScanTime = nowISO;
          chrome.storage.local.get(['first_scan_time'], (res) => {
            const updates = { 
              total_orders_today: totalOrdersToday,
              last_scan_time: nowISO
            };
            if (!res.first_scan_time && !firstScanTime) {
              firstScanTime = nowISO;
              updates.first_scan_time = nowISO;
            }
            chrome.storage.local.set(updates, () => {
              updatePanelUI();
            });
          });
        } else {
          console.log(`UpSeller Extension: Rastreio ${tracking} já estava registrado no banco de dados.`);
        }
      } else if (response && response.desconectada) {
        showToast(response.error, 'error');
      } else {
        const errMsg = response ? response.error : 'Erro desconhecido de comunicação';
        showToast(`Falha ao salvar no banco: ${errMsg}`, 'error');
      }
    });
  }

  // Buscar total de pedidos de hoje do operador no Supabase
  function fetchTodayStats() {
    if (!activeOperator) return;

    // Início de hoje local convertido para string UTC ISO
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayISO = startOfToday.toISOString();

    chrome.runtime.sendMessage({
      type: 'GET_OPERATOR_STATS',
      data: {
        id_operador: activeOperator.id_operador,
        start_date: startOfTodayISO
      }
    }, (response) => {
      if (response && response.success) {
        totalOrdersToday = response.total;
        firstScanTime = response.first_scan_time;
        lastScanTime = response.last_scan_time;
        chrome.storage.local.set({ 
          total_orders_today: totalOrdersToday,
          first_scan_time: firstScanTime,
          last_scan_time: lastScanTime
        }, () => {
          updatePanelUI();
        });
      } else {
        console.error('UpSeller Extension: Falha ao buscar estatísticas diárias:', response ? response.error : 'Erro desconhecido');
      }
    });
  }

  // Observador para interceptar o botão de Envio e Tabela "Já Escaneado"
  function initCheckoutObserver() {
    if (observer) observer.disconnect();

    // Buscar e vincular listener ao botão azul Enviar periodicamente (caso o DOM mude)
    const attachInterval = setInterval(() => {
      const btn = getEnviarButton();
      if (btn && !btn.dataset.hasListener) {
        btn.dataset.hasListener = 'true';
        // Registrar na fase de captura (true) para interceptar os dados antes do envio/limpeza do DOM
        btn.addEventListener('click', handleEnviarClick, true);
        console.log('UpSeller Extension: Vinculado listener de captura ao botão Enviar!');
      }
    }, 1000);

    // Observer para processar novos escaneios em tempo real quando o DOM mudar
    observer = new MutationObserver(() => {
      scrapeActiveOrder();
      processTableScans();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Buscar o botão azul "Enviar" na tela
  function getEnviarButton() {
    const clickableElements = Array.from(document.querySelectorAll('button, div, span, a'));
    return clickableElements.find(el => {
      const text = (el.innerText || el.textContent || '').trim();
      const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
      return text === 'Enviar' && isVisible;
    });
  }

  // Buscar e extrair a quantidade da seção "Já Escaneado"
  function getScannedCount() {
    // 1. Procurar texto direto "Já Escaneado: X"
    const all = document.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.children.length <= 2 && el.textContent.includes('Já Escaneado:')) {
        const text = el.textContent.trim();
        const match = text.match(/Já\s+Escaneado:\s*(\d+|-)/i);
        if (match) {
          const val = match[1];
          if (val === '-') return 0;
          return parseInt(val, 10);
        }
      }
    }

    // 2. Fallback: Contar linhas da tabela de checkout
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      if (headers.includes('Nº de Rastreio') && headers.includes('Nº de Pedido')) {
        const rows = table.querySelectorAll('tbody tr');
        let count = 0;
        rows.forEach(row => {
          if (!row.textContent.includes('Nenhum') && row.querySelector('td')) {
            count++;
          }
        });
        return count;
      }
    }

    return 0;
  }

  // Interceptar clique do botão "Enviar"
  async function handleEnviarClick(e) {
    console.log('UpSeller Extension: Detectado clique em Enviar. Pedidos já registrados individualmente.');
  }

  // ====================================================================
  // Renderização e Lógica do Painel Flutuante (Gamificação)
  // ====================================================================

  function renderFloatingPanel() {
    const root = getContainer();
    
    // Se o painel já existe, não duplicar
    if (document.getElementById('upseller-ext-floating-panel')) {
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'upseller-ext-floating-panel';
    panel.className = 'upseller-ext-panel status-yellow'; // Inicia em amarelo padrão

    panel.innerHTML = `
      <div class="upseller-ext-panel-header" id="upseller-ext-panel-drag-handle">
        <span class="upseller-ext-panel-title">
          <span class="upseller-ext-pulse-dot"></span>
          Produtividade UpSeller
        </span>
        <div style="display: flex; gap: 4px;">
          <button id="ext-panel-btn-collapse" class="upseller-ext-btn-icon" title="Colapsar Panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
        </div>
      </div>
      <div id="ext-ui-desconectada" class="upseller-ext-alert-desconectada" hidden>
        ⚠️ Bancada desconectada, chame a liderança para parear de novo. As bipagens não estão sendo registradas.
      </div>
      <div class="upseller-ext-panel-body">
        <div class="upseller-ext-operator-row">
          <div class="upseller-ext-operator-info">
            <span id="ext-ui-op-name" class="upseller-ext-operator-name">Carregando...</span>
            <span id="ext-ui-op-details" class="upseller-ext-operator-details">Bancada: --</span>
          </div>
          <img src="${chrome.runtime.getURL('logo-hope-white.svg')}" alt="Hope Cirúrgica" class="upseller-ext-brand-logo">
        </div>

        <div class="upseller-ext-stats-grid">
          <div class="upseller-ext-stat-card">
            <div class="upseller-ext-stat-label">Pedidos Hoje</div>
            <div id="ext-ui-stat-total" class="upseller-ext-stat-val">0</div>
          </div>
          <div class="upseller-ext-stat-card">
            <div class="upseller-ext-stat-label">Média / Hora</div>
            <div id="ext-ui-stat-average" class="upseller-ext-stat-val">0.0</div>
          </div>
        </div>

        <div class="upseller-ext-progress-container">
          <div class="upseller-ext-progress-labels">
            <span>Progresso da Meta</span>
            <span id="ext-ui-meta-desc" class="upseller-ext-meta-highlight">Meta de hoje: --/h</span>
          </div>
          <div class="upseller-ext-progress-bar-bg">
            <div id="ext-ui-progress-fill" class="upseller-ext-progress-bar-fill" style="width: 0%;"></div>
          </div>
        </div>

        <div id="ext-ui-feedback" class="upseller-ext-feedback-box">
          Carregando status de produtividade...
        </div>

        <div class="upseller-ext-actions" style="margin-top: 8px;">
          <button id="ext-panel-btn-logout" class="upseller-ext-btn-logout">
            <span>Alterar Operador</span>
          </button>
        </div>
      </div>
    `;

    root.appendChild(panel);

    // Ajustar posição inicial salva no storage (se existir)
    chrome.storage.local.get('panel_pos', (res) => {
      if (res.panel_pos) {
        panel.style.top = res.panel_pos.top;
        panel.style.left = res.panel_pos.left;
        panel.style.right = 'auto';
      }
    });

    // Ativar comportamento de arrastar a partir de qualquer ponto do painel (exceto botões)
    makeDraggable(panel, panel);

    // Evento de colapsar
    const collapseBtn = document.getElementById('ext-panel-btn-collapse');
    collapseBtn.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      const isCollapsed = panel.classList.contains('collapsed');
      
      // Salvar estado colapsado no storage
      chrome.storage.local.set({ panel_collapsed: isCollapsed });

      // Ajustar ícone do botão
      collapseBtn.innerHTML = isCollapsed 
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>`;
    });

    // Carregar estado de colapso salvo
    chrome.storage.local.get('panel_collapsed', (res) => {
      if (res.panel_collapsed) {
        panel.classList.add('collapsed');
        collapseBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;
      }
    });

    // Evento de Logout (Alterar Operador)
    document.getElementById('ext-panel-btn-logout').addEventListener('click', showLogoutJustifications);

    updatePanelUI();
    updateDesconectadaAlert();
  }

  // Aviso fixo quando a bancada pareada perdeu o acesso (sessão revogada ou vencida). Fica fora do
  // corpo do painel para aparecer mesmo com ele colapsado. O background nunca cai para a chave
  // compartilhada nesse estado, então as bipagens param até a liderança parear de novo.
  function updateDesconectadaAlert() {
    chrome.storage.local.get('sessao_bancada', (res) => {
      const alert = document.getElementById('ext-ui-desconectada');
      if (alert) alert.hidden = !(res.sessao_bancada && res.sessao_bancada.desconectada);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sessao_bancada) updateDesconectadaAlert();
  });

  // Atualizar dados exibidos no painel flutuante
  function updatePanelUI() {
    const panel = document.getElementById('upseller-ext-floating-panel');
    if (!panel || !activeOperator || !loginTimestamp) return;

    // Calcular tempo decorrido desde o início da atividade de hoje
    const now = new Date();
    const loginTime = new Date(loginTimestamp);
    const startScan = firstScanTime ? new Date(firstScanTime) : null;
    const lastScan = lastScanTime ? new Date(lastScanTime) : null;
    const startTime = startScan ? new Date(Math.min(startScan, loginTime)) : loginTime;
    
    let elapsedMs;
    if (lastScan) {
      const timeSinceLastScanMs = now - lastScan;
      const minutesSinceLastScan = timeSinceLastScanMs / (1000 * 60);
      if (minutesSinceLastScan > 60) {
        // Inativo: congela a divisão no tempo do último escaneamento
        elapsedMs = lastScan - startTime;
      } else {
        // Ativo: calcula pelo tempo decorrido de agora
        elapsedMs = now - startTime;
      }
    } else {
      // Sem escaneamentos ainda
      elapsedMs = now - startTime;
    }
    
    // Mínimo de 5 minutos (0.083 horas) para evitar médias infladas ao iniciar o turno
    const elapsedHours = Math.max(0.083, elapsedMs / (1000 * 60 * 60));
    
    // Prioridade: meta global remota (se definida) > meta individual do operador > padrão do código
    const metaHorariaOperador = (metaGlobal != null)
      ? metaGlobal
      : ((activeOperator && activeOperator.meta_horaria) ? activeOperator.meta_horaria : META_HORARIA);
    const mediaHoraria = totalOrdersToday / elapsedHours;

    // Atualizar textos na UI
    document.getElementById('ext-ui-op-name').innerText = activeOperator.nome_colaborador;
    document.getElementById('ext-ui-op-details').innerText = `ID: ${activeOperator.id_operador} | Bancada: ${currentBancada}`;
    document.getElementById('ext-ui-stat-total').innerText = totalOrdersToday;
    document.getElementById('ext-ui-stat-average').innerText = mediaHoraria.toFixed(1);
    document.getElementById('ext-ui-meta-desc').innerText = `Meta de hoje: ${metaHorariaOperador}/h`;

    // Calcular porcentagem para barra de progresso (em relação à meta horária atual)
    const progressPercent = Math.min(100, Math.round((mediaHoraria / metaHorariaOperador) * 100));
    document.getElementById('ext-ui-progress-fill').style.width = `${progressPercent}%`;

    // Determinar Status de Cores e Mensagens de Gamificação
    let statusClass = 'status-yellow';
    let feedbackText = 'É isso aí, você está na média! Continue assim 👍';

    // Faixas relativas à meta do dia: vermelho abaixo de 95%, amarelo até 110%,
    // verde de 110% a 120%, azul (recorde) acima de 120%.
    const limiteInferior = metaHorariaOperador * 0.95;
    const limiteSuperior = metaHorariaOperador * 1.10;
    const limiteRecorde = metaHorariaOperador * 1.20;

    if (mediaHoraria > limiteRecorde) {
      statusClass = 'status-blue';
      feedbackText = 'Eita! Vai bater seu recorde hoje? 🔥';
    } else if (mediaHoraria > limiteSuperior) {
      statusClass = 'status-green';
      feedbackText = 'Parabéns, hoje você está um foguete! 🚀';
    } else if (mediaHoraria < limiteInferior) {
      statusClass = 'status-red';
      feedbackText = 'Precisa acelerar um pouquinho. Você consegue 💪';
    } else {
      statusClass = 'status-yellow';
      feedbackText = 'É isso aí, você está na média! Continue assim 👍';
    }

    // Aplicar a classe de estilo de status ao painel
    panel.className = `upseller-ext-panel ${statusClass}`;
    if (panel.classList.contains('collapsed')) {
      panel.classList.add('collapsed'); // preservar estado de colapso
    }
    
    document.getElementById('ext-ui-feedback').innerText = feedbackText;
  }

  // Tornar elemento arrastável
  function makeDraggable(dragTarget, panel) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    dragTarget.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      // Ignorar clique se for em botão
      if (e.target.closest('button')) return;
      
      e = e || window.event;
      e.preventDefault();
      
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      let newTop = panel.offsetTop - pos2;
      let newLeft = panel.offsetLeft - pos1;
      
      // Respeitar limites da viewport do navegador
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));
      
      panel.style.top = `${newTop}px`;
      panel.style.left = `${newLeft}px`;
      panel.style.right = 'auto';
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
      
      // Salvar posição preferida
      chrome.storage.local.set({
        panel_pos: { top: panel.style.top, left: panel.style.left }
      });
    }
  }

  // ====================================================================
  // Fluxo de Logout e Troca Segura (Justificativa Obrigatória)
  // ====================================================================

  function showLogoutJustifications() {
    const body = document.querySelector('.upseller-ext-panel-body');
    if (!body) return;

    // Preservar altura para efeito suave
    body.style.maxHeight = '500px';

    // Renderizar formulário de justificativa
    body.innerHTML = `
      <div class="upseller-ext-modal-container">
        <span class="upseller-ext-label" style="margin-bottom: 5px;">Selecione a Justificativa de Troca</span>
        <button class="upseller-ext-justification-btn" data-just="Problema Técnico na Máquina">
          ⚙️ Problema Técnico na Máquina
        </button>
        <button class="upseller-ext-justification-btn" data-just="Troca de Turno / Almoço">
          🥪 Troca de Turno / Almoço
        </button>
        <button class="upseller-ext-justification-btn" data-just="Remanejamento">
          🔄 Remanejamento
        </button>
        
        <button id="ext-btn-cancel-logout" class="upseller-ext-btn upseller-ext-btn-secondary" style="margin-top: 5px; padding: 8px 12px; font-size: 13px;">
          <span>Cancelar</span>
        </button>
      </div>
    `;

    // Vincular clique nas justificativas
    document.querySelectorAll('.upseller-ext-justification-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const just = e.currentTarget.getAttribute('data-just');
        executeLogout(just);
      });
    });

    // Cancelar alteração
    document.getElementById('ext-btn-cancel-logout').addEventListener('click', () => {
      // Re-renderizar o rodapé de ações original restaurando o painel
      const panel = document.getElementById('upseller-ext-floating-panel');
      if (panel) {
        panel.remove();
        renderFloatingPanel();
      }
    });
  }

  function executeLogout(justificativa) {
    if (!activeOperator) return;

    // Salvar o evento de logout pendente com o ID atual para logar a troca quando o próximo operador entrar
    const pendingData = {
      id_anterior: activeOperator.id_operador,
      justificativa: justificativa,
      timestamp: new Date().toISOString()
    };

    chrome.storage.local.set({ pending_logout: pendingData }, () => {
      // Limpar sessão local
      chrome.storage.local.remove(['active_operator', 'login_timestamp', 'total_orders_today', 'first_scan_time', 'last_scan_time'], () => {
        activeOperator = null;
        loginTimestamp = null;
        totalOrdersToday = 0;
        firstScanTime = null;
        lastScanTime = null;

        // Limpar painel flutuante
        const panel = document.getElementById('upseller-ext-floating-panel');
        if (panel) panel.remove();
        if (statsInterval) clearInterval(statsInterval);

        showToast('Logout efetuado. Insira o novo operador.', 'success');
        // Exibir a tela de login exigindo a identificação imediata
        showLoginOverlay();
      });
    });
  }

  // ====================================================================
  // Utilitários de Interface (Toast de Notificação)
  // ====================================================================

  function showToast(message, type = 'success') {
    const root = getContainer();
    
    // Remover toast anterior se existir
    const prevToast = document.querySelector('.upseller-ext-toast');
    if (prevToast) prevToast.remove();

    const toast = document.createElement('div');
    toast.className = `upseller-ext-toast toast-${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '✅' : '❌'}</span>
      <span>${message}</span>
    `;

    root.appendChild(toast);

    // Fade-in
    setTimeout(() => {
      toast.classList.add('show');
    }, 50);

    // Auto-destruir após 3.5 segundos
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 3500);
  }

  function checkUrlAndInit() {
    const url = window.location.href;
    if (url === currentUrl) return;
    currentUrl = url;

    const isScanCheckPage = url.includes('app.upseller.com/pt/order/scan-check');
    const isLocalTest = url.includes('localhost') || url.includes('127.0.0.1') || url.startsWith('file:///');

    if (isScanCheckPage || isLocalTest) {
      if (!isInitialized) {
        isInitialized = true;
        init();
      }
    } else {
      if (isInitialized) {
        isInitialized = false;
        cleanup();
      }
    }
  }

  // Executar monitoramento de URL ao carregar a página
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    checkUrlAndInit();
  } else {
    window.addEventListener('DOMContentLoaded', checkUrlAndInit);
  }

  // Configurar listeners de mudança de URL
  setInterval(checkUrlAndInit, 1000);
  window.addEventListener('popstate', checkUrlAndInit);
  window.addEventListener('hashchange', checkUrlAndInit);
})();
