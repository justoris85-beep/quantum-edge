// server/engine/riskManager.js — Advanced risk management with Kelly Criterion
'use strict';

const config = require('../config');
const log = require('../utils/logger');

class RiskManager {
  constructor() {
    this.dailyPnl = 0;
    this.dailyDate = this._todayStr();
    this.paused = false;
    this.pauseReason = null;
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = config.maxConsecutiveLosses;
    this.lastTradeTime = 0;
    this.tradeHistory = []; // recent closed trades for Kelly calculation
    this.recentSignalIds = new Set(); // dedup window
    this._maxTradeHistory = 200;
  }

  /**
   * Evaluate whether a trade should be approved.
   * @param {object} signal         - Incoming signal payload
   * @param {number} accountBalance - Current account balance
   * @param {object} regimeDetector - RegimeDetector instance
   * @param {number} openPositionCount - Number of currently open positions
   * @returns {{ approved: boolean, reason: string|null, quantity: number, riskAmount: number, kellyFraction: number }}
   */
  evaluate(signal, accountBalance, regimeDetector, openPositionCount) {
    // Reset daily tracking on date change
    this._checkDateRollover();

    // 1. Check if trading is paused
    if (this.paused) {
      log.risk(`Trade REJECTED: Trading paused — ${this.pauseReason}`);
      return this._reject(`Trading paused: ${this.pauseReason}`);
    }

    // 2. Cooldown check
    const now = Date.now();
    const cooldownMs = config.tradeCooldownSeconds * 1000;
    if (now - this.lastTradeTime < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (now - this.lastTradeTime)) / 1000);
      log.risk(`Trade REJECTED: Cooldown active (${remaining}s remaining)`);
      return this._reject(`Cooldown active: ${remaining}s remaining`);
    }

    // 3. Max open positions check
    if (openPositionCount >= config.maxOpenPositions) {
      log.risk(`Trade REJECTED: Max open positions reached (${openPositionCount}/${config.maxOpenPositions})`);
      return this._reject(`Max open positions reached: ${openPositionCount}/${config.maxOpenPositions}`);
    }

    // 4. Duplicate signal check (dedup within 60 seconds)
    const signalKey = `${signal.action}_${signal.ticker}_${signal.price}`;
    if (this.recentSignalIds.has(signalKey)) {
      log.risk('Trade REJECTED: Duplicate signal detected');
      return this._reject('Duplicate signal within dedup window');
    }
    this.recentSignalIds.add(signalKey);
    setTimeout(() => this.recentSignalIds.delete(signalKey), 60000);

    // 5. Daily drawdown check
    const dailyDrawdownLimit = accountBalance * config.maxDailyDrawdown;
    if (this.dailyPnl <= -dailyDrawdownLimit) {
      log.risk(`Trade REJECTED: Daily drawdown limit reached (PnL: $${this.dailyPnl.toFixed(2)}, Limit: -$${dailyDrawdownLimit.toFixed(2)})`);
      this.setPaused(true, 'Daily drawdown limit reached');
      return this._reject(`Daily drawdown limit hit: $${this.dailyPnl.toFixed(2)}`);
    }

    // 6. Consecutive losses check
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      log.risk(`Trade REJECTED: ${this.consecutiveLosses} consecutive losses reached max (${this.maxConsecutiveLosses})`);
      this.setPaused(true, `${this.consecutiveLosses} consecutive losses`);
      return this._reject(`Consecutive loss limit: ${this.consecutiveLosses} losses`);
    }

    // 7. Volatile regime check
    const riskMultiplier = regimeDetector.getRiskMultiplier();
    if (riskMultiplier === 0) {
      log.risk(`Trade REJECTED: Volatile regime — no trading allowed (regime=${regimeDetector.getCurrentRegime()})`);
      return this._reject(`Volatile regime: trading suspended`);
    }

    // 8. Signal quality checks
    const signalScore = signal.signal_score || 0;
    const confidence = signal.confidence || 0;
    if (signalScore < 5.0) {
      log.risk(`Trade REJECTED: Signal score too low (${signalScore} < 5.0)`);
      return this._reject(`Signal score too low: ${signalScore}`);
    }
    if (confidence < 0.4) {
      log.risk(`Trade REJECTED: Confidence too low (${confidence} < 0.4)`);
      return this._reject(`Confidence too low: ${confidence}`);
    }

    // All checks passed — calculate position size
    const sizing = this.calculatePositionSize(signal, accountBalance, regimeDetector);

    log.risk(`Trade APPROVED: qty=${sizing.quantity.toFixed(6)}, risk=$${sizing.riskAmount.toFixed(2)}, kelly=${sizing.kellyFraction.toFixed(4)}, regimeMult=${riskMultiplier}`);

    this.lastTradeTime = now;

    return {
      approved: true,
      reason: null,
      quantity: sizing.quantity,
      riskAmount: sizing.riskAmount,
      kellyFraction: sizing.kellyFraction,
    };
  }

  /**
   * Calculate position size using fractional Kelly Criterion, adjusted by regime and volatility.
   * @param {object} signal
   * @param {number} accountBalance
   * @param {object} regimeDetector
   * @returns {{ quantity: number, riskAmount: number, kellyFraction: number }}
   */
  calculatePositionSize(signal, accountBalance, regimeDetector) {
    const price = signal.price || 1;
    const atr = signal.atr || price * 0.02; // fallback: 2% of price as ATR

    // Compute Kelly percentage from trade history
    let kellyPct = config.maxRiskPerTrade; // default if insufficient history
    if (this.tradeHistory.length >= 10) {
      const wins = this.tradeHistory.filter(t => t.pnl > 0);
      const losses = this.tradeHistory.filter(t => t.pnl < 0);

      if (wins.length > 0 && losses.length > 0) {
        const winRate = wins.length / this.tradeHistory.length;
        const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
        const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
        const avgWinRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

        // Kelly formula: K = (W * R - (1 - W)) / R where W = win rate, R = avg win/loss ratio
        kellyPct = (winRate * avgWinRatio - (1 - winRate)) / avgWinRatio;
        kellyPct = Math.max(0, kellyPct); // Kelly can be negative (don't trade)
      }
    }

    // Apply fractional Kelly
    const fractionalKelly = kellyPct * config.kellyFraction;

    // Apply regime risk multiplier
    const regimeMultiplier = regimeDetector.getRiskMultiplier();
    let adjustedRisk = fractionalKelly * regimeMultiplier;

    // Volatility adjustment: higher ATR = smaller position
    // Normalize ATR as percentage of price
    const atrPct = atr / price;
    // If ATR > 3% of price, scale down proportionally
    if (atrPct > 0.03) {
      const volScaling = 0.03 / atrPct;
      adjustedRisk *= volScaling;
    }

    // Floor at 0.5% of equity, cap at 2% of equity
    const minRisk = 0.005;
    const maxRisk = 0.02;
    adjustedRisk = Math.max(minRisk, Math.min(maxRisk, adjustedRisk));

    const riskAmount = accountBalance * adjustedRisk;
    const quantity = riskAmount / price;

    return {
      quantity: Math.max(0.00001, quantity), // minimum trade size
      riskAmount,
      kellyFraction: fractionalKelly,
    };
  }

  /**
   * Record realized P&L from a closed trade.
   * @param {number} pnl - Profit/loss amount
   */
  recordPnl(pnl) {
    this._checkDateRollover();
    this.dailyPnl += pnl;

    // Track consecutive losses
    if (pnl < 0) {
      this.consecutiveLosses++;
      log.risk(`Consecutive losses: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
    } else if (pnl > 0) {
      if (this.consecutiveLosses > 0) {
        log.risk(`Consecutive loss streak broken after ${this.consecutiveLosses} losses`);
      }
      this.consecutiveLosses = 0;
    }

    // Add to trade history for Kelly calculation
    this.tradeHistory.push({ pnl, timestamp: Date.now() });
    if (this.tradeHistory.length > this._maxTradeHistory) {
      this.tradeHistory = this.tradeHistory.slice(-this._maxTradeHistory);
    }

    // Auto-unpause at next day (handled by date rollover)
  }

  /**
   * Pause or resume trading.
   * @param {boolean} paused
   * @param {string} reason
   */
  setPaused(paused, reason) {
    this.paused = paused;
    this.pauseReason = paused ? reason : null;
    if (paused) {
      log.risk(`Trading PAUSED: ${reason}`);
    } else {
      log.risk('Trading RESUMED');
    }
  }

  /**
   * Full status snapshot.
   * @returns {object}
   */
  getStatus() {
    this._checkDateRollover();
    const now = Date.now();
    const cooldownRemaining = Math.max(0, config.tradeCooldownSeconds * 1000 - (now - this.lastTradeTime));

    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      dailyPnl: parseFloat(this.dailyPnl.toFixed(2)),
      dailyDate: this.dailyDate,
      dailyDrawdownLimit: parseFloat((config.maxDailyDrawdown * 100).toFixed(2)) + '%',
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      cooldownRemaining: Math.ceil(cooldownRemaining / 1000),
      maxOpenPositions: config.maxOpenPositions,
      maxRiskPerTrade: parseFloat((config.maxRiskPerTrade * 100).toFixed(2)) + '%',
      kellyFraction: config.kellyFraction,
      tradeHistorySize: this.tradeHistory.length,
    };
  }

  /** Check if the date has rolled over and reset daily counters. */
  _checkDateRollover() {
    const today = this._todayStr();
    if (today !== this.dailyDate) {
      log.risk(`New trading day: ${today} (previous daily PnL: $${this.dailyPnl.toFixed(2)})`);
      this.dailyPnl = 0;
      this.dailyDate = today;
      // Auto-resume on new day if paused due to drawdown/losses
      if (this.paused && (this.pauseReason || '').includes('drawdown') || (this.pauseReason || '').includes('consecutive')) {
        this.setPaused(false, null);
        this.consecutiveLosses = 0;
      }
    }
  }

  /** @returns {string} YYYY-MM-DD */
  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Helper to create a rejection result */
  _reject(reason) {
    return {
      approved: false,
      reason,
      quantity: 0,
      riskAmount: 0,
      kellyFraction: 0,
    };
  }
}

module.exports = RiskManager;
