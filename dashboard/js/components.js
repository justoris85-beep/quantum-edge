/* ============================================================
   QUANTUM EDGE — UI Components
   Formatters, DOM builders, animations
   ============================================================ */

(function () {
  'use strict';

  /* --------------------------------------------------------
     FORMATTERS
     -------------------------------------------------------- */
  function formatTime(iso) {
    if (!iso) return '--:--:--';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatDate(iso) {
    if (!iso) return '----';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function formatPrice(val) {
    if (val == null || isNaN(val)) return '—';
    const n = Number(val);
    if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
  }

  function formatPnl(val) {
    if (val == null || isNaN(val)) return '$0.00';
    const n = Number(val);
    const sign = n >= 0 ? '+' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatQty(val) {
    if (val == null || isNaN(val)) return '0';
    const n = Number(val);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
  }

  function formatPercent(val) {
    if (val == null || isNaN(val)) return '0.00%';
    const n = Number(val);
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  function formatNumber(val, decimals) {
    if (val == null || isNaN(val)) return '0';
    return Number(val).toFixed(decimals != null ? decimals : 2);
  }

  /* --------------------------------------------------------
     CLASSIFIERS
     -------------------------------------------------------- */
  function pnlClass(val) {
    const n = Number(val);
    if (n > 0) return 'pnl-positive';
    if (n < 0) return 'pnl-negative';
    return '';
  }

  function sideClass(side) {
    if (!side) return '';
    const s = String(side).toLowerCase();
    if (s === 'long' || s === 'buy') return 'side-long';
    if (s === 'short' || s === 'sell') return 'side-short';
    return '';
  }

  function sideLabel(side) {
    if (!side) return '—';
    const s = String(side).toLowerCase();
    if (s === 'long' || s === 'buy') return 'LONG';
    if (s === 'short' || s === 'sell') return 'SHORT';
    return String(side).toUpperCase();
  }

  function regimeClass(regime) {
    if (!regime) return 'unknown';
    const r = String(regime).toLowerCase();
    if (r.includes('trend')) return 'trending';
    if (r.includes('rang')) return 'ranging';
    if (r.includes('volat')) return 'volatile';
    return 'unknown';
  }

  function regimeLabel(regime) {
    if (!regime) return 'UNKNOWN';
    const r = String(regime).toLowerCase();
    if (r.includes('trend')) return 'TRENDING';
    if (r.includes('rang')) return 'RANGING';
    if (r.includes('volat')) return 'VOLATILE';
    return String(regime).toUpperCase();
  }

  function regimeIcon(regime) {
    const r = regimeClass(regime);
    if (r === 'trending') return '📈';
    if (r === 'ranging') return '📊';
    if (r === 'volatile') return '⚠️';
    return '◆';
  }

  function scoreClass(score) {
    const n = Number(score);
    if (n >= 8) return 'score-high';
    if (n >= 5) return 'score-mid';
    return 'score-low';
  }

  /* --------------------------------------------------------
     DOM BUILDERS
     -------------------------------------------------------- */
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function createPositionRow(pos) {
    const tr = el('tr');
    tr.className = 'row-enter';
    
    const tradeId = pos.trade_id || pos.tradeId;
    if (tradeId) {
      tr.setAttribute('data-trade-id', tradeId);
    }

    // Side
    const tdSide = el('td', sideClass(pos.side), sideLabel(pos.side));
    tdSide.setAttribute('title', 'Direction: LONG (buy) or SHORT (sell)');
    tr.appendChild(tdSide);

    // Pair
    tr.appendChild(el('td', '', pos.pair || pos.symbol || 'BTC/USDT'));

    // Qty
    tr.appendChild(el('td', '', formatQty(pos.qty || pos.quantity || pos.size)));

    // Entry
    tr.appendChild(el('td', '', formatPrice(pos.entry || pos.entry_price)));

    // SL / TP stacked
    const tdSlTp = el('td');
    const slTpDiv = el('div', 'sl-tp-stack');
    const slSpan = el('span', 'sl-val', 'SL: ' + formatPrice(pos.sl || pos.stop_loss));
    const tpSpan = el('span', 'tp-val', 'TP: ' + formatPrice(pos.tp || pos.take_profit));
    slTpDiv.appendChild(slSpan);
    slTpDiv.appendChild(tpSpan);
    tdSlTp.appendChild(slTpDiv);
    tr.appendChild(tdSlTp);

    // Regime mini pill
    const tdRegime = el('td');
    const rVal = pos.regime !== undefined ? pos.regime : pos.regime_at_entry;
    const rClass = regimeClass(rVal);
    const rPill = el('span', 'regime-mini ' + rClass, regimeLabel(rVal));
    rPill.setAttribute('title', 'Market regime when this position was opened');
    tdRegime.appendChild(rPill);
    tr.appendChild(tdRegime);

    // Score
    const tdScore = el('td');
    const scoreVal = pos.score !== undefined ? pos.score : (pos.signal_score !== undefined ? pos.signal_score : 0);
    const sBadge = el('span', 'score-badge ' + scoreClass(scoreVal), formatNumber(scoreVal, 1));
    sBadge.setAttribute('title', 'Multi-factor strategy signal score at entry (out of 10)');
    tdScore.appendChild(sBadge);
    tr.appendChild(tdScore);

    // Unrealized P&L
    const pnlVal = pos.unrealized_pnl || pos.unr_pnl || pos.pnl || 0;
    const tdPnl = el('td', pnlClass(pnlVal), formatPnl(pnlVal));
    tdPnl.setAttribute('title', 'Running unrealized profit/loss based on current price');
    tr.appendChild(tdPnl);

    return tr;
  }

  function createHistoryRow(trade) {
    const tr = el('tr');
    tr.className = 'row-enter';

    // Time
    tr.appendChild(el('td', '', formatDate(trade.closed_at || trade.close_time || trade.time)));

    // Side
    const tdSide = el('td', sideClass(trade.side), sideLabel(trade.side));
    tdSide.setAttribute('title', 'Direction: LONG (buy) or SHORT (sell)');
    tr.appendChild(tdSide);

    // Pair
    tr.appendChild(el('td', '', trade.pair || trade.symbol || 'BTC/USDT'));

    // Entry
    tr.appendChild(el('td', '', formatPrice(trade.entry || trade.entry_price)));

    // Exit
    tr.appendChild(el('td', '', formatPrice(trade.exit || trade.exit_price)));

    // P&L
    const pnl = trade.pnl || trade.realized_pnl || 0;
    const tdPnl = el('td', pnlClass(pnl), formatPnl(pnl));
    tdPnl.setAttribute('title', 'Net realized profit or loss after fees');
    tr.appendChild(tdPnl);

    // P&L %
    const pnlPct = trade.pnl_pct || trade.pnl_percent || 0;
    const tdPnlPct = el('td', pnlClass(pnlPct), formatPercent(pnlPct));
    tdPnlPct.setAttribute('title', 'Percentage return relative to the entry price');
    tr.appendChild(tdPnlPct);

    // Score
    const tdScore = el('td');
    const scoreVal = trade.score !== undefined ? trade.score : (trade.signal_score !== undefined ? trade.signal_score : 0);
    const sB = el('span', 'score-badge ' + scoreClass(scoreVal), formatNumber(scoreVal, 1));
    sB.setAttribute('title', 'Multi-factor strategy signal score when the trade was opened');
    tdScore.appendChild(sB);
    tr.appendChild(tdScore);

    return tr;
  }

  function createActivityItem(type, msg) {
    const div = el('div', 'activity-item type-' + (type || 'info'));
    const timeSpan = el('span', 'activity-time', formatTime(new Date().toISOString()));
    const msgSpan = el('span', 'activity-msg', msg);
    div.appendChild(timeSpan);
    div.appendChild(msgSpan);
    return div;
  }

  function createFactorBar(name, score, maxScore) {
    maxScore = maxScore || 2;
    const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));

    const row = el('div', 'factor-row');

    const label = el('div', 'factor-label', name);
    row.appendChild(label);

    const track = el('div', 'factor-bar-track');
    const fill = el('div', 'factor-bar-fill');
    fill.style.width = pct + '%';

    // Color class based on score
    if (pct >= 70) fill.classList.add('strong');
    else if (pct >= 40) fill.classList.add('medium');
    else fill.classList.add('weak');

    track.appendChild(fill);
    row.appendChild(track);

    const val = el('div', 'factor-score mono', formatNumber(score, 1));
    row.appendChild(val);

    return row;
  }

  function createMetricCard(label, value, subtext) {
    const card = el('div', 'metric-card');
    card.appendChild(el('div', 'metric-label', label));
    card.appendChild(el('div', 'metric-value mono', String(value)));
    if (subtext) card.appendChild(el('div', 'metric-sub', subtext));
    return card;
  }

  /* --------------------------------------------------------
     ANIMATION HELPERS
     -------------------------------------------------------- */
  function animateValue(element, start, end, duration, formatter) {
    if (!element) return;
    duration = duration || 600;
    formatter = formatter || ((v) => v.toFixed(2));
    const startTime = performance.now();
    const diff = end - start;

    function frame(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = start + diff * eased;
      element.textContent = formatter(current);
      if (progress < 1) requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  function flashElement(el, type) {
    if (!el) return;
    el.classList.remove('flash-long', 'flash-short');
    void el.offsetWidth; // force reflow
    el.classList.add(type === 'long' || type === 'buy' ? 'flash-long' : 'flash-short');
    setTimeout(() => el.classList.remove('flash-long', 'flash-short'), 700);
  }

  /* --------------------------------------------------------
     EXPORT
     -------------------------------------------------------- */
  window.UI = {
    // Formatters
    formatTime,
    formatDate,
    formatPrice,
    formatPnl,
    formatQty,
    formatPercent,
    formatNumber,

    // Classifiers
    pnlClass,
    sideClass,
    sideLabel,
    regimeClass,
    regimeLabel,
    regimeIcon,
    scoreClass,

    // DOM builders
    createPositionRow,
    createHistoryRow,
    createActivityItem,
    createFactorBar,
    createMetricCard,

    // Animations
    animateValue,
    flashElement,
  };
})();
