/* ============================================================
   QUANTUM EDGE — Canvas Chart Engine
   Three premium chart classes for the trading dashboard
   ============================================================ */

(function () {
  'use strict';

  /* --------------------------------------------------------
     Utility helpers shared across charts
     -------------------------------------------------------- */
  const CHART_COLORS = {
    green: '#10b981',
    greenFade: 'rgba(16,185,129,0.25)',
    greenGlow: 'rgba(16,185,129,0.6)',
    red: '#f43f5e',
    redFade: 'rgba(244,63,94,0.20)',
    redGlow: 'rgba(244,63,94,0.6)',
    blue: '#3b82f6',
    blueFade: 'rgba(59,130,246,0.15)',
    grid: 'rgba(255,255,255,0.04)',
    gridText: 'rgba(255,255,255,0.22)',
    axisText: 'rgba(255,255,255,0.32)',
    yellow: '#f59e0b',
    white08: 'rgba(255,255,255,0.08)',
    white20: 'rgba(255,255,255,0.20)',
    bg: '#06080d',
    purple: '#a78bfa',
  };

  function dpr() {
    return window.devicePixelRatio || 1;
  }

  function setupCanvas(canvas) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const r = dpr();
    canvas.width = rect.width * r;
    canvas.height = rect.height * r;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(r, r);
    return { ctx, w: rect.width, h: rect.height };
  }

  function niceSteps(min, max, targetSteps) {
    const range = max - min || 1;
    const rough = range / targetSteps;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const residual = rough / mag;
    let nice;
    if (residual <= 1.5) nice = 1;
    else if (residual <= 3) nice = 2;
    else if (residual <= 7) nice = 5;
    else nice = 10;
    const step = nice * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const steps = [];
    for (let v = niceMin; v <= niceMax + step * 0.01; v += step) {
      steps.push(parseFloat(v.toFixed(10)));
    }
    return { min: niceMin, max: niceMax, steps };
  }

  function formatDollar(v) {
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }

  function formatPercent(v) {
    return v.toFixed(2) + '%';
  }

  /* ============================================================
     EQUITY CHART — Gradient-filled line chart
     ============================================================ */
  class EquityChart {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.data = [];
      this._animFrame = null;
      this._glowPhase = 0;
      this._bind();
      this._startLoop();
    }

    _bind() {
      const ro = new ResizeObserver(() => this.render());
      ro.observe(this.canvas.parentElement);
    }

    setData(arr) {
      // arr: array of numbers (equity values) or {value, ts}
      this.data = arr.map(v => (typeof v === 'object' ? v.value || v.total || v : v));
      this.render();
    }

    addPoint(val) {
      this.data.push(typeof val === 'object' ? val.value || val.total || val : val);
      if (this.data.length > 500) this.data.shift();
      this.render();
    }

    render() {
      if (!this.canvas.parentElement) return;
      const { ctx, w, h } = setupCanvas(this.canvas);

      if (this.data.length < 2) {
        this._drawEmpty(ctx, w, h, 'Awaiting equity data...');
        return;
      }

      const pad = { top: 12, right: 60, bottom: 24, left: 8 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      const min = Math.min(...this.data);
      const max = Math.max(...this.data);
      const { min: yMin, max: yMax, steps } = niceSteps(min, max, 5);
      const yRange = yMax - yMin || 1;

      const toX = (i) => pad.left + (i / (this.data.length - 1)) * cw;
      const toY = (v) => pad.top + ch - ((v - yMin) / yRange) * ch;

      // Grid lines
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      steps.forEach(sv => {
        const y = toY(sv);
        ctx.strokeStyle = CHART_COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
        ctx.fillStyle = CHART_COLORS.axisText;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(formatDollar(sv), w - pad.right + 6, y + 3);
      });

      // Build smooth path with quadratic bezier
      const pts = this.data.map((v, i) => ({ x: toX(i), y: toY(v) }));

      const path = new Path2D();
      path.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const cpx = (prev.x + cur.x) / 2;
        path.quadraticCurveTo(prev.x + (cpx - prev.x) * 0.8, prev.y, cpx, (prev.y + cur.y) / 2);
        path.quadraticCurveTo(cur.x - (cur.x - cpx) * 0.8, cur.y, cur.x, cur.y);
      }

      // Determine color direction
      const last = this.data[this.data.length - 1];
      const first = this.data[0];
      const isUp = last >= first;
      const lineColor = isUp ? CHART_COLORS.green : CHART_COLORS.red;
      const fadeColor = isUp ? CHART_COLORS.greenFade : CHART_COLORS.redFade;

      // Gradient fill
      const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
      grad.addColorStop(0, fadeColor);
      grad.addColorStop(1, 'transparent');

      const fillPath = new Path2D();
      fillPath.addPath(path);
      fillPath.lineTo(pts[pts.length - 1].x, h - pad.bottom);
      fillPath.lineTo(pts[0].x, h - pad.bottom);
      fillPath.closePath();

      ctx.fillStyle = grad;
      ctx.fill(fillPath);

      // Line stroke
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(path);

      // Pulsing end dot
      const endPt = pts[pts.length - 1];
      this._glowPhase += 0.05;
      const glowSize = 4 + Math.sin(this._glowPhase) * 2;
      const glowAlpha = 0.3 + Math.sin(this._glowPhase) * 0.15;

      ctx.beginPath();
      ctx.arc(endPt.x, endPt.y, glowSize + 4, 0, Math.PI * 2);
      ctx.fillStyle = isUp
        ? `rgba(16,185,129,${glowAlpha})`
        : `rgba(244,63,94,${glowAlpha})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(endPt.x, endPt.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();

      // Current value label
      ctx.fillStyle = lineColor;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(formatDollar(last), endPt.x - 8, endPt.y - 8);
    }

    _drawEmpty(ctx, w, h, msg) {
      ctx.fillStyle = CHART_COLORS.gridText;
      ctx.font = '12px "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, w / 2, h / 2);
    }

    _startLoop() {
      const tick = () => {
        if (this.data.length > 1) this.render();
        this._animFrame = requestAnimationFrame(tick);
      };
      this._animFrame = requestAnimationFrame(tick);
    }

    destroy() {
      cancelAnimationFrame(this._animFrame);
    }
  }

  /* ============================================================
     DRAWDOWN CHART — Inverted red area chart
     ============================================================ */
  class DrawdownChart {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.data = []; // array of negative percentages (e.g. -1.5)
      this.maxAllowed = -3; // max allowed drawdown line
      this._bind();
    }

    _bind() {
      const ro = new ResizeObserver(() => this.render());
      ro.observe(this.canvas.parentElement);
    }

    setData(arr) {
      this.data = arr.map(v => (typeof v === 'object' ? v.value || v : v));
      this.render();
    }

    addPoint(val) {
      this.data.push(typeof val === 'object' ? val.value || val : val);
      if (this.data.length > 500) this.data.shift();
      this.render();
    }

    render() {
      if (!this.canvas.parentElement) return;
      const { ctx, w, h } = setupCanvas(this.canvas);

      if (this.data.length < 2) {
        ctx.fillStyle = CHART_COLORS.gridText;
        ctx.font = '12px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Awaiting drawdown data...', w / 2, h / 2);
        return;
      }

      const pad = { top: 12, right: 52, bottom: 24, left: 8 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      // Y range: 0 at top to min(data, maxAllowed) at bottom
      const dataMin = Math.min(...this.data, this.maxAllowed);
      const yTop = 0;
      const yBottom = Math.min(dataMin * 1.2, this.maxAllowed * 1.3);
      const yRange = yTop - yBottom || 1; // positive number

      const toX = (i) => pad.left + (i / (this.data.length - 1)) * cw;
      const toY = (v) => pad.top + ((yTop - v) / yRange) * ch;

      // Grid
      const { steps } = niceSteps(yBottom, yTop, 4);
      ctx.lineWidth = 1;
      steps.forEach(sv => {
        const y = toY(sv);
        ctx.strokeStyle = CHART_COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
        ctx.fillStyle = CHART_COLORS.axisText;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(formatPercent(sv), w - pad.right + 5, y + 3);
      });

      // Max drawdown threshold line
      const threshY = toY(this.maxAllowed);
      ctx.strokeStyle = CHART_COLORS.yellow;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, threshY);
      ctx.lineTo(w - pad.right, threshY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = CHART_COLORS.yellow;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('Max DD', w - pad.right + 5, threshY - 4);

      // Build line path
      const zeroY = toY(0);
      const pts = this.data.map((v, i) => ({ x: toX(i), y: toY(v) }));

      // Fill area
      ctx.beginPath();
      ctx.moveTo(pts[0].x, zeroY);
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) {
          ctx.lineTo(pts[i].x, pts[i].y);
        } else {
          const prev = pts[i - 1];
          const cur = pts[i];
          const cpx = (prev.x + cur.x) / 2;
          ctx.quadraticCurveTo(prev.x + (cpx - prev.x) * 0.7, prev.y, cpx, (prev.y + cur.y) / 2);
          ctx.quadraticCurveTo(cur.x - (cur.x - cpx) * 0.7, cur.y, cur.x, cur.y);
        }
      }
      ctx.lineTo(pts[pts.length - 1].x, zeroY);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, zeroY, 0, h);
      grad.addColorStop(0, 'rgba(244,63,94,0.05)');
      grad.addColorStop(1, 'rgba(244,63,94,0.25)');
      ctx.fillStyle = grad;
      ctx.fill();

      // Stroke line
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const cpx = (prev.x + cur.x) / 2;
        ctx.quadraticCurveTo(prev.x + (cpx - prev.x) * 0.7, prev.y, cpx, (prev.y + cur.y) / 2);
        ctx.quadraticCurveTo(cur.x - (cur.x - cpx) * 0.7, cur.y, cur.x, cur.y);
      }
      ctx.strokeStyle = CHART_COLORS.red;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Current value label
      const lastVal = this.data[this.data.length - 1];
      const lastPt = pts[pts.length - 1];
      ctx.fillStyle = CHART_COLORS.red;
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(formatPercent(lastVal), lastPt.x - 6, lastPt.y - 6);
    }
  }

  /* ============================================================
     P&L DISTRIBUTION — Histogram with bell curve overlay
     ============================================================ */
  class PnLDistribution {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.data = []; // raw P&L values
      this.bucketSize = 50;
      this._bind();
    }

    _bind() {
      const ro = new ResizeObserver(() => this.render());
      ro.observe(this.canvas.parentElement);
    }

    setData(arr) {
      this.data = arr.map(v => (typeof v === 'object' ? v.pnl || v.value || v : v));
      this.render();
    }

    addPoint(val) {
      this.data.push(typeof val === 'object' ? val.pnl || val.value || val : val);
      this.render();
    }

    render() {
      if (!this.canvas.parentElement) return;
      const { ctx, w, h } = setupCanvas(this.canvas);

      if (this.data.length < 3) {
        ctx.fillStyle = CHART_COLORS.gridText;
        ctx.font = '12px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Need more trades for distribution...', w / 2, h / 2);
        return;
      }

      const pad = { top: 16, right: 12, bottom: 28, left: 12 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      // Build buckets
      const minVal = Math.min(...this.data);
      const maxVal = Math.max(...this.data);
      const range = maxVal - minVal || 100;

      // Auto bucket size
      let bs = this.bucketSize;
      if (range > 2000) bs = 200;
      else if (range > 1000) bs = 100;
      else if (range > 500) bs = 50;
      else bs = 25;

      const bucketStart = Math.floor(minVal / bs) * bs;
      const bucketEnd = Math.ceil(maxVal / bs) * bs;
      const buckets = [];
      for (let b = bucketStart; b < bucketEnd; b += bs) {
        const count = this.data.filter(v => v >= b && v < b + bs).length;
        buckets.push({ start: b, end: b + bs, mid: b + bs / 2, count });
      }

      if (buckets.length === 0) return;

      const maxCount = Math.max(...buckets.map(b => b.count), 1);
      const barW = Math.max(Math.floor(cw / buckets.length) - 2, 4);
      const gap = (cw - barW * buckets.length) / (buckets.length + 1);

      // Draw bars
      buckets.forEach((bucket, i) => {
        const x = pad.left + gap + i * (barW + gap);
        const barH = (bucket.count / maxCount) * ch;
        const y = pad.top + ch - barH;

        const isPositive = bucket.mid >= 0;
        const barColor = isPositive ? CHART_COLORS.green : CHART_COLORS.red;
        const fadeColor = isPositive ? 'rgba(16,185,129,0.6)' : 'rgba(244,63,94,0.6)';

        const grad = ctx.createLinearGradient(0, y, 0, pad.top + ch);
        grad.addColorStop(0, barColor);
        grad.addColorStop(1, fadeColor);

        ctx.fillStyle = grad;
        ctx.beginPath();
        // Rounded top corners
        const r = Math.min(3, barW / 2);
        ctx.moveTo(x, y + r);
        ctx.arcTo(x, y, x + barW, y, r);
        ctx.arcTo(x + barW, y, x + barW, y + barH, r);
        ctx.lineTo(x + barW, pad.top + ch);
        ctx.lineTo(x, pad.top + ch);
        ctx.closePath();
        ctx.fill();

        // Count label
        if (bucket.count > 0) {
          ctx.fillStyle = CHART_COLORS.white20;
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(bucket.count, x + barW / 2, y - 4);
        }
      });

      // Zero line
      const zeroIdx = buckets.findIndex(b => b.start <= 0 && b.end > 0);
      if (zeroIdx >= 0) {
        const zx = pad.left + gap + zeroIdx * (barW + gap) + barW / 2;
        ctx.strokeStyle = CHART_COLORS.white08;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(zx, pad.top);
        ctx.lineTo(zx, pad.top + ch);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = CHART_COLORS.axisText;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('$0', zx, pad.top + ch + 14);
      }

      // X-axis labels (first, middle, last)
      ctx.fillStyle = CHART_COLORS.axisText;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      if (buckets.length > 0) {
        const firstX = pad.left + gap + barW / 2;
        ctx.fillText(formatDollar(buckets[0].mid), firstX, pad.top + ch + 14);

        const lastX = pad.left + gap + (buckets.length - 1) * (barW + gap) + barW / 2;
        ctx.fillText(formatDollar(buckets[buckets.length - 1].mid), lastX, pad.top + ch + 14);
      }

      // Bell curve overlay if 10+ data points
      if (this.data.length >= 10) {
        const mean = this.data.reduce((a, b) => a + b, 0) / this.data.length;
        const variance = this.data.reduce((a, b) => a + (b - mean) ** 2, 0) / this.data.length;
        const std = Math.sqrt(variance) || 1;

        ctx.beginPath();
        ctx.strokeStyle = CHART_COLORS.purple;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;

        const numPts = 80;
        const xMin = bucketStart;
        const xMax = bucketEnd;
        const xRange = xMax - xMin;

        for (let i = 0; i <= numPts; i++) {
          const xVal = xMin + (i / numPts) * xRange;
          const gaussY = (1 / (std * Math.sqrt(2 * Math.PI))) *
            Math.exp(-0.5 * ((xVal - mean) / std) ** 2);
          // Scale: gaussY peak should map to maxCount
          const peakGauss = 1 / (std * Math.sqrt(2 * Math.PI));
          const scaledY = (gaussY / peakGauss) * maxCount * 0.85;
          const px = pad.left + ((xVal - xMin) / xRange) * cw;
          const py = pad.top + ch - (scaledY / maxCount) * ch;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }
  }

  /* --------------------------------------------------------
     Export to window
     -------------------------------------------------------- */
  window.EquityChart = EquityChart;
  window.DrawdownChart = DrawdownChart;
  window.PnLDistribution = PnLDistribution;
})();
