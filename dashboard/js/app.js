/* ============================================================
   QUANTUM EDGE — Main Application Controller
   Wires up WebSocket, REST, charts, controls, and live updates
   ============================================================ */

(function () {
  'use strict';

  /* --------------------------------------------------------
     State
     -------------------------------------------------------- */
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  let startTime = Date.now();
  let equityChart, drawdownChart, pnlDistChart;
  let lastFactors = null;
  let isPaused = false;
  let activityCount = 0;
  const MAX_ACTIVITY = 200;
  let demoInterval = null;

  const $ = (id) => document.getElementById(id);

  /* --------------------------------------------------------
     INIT
     -------------------------------------------------------- */
  function init() {
    equityChart = new EquityChart('equity-chart');
    drawdownChart = new DrawdownChart('drawdown-chart');
    pnlDistChart = new PnLDistribution('pnl-dist-chart');

    connectWebSocket();
    fetchInitialData();
    setupControls();
    startUptimeTimer();

    // Refresh performance metrics every 60s
    setInterval(fetchPerformance, 60000);

    addActivity('info', 'Dashboard initialized — Quantum Edge v2.0');
  }

  /* --------------------------------------------------------
     WEBSOCKET
     -------------------------------------------------------- */
  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + location.host + '/ws';

    updateWsStatus('connecting');

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      updateWsStatus('disconnected');
      addActivity('warning', 'WebSocket not available — running in demo mode');
      scheduleReconnect();
      startDemoMode();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = 1000;
      updateWsStatus('connected');
      updateAgentStatus('connected', 'Online');
      addActivity('info', 'WebSocket connected');
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.warn('WS parse error:', e);
      }
    };

    ws.onclose = function () {
      updateWsStatus('disconnected');
      updateAgentStatus('connecting', 'Reconnecting...');
      addActivity('warning', 'WebSocket disconnected — reconnecting...');
      scheduleReconnect();
    };

    ws.onerror = function () {
      updateWsStatus('disconnected');
      if (ws) ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
      connectWebSocket();
    }, reconnectDelay);
  }

  function updateWsStatus(state) {
    const el = $('ws-status');
    if (!el) return;
    const dot = el.querySelector('.ws-dot');
    if (dot) {
      dot.className = 'ws-dot ' + state;
    }
    const labels = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting...' };
    el.innerHTML = '';
    const d = document.createElement('span');
    d.className = 'ws-dot ' + state;
    el.appendChild(d);
    el.appendChild(document.createTextNode(' ' + (labels[state] || state)));
  }

  function updateAgentStatus(state, text) {
    const badge = $('agent-status');
    if (!badge) return;
    badge.className = 'status-badge status-' + state;
    const dot = badge.querySelector('.status-dot');
    const txt = badge.querySelector('.status-text');
    if (txt) txt.textContent = text || state;
  }

  /* --------------------------------------------------------
     MESSAGE HANDLER
     -------------------------------------------------------- */
  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'init':
        updateFullStatus(msg.data);
        break;
      case 'signal':
        handleSignal(msg.data);
        break;
      case 'trade_open':
        handleTradeOpen(msg.data);
        break;
      case 'trade_close':
        handleTradeClose(msg.data);
        break;
      case 'equity':
        equityChart.addPoint(msg.data.total || msg.data.value || msg.data);
        updateEquityDisplay(msg.data.total || msg.data.value || msg.data);
        break;
      case 'regime':
        updateRegime(msg.data);
        break;
      case 'alert':
        handleAlert(msg.data);
        break;
      case 'performance':
        updatePerformanceMetrics(msg.data);
        break;
      case 'readiness':
        renderReadinessChecklist(msg.data);
        break;
      default:
        console.log('Unknown message type:', msg.type);
    }
  }

  /* --------------------------------------------------------
     REST DATA FETCHING
     -------------------------------------------------------- */
  async function fetchInitialData() {
    try {
      const [status, trades, equity, performance, regime, readiness] = await Promise.all([
        safeFetch('/api/status'),
        safeFetch('/api/trades?limit=50'),
        safeFetch('/api/equity'),
        safeFetch('/api/performance'),
        safeFetch('/api/regime'),
        safeFetch('/api/readiness'),
      ]);

      if (status) updateFullStatus(status.data || status);
      if (trades) renderTradeHistory(trades.data || (Array.isArray(trades) ? trades : trades.trades || []));
      if (equity) {
        const eqArr = Array.isArray(equity) ? equity : equity.data || equity.values || [];
        equityChart.setData(eqArr);
        buildDrawdownFromEquity(eqArr);
        if (eqArr.length > 0) {
          const last = eqArr[eqArr.length - 1];
          updateEquityDisplay(typeof last === 'object' ? last.value || last.total : last);
        }
      }
      if (performance) updatePerformanceMetrics(performance.data || performance);
      if (regime) updateRegime(regime.data ? (regime.data.current || regime.data) : regime);
      if (readiness) renderReadinessChecklist(readiness.data || readiness);

      if (trades) {
        const tArr = trades.data || (Array.isArray(trades) ? trades : trades.trades || []);
        buildPnLDistribution(tArr);
      }
    } catch (e) {
      addActivity('warning', 'API not available — loading demo data');
      loadDemoData();
    }
  }

  async function fetchPerformance() {
    try {
      const [perf, read] = await Promise.all([
        safeFetch('/api/performance'),
        safeFetch('/api/readiness')
      ]);
      if (perf) updatePerformanceMetrics(perf.data || perf);
      if (read) renderReadinessChecklist(read.data || read);
    } catch (e) { /* silent */ }
  }

  async function safeFetch(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------
     UPDATE FULL STATUS
     -------------------------------------------------------- */
  function updateFullStatus(rawPayload) {
    if (!rawPayload) return;
    const data = rawPayload.data || rawPayload;

    // Mode
    if (data.mode) {
      const mi = $('mode-indicator');
      if (mi) {
        const isLive = String(data.mode).toLowerCase() === 'live';
        mi.className = 'mode-indicator' + (isLive ? ' mode-live' : '');
        const icon = mi.querySelector('.mode-icon');
        const text = mi.querySelector('.mode-text');
        if (icon) icon.textContent = isLive ? '🔴' : '📄';
        if (text) text.textContent = isLive ? 'LIVE TRADING' : 'PAPER TRADE';
      }
    }

    // Agent status
    if (data.agent_active !== undefined) {
      updateAgentStatus(
        data.agent_active ? 'connected' : 'error',
        data.agent_active ? 'Online' : 'Offline'
      );
    }

    // Trading pair
    if (data.pair || data.symbol) {
      setText('trading-pair', data.pair || data.symbol);
    }

    // Balance
    if (data.balance != null) {
      setAnimatedValue('balance-value', data.balance, (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }

    // Daily PnL
    if (data.daily_pnl != null) {
      const dpVal = $('daily-pnl-value');
      if (dpVal) {
        dpVal.textContent = UI.formatPnl(data.daily_pnl);
        dpVal.className = 'stat-value mono ' + (data.daily_pnl >= 0 ? 'positive' : 'negative');
      }
      if (data.daily_pnl_pct != null) {
        setText('daily-pnl-sub', UI.formatPercent(data.daily_pnl_pct));
      }
    }

    // Win Rate
    if (data.win_rate != null) {
      setText('winrate-value', UI.formatPercent(data.win_rate).replace('+', ''));
      if (data.wins != null && data.total_trades != null) {
        setText('winrate-sub', data.wins + ' / ' + data.total_trades + ' trades');
      }
    }

    // Sharpe
    if (data.sharpe != null) {
      setText('sharpe-value', UI.formatNumber(data.sharpe));
    }

    // Profit Factor
    if (data.profit_factor != null) {
      setText('profit-factor-value', UI.formatNumber(data.profit_factor));
    }

    // Max Drawdown
    if (data.max_drawdown != null) {
      const ddEl = $('drawdown-value');
      if (ddEl) {
        ddEl.textContent = UI.formatPercent(-Math.abs(data.max_drawdown)).replace('+', '');
        ddEl.className = 'stat-value mono negative';
      }
    }

    // Positions
    if (data.positions) {
      renderPositions(Array.isArray(data.positions) ? data.positions : []);
    }

    // Paused
    if (data.paused != null) {
      updatePauseState(data.paused);
    }

    // Risk info
    if (data.risk) {
      if (data.risk.risk_per_trade != null) setText('risk-per-trade', UI.formatPercent(data.risk.risk_per_trade).replace('+', ''));
      if (data.risk.max_drawdown != null) setText('risk-max-dd', UI.formatPercent(data.risk.max_drawdown).replace('+', ''));
      if (data.risk.kelly != null) setText('risk-kelly', UI.formatNumber(data.risk.kelly));
      if (data.risk.cooldown != null) setText('risk-cooldown', data.risk.cooldown ? data.risk.cooldown + 's' : 'None');
      if (data.risk.consecutive_losses != null) setText('risk-consec-losses', String(data.risk.consecutive_losses));
      if (data.risk.daily_trades != null) setText('risk-daily-trades', String(data.risk.daily_trades));
    }

    // Regime
    if (data.regime) {
      updateRegime(data.regime);
    }

    // Readiness Checklist
    if (data.readiness) {
      renderReadinessChecklist(data.readiness);
    }
  }

  /* --------------------------------------------------------
     REGIME
     -------------------------------------------------------- */
  function updateRegime(data) {
    if (!data) return;
    const regime = typeof data === 'string' ? data : data.regime || data.type || 'unknown';
    const pill = $('regime-indicator');
    const text = $('regime-text');
    const icon = pill ? pill.querySelector('.regime-icon') : null;

    const cls = UI.regimeClass(regime);
    if (pill) pill.className = 'regime-pill regime-' + cls;
    if (text) text.textContent = UI.regimeLabel(regime);
    if (icon) icon.textContent = UI.regimeIcon(regime);

    addActivity('regime', 'Market regime: ' + UI.regimeLabel(regime));
  }

  /* --------------------------------------------------------
     PERFORMANCE METRICS
     -------------------------------------------------------- */
  function updatePerformanceMetrics(rawPayload) {
    if (!rawPayload) return;
    const data = rawPayload.data || rawPayload;

    if (data.sharpe != null) {
      setText('qm-sharpe', UI.formatNumber(data.sharpe));
      setText('sharpe-value', UI.formatNumber(data.sharpe));
    }
    if (data.sortino != null) setText('qm-sortino', UI.formatNumber(data.sortino));
    if (data.calmar != null) setText('qm-calmar', UI.formatNumber(data.calmar));
    if (data.expectancy != null) setText('qm-expectancy', UI.formatPnl(data.expectancy));
    if (data.avg_win_loss != null || data.avg_wl != null) setText('qm-avg-wl', UI.formatNumber(data.avg_win_loss || data.avg_wl));
    if (data.total_return != null) {
      const trEl = $('qm-total-return');
      if (trEl) {
        trEl.textContent = UI.formatPercent(data.total_return);
        trEl.className = 'metric-value mono ' + (data.total_return >= 0 ? 'pnl-positive' : 'pnl-negative');
      }
    }
    if (data.profit_factor != null) setText('profit-factor-value', UI.formatNumber(data.profit_factor));
    if (data.win_rate != null) setText('winrate-value', UI.formatPercent(data.win_rate).replace('+', ''));

    if (data.max_drawdown != null) {
      const ddEl = $('drawdown-value');
      if (ddEl) {
        ddEl.textContent = UI.formatPercent(-Math.abs(data.max_drawdown)).replace('+', '');
      }
      setText('dd-current', UI.formatPercent(-Math.abs(data.max_drawdown)));
    }
  }

  /* --------------------------------------------------------
     SIGNALS
     -------------------------------------------------------- */
  function handleSignal(data) {
    if (!data) return;
    lastFactors = data.factors || data;
    renderFactorBars(lastFactors);

    const direction = data.direction || data.side || '?';
    const score = data.score != null ? ' (score: ' + UI.formatNumber(data.score, 1) + ')' : '';
    addActivity('signal', 'Signal: ' + direction.toUpperCase() + score);
  }

  function renderFactorBars(factors) {
    if (!factors) return;

    const factorMap = {
      ema: 'EMA Trend',
      rsi: 'RSI Signal',
      macd: 'MACD Cross',
      bb: 'Bollinger Band',
      volume: 'Volume Profile',
      squeeze: 'Squeeze Detect',
      htf: 'HTF Confirm',
    };

    // Update existing factor bar fills and values
    Object.keys(factorMap).forEach((key) => {
      const score = factors[key] != null ? Number(factors[key]) : 0;
      const maxScore = 2;
      const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));

      const fill = document.querySelector('[data-factor="' + key + '"]');
      const val = document.querySelector('[data-factor-val="' + key + '"]');

      if (fill) {
        fill.style.width = pct + '%';
        fill.classList.remove('strong', 'medium', 'weak');
        if (pct >= 70) fill.classList.add('strong');
        else if (pct >= 40) fill.classList.add('medium');
        else fill.classList.add('weak');
      }

      if (val) {
        val.textContent = UI.formatNumber(score, 1);
      }
    });
  }

  /* --------------------------------------------------------
     TRADES
     -------------------------------------------------------- */
  function handleTradeOpen(data) {
    if (!data) return;
    addActivity('trade', 'Opened ' + UI.sideLabel(data.side) + ' ' + (data.pair || 'BTC/USDT') + ' @ ' + UI.formatPrice(data.entry || data.entry_price));

    // Add to positions
    const tbody = $('positions-body');
    const empty = $('positions-empty');
    if (tbody) {
      const row = UI.createPositionRow(data);
      tbody.prepend(row);
      UI.flashElement(row, data.side);
    }
    if (empty) empty.style.display = 'none';
    updatePositionCount();
  }

  function handleTradeClose(data) {
    if (!data) return;
    const pnl = data.pnl || data.realized_pnl || 0;
    addActivity('trade', 'Closed ' + UI.sideLabel(data.side) + ' ' + (data.pair || 'BTC/USDT') + ' P&L: ' + UI.formatPnl(pnl));

    // Add to history
    const tbody = $('history-body');
    const empty = $('history-empty');
    if (tbody) {
      const row = UI.createHistoryRow(data);
      tbody.prepend(row);
    }
    if (empty) empty.style.display = 'none';
    updateHistoryCount();

    // Update P&L distribution
    pnlDistChart.addPoint(pnl);

    // Refresh balance etc. if provided
    if (data.balance != null) {
      setAnimatedValue('balance-value', data.balance, (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      equityChart.addPoint(data.balance);
      updateEquityDisplay(data.balance);
    }
  }

  function handleAlert(data) {
    if (!data) return;
    const severity = data.severity || data.level || 'warning';
    const msg = data.message || data.msg || String(data);
    addActivity(severity, msg);
  }

  /* --------------------------------------------------------
     RENDERERS
     -------------------------------------------------------- */
  function renderReadinessChecklist(readinessData) {
    if (!readinessData) return;
    const data = readinessData.data || readinessData;
    const checklist = data.checklist || [];

    const badge = $('readiness-summary-badge');
    if (badge) {
      badge.textContent = `${data.passedCount}/${data.totalCount} PASSED`;
      if (data.isReady) {
        badge.classList.add('ready');
      } else {
        badge.classList.remove('ready');
      }
    }

    const fill = $('readiness-progress-fill');
    const text = $('readiness-progress-text');
    if (fill) {
      fill.style.width = `${data.progressPct}%`;
    }
    if (text) {
      text.textContent = `${data.progressPct}% Complete`;
    }

    const container = $('readiness-checklist-container');
    if (container) {
      container.innerHTML = '';
      checklist.forEach((item) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'readiness-item ' + (item.passed ? 'passed' : 'failed');
        const statusIcon = item.passed ? '✅' : '❌';
        itemEl.innerHTML = `
          <div class="readiness-item-main">
            <div class="readiness-item-left">
              <span class="readiness-status-icon">${statusIcon}</span>
              <span class="readiness-metric-name">${item.name}</span>
            </div>
            <div class="readiness-item-right">
              <span class="readiness-metric-values">
                <span class="readiness-metric-current">${item.current}</span>
                <span class="readiness-metric-target">/ ${item.target}</span>
              </span>
            </div>
          </div>
          <div class="readiness-item-why">${item.why}</div>
        `;
        container.appendChild(itemEl);
      });
    }
  }

  function renderPositions(positions) {
    const tbody = $('positions-body');
    const empty = $('positions-empty');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (positions.length === 0) {
      if (empty) empty.style.display = '';
    } else {
      if (empty) empty.style.display = 'none';
      positions.forEach((pos) => {
        tbody.appendChild(UI.createPositionRow(pos));
      });
    }
    updatePositionCount(positions.length);
  }

  function renderTradeHistory(trades) {
    const tbody = $('history-body');
    const empty = $('history-empty');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (trades.length === 0) {
      if (empty) empty.style.display = '';
    } else {
      if (empty) empty.style.display = 'none';
      trades.forEach((trade) => {
        tbody.appendChild(UI.createHistoryRow(trade));
      });
    }
    updateHistoryCount(trades.length);
  }

  function updatePositionCount(count) {
    const badge = $('positions-count');
    if (badge) {
      const c = count != null ? count : ($('positions-body') ? $('positions-body').children.length : 0);
      badge.textContent = c;
    }
  }

  function updateHistoryCount(count) {
    const badge = $('history-count');
    if (badge) {
      const c = count != null ? count : ($('history-body') ? $('history-body').children.length : 0);
      badge.textContent = c;
    }
  }

  function updateEquityDisplay(val) {
    const el = $('equity-current');
    if (el && val != null) {
      el.textContent = '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  }

  /* --------------------------------------------------------
     ACTIVITY FEED
     -------------------------------------------------------- */
  function addActivity(type, msg) {
    const feed = $('activity-feed');
    if (!feed) return;

    const item = UI.createActivityItem(type, msg);
    feed.prepend(item);
    activityCount++;

    // Trim old items
    while (feed.children.length > MAX_ACTIVITY) {
      feed.removeChild(feed.lastChild);
    }
  }

  /* --------------------------------------------------------
     DRAWDOWN & P&L DISTRIBUTION COMPUTATION
     -------------------------------------------------------- */
  function buildDrawdownFromEquity(equityData) {
    if (!equityData || equityData.length < 2) return;

    const values = equityData.map((v) => (typeof v === 'object' ? v.value || v.total || v : v));
    const ddSeries = [];
    let peak = values[0];

    for (let i = 0; i < values.length; i++) {
      if (values[i] > peak) peak = values[i];
      const dd = peak > 0 ? -((peak - values[i]) / peak) * 100 : 0;
      ddSeries.push(dd);
    }

    drawdownChart.setData(ddSeries);

    // Update current DD display
    const currentDD = ddSeries[ddSeries.length - 1];
    setText('dd-current', UI.formatPercent(currentDD));
  }

  function buildPnLDistribution(trades) {
    if (!trades || trades.length === 0) return;
    const pnls = trades
      .map((t) => t.pnl || t.realized_pnl || 0)
      .filter((v) => v !== 0);
    pnlDistChart.setData(pnls);
  }

  /* --------------------------------------------------------
     CONTROLS
     -------------------------------------------------------- */
  function setupControls() {
    const killBtn = $('btn-kill-switch');
    const resumeBtn = $('btn-resume');
    const closeAllBtn = $('btn-close-all');

    if (killBtn) {
      killBtn.addEventListener('click', async () => {
        killBtn.disabled = true;
        killBtn.querySelector('.btn-label').textContent = 'STOPPING...';
        try {
          const r = await fetch('/api/pause', { method: 'POST' });
          if (r.ok) {
            updatePauseState(true);
            addActivity('warning', 'KILL SWITCH activated — agent paused');
          }
        } catch (e) {
          // Demo mode
          updatePauseState(true);
          addActivity('warning', 'KILL SWITCH activated — agent paused');
        }
        killBtn.disabled = false;
        killBtn.querySelector('.btn-label').textContent = 'KILL SWITCH';
      });
    }

    if (resumeBtn) {
      resumeBtn.addEventListener('click', async () => {
        resumeBtn.disabled = true;
        resumeBtn.querySelector('.btn-label').textContent = 'RESUMING...';
        try {
          const r = await fetch('/api/resume', { method: 'POST' });
          if (r.ok) {
            updatePauseState(false);
            addActivity('info', 'Agent resumed — trading active');
          }
        } catch (e) {
          updatePauseState(false);
          addActivity('info', 'Agent resumed — trading active');
        }
        resumeBtn.disabled = false;
        resumeBtn.querySelector('.btn-label').textContent = 'RESUME';
      });
    }

    if (closeAllBtn) {
      closeAllBtn.addEventListener('click', async () => {
        if (!confirm('Close ALL open positions?')) return;
        closeAllBtn.disabled = true;
        closeAllBtn.textContent = 'Closing...';
        try {
          await fetch('/api/close-all', { method: 'POST' });
          renderPositions([]);
          addActivity('warning', 'All positions closed');
        } catch (e) {
          renderPositions([]);
          addActivity('warning', 'All positions closed');
        }
        closeAllBtn.disabled = false;
        closeAllBtn.textContent = 'Close All';
      });
    }
  }

  function updatePauseState(paused) {
    isPaused = paused;
    const killBtn = $('btn-kill-switch');
    const resumeBtn = $('btn-resume');

    if (paused) {
      if (killBtn) killBtn.classList.add('hidden');
      if (resumeBtn) resumeBtn.classList.remove('hidden');
      updateAgentStatus('error', 'Paused');
    } else {
      if (killBtn) killBtn.classList.remove('hidden');
      if (resumeBtn) resumeBtn.classList.add('hidden');
      updateAgentStatus('connected', 'Online');
    }
  }

  /* --------------------------------------------------------
     UPTIME TIMER
     -------------------------------------------------------- */
  function startUptimeTimer() {
    function update() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      setText('uptime', h + ':' + m + ':' + s);
    }
    update();
    setInterval(update, 1000);
  }

  /* --------------------------------------------------------
     HELPERS
     -------------------------------------------------------- */
  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function setAnimatedValue(id, val, formatter) {
    const el = $(id);
    if (!el) return;
    const current = parseFloat(el.textContent.replace(/[^0-9.\-]/g, '')) || 0;
    UI.animateValue(el, current, val, 500, formatter || ((v) => '$' + v.toFixed(2)));
  }

  /* --------------------------------------------------------
     DEMO MODE — Generates realistic data when no backend
     -------------------------------------------------------- */
  function loadDemoData() {
    addActivity('info', 'Loading demonstration data...');

    // Generate equity curve
    const equityData = [];
    let equity = 10000;
    for (let i = 0; i < 120; i++) {
      equity += (Math.random() - 0.42) * 80;
      equity = Math.max(equity, 8500);
      equityData.push(parseFloat(equity.toFixed(2)));
    }
    equityChart.setData(equityData);
    buildDrawdownFromEquity(equityData);
    updateEquityDisplay(equityData[equityData.length - 1]);

    // Generate demo trades
    const demoTrades = [];
    const sides = ['long', 'short'];
    const regimes = ['trending', 'ranging', 'volatile'];
    let tradeEquity = 10000;
    for (let i = 0; i < 28; i++) {
      const side = sides[Math.random() > 0.55 ? 0 : 1];
      const entry = 67000 + Math.random() * 4000;
      const pnl = (Math.random() - 0.42) * 300;
      const exit = side === 'long' ? entry + pnl / 0.01 : entry - pnl / 0.01;
      tradeEquity += pnl;
      const d = new Date(Date.now() - (28 - i) * 3600000 * 2);
      demoTrades.push({
        closed_at: d.toISOString(),
        side: side,
        pair: 'BTC/USDT',
        entry_price: entry,
        exit_price: exit,
        pnl: parseFloat(pnl.toFixed(2)),
        pnl_pct: parseFloat(((pnl / tradeEquity) * 100).toFixed(3)),
        score: parseFloat((4 + Math.random() * 6).toFixed(1)),
        regime: regimes[Math.floor(Math.random() * regimes.length)],
      });
    }
    renderTradeHistory(demoTrades);
    buildPnLDistribution(demoTrades);

    // Demo positions
    const demoPositions = [
      {
        side: 'long', pair: 'BTC/USDT', qty: 0.0142, entry_price: 68432.50,
        stop_loss: 67800.00, take_profit: 69500.00, regime: 'trending',
        score: 8.4, unrealized_pnl: 127.35,
      },
      {
        side: 'short', pair: 'BTC/USDT', qty: 0.0085, entry_price: 69100.00,
        stop_loss: 69650.00, take_profit: 68200.00, regime: 'volatile',
        score: 6.2, unrealized_pnl: -42.18,
      },
    ];
    renderPositions(demoPositions);

    // Demo performance
    updatePerformanceMetrics({
      sharpe: 1.87,
      sortino: 2.43,
      calmar: 3.12,
      expectancy: 28.45,
      avg_win_loss: 1.65,
      total_return: 8.42,
      profit_factor: 1.78,
      win_rate: 62.5,
      max_drawdown: 1.84,
    });

    const demoReadiness = {
      checklist: [
        { id: 'sample_size', name: 'Sample Size', target: '≥ 100 closed trades', current: '28 closed', value: 28, why: 'Anything less is statistically meaningless', passed: false },
        { id: 'win_rate', name: 'Win Rate', target: '≥ 52.00%', current: '62.50%', value: 62.5, why: 'Proves edge exists after fees', passed: true },
        { id: 'profit_factor', name: 'Profit Factor', target: '≥ 1.30', current: '1.78', value: 1.78, why: 'Gross wins / gross losses — below 1.0 means you\'re losing', passed: true },
        { id: 'sharpe_ratio', name: 'Sharpe Ratio', target: '≥ 1.00', current: '1.87', value: 1.87, why: 'Risk-adjusted return — below 1.0 isn\'t worth the risk', passed: true },
        { id: 'max_drawdown', name: 'Max Drawdown', target: '≤ 15.00%', current: '1.84%', value: 1.84, why: 'If paper trading blows past this, live will be worse', passed: true },
        { id: 'expectancy', name: 'Expectancy', target: '> $0.00', current: '$28.45', value: 28.45, why: '(WinRate × AvgWin) - (LossRate × AvgLoss) must be positive', passed: true },
        { id: 'time_in_paper', name: 'Time in Paper', target: '≥ 14.0 days', current: '4.2 days', value: 4.2, why: 'Must survive different market conditions (trending + ranging + choppy)', passed: false },
        { id: 'consecutive_loss_recovery', name: 'Loss Streak Recovery', target: 'Streak recovered', current: 'Recovered from 1 streak (max: 3 losses)', value: 1, why: 'System must have recovered from at least one 3-5 loss streak', passed: true }
      ],
      passedCount: 6,
      totalCount: 8,
      progressPct: 75.00,
      isReady: false
    };

    // Demo status
    updateFullStatus({
      mode: 'paper',
      agent_active: true,
      pair: 'BTC/USDT',
      balance: equityData[equityData.length - 1],
      daily_pnl: 187.32,
      daily_pnl_pct: 1.87,
      win_rate: 62.5,
      wins: 17,
      total_trades: 28,
      sharpe: 1.87,
      profit_factor: 1.78,
      max_drawdown: 1.84,
      readiness: demoReadiness,
      risk: {
        risk_per_trade: 1.0,
        max_drawdown: 3.0,
        kelly: 0.38,
        cooldown: null,
        consecutive_losses: 1,
        daily_trades: 4,
      },
    });

    // Demo regime
    updateRegime('trending');

    // Demo factors
    renderFactorBars({
      ema: 1.8,
      rsi: 1.2,
      macd: 1.5,
      bb: 0.8,
      volume: 1.6,
      squeeze: 0.4,
      htf: 1.9,
    });

    addActivity('trade', 'Opened LONG BTC/USDT @ 68,432.50');
    addActivity('signal', 'Signal: LONG (score: 8.4)');
    addActivity('regime', 'Market regime: TRENDING');

    // Start live demo updates
    startDemoMode();
  }

  function startDemoMode() {
    if (demoInterval) return;
    let demoEquity = parseFloat(($('equity-current')?.textContent || '10000').replace(/[^0-9.\-]/g, '')) || 10000;
    let tickCount = 0;

    demoInterval = setInterval(() => {
      tickCount++;

      // Equity tick every 3s
      const delta = (Math.random() - 0.47) * 25;
      demoEquity += delta;
      demoEquity = Math.max(demoEquity, 8000);
      equityChart.addPoint(parseFloat(demoEquity.toFixed(2)));
      updateEquityDisplay(demoEquity);

      // Update balance
      const balEl = $('balance-value');
      if (balEl) {
        balEl.textContent = '$' + demoEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      // Periodically update drawdown
      if (tickCount % 5 === 0) {
        const eqData = equityChart.data.slice();
        buildDrawdownFromEquity(eqData);
      }

      // Random signal every ~30 ticks
      if (tickCount % 30 === 0) {
        const side = Math.random() > 0.5 ? 'long' : 'short';
        const score = (4 + Math.random() * 6).toFixed(1);
        handleSignal({
          direction: side,
          score: parseFloat(score),
          factors: {
            ema: parseFloat((Math.random() * 2).toFixed(1)),
            rsi: parseFloat((Math.random() * 2).toFixed(1)),
            macd: parseFloat((Math.random() * 2).toFixed(1)),
            bb: parseFloat((Math.random() * 2).toFixed(1)),
            volume: parseFloat((Math.random() * 2).toFixed(1)),
            squeeze: parseFloat((Math.random() * 2).toFixed(1)),
            htf: parseFloat((Math.random() * 2).toFixed(1)),
          },
        });
      }

      // Random regime change every ~60 ticks
      if (tickCount % 60 === 0) {
        const regimes = ['trending', 'ranging', 'volatile'];
        updateRegime(regimes[Math.floor(Math.random() * regimes.length)]);
      }
    }, 3000);
  }

  /* --------------------------------------------------------
     BOOT
     -------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', init);
})();
