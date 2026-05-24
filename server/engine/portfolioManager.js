// server/engine/portfolioManager.js — Position and equity tracking
'use strict';

const config = require('../config');
const log = require('../utils/logger');

class PortfolioManager {
  constructor(db) {
    this.db = db;
    this.positions = new Map(); // trade_id -> position object
    this.peakEquity = config.initialBalance;
  }

  /**
   * Add a new position to the portfolio.
   * @param {object} trade - Trade record { trade_id, side, quantity, entry_price, stop_loss, take_profit, ... }
   */
  addPosition(trade) {
    this.positions.set(trade.trade_id, {
      trade_id: trade.trade_id,
      signal_id: trade.signal_id || null,
      ticker: trade.ticker || config.tradingPair,
      side: trade.side,
      quantity: trade.quantity,
      entry_price: trade.entry_price,
      fill_price: trade.fill_price || trade.entry_price,
      stop_loss: trade.stop_loss || null,
      take_profit: trade.take_profit || null,
      regime_at_entry: trade.regime_at_entry || null,
      unrealized_pnl: 0,
      opened_at: trade.opened_at || new Date().toISOString(),
    });

    log.info(`Position added: ${trade.side.toUpperCase()} ${trade.quantity.toFixed(6)} @ $${trade.entry_price.toFixed(2)} [${trade.trade_id}]`);
  }

  /**
   * Remove a position from the portfolio (after closing).
   * @param {string} tradeId
   * @returns {object|null} Removed position or null
   */
  removePosition(tradeId) {
    const pos = this.positions.get(tradeId);
    if (pos) {
      this.positions.delete(tradeId);
      log.info(`Position removed: [${tradeId}]`);
    }
    return pos || null;
  }

  /**
   * Update unrealized P&L for all open positions based on current price.
   * @param {number} currentPrice
   */
  updatePnl(currentPrice) {
    for (const [id, pos] of this.positions) {
      if (pos.side === 'buy' || pos.side === 'long') {
        pos.unrealized_pnl = (currentPrice - pos.entry_price) * pos.quantity;
      } else {
        pos.unrealized_pnl = (pos.entry_price - currentPrice) * pos.quantity;
      }
    }
  }

  /**
   * Check all positions for stop-loss and take-profit hits.
   * @param {number} currentPrice
   * @returns {Array<{ trade_id, reason, exit_price }>} Positions that should be closed
   */
  checkExits(currentPrice) {
    const exits = [];

    for (const [id, pos] of this.positions) {
      const isLong = pos.side === 'buy' || pos.side === 'long';

      // Stop Loss check
      if (pos.stop_loss !== null) {
        if (isLong && currentPrice <= pos.stop_loss) {
          exits.push({
            trade_id: id,
            reason: 'stop_loss',
            exit_price: pos.stop_loss,
          });
          continue;
        }
        if (!isLong && currentPrice >= pos.stop_loss) {
          exits.push({
            trade_id: id,
            reason: 'stop_loss',
            exit_price: pos.stop_loss,
          });
          continue;
        }
      }

      // Take Profit check
      if (pos.take_profit !== null) {
        if (isLong && currentPrice >= pos.take_profit) {
          exits.push({
            trade_id: id,
            reason: 'take_profit',
            exit_price: pos.take_profit,
          });
          continue;
        }
        if (!isLong && currentPrice <= pos.take_profit) {
          exits.push({
            trade_id: id,
            reason: 'take_profit',
            exit_price: pos.take_profit,
          });
          continue;
        }
      }
    }

    return exits;
  }

  /**
   * Get all open positions as an array.
   * @returns {Array}
   */
  getAllPositions() {
    return Array.from(this.positions.values());
  }

  /**
   * Get total unrealized P&L across all positions.
   * @returns {number}
   */
  getTotalUnrealizedPnl() {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.unrealized_pnl || 0;
    }
    return total;
  }

  /**
   * Calculate current drawdown percentage from peak equity.
   * @param {number} equity - Current total equity
   * @returns {number} Drawdown as decimal (e.g., 0.05 = 5%)
   */
  getCurrentDrawdown(equity) {
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }
    if (this.peakEquity === 0) return 0;
    return Math.max(0, (this.peakEquity - equity) / this.peakEquity);
  }

  /**
   * Reload open positions from the database.
   */
  loadFromDb() {
    const openTrades = this.db.getOpenTrades();
    this.positions.clear();

    for (const trade of openTrades) {
      this.positions.set(trade.trade_id, {
        trade_id: trade.trade_id,
        signal_id: trade.signal_id,
        ticker: trade.ticker,
        side: trade.side,
        quantity: trade.quantity,
        entry_price: trade.entry_price,
        fill_price: trade.fill_price || trade.entry_price,
        stop_loss: trade.stop_loss,
        take_profit: trade.take_profit,
        regime_at_entry: trade.regime_at_entry,
        unrealized_pnl: 0,
        opened_at: trade.opened_at,
      });
    }

    if (openTrades.length > 0) {
      log.info(`Loaded ${openTrades.length} open position(s) from database`);
    }

    // Restore peak equity from equity snapshots
    const equityHistory = this.db.getEquityHistory(500);
    if (equityHistory.length > 0) {
      this.peakEquity = Math.max(this.peakEquity, ...equityHistory.map(e => e.peak_equity));
    }
  }

  /**
   * Get open position count.
   * @returns {number}
   */
  getPositionCount() {
    return this.positions.size;
  }

  /**
   * Get position by trade ID.
   * @param {string} tradeId
   * @returns {object|undefined}
   */
  getPosition(tradeId) {
    return this.positions.get(tradeId);
  }

  /**
   * Get positions by side.
   * @param {string} side - 'buy'/'long' or 'sell'/'short'
   * @returns {Array}
   */
  getPositionsBySide(side) {
    const result = [];
    for (const pos of this.positions.values()) {
      if (pos.side === side) result.push(pos);
    }
    return result;
  }

  /**
   * Full portfolio status.
   * @returns {object}
   */
  getStatus() {
    return {
      openPositions: this.positions.size,
      positions: this.getAllPositions(),
      totalUnrealizedPnl: parseFloat(this.getTotalUnrealizedPnl().toFixed(2)),
      peakEquity: parseFloat(this.peakEquity.toFixed(2)),
    };
  }
}

module.exports = PortfolioManager;
