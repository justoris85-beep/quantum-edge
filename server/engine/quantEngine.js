// server/engine/quantEngine.js — Main trading engine orchestrator
'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const log = require('../utils/logger');
const db = require('../db/database');
const RegimeDetector = require('./regimeDetector');
const RiskManager = require('./riskManager');
const PerformanceTracker = require('./performanceTracker');
const PortfolioManager = require('./portfolioManager');

class QuantEngine {
  constructor() {
    this.wsClients = new Set();
    this.paperBalance = config.initialBalance;
    this.started = false;

    // Sub-modules
    this.regimeDetector = new RegimeDetector();
    this.riskManager = new RiskManager();
    this.performanceTracker = new PerformanceTracker(db);
    this.portfolioManager = new PortfolioManager(db);

    this.totalSignalsReceived = 0;
    this.totalTradesExecuted = 0;
    this.startTime = null;
    this.lastPrice = null;
  }

  /**
   * Initialize all sub-modules and restore state from database.
   */
  async initialize() {
    log.system('Initializing Quantum Edge Engine...');

    // Initialize Schema
    await db.initializeSchema();

    // Load open positions from DB
    await this.portfolioManager.loadFromDb();

    // Restore balance from latest equity snapshot
    const equityHistory = await db.getEquityHistory(1);
    if (equityHistory.length > 0) {
      const latest = equityHistory[equityHistory.length - 1];
      this.paperBalance = latest.balance;
      log.info(`Restored balance: $${this.paperBalance.toFixed(2)} from last equity snapshot`);
    } else {
      // Seed initial equity snapshot so charts have at least 2 points on startup
      await db.insertEquitySnapshot({
        balance: config.initialBalance,
        unrealized_pnl: 0,
        total_equity: config.initialBalance,
        drawdown_pct: 0,
        peak_equity: config.initialBalance,
      });
      log.info(`Seeded initial equity snapshot: $${config.initialBalance}`);
    }

    // Restore regime from latest history
    const regimeHistory = await db.getRegimeHistory(1);
    if (regimeHistory.length > 0) {
      const latest = regimeHistory[0];
      this.regimeDetector.update(latest.regime, latest.adx_value, latest.atr_value);
      log.info(`Restored regime: ${latest.regime}`);
    }

    // Load trade history for risk manager Kelly calculation
    const closedTrades = await db.getAllClosedTrades();
    for (const trade of closedTrades.slice(-200)) {
      this.riskManager.tradeHistory.push({
        pnl: trade.pnl,
        timestamp: new Date(trade.closed_at || trade.opened_at).getTime(),
      });
    }

    this.started = true;
    this.startTime = Date.now();

    log.system('Quantum Edge Engine initialized successfully');
    log.table({
      'Mode': config.paperTrade ? 'PAPER TRADING' : 'LIVE TRADING',
      'Pair': config.tradingPair,
      'Balance': `$${this.paperBalance.toFixed(2)}`,
      'Max Risk/Trade': `${(config.maxRiskPerTrade * 100).toFixed(1)}%`,
      'Max Positions': config.maxOpenPositions,
      'Kelly Fraction': config.kellyFraction,
      'Open Positions': this.portfolioManager.getPositionCount(),
    });
  }

  /**
   * Process an incoming TradingView webhook signal.
   * @param {object} payload - Parsed webhook payload
   * @returns {object} Processing result
   */
  async processSignal(payload) {
    this.totalSignalsReceived++;
    const signalId = uuidv4();
    if (payload && payload.price) {
      this.lastPrice = payload.price;
    }

    log.signal(`Signal received: ${payload.action} | price=$${payload.price} | score=${payload.signal_score || '?'} | regime=${payload.regime || '?'}`);

    // Broadcast signal to dashboard
    this.broadcast({
      type: 'signal',
      data: {
        direction: payload.action,
        side: payload.action,
        score: payload.signal_score,
        factors: payload.factors,
      },
    });

    // 1. Log signal to DB
    await db.insertSignal({
      signal_id: signalId,
      raw_payload: payload,
      action: payload.action,
      ticker: payload.ticker || config.tradingPair,
      price: payload.price,
      regime: payload.regime,
      signal_score: payload.signal_score,
      confidence: payload.confidence,
      factors: payload.factors,
      atr: payload.atr,
      stop_loss: payload.stop_loss,
      take_profit: payload.take_profit,
      comment: payload.comment,
      validated: false,
      processed: false,
    });

    // 2. Validate minimum signal fields
    if (!payload.action || !payload.price) {
      const reason = 'Missing required fields: action or price';
      await db.markSignalRejected(signalId, reason);
      log.warn(`Signal rejected: ${reason}`);
      return { success: false, signalId, reason };
    }

    // 3. Update regime detector
    if (payload.regime) {
      const regimeUpdate = this.regimeDetector.update(
        payload.regime,
        payload.adx,
        payload.atr
      );
      if (regimeUpdate.changed) {
        await db.insertRegimeChange({
          regime: payload.regime,
          adx_value: payload.adx,
          atr_value: payload.atr,
        });

        // Broadcast regime change
        this.broadcast({
          type: 'regime',
          data: payload.regime,
        });
      }
    }

    // 4. Update unrealized P&L with current price
    this.portfolioManager.updatePnl(payload.price);

    // 5. Check SL/TP exits for existing positions
    const exits = this.portfolioManager.checkExits(payload.price);
    for (const exit of exits) {
      await this.closePosition(exit.trade_id, exit.exit_price, exit.reason);
    }

    // 6. Route by action
    const action = payload.action.toLowerCase().trim();
    let result;

    if (action === 'buy' || action === 'long') {
      result = await this.handleEntry('buy', payload, signalId);
    } else if (action === 'sell' || action === 'short') {
      result = await this.handleEntry('sell', payload, signalId);
    } else if (action === 'close_long' || action === 'close_short' || action === 'close_all') {
      result = await this.handleClose(action, payload, signalId);
    } else {
      const reason = `Unknown action: ${action}`;
      await db.markSignalRejected(signalId, reason);
      log.warn(`Signal rejected: ${reason}`);
      result = { success: false, signalId, reason };
    }

    // 7. Broadcast update to dashboard
    this.broadcast({
      type: 'signal_processed',
      data: {
        signalId,
        action: payload.action,
        price: payload.price,
        result,
        positions: this.portfolioManager.getPositionCount(),
        balance: parseFloat(this.paperBalance.toFixed(2)),
      },
    });

    return result;
  }

  /**
   * Handle a new entry (buy/sell).
   * @param {string} side - 'buy' or 'sell'
   * @param {object} payload - Signal payload
   * @param {string} signalId - Signal UUID
   * @returns {object}
   */
  async handleEntry(side, payload, signalId) {
    // Run risk manager evaluation
    const evaluation = this.riskManager.evaluate(
      payload,
      this.paperBalance,
      this.regimeDetector,
      this.portfolioManager.getPositionCount()
    );

    if (!evaluation.approved) {
      await db.markSignalRejected(signalId, evaluation.reason);
      return { success: false, signalId, reason: evaluation.reason };
    }

    // Create trade
    const tradeId = uuidv4();
    const trade = {
      trade_id: tradeId,
      signal_id: signalId,
      ticker: payload.ticker || config.tradingPair,
      side,
      quantity: evaluation.quantity,
      entry_price: payload.price,
      fill_price: payload.price, // paper fill at signal price
      stop_loss: payload.stop_loss || null,
      take_profit: payload.take_profit || null,
      regime_at_entry: this.regimeDetector.getCurrentRegime(),
      signal_score: payload.signal_score,
      confidence: payload.confidence,
      factors: payload.factors,
      is_paper: config.paperTrade,
      notes: `Kelly=${evaluation.kellyFraction.toFixed(4)}, Risk=$${evaluation.riskAmount.toFixed(2)}`,
      opened_at: new Date().toISOString(),
    };

    // Save to DB
    await db.insertTrade(trade);
    await db.markSignalProcessed(signalId);

    // Add to portfolio
    this.portfolioManager.addPosition(trade);
    this.totalTradesExecuted++;

    log.trade(side, `ENTRY: ${side.toUpperCase()} ${evaluation.quantity.toFixed(6)} ${config.tradingPair} @ $${payload.price.toFixed(2)} | SL=$${payload.stop_loss || 'none'} TP=$${payload.take_profit || 'none'} | [${tradeId.slice(0, 8)}]`);

    // Broadcast trade open to dashboard
    this.broadcast({
      type: 'trade_open',
      data: {
        trade_id: tradeId,
        tradeId: tradeId,
        signal_id: signalId,
        ticker: trade.ticker,
        pair: trade.ticker,
        side: trade.side,
        qty: trade.quantity,
        quantity: trade.quantity,
        entry: trade.entry_price,
        entry_price: trade.entry_price,
        sl: trade.stop_loss,
        stop_loss: trade.stop_loss,
        tp: trade.take_profit,
        take_profit: trade.take_profit,
        regime: trade.regime_at_entry,
        score: trade.signal_score,
        unrealized_pnl: 0,
        opened_at: trade.opened_at,
      },
    });

    return {
      success: true,
      signalId,
      tradeId,
      side,
      quantity: evaluation.quantity,
      entryPrice: payload.price,
      riskAmount: evaluation.riskAmount,
    };
  }

  /**
   * Close a specific position.
   * @param {string} tradeId
   * @param {number} exitPrice
   * @param {string} reason - 'stop_loss', 'take_profit', 'manual', 'signal'
   * @returns {object}
   */
  async closePosition(tradeId, exitPrice, reason) {
    const position = this.portfolioManager.getPosition(tradeId);
    if (!position) {
      log.warn(`Cannot close position: ${tradeId} not found`);
      return { success: false, reason: 'Position not found' };
    }

    // Calculate P&L
    const isLong = position.side === 'buy' || position.side === 'long';
    const pnl = isLong
      ? (exitPrice - position.entry_price) * position.quantity
      : (position.entry_price - exitPrice) * position.quantity;

    const notional = position.entry_price * position.quantity;
    const pnlPercent = notional > 0 ? (pnl / notional) * 100 : 0;

    // Simulated fees (0.1% round trip)
    const fees = notional * 0.001;
    const netPnl = pnl - fees;

    // Update paper balance
    this.paperBalance += netPnl;

    // Record in risk manager
    this.riskManager.recordPnl(netPnl);

    // Update peak equity
    this.portfolioManager.getCurrentDrawdown(this.paperBalance);

    // Close in DB
    await db.closeTrade({
      trade_id: tradeId,
      exit_price: exitPrice,
      pnl: parseFloat(netPnl.toFixed(2)),
      pnl_percent: parseFloat(pnlPercent.toFixed(4)),
      fees: parseFloat(fees.toFixed(2)),
      notes: `Closed: ${reason}`,
    });

    // Remove from portfolio
    this.portfolioManager.removePosition(tradeId);

    const pnlStr = netPnl >= 0 ? `+$${netPnl.toFixed(2)}` : `-$${Math.abs(netPnl).toFixed(2)}`;
    const pnlPctStr = pnlPercent >= 0 ? `+${pnlPercent.toFixed(2)}%` : `${pnlPercent.toFixed(2)}%`;

    log.trade(
      netPnl >= 0 ? 'buy' : 'sell',
      `EXIT (${reason}): ${position.side.toUpperCase()} ${position.quantity.toFixed(6)} @ $${exitPrice.toFixed(2)} | PnL: ${pnlStr} (${pnlPctStr}) | Balance: $${this.paperBalance.toFixed(2)} [${tradeId.slice(0, 8)}]`
    );

    // Broadcast trade close
    this.broadcast({
      type: 'trade_close',
      data: {
        trade_id: tradeId,
        tradeId,
        signal_id: position.signal_id,
        ticker: position.ticker,
        pair: position.ticker,
        side: position.side,
        qty: position.quantity,
        quantity: position.quantity,
        entry: position.entry_price,
        entry_price: position.entry_price,
        exit: exitPrice,
        exit_price: exitPrice,
        exitPrice,
        pnl: parseFloat(netPnl.toFixed(2)),
        realized_pnl: parseFloat(netPnl.toFixed(2)),
        pnl_percent: parseFloat(pnlPercent.toFixed(4)),
        pnlPercent: parseFloat(pnlPercent.toFixed(4)),
        pnl_pct: parseFloat(pnlPercent.toFixed(4)),
        fees: parseFloat(fees.toFixed(2)),
        score: position.signal_score || 0,
        regime: position.regime_at_entry || '',
        opened_at: position.opened_at,
        closed_at: new Date().toISOString(),
        time: new Date().toISOString(),
        balance: parseFloat(this.paperBalance.toFixed(2)),
      },
    });

    // Broadcast updated readiness checklist
    try {
      const readinessData = await this.performanceTracker.getReadinessChecklist(this.startTime);
      this.broadcast({
        type: 'readiness',
        data: readinessData,
      });
    } catch (err) {
      log.error(`Failed to broadcast readiness on trade close: ${err.message}`);
    }

    return {
      success: true,
      tradeId,
      pnl: parseFloat(netPnl.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(4)),
      reason,
    };
  }

  /**
   * Handle close signals (close_long, close_short, close_all).
   * @param {string} action
   * @param {object} payload
   * @param {string} signalId
   * @returns {object}
   */
  async handleClose(action, payload, signalId) {
    const exitPrice = payload.price;
    let closedCount = 0;
    let totalPnl = 0;

    if (action === 'close_all') {
      const positions = this.portfolioManager.getAllPositions();
      for (const pos of positions) {
        const result = await this.closePosition(pos.trade_id, exitPrice, 'signal_close_all');
        if (result.success) {
          closedCount++;
          totalPnl += result.pnl;
        }
      }
    } else if (action === 'close_long') {
      const longPositions = this.portfolioManager.getPositionsBySide('buy');
      for (const pos of longPositions) {
        const result = await this.closePosition(pos.trade_id, exitPrice, 'signal_close_long');
        if (result.success) {
          closedCount++;
          totalPnl += result.pnl;
        }
      }
    } else if (action === 'close_short') {
      const shortPositions = this.portfolioManager.getPositionsBySide('sell');
      for (const pos of shortPositions) {
        const result = await this.closePosition(pos.trade_id, exitPrice, 'signal_close_short');
        if (result.success) {
          closedCount++;
          totalPnl += result.pnl;
        }
      }
    }

    await db.markSignalProcessed(signalId);

    log.signal(`Close signal processed: ${action} | Closed ${closedCount} position(s) | Total PnL: $${totalPnl.toFixed(2)}`);

    return {
      success: true,
      signalId,
      action,
      closedCount,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
    };
  }

  /**
   * Get full engine status.
   * @returns {object}
   */
  async getStatus() {
    const todayStats = await db.getTodayStats();
    const totalEquity = this.paperBalance + this.portfolioManager.getTotalUnrealizedPnl();
    const drawdown = this.portfolioManager.getCurrentDrawdown(totalEquity);
    const readiness = await this.performanceTracker.getReadinessChecklist(this.startTime);

    return {
      engine: {
        started: this.started,
        uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
        mode: config.paperTrade ? 'paper' : 'live',
        pair: config.tradingPair,
      },
      account: {
        balance: parseFloat(this.paperBalance.toFixed(2)),
        unrealizedPnl: parseFloat(this.portfolioManager.getTotalUnrealizedPnl().toFixed(2)),
        totalEquity: parseFloat(totalEquity.toFixed(2)),
        peakEquity: parseFloat(this.portfolioManager.peakEquity.toFixed(2)),
        drawdown: parseFloat((drawdown * 100).toFixed(2)),
      },
      positions: this.portfolioManager.getStatus(),
      regime: this.regimeDetector.getStatus(),
      risk: this.riskManager.getStatus(),
      today: todayStats || {},
      stats: {
        totalSignals: this.totalSignalsReceived,
        totalTrades: this.totalTradesExecuted,
        wsClients: this.wsClients.size,
      },
      readiness,
      performance: await this.getPerformance(),
    };
  }

  /**
   * Get full quantitative performance metrics.
   * @returns {object}
   */
  async getPerformance() {
    return await this.performanceTracker.getMetrics();
  }

  /**
   * Take an equity snapshot (called on interval).
   */
  async takeEquitySnapshot() {
    const unrealizedPnl = this.portfolioManager.getTotalUnrealizedPnl();
    const totalEquity = this.paperBalance + unrealizedPnl;
    const drawdown = this.portfolioManager.getCurrentDrawdown(totalEquity);

    await db.insertEquitySnapshot({
      balance: parseFloat(this.paperBalance.toFixed(2)),
      unrealized_pnl: parseFloat(unrealizedPnl.toFixed(2)),
      total_equity: parseFloat(totalEquity.toFixed(2)),
      drawdown_pct: parseFloat(drawdown.toFixed(6)),
      peak_equity: parseFloat(this.portfolioManager.peakEquity.toFixed(2)),
    });

    log.debug(`Equity snapshot: balance=$${this.paperBalance.toFixed(2)}, equity=$${totalEquity.toFixed(2)}, DD=${(drawdown * 100).toFixed(2)}%`);

    // Broadcast equity snapshot to dashboard
    this.broadcast({
      type: 'equity',
      data: {
        total: parseFloat(totalEquity.toFixed(2)),
        value: parseFloat(totalEquity.toFixed(2)),
        balance: parseFloat(this.paperBalance.toFixed(2)),
        unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
        drawdown: parseFloat((drawdown * 100).toFixed(4)),
      },
    });
  }

  /**
   * Take a performance snapshot (called on interval).
   */
  async takePerformanceSnapshot() {
    const metrics = await this.performanceTracker.computeAll();
    const today = new Date().toISOString().slice(0, 10);

    await db.insertPerformanceSnapshot({
      date: today,
      total_trades: metrics.totalTrades,
      wins: metrics.wins,
      losses: metrics.losses,
      win_rate: metrics.winRate,
      total_pnl: metrics.totalPnl,
      avg_win: metrics.avgWin,
      avg_loss: metrics.avgLoss,
      profit_factor: metrics.profitFactor,
      sharpe_ratio: metrics.sharpeRatio,
      sortino_ratio: metrics.sortinoRatio,
      max_drawdown: metrics.maxDrawdown,
      expectancy: metrics.expectancy,
    });

    log.debug(`Performance snapshot saved: ${metrics.totalTrades} trades, PF=${metrics.profitFactor.toFixed(2)}, Sharpe=${metrics.sharpeRatio.toFixed(2)}`);

    // Broadcast performance metrics to dashboard
    this.broadcast({
      type: 'performance',
      data: metrics,
    });
  }

  /**
   * Broadcast a message to all connected WebSocket clients.
   * @param {object} message
   */
  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.wsClients) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(payload);
        }
      } catch (err) {
        log.error(`WS broadcast error: ${err.message}`);
      }
    }
  }

  /**
   * Register a new WebSocket client.
   * @param {WebSocket} ws
   */
  registerWsClient(ws) {
    this.wsClients.add(ws);
    log.info(`WebSocket client connected (total: ${this.wsClients.size})`);
  }

  /**
   * Remove a disconnected WebSocket client.
   * @param {WebSocket} ws
   */
  removeWsClient(ws) {
    this.wsClients.delete(ws);
    log.info(`WebSocket client disconnected (total: ${this.wsClients.size})`);
  }

  /**
   * Close all positions and shut down the engine.
   */
  async shutdown() {
    log.system('Shutting down Quantum Edge Engine...');

    // Take final snapshots
    await this.takeEquitySnapshot();
    await this.takePerformanceSnapshot();

    // Close all WS clients
    for (const ws of this.wsClients) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch (_) { /* ignore */ }
    }
    this.wsClients.clear();

    // Close database
    await db.close();

    this.started = false;
    log.system('Quantum Edge Engine shut down complete');
  }
}

module.exports = QuantEngine;
