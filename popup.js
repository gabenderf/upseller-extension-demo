document.addEventListener('DOMContentLoaded', () => {
  // Meta padrão por hora obtida da configuração global
  const META_HORARIA = (window.UPSELLER_CONFIG && window.UPSELLER_CONFIG.META_PEDIDOS_POR_HORA) || 35;

  chrome.storage.local.get([
    'bancada',
    'active_operator',
    'login_timestamp',
    'total_orders_today',
    'first_scan_time',
    'last_scan_time',
    'meta_global'
  ], (result) => {
    const bancada = result.bancada || 'Não Configurada';
    const badge = document.getElementById('popup-terminal-badge');
    badge.innerText = `💻 ${bancada}`;

    // Permitir alterar bancada clicando no badge
    badge.addEventListener('click', () => {
      const currentVal = result.bancada || '';
      const newVal = prompt('Digite o novo identificador da bancada:', currentVal);
      if (newVal !== null) {
        const cleanedVal = newVal.trim();
        if (cleanedVal !== '') {
          chrome.storage.local.set({ bancada: cleanedVal }, () => {
            badge.innerText = `💻 ${cleanedVal}`;
            showToast(`Bancada alterada para: ${cleanedVal}`);
            // Recarregar a aba ativa para aplicar a mudança na tela do operador
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0] && tabs[0].id) {
                chrome.tabs.reload(tabs[0].id);
              }
            });
            // Atualizar detalhes na UI do popup caso o operador esteja ativo
            const detailsElement = document.getElementById('popup-operator-details');
            if (detailsElement && result.active_operator) {
              detailsElement.innerText = `ID: ${result.active_operator.id_operador} | Bancada: ${cleanedVal}`;
            }
          });
        } else {
          showToast('Identificador de bancada não pode ser vazio!', true);
        }
      }
    });

    const activeOperator = result.active_operator;
    if (activeOperator && result.login_timestamp) {
      // Mostrar dashboard ativo
      document.getElementById('session-active-card').style.display = 'block';
      document.getElementById('session-inactive-card').style.display = 'none';

      const totalOrdersToday = result.total_orders_today || 0;
      const loginTimestamp = result.login_timestamp;

      // Calcular tempo decorrido desde o início da atividade de hoje
      const now = new Date();
      const loginTime = new Date(loginTimestamp);
      const firstScan = result.first_scan_time ? new Date(result.first_scan_time) : null;
      const lastScan = result.last_scan_time ? new Date(result.last_scan_time) : null;
      const startTime = firstScan ? new Date(Math.min(firstScan, loginTime)) : loginTime;
      
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
      
      // Mínimo de 5 minutos (0.083 horas) para evitar médias infladas ao iniciar
      const elapsedHours = Math.max(0.083, elapsedMs / (1000 * 60 * 60));
      
      // Prioridade: meta global remota (se definida) > meta individual do operador > padrão do código
      const metaHorariaOperador = (result.meta_global != null)
        ? result.meta_global
        : ((activeOperator && activeOperator.meta_horaria) ? activeOperator.meta_horaria : META_HORARIA);
      const mediaHoraria = totalOrdersToday / elapsedHours;

      // Atualizar textos na UI
      document.getElementById('popup-operator-name').innerText = activeOperator.nome_colaborador;
      document.getElementById('popup-operator-details').innerText = `ID: ${activeOperator.id_operador} | Bancada: ${bancada}`;
      document.getElementById('popup-stat-total').innerText = totalOrdersToday;
      document.getElementById('popup-stat-average').innerText = mediaHoraria.toFixed(1);
      document.getElementById('popup-meta-desc').innerText = `Meta de hoje: ${metaHorariaOperador}/h`;

      // Calcular barra de progresso
      const progressPercent = Math.min(100, Math.round((mediaHoraria / metaHorariaOperador) * 100));
      document.getElementById('popup-progress-fill').style.width = `${progressPercent}%`;

      // Status de cores e gamificação
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

      // Aplicar status ao card da sessão ativa
      const activeCard = document.getElementById('session-active-card');
      activeCard.className = statusClass;
      document.getElementById('popup-feedback').innerText = feedbackText;

      // Lógica de logout / alterar operador
      const btnLogoutInit = document.getElementById('popup-btn-logout-init');
      const justificationsPanel = document.getElementById('popup-justifications-panel');
      const btnCancelLogout = document.getElementById('popup-btn-cancel-logout');

      btnLogoutInit.addEventListener('click', () => {
        btnLogoutInit.style.display = 'none';
        justificationsPanel.style.display = 'flex';
      });

      btnCancelLogout.addEventListener('click', () => {
        btnLogoutInit.style.display = 'block';
        justificationsPanel.style.display = 'none';
      });

      // Vincular clique nas justificativas
      document.querySelectorAll('.justification-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const justification = e.currentTarget.getAttribute('data-just');
          executePopupLogout(activeOperator, bancada, justification);
        });
      });

    } else {
      // Mostrar tela inativa
      document.getElementById('session-active-card').style.display = 'none';
      document.getElementById('session-inactive-card').style.display = 'block';
    }
  });

  function executePopupLogout(operator, bancada, justificativa) {
    // Salvar o evento de logout pendente para o background
    const pendingData = {
      id_anterior: operator.id_operador,
      justificativa: justificativa,
      timestamp: new Date().toISOString()
    };

    chrome.storage.local.set({ pending_logout: pendingData }, () => {
      // Registrar log de acesso no Supabase
      chrome.runtime.sendMessage({
        type: 'LOG_ACCESS',
        data: {
          bancada: bancada,
          id_anterior: operator.id_operador,
          id_novo: null,
          justificativa: justificativa
        }
      });

      // Limpar sessão local
      chrome.storage.local.remove(['active_operator', 'login_timestamp', 'total_orders_today', 'first_scan_time', 'last_scan_time'], () => {
        showToast('Operador deslogado!', false);

        // Recarregar a aba ativa para exibir o bloqueio de login imediatamente
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0] && tabs[0].id) {
            chrome.tabs.reload(tabs[0].id);
          }
        });

        setTimeout(() => {
          window.close();
        }, 1000);
      });
    });
  }

  // ====================================================================
  // Acesso da bancada: pareamento com o Hope SaaS (versão de transição com fallback)
  //
  // O popup só mostra e manda comandos. Quem pede o código, consulta a aprovação a cada 5 s e
  // guarda a sessão é o background.js: o popup fecha quando perde o foco e a consulta não pode
  // parar junto. O segredo de consulta e os tokens nunca passam por aqui.
  // ====================================================================

  const versionEl = document.getElementById('popup-version');
  if (versionEl) versionEl.innerText = `UpSeller Productivity Extension v${chrome.runtime.getManifest().version}`;

  const pair = {
    card: document.getElementById('pair-card'),
    pill: document.getElementById('pair-pill'),
    views: {
      none: document.getElementById('pair-view-none'),
      code: document.getElementById('pair-view-code'),
      retry: document.getElementById('pair-view-retry'),
      ok: document.getElementById('pair-view-ok'),
      off: document.getElementById('pair-view-off'),
    },
    code: document.getElementById('pair-code'),
    countdown: document.getElementById('pair-countdown'),
    retryText: document.getElementById('pair-retry-text'),
    okText: document.getElementById('pair-ok-text'),
  };
  let pairExpiresAt = null;

  function formatPairCode(codigo) {
    return codigo && codigo.length === 8 ? `${codigo.slice(0, 4)}-${codigo.slice(4)}` : (codigo || '');
  }

  function formatDateTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${dia} às ${hora}`;
  }

  function tickCountdown() {
    if (!pairExpiresAt) return;
    const total = Math.max(0, Math.ceil((pairExpiresAt - Date.now()) / 1000));
    pair.countdown.innerText = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function showPairView(name, pillText, pillClass) {
    Object.entries(pair.views).forEach(([key, el]) => { el.hidden = key !== name; });
    pair.pill.innerText = pillText;
    pair.pill.className = `pair-pill ${pillClass || ''}`.trim();
    pair.card.hidden = false;
  }

  function renderPairing(state) {
    if (!state || !state.success) {
      pair.card.hidden = true;
      return;
    }
    const pendente = state.pendente;
    pairExpiresAt = null;

    if (pendente && (pendente.status === 'aguardando' || pendente.status === 'verificando')) {
      pair.code.innerText = formatPairCode(pendente.codigo);
      pairExpiresAt = Date.parse(pendente.expira_em);
      document.getElementById('pair-wait').innerText =
        pendente.status === 'verificando' ? 'Aprovado, concluindo…' : 'Aguardando aprovação…';
      tickCountdown();
      showPairView('code', 'Pareando', 'is-wait');
      return;
    }
    if (pendente && (pendente.status === 'expirado' || pendente.status === 'erro')) {
      pair.retryText.innerText = pendente.status === 'expirado'
        ? 'O código expirou antes de ser aprovado.'
        : pendente.erro;
      const isOff = state.estado === 'desconectada';
      showPairView('retry', isOff ? 'Desconectada' : (state.estado === 'pareada' ? 'Pareada' : 'Chave compartilhada'), isOff ? 'is-off' : '');
      return;
    }

    if (state.estado === 'pareada') {
      pair.okText.innerText =
        `Conta própria desta máquina, pareada em ${formatDateTime(state.sessao.pareada_em)}. ` +
        `Acesso renovado em ${formatDateTime(state.sessao.renovada_em)}.`;
      showPairView('ok', 'Pareada', 'is-ok');
    } else if (state.estado === 'desconectada') {
      showPairView('off', 'Desconectada', 'is-off');
    } else {
      showPairView('none', 'Chave compartilhada', '');
    }
  }

  function sendPairMessage(type) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type }, (response) => {
        resolve(response || { success: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Sem resposta' });
      });
    });
  }

  async function refreshPairing() {
    renderPairing(await sendPairMessage('PAIR_STATUS'));
  }

  async function startPairing(button) {
    button.disabled = true;
    const original = button.innerText;
    button.innerText = 'Pedindo código…';
    const response = await sendPairMessage('PAIR_START');
    button.disabled = false;
    button.innerText = original;
    if (!response.success) {
      showToast(response.error || 'Não foi possível pedir o código.', true);
      return;
    }
    renderPairing(response);
  }

  async function unpair() {
    const ok = confirm(
      'Desparear esta bancada?\n\n' +
      'Ela volta a usar a chave compartilhada até ser pareada de novo. ' +
      'Revogue também o dispositivo em Configurações › Dispositivos do Hope SaaS.'
    );
    if (!ok) return;
    const response = await sendPairMessage('UNPAIR');
    if (response.success) showToast('Bancada despareada.');
    renderPairing(response);
  }

  document.getElementById('pair-btn-start').addEventListener('click', (e) => startPairing(e.currentTarget));
  document.getElementById('pair-btn-retry').addEventListener('click', (e) => startPairing(e.currentTarget));
  document.getElementById('pair-btn-repair').addEventListener('click', (e) => startPairing(e.currentTarget));
  document.getElementById('pair-btn-cancel').addEventListener('click', async () => renderPairing(await sendPairMessage('PAIR_CANCEL')));
  document.getElementById('pair-btn-dismiss').addEventListener('click', async () => renderPairing(await sendPairMessage('PAIR_CANCEL')));
  document.getElementById('pair-btn-unpair').addEventListener('click', unpair);
  document.getElementById('pair-btn-unpair-off').addEventListener('click', unpair);

  // O background grava a sessão em storage.local e o pareamento em andamento em storage.session.
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && changes.sessao_bancada) || (area === 'session' && changes.pareamento_pendente)) {
      refreshPairing();
    }
  });
  setInterval(tickCountdown, 1000);
  refreshPairing();

  function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.className = 'toast';
    if (isError) {
      toast.classList.add('toast-error');
    }
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }
});
