// server/routes/api.js — Dashboard REST API
'use strict';

const express = require('express');
const db = require('../db/database');
const log = require('../utils/logger');

const router = express.Router();

/**
 * Helper to get the engine from app.locals.
 */
function getEngine(req, res) {
  const engine = req.app.locals.engine;
  if (!engine || !engine.started) {
    res.status(503).json({ success: false, error: 'Engine not initialized' });
    return null;
  }
  return engine;
}

// ─── GET /api/status ─────────────────────────────────────────────
router.get('/api/status', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    const status = await engine.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    log.error(`API /status error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/trades ─────────────────────────────────────────────
router.get('/api/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const trades = await db.getAllTrades(limit);
    res.json({ success: true, count: trades.length, data: trades });
  } catch (err) {
    log.error(`API /trades error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/trades/open ────────────────────────────────────────
router.get('/api/trades/open', (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    const positions = engine.portfolioManager.getAllPositions();
    res.json({ success: true, count: positions.length, data: positions });
  } catch (err) {
    log.error(`API /trades/open error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/signals ────────────────────────────────────────────
router.get('/api/signals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);
    const signals = await db.getRecentSignals(limit);
    res.json({ success: true, count: signals.length, data: signals });
  } catch (err) {
    log.error(`API /signals error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/equity ─────────────────────────────────────────────
router.get('/api/equity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const equity = await db.getEquityHistory(limit);
    res.json({ success: true, count: equity.length, data: equity });
  } catch (err) {
    log.error(`API /equity error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/performance ────────────────────────────────────────
router.get('/api/performance', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    const metrics = await engine.getPerformance();
    res.json({ success: true, data: metrics });
  } catch (err) {
    log.error(`API /performance error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/readiness ──────────────────────────────────────────
router.get('/api/readiness', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    const readiness = await engine.performanceTracker.getReadinessChecklist(engine.startTime);
    res.json({ success: true, data: readiness });
  } catch (err) {
    log.error(`API /readiness error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/regime ─────────────────────────────────────────────
router.get('/api/regime', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    const regime = engine.regimeDetector.getStatus();
    const history = await db.getRegimeHistory(50);
    res.json({
      success: true,
      data: {
        current: regime,
        history,
      },
    });
  } catch (err) {
    log.error(`API /regime error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/stats/today ────────────────────────────────────────
router.get('/api/stats/today', async (req, res) => {
  try {
    const stats = await db.getTodayStats();
    const engine = getEngine(req, res);
    if (!engine) return;

    res.json({
      success: true,
      data: {
        ...stats,
        balance: parseFloat(engine.paperBalance.toFixed(2)),
        unrealizedPnl: parseFloat(engine.portfolioManager.getTotalUnrealizedPnl().toFixed(2)),
        openPositions: engine.portfolioManager.getPositionCount(),
        regime: engine.regimeDetector.getCurrentRegime(),
      },
    });
  } catch (err) {
    log.error(`API /stats/today error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/pause ─────────────────────────────────────────────
router.post('/api/pause', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    const reason = (req.body && req.body.reason) || 'Manual pause via API';
    engine.riskManager.setPaused(true, reason);
    log.system(`Trading paused via API: ${reason}`);

    // Broadcast updated status to all dashboard clients
    engine.broadcast({
      type: 'init',
      data: await engine.getStatus()
    });

    res.json({ success: true, message: `Trading paused: ${reason}` });
  } catch (err) {
    log.error(`API /pause error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/resume ────────────────────────────────────────────
router.post('/api/resume', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;
    engine.riskManager.setPaused(false, null);
    log.system('Trading resumed via API');

    // Broadcast updated status to all dashboard clients
    engine.broadcast({
      type: 'init',
      data: await engine.getStatus()
    });

    res.json({ success: true, message: 'Trading resumed' });
  } catch (err) {
    log.error(`API /resume error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/close-all ────────────────────────────────────────
router.post('/api/close-all', async (req, res) => {
  try {
    const engine = getEngine(req, res);
    if (!engine) return;

    let priceInput = (req.body && req.body.price) ? parseFloat(req.body.price) : null;
    const fallbackPrice = priceInput || engine.lastPrice;

    const positions = engine.portfolioManager.getAllPositions();
    let closedCount = 0;
    let totalPnl = 0;

    for (const pos of positions) {
      const exitPrice = fallbackPrice || pos.entry_price || pos.fill_price || 0;
      const result = await engine.closePosition(pos.trade_id, exitPrice, 'manual_close_all');
      if (result.success) {
        closedCount++;
        totalPnl += result.pnl;
      }
    }

    log.system(`Manual close-all: ${closedCount} positions closed, PnL: $${totalPnl.toFixed(2)}`);

    res.json({
      success: true,
      closedCount,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      balance: parseFloat(engine.paperBalance.toFixed(2)),
    });
  } catch (err) {
    log.error(`API /close-all error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/performance/daily ──────────────────────────────────
router.get('/api/performance/daily', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 365);
    const resDb = await db.raw.query(`
      SELECT * FROM performance_snapshots ORDER BY date DESC LIMIT $1
    `, [limit]);
    const history = resDb.rows.reverse();
    res.json({ success: true, count: history.length, data: history });
  } catch (err) {
    log.error(`API /performance/daily error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /health ─────────────────────────────────────────────────
router.get('/health', (req, res) => {
  const engine = req.app.locals.engine;
  res.json({
    status: engine && engine.started ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    mode: engine ? (engine.started ? 'running' : 'starting') : 'not_initialized',
  });
});

module.exports = router;
