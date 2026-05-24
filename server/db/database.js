// server/db/database.js — SQLite database layer with better-sqlite3
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');
const log = require('../utils/logger');

// Ensure data directory exists
const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(config.dbPath, { verbose: null });

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -8000'); // 8 MB

// ─── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT UNIQUE NOT NULL,
    raw_payload TEXT NOT NULL,
    action TEXT NOT NULL,
    ticker TEXT NOT NULL,
    price REAL,
    regime TEXT,
    signal_score REAL,
    confidence REAL,
    factors TEXT,
    atr REAL,
    stop_loss REAL,
    take_profit REAL,
    comment TEXT,
    validated INTEGER DEFAULT 0,
    processed INTEGER DEFAULT 0,
    rejected_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT UNIQUE NOT NULL,
    signal_id TEXT,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL NOT NULL,
    entry_price REAL NOT NULL,
    fill_price REAL,
    exit_price REAL,
    status TEXT DEFAULT 'open',
    pnl REAL DEFAULT 0,
    pnl_percent REAL DEFAULT 0,
    fees REAL DEFAULT 0,
    stop_loss REAL,
    take_profit REAL,
    regime_at_entry TEXT,
    signal_score REAL,
    confidence REAL,
    factors TEXT,
    is_paper INTEGER DEFAULT 1,
    notes TEXT,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    balance REAL NOT NULL,
    unrealized_pnl REAL DEFAULT 0,
    total_equity REAL NOT NULL,
    drawdown_pct REAL DEFAULT 0,
    peak_equity REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS regime_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    regime TEXT NOT NULL,
    adx_value REAL,
    atr_value REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS performance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    total_trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    avg_win REAL DEFAULT 0,
    avg_loss REAL DEFAULT 0,
    profit_factor REAL DEFAULT 0,
    sharpe_ratio REAL DEFAULT 0,
    sortino_ratio REAL DEFAULT 0,
    max_drawdown REAL DEFAULT 0,
    expectancy REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
  CREATE INDEX IF NOT EXISTS idx_signals_action ON signals(action);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
  CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at);
  CREATE INDEX IF NOT EXISTS idx_trades_signal ON trades(signal_id);
  CREATE INDEX IF NOT EXISTS idx_equity_created ON equity_snapshots(created_at);
  CREATE INDEX IF NOT EXISTS idx_regime_created ON regime_history(created_at);
`);

log.system(`Database initialized at ${config.dbPath}`);

// ─── Prepared Statements ────────────────────────────────────────
const stmts = {
  insertSignal: db.prepare(`
    INSERT INTO signals (signal_id, raw_payload, action, ticker, price, regime,
      signal_score, confidence, factors, atr, stop_loss, take_profit, comment, validated, processed, rejected_reason)
    VALUES (@signal_id, @raw_payload, @action, @ticker, @price, @regime,
      @signal_score, @confidence, @factors, @atr, @stop_loss, @take_profit, @comment, @validated, @processed, @rejected_reason)
  `),

  insertTrade: db.prepare(`
    INSERT INTO trades (trade_id, signal_id, ticker, side, quantity, entry_price, fill_price,
      stop_loss, take_profit, regime_at_entry, signal_score, confidence, factors, is_paper, notes)
    VALUES (@trade_id, @signal_id, @ticker, @side, @quantity, @entry_price, @fill_price,
      @stop_loss, @take_profit, @regime_at_entry, @signal_score, @confidence, @factors, @is_paper, @notes)
  `),

  closeTrade: db.prepare(`
    UPDATE trades
    SET status = 'closed', exit_price = @exit_price, pnl = @pnl, pnl_percent = @pnl_percent,
        fees = @fees, notes = COALESCE(notes || ' | ', '') || @notes, closed_at = datetime('now')
    WHERE trade_id = @trade_id AND status = 'open'
  `),

  getOpenTrades: db.prepare(`
    SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC
  `),

  getAllTrades: db.prepare(`
    SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?
  `),

  getTradesByDate: db.prepare(`
    SELECT * FROM trades WHERE date(opened_at) = ? ORDER BY opened_at DESC
  `),

  getTodayStats: db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN pnl = 0 AND status = 'closed' THEN 1 ELSE 0 END) as breakeven,
      COALESCE(SUM(pnl), 0) as total_pnl,
      COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl END), 0) as avg_win,
      COALESCE(AVG(CASE WHEN pnl < 0 THEN pnl END), 0) as avg_loss,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count
    FROM trades
    WHERE date(opened_at) = date('now')
  `),

  insertEquitySnapshot: db.prepare(`
    INSERT INTO equity_snapshots (balance, unrealized_pnl, total_equity, drawdown_pct, peak_equity)
    VALUES (@balance, @unrealized_pnl, @total_equity, @drawdown_pct, @peak_equity)
  `),

  getEquityHistory: db.prepare(`
    SELECT * FROM equity_snapshots ORDER BY created_at DESC LIMIT ?
  `),

  getRecentSignals: db.prepare(`
    SELECT * FROM signals ORDER BY created_at DESC LIMIT ?
  `),

  insertRegimeChange: db.prepare(`
    INSERT INTO regime_history (regime, adx_value, atr_value)
    VALUES (@regime, @adx_value, @atr_value)
  `),

  getRegimeHistory: db.prepare(`
    SELECT * FROM regime_history ORDER BY created_at DESC LIMIT ?
  `),

  insertPerformanceSnapshot: db.prepare(`
    INSERT OR REPLACE INTO performance_snapshots
      (date, total_trades, wins, losses, win_rate, total_pnl, avg_win, avg_loss,
       profit_factor, sharpe_ratio, sortino_ratio, max_drawdown, expectancy)
    VALUES (@date, @total_trades, @wins, @losses, @win_rate, @total_pnl, @avg_win, @avg_loss,
       @profit_factor, @sharpe_ratio, @sortino_ratio, @max_drawdown, @expectancy)
  `),

  getLatestPerformance: db.prepare(`
    SELECT * FROM performance_snapshots ORDER BY date DESC LIMIT 1
  `),

  getAllClosedTrades: db.prepare(`
    SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC
  `),

  getTradeById: db.prepare(`
    SELECT * FROM trades WHERE trade_id = ?
  `),

  getOpenTradesBySide: db.prepare(`
    SELECT * FROM trades WHERE status = 'open' AND side = ? ORDER BY opened_at DESC
  `),

  getSignalById: db.prepare(`
    SELECT * FROM signals WHERE signal_id = ?
  `),

  updateSignalProcessed: db.prepare(`
    UPDATE signals SET processed = 1 WHERE signal_id = ?
  `),

  updateSignalRejected: db.prepare(`
    UPDATE signals SET processed = 1, rejected_reason = ? WHERE signal_id = ?
  `),
};

// ─── Exported API ───────────────────────────────────────────────
module.exports = {
  /** Insert a new signal record */
  insertSignal(params) {
    return stmts.insertSignal.run({
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
    });
  },

  /** Insert a new trade */
  insertTrade(params) {
    return stmts.insertTrade.run({
      trade_id: params.trade_id,
      signal_id: params.signal_id || null,
      ticker: params.ticker || config.tradingPair,
      side: params.side,
      quantity: params.quantity,
      entry_price: params.entry_price,
      fill_price: params.fill_price || params.entry_price,
      stop_loss: params.stop_loss || null,
      take_profit: params.take_profit || null,
      regime_at_entry: params.regime_at_entry || null,
      signal_score: params.signal_score || null,
      confidence: params.confidence || null,
      factors: typeof params.factors === 'string' ? params.factors : JSON.stringify(params.factors || null),
      is_paper: params.is_paper !== undefined ? (params.is_paper ? 1 : 0) : 1,
      notes: params.notes || null,
    });
  },

  /** Close an open trade */
  closeTrade(params) {
    return stmts.closeTrade.run({
      trade_id: params.trade_id,
      exit_price: params.exit_price,
      pnl: params.pnl,
      pnl_percent: params.pnl_percent || 0,
      fees: params.fees || 0,
      notes: params.notes || '',
    });
  },

  /** Get all open trades */
  getOpenTrades() {
    return stmts.getOpenTrades.all();
  },

  /** Get trades with limit */
  getAllTrades(limit = 50) {
    return stmts.getAllTrades.all(limit);
  },

  /** Get trades by date (YYYY-MM-DD) */
  getTradesByDate(dateStr) {
    return stmts.getTradesByDate.all(dateStr);
  },

  /** Get today's aggregated stats */
  getTodayStats() {
    return stmts.getTodayStats.get();
  },

  /** Insert equity snapshot */
  insertEquitySnapshot(params) {
    return stmts.insertEquitySnapshot.run({
      balance: params.balance,
      unrealized_pnl: params.unrealized_pnl || 0,
      total_equity: params.total_equity,
      drawdown_pct: params.drawdown_pct || 0,
      peak_equity: params.peak_equity,
    });
  },

  /** Get equity history (most recent first) */
  getEquityHistory(limit = 200) {
    return stmts.getEquityHistory.all(limit).reverse();
  },

  /** Get recent signals */
  getRecentSignals(limit = 30) {
    return stmts.getRecentSignals.all(limit);
  },

  /** Insert a regime change */
  insertRegimeChange(params) {
    return stmts.insertRegimeChange.run({
      regime: params.regime,
      adx_value: params.adx_value || null,
      atr_value: params.atr_value || null,
    });
  },

  /** Get regime history */
  getRegimeHistory(limit = 50) {
    return stmts.getRegimeHistory.all(limit);
  },

  /** Insert/replace daily performance snapshot */
  insertPerformanceSnapshot(params) {
    return stmts.insertPerformanceSnapshot.run({
      date: params.date,
      total_trades: params.total_trades || 0,
      wins: params.wins || 0,
      losses: params.losses || 0,
      win_rate: params.win_rate || 0,
      total_pnl: params.total_pnl || 0,
      avg_win: params.avg_win || 0,
      avg_loss: params.avg_loss || 0,
      profit_factor: params.profit_factor || 0,
      sharpe_ratio: params.sharpe_ratio || 0,
      sortino_ratio: params.sortino_ratio || 0,
      max_drawdown: params.max_drawdown || 0,
      expectancy: params.expectancy || 0,
    });
  },

  /** Get latest performance snapshot */
  getLatestPerformance() {
    return stmts.getLatestPerformance.get() || null;
  },

  /** Get all closed trades */
  getAllClosedTrades() {
    return stmts.getAllClosedTrades.all();
  },

  /** Get single trade by ID */
  getTradeById(tradeId) {
    return stmts.getTradeById.get(tradeId) || null;
  },

  /** Get open trades by side */
  getOpenTradesBySide(side) {
    return stmts.getOpenTradesBySide.all(side);
  },

  /** Get signal by ID */
  getSignalById(signalId) {
    return stmts.getSignalById.get(signalId) || null;
  },

  /** Mark a signal as processed */
  markSignalProcessed(signalId) {
    return stmts.updateSignalProcessed.run(signalId);
  },

  /** Mark a signal as rejected */
  markSignalRejected(signalId, reason) {
    return stmts.updateSignalRejected.run(reason, signalId);
  },

  /** Get the timestamp of the first recorded trade or equity snapshot */
  getFirstEventTime() {
    try {
      const row = db.prepare(`
        SELECT MIN(created_at) as first_time FROM (
          SELECT MIN(opened_at) as created_at FROM trades
          UNION ALL
          SELECT MIN(created_at) as created_at FROM equity_snapshots
        ) WHERE created_at IS NOT NULL
      `).get();
      return row ? row.first_time : null;
    } catch (e) {
      log.error(`getFirstEventTime error: ${e.message}`);
      return null;
    }
  },

  /** Close the database connection */
  close() {
    log.system('Closing database connection');
    db.close();
  },

  /** Raw db instance for advanced queries */
  raw: db,
};
