// server/db/database.js — Dual-mode database layer (PostgreSQL / In-Memory Fallback)
'use strict';

const { Pool } = require('pg');
const config = require('../config');
const log = require('../utils/logger');

let pool = null;
let useMemoryFallback = false;

// If DATABASE_URL is not set, print a warning and run in-memory fallback
if (!config.databaseUrl) {
  log.warn('======================================================================');
  log.warn('DATABASE_URL is not defined in config/environment.');
  log.warn('Running in-memory database fallback for local testing & development.');
  log.warn('Please add DATABASE_URL to your .env file for persistent PostgreSQL:');
  log.warn('DATABASE_URL=postgresql://user:password@host:port/dbname?sslmode=require');
  log.warn('======================================================================');
  useMemoryFallback = true;
} else {
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: false // Required for Neon / Supabase free connections
    }
  });

  // Test connection
  pool.connect((err, client, release) => {
    if (err) {
      log.error(`PostgreSQL connection test failed: ${err.message}`);
    } else {
      log.system('PostgreSQL connection established successfully');
      release();
    }
  });
}

// In-Memory Database Store for fallback mode
const memDB = {
  signals: [],
  trades: [],
  equity_snapshots: [],
  regime_history: [],
  performance_snapshots: []
};

// Helper to query raw database directly (needed for daily history endpoint)
const raw = {
  query: async (text, params) => {
    if (useMemoryFallback) {
      // Mock daily performance query for endpoint
      if (text.includes('performance_snapshots')) {
        const limit = params ? params[0] : 30;
        const rows = [...memDB.performance_snapshots]
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, limit)
          .reverse();
        return { rows };
      }
      return { rows: [] };
    }
    return await pool.query(text, params);
  }
};

// ─── Schema ──────────────────────────────────────────────────────
async function initializeSchema() {
  if (useMemoryFallback) {
    log.system('In-memory database schema initialized (fallback mode)');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        signal_id VARCHAR(50) UNIQUE NOT NULL,
        raw_payload TEXT NOT NULL,
        action VARCHAR(20) NOT NULL,
        ticker VARCHAR(20) NOT NULL,
        price DOUBLE PRECISION,
        regime VARCHAR(20),
        signal_score DOUBLE PRECISION,
        confidence DOUBLE PRECISION,
        factors TEXT,
        atr DOUBLE PRECISION,
        stop_loss DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        comment TEXT,
        validated INTEGER DEFAULT 0,
        processed INTEGER DEFAULT 0,
        rejected_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        trade_id VARCHAR(50) UNIQUE NOT NULL,
        signal_id VARCHAR(50),
        ticker VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        fill_price DOUBLE PRECISION,
        exit_price DOUBLE PRECISION,
        status VARCHAR(20) DEFAULT 'open',
        pnl DOUBLE PRECISION DEFAULT 0,
        pnl_percent DOUBLE PRECISION DEFAULT 0,
        fees DOUBLE PRECISION DEFAULT 0,
        stop_loss DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        regime_at_entry VARCHAR(20),
        signal_score DOUBLE PRECISION,
        confidence DOUBLE PRECISION,
        factors TEXT,
        is_paper INTEGER DEFAULT 1,
        notes TEXT,
        opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id SERIAL PRIMARY KEY,
        balance DOUBLE PRECISION NOT NULL,
        unrealized_pnl DOUBLE PRECISION DEFAULT 0,
        total_equity DOUBLE PRECISION NOT NULL,
        drawdown_pct DOUBLE PRECISION DEFAULT 0,
        peak_equity DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS regime_history (
        id SERIAL PRIMARY KEY,
        regime VARCHAR(20) NOT NULL,
        adx_value DOUBLE PRECISION,
        atr_value DOUBLE PRECISION,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id SERIAL PRIMARY KEY,
        date VARCHAR(20) UNIQUE NOT NULL,
        total_trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        win_rate DOUBLE PRECISION DEFAULT 0,
        total_pnl DOUBLE PRECISION DEFAULT 0,
        avg_win DOUBLE PRECISION DEFAULT 0,
        avg_loss DOUBLE PRECISION DEFAULT 0,
        profit_factor DOUBLE PRECISION DEFAULT 0,
        sharpe_ratio DOUBLE PRECISION DEFAULT 0,
        sortino_ratio DOUBLE PRECISION DEFAULT 0,
        max_drawdown DOUBLE PRECISION DEFAULT 0,
        expectancy DOUBLE PRECISION DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
      CREATE INDEX IF NOT EXISTS idx_signals_action ON signals(action);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at);
      CREATE INDEX IF NOT EXISTS idx_trades_signal ON trades(signal_id);
      CREATE INDEX IF NOT EXISTS idx_equity_created ON equity_snapshots(created_at);
      CREATE INDEX IF NOT EXISTS idx_regime_created ON regime_history(created_at);
    `);
    log.system('PostgreSQL database schema initialized');
  } catch (err) {
    log.error(`Schema initialization error: ${err.message}`);
    throw err;
  }
}

// ─── Exported API ───────────────────────────────────────────────
module.exports = {
  initializeSchema,
  raw,

  /** Insert a new signal record */
  async insertSignal(params) {
    if (useMemoryFallback) {
      const signal = {
        id: memDB.signals.length + 1,
        signal_id: params.signal_id,
        raw_payload: typeof params.raw_payload === 'string' ? params.raw_payload : JSON.stringify(params.raw_payload),
        action: params.action,
        ticker: params.ticker || config.tradingPair,
        price: params.price || null,
        regime: params.regime || null,
        signal_score: params.signal_score || null,
        confidence: params.confidence || null,
        factors: typeof params.factors === 'string' ? params.factors : JSON.stringify(params.factors || null),
        atr: params.atr || null,
        stop_loss: params.stop_loss || null,
        take_profit: params.take_profit || null,
        comment: params.comment || null,
        validated: params.validated ? 1 : 0,
        processed: params.processed ? 1 : 0,
        rejected_reason: params.rejected_reason || null,
        created_at: new Date().toISOString()
      };
      memDB.signals.push(signal);
      return { rows: [signal] };
    }

    const sql = `
      INSERT INTO signals (signal_id, raw_payload, action, ticker, price, regime,
        signal_score, confidence, factors, atr, stop_loss, take_profit, comment, validated, processed, rejected_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `;
    const values = [
      params.signal_id,
      typeof params.raw_payload === 'string' ? params.raw_payload : JSON.stringify(params.raw_payload),
      params.action,
      params.ticker || config.tradingPair,
      params.price || null,
      params.regime || null,
      params.signal_score || null,
      params.confidence || null,
      typeof params.factors === 'string' ? params.factors : JSON.stringify(params.factors || null),
      params.atr || null,
      params.stop_loss || null,
      params.take_profit || null,
      params.comment || null,
      params.validated ? 1 : 0,
      params.processed ? 1 : 0,
      params.rejected_reason || null
    ];
    return await pool.query(sql, values);
  },

  /** Insert a new trade */
  async insertTrade(params) {
    if (useMemoryFallback) {
      const trade = {
        id: memDB.trades.length + 1,
        trade_id: params.trade_id,
        signal_id: params.signal_id || null,
        ticker: params.ticker || config.tradingPair,
        side: params.side,
        quantity: params.quantity,
        entry_price: params.entry_price,
        fill_price: params.fill_price || params.entry_price,
        exit_price: null,
        status: 'open',
        pnl: 0,
        pnl_percent: 0,
        fees: 0,
        stop_loss: params.stop_loss || null,
        take_profit: params.take_profit || null,
        regime_at_entry: params.regime_at_entry || null,
        signal_score: params.signal_score || null,
        confidence: params.confidence || null,
        factors: typeof params.factors === 'string' ? params.factors : JSON.stringify(params.factors || null),
        is_paper: params.is_paper !== undefined ? (params.is_paper ? 1 : 0) : 1,
        notes: params.notes || null,
        opened_at: new Date().toISOString(),
        closed_at: null
      };
      memDB.trades.push(trade);
      return { rows: [trade] };
    }

    const sql = `
      INSERT INTO trades (trade_id, signal_id, ticker, side, quantity, entry_price, fill_price,
        stop_loss, take_profit, regime_at_entry, signal_score, confidence, factors, is_paper, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;
    const values = [
      params.trade_id,
      params.signal_id || null,
      params.ticker || config.tradingPair,
      params.side,
      params.quantity,
      params.entry_price,
      params.fill_price || params.entry_price,
      params.stop_loss || null,
      params.take_profit || null,
      params.regime_at_entry || null,
      params.signal_score || null,
      params.confidence || null,
      typeof params.factors === 'string' ? params.factors : JSON.stringify(params.factors || null),
      params.is_paper !== undefined ? (params.is_paper ? 1 : 0) : 1,
      params.notes || null
    ];
    return await pool.query(sql, values);
  },

  /** Close an open trade */
  async closeTrade(params) {
    if (useMemoryFallback) {
      const trade = memDB.trades.find(t => t.trade_id === params.trade_id && t.status === 'open');
      if (trade) {
        trade.status = 'closed';
        trade.exit_price = params.exit_price;
        trade.pnl = params.pnl;
        trade.pnl_percent = params.pnl_percent || 0;
        trade.fees = params.fees || 0;
        trade.notes = (trade.notes ? trade.notes + ' | ' : '') + (params.notes || '');
        trade.closed_at = new Date().toISOString();
      }
      return { rowCount: trade ? 1 : 0 };
    }

    const sql = `
      UPDATE trades
      SET status = 'closed', exit_price = $1, pnl = $2, pnl_percent = $3,
          fees = $4, notes = COALESCE(notes || ' | ', '') || $5, closed_at = CURRENT_TIMESTAMP
      WHERE trade_id = $6 AND status = 'open'
    `;
    const values = [
      params.exit_price,
      params.pnl,
      params.pnl_percent || 0,
      params.fees || 0,
      params.notes || '',
      params.trade_id
    ];
    return await pool.query(sql, values);
  },

  /** Get all open trades */
  async getOpenTrades() {
    if (useMemoryFallback) {
      return memDB.trades.filter(t => t.status === 'open').sort((a, b) => b.id - a.id);
    }

    const res = await pool.query(`
      SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC
    `);
    return res.rows;
  },

  /** Get trades with limit */
  async getAllTrades(limit = 50) {
    if (useMemoryFallback) {
      return [...memDB.trades].sort((a, b) => b.id - a.id).slice(0, limit);
    }

    const res = await pool.query(`
      SELECT * FROM trades ORDER BY opened_at DESC LIMIT $1
    `, [limit]);
    return res.rows;
  },

  /** Get trades by date (YYYY-MM-DD) */
  async getTradesByDate(dateStr) {
    if (useMemoryFallback) {
      return memDB.trades
        .filter(t => t.opened_at && t.opened_at.substring(0, 10) === dateStr)
        .sort((a, b) => b.id - a.id);
    }

    const res = await pool.query(`
      SELECT * FROM trades WHERE opened_at::date = $1 ORDER BY opened_at DESC
    `, [dateStr]);
    return res.rows;
  },

  /** Get today's aggregated stats */
  async getTodayStats() {
    if (useMemoryFallback) {
      const todayStr = new Date().toISOString().substring(0, 10);
      const todayTrades = memDB.trades.filter(t => t.opened_at && t.opened_at.substring(0, 10) === todayStr);
      const wins = todayTrades.filter(t => t.pnl > 0);
      const losses = todayTrades.filter(t => t.pnl < 0);
      const breakeven = todayTrades.filter(t => t.pnl === 0 && t.status === 'closed');
      const totalPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
      const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;
      const openCount = todayTrades.filter(t => t.status === 'open').length;

      return {
        total_trades: todayTrades.length,
        wins: wins.length,
        losses: losses.length,
        breakeven: breakeven.length,
        total_pnl: totalPnl,
        avg_win: avgWin,
        avg_loss: avgLoss,
        open_count: openCount
      };
    }

    const res = await pool.query(`
      SELECT
        COUNT(*)::integer as total_trades,
        COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0)::integer as wins,
        COALESCE(SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END), 0)::integer as losses,
        COALESCE(SUM(CASE WHEN pnl = 0 AND status = 'closed' THEN 1 ELSE 0 END), 0)::integer as breakeven,
        COALESCE(SUM(pnl), 0)::double precision as total_pnl,
        COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl END), 0)::double precision as avg_win,
        COALESCE(AVG(CASE WHEN pnl < 0 THEN pnl END), 0)::double precision as avg_loss,
        COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0)::integer as open_count
      FROM trades
      WHERE opened_at::date = CURRENT_DATE
    `);
    return res.rows[0];
  },

  /** Insert equity snapshot */
  async insertEquitySnapshot(params) {
    if (useMemoryFallback) {
      const snap = {
        id: memDB.equity_snapshots.length + 1,
        balance: params.balance,
        unrealized_pnl: params.unrealized_pnl || 0,
        total_equity: params.total_equity,
        drawdown_pct: params.drawdown_pct || 0,
        peak_equity: params.peak_equity,
        created_at: new Date().toISOString()
      };
      memDB.equity_snapshots.push(snap);
      return { rows: [snap] };
    }

    const sql = `
      INSERT INTO equity_snapshots (balance, unrealized_pnl, total_equity, drawdown_pct, peak_equity)
      VALUES ($1, $2, $3, $4, $5)
    `;
    const values = [
      params.balance,
      params.unrealized_pnl || 0,
      params.total_equity,
      params.drawdown_pct || 0,
      params.peak_equity
    ];
    return await pool.query(sql, values);
  },

  /** Get equity history (most recent first) */
  async getEquityHistory(limit = 200) {
    if (useMemoryFallback) {
      return [...memDB.equity_snapshots].sort((a, b) => b.id - a.id).slice(0, limit).reverse();
    }

    const res = await pool.query(`
      SELECT * FROM equity_snapshots ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    return res.rows.reverse();
  },

  /** Get recent signals */
  async getRecentSignals(limit = 30) {
    if (useMemoryFallback) {
      return [...memDB.signals].sort((a, b) => b.id - a.id).slice(0, limit);
    }

    const res = await pool.query(`
      SELECT * FROM signals ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    return res.rows;
  },

  /** Insert a regime change */
  async insertRegimeChange(params) {
    if (useMemoryFallback) {
      const item = {
        id: memDB.regime_history.length + 1,
        regime: params.regime,
        adx_value: params.adx_value || null,
        atr_value: params.atr_value || null,
        created_at: new Date().toISOString()
      };
      memDB.regime_history.push(item);
      return { rows: [item] };
    }

    const sql = `
      INSERT INTO regime_history (regime, adx_value, atr_value)
      VALUES ($1, $2, $3)
    `;
    const values = [
      params.regime,
      params.adx_value || null,
      params.atr_value || null
    ];
    return await pool.query(sql, values);
  },

  /** Get regime history */
  async getRegimeHistory(limit = 50) {
    if (useMemoryFallback) {
      return [...memDB.regime_history].sort((a, b) => b.id - a.id).slice(0, limit);
    }

    const res = await pool.query(`
      SELECT * FROM regime_history ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    return res.rows;
  },

  /** Insert/replace daily performance snapshot */
  async insertPerformanceSnapshot(params) {
    if (useMemoryFallback) {
      let snap = memDB.performance_snapshots.find(p => p.date === params.date);
      if (!snap) {
        snap = { id: memDB.performance_snapshots.length + 1, date: params.date };
        memDB.performance_snapshots.push(snap);
      }
      snap.total_trades = params.total_trades || 0;
      snap.wins = params.wins || 0;
      snap.losses = params.losses || 0;
      snap.win_rate = params.win_rate || 0;
      snap.total_pnl = params.total_pnl || 0;
      snap.avg_win = params.avg_win || 0;
      snap.avg_loss = params.avg_loss || 0;
      snap.profit_factor = params.profit_factor || 0;
      snap.sharpe_ratio = params.sharpe_ratio || 0;
      snap.sortino_ratio = params.sortino_ratio || 0;
      snap.max_drawdown = params.max_drawdown || 0;
      snap.expectancy = params.expectancy || 0;
      snap.created_at = new Date().toISOString();
      return { rows: [snap] };
    }

    const sql = `
      INSERT INTO performance_snapshots
        (date, total_trades, wins, losses, win_rate, total_pnl, avg_win, avg_loss,
         profit_factor, sharpe_ratio, sortino_ratio, max_drawdown, expectancy)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (date) DO UPDATE SET
        total_trades = EXCLUDED.total_trades,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        win_rate = EXCLUDED.win_rate,
        total_pnl = EXCLUDED.total_pnl,
        avg_win = EXCLUDED.avg_win,
        avg_loss = EXCLUDED.avg_loss,
        profit_factor = EXCLUDED.profit_factor,
        sharpe_ratio = EXCLUDED.sharpe_ratio,
        sortino_ratio = EXCLUDED.sortino_ratio,
        max_drawdown = EXCLUDED.max_drawdown,
        expectancy = EXCLUDED.expectancy
    `;
    const values = [
      params.date,
      params.total_trades || 0,
      params.wins || 0,
      params.losses || 0,
      params.win_rate || 0,
      params.total_pnl || 0,
      params.avg_win || 0,
      params.avg_loss || 0,
      params.profit_factor || 0,
      params.sharpe_ratio || 0,
      params.sortino_ratio || 0,
      params.max_drawdown || 0,
      params.expectancy || 0
    ];
    return await pool.query(sql, values);
  },

  /** Get latest performance snapshot */
  async getLatestPerformance() {
    if (useMemoryFallback) {
      if (memDB.performance_snapshots.length === 0) return null;
      return [...memDB.performance_snapshots].sort((a, b) => b.date.localeCompare(a.date))[0];
    }

    const res = await pool.query(`
      SELECT * FROM performance_snapshots ORDER BY date DESC LIMIT 1
    `);
    return res.rows[0] || null;
  },

  /** Get all closed trades */
  async getAllClosedTrades() {
    if (useMemoryFallback) {
      return memDB.trades.filter(t => t.status === 'closed').sort((a, b) => b.id - a.id);
    }

    const res = await pool.query(`
      SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC
    `);
    return res.rows;
  },

  /** Get single trade by ID */
  async getTradeById(tradeId) {
    if (useMemoryFallback) {
      return memDB.trades.find(t => t.trade_id === tradeId) || null;
    }

    const res = await pool.query(`
      SELECT * FROM trades WHERE trade_id = $1
    `, [tradeId]);
    return res.rows[0] || null;
  },

  /** Get open trades by side */
  async getOpenTradesBySide(side) {
    if (useMemoryFallback) {
      return memDB.trades
        .filter(t => t.status === 'open' && t.side === side)
        .sort((a, b) => b.id - a.id);
    }

    const res = await pool.query(`
      SELECT * FROM trades WHERE status = 'open' AND side = $1 ORDER BY opened_at DESC
    `, [side]);
    return res.rows;
  },

  /** Get signal by ID */
  async getSignalById(signalId) {
    if (useMemoryFallback) {
      return memDB.signals.find(s => s.signal_id === signalId) || null;
    }

    const res = await pool.query(`
      SELECT * FROM signals WHERE signal_id = $1
    `, [signalId]);
    return res.rows[0] || null;
  },

  /** Mark a signal as processed */
  async markSignalProcessed(signalId) {
    if (useMemoryFallback) {
      const signal = memDB.signals.find(s => s.signal_id === signalId);
      if (signal) signal.processed = 1;
      return { rowCount: signal ? 1 : 0 };
    }

    return await pool.query(`
      UPDATE signals SET processed = 1 WHERE signal_id = $1
    `, [signalId]);
  },

  /** Mark a signal as rejected */
  async markSignalRejected(signalId, reason) {
    if (useMemoryFallback) {
      const signal = memDB.signals.find(s => s.signal_id === signalId);
      if (signal) {
        signal.processed = 1;
        signal.rejected_reason = reason;
      }
      return { rowCount: signal ? 1 : 0 };
    }

    return await pool.query(`
      UPDATE signals SET processed = 1, rejected_reason = $1 WHERE signal_id = $2
    `, [reason, signalId]);
  },

  /** Get the timestamp of the first recorded trade or equity snapshot */
  async getFirstEventTime() {
    if (useMemoryFallback) {
      const times = [
        ...memDB.trades.map(t => t.opened_at),
        ...memDB.equity_snapshots.map(e => e.created_at)
      ].filter(Boolean);
      if (times.length === 0) return null;
      times.sort();
      return times[0].replace('T', ' ').substring(0, 19);
    }

    try {
      const res = await pool.query(`
        SELECT MIN(created_at) as first_time FROM (
          SELECT MIN(opened_at) as created_at FROM trades
          UNION ALL
          SELECT MIN(created_at) as created_at FROM equity_snapshots
        ) AS combined WHERE created_at IS NOT NULL
      `);
      const firstTime = res.rows[0]?.first_time;
      if (firstTime instanceof Date) {
        return firstTime.toISOString().replace('T', ' ').substring(0, 19);
      }
      return firstTime || null;
    } catch (e) {
      log.error(`getFirstEventTime error: ${e.message}`);
      return null;
    }
  },

  /** Close the pool connection */
  async close() {
    if (useMemoryFallback) return;
    log.system('Closing PostgreSQL connection pool');
    await pool.end();
  },
};
