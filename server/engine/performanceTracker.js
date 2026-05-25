// server/engine/performanceTracker.js — Quantitative performance analytics
'use strict';

const log = require('../utils/logger');

class PerformanceTracker {
  constructor(db) {
    this.db = db;
  }

  /**
   * Compute all performance metrics from closed trades.
   * @returns {object} Full metrics snapshot
   */
  async computeAll() {
    const trades = await this.db.getAllClosedTrades();
    const equityHistory = await this.db.getEquityHistory(500);

    if (trades.length === 0) {
      return this._emptyMetrics();
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const breakeven = trades.filter(t => t.pnl === 0);

    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    const profitFactor = this.computeProfitFactor(trades);
    const expectancy = this.computeExpectancy(trades);
    const sharpe = this.computeSharpeRatio(trades);
    const sortino = this.computeSortinoRatio(trades);
    const maxDrawdown = this.computeMaxDrawdown(equityHistory);
    const winLossRatio = this.computeWinLossRatio(trades);

    // Calmar needs peak equity
    const peakEquity = equityHistory.length > 0
      ? Math.max(...equityHistory.map(e => e.total_equity))
      : 0;
    const calmar = this.computeCalmarRatio(trades, peakEquity, equityHistory);

    // Calculate streaks (chrono order)
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    const chronoTrades = [...trades].reverse();
    for (const t of chronoTrades) {
      if (t.pnl > 0) {
        currentWinStreak++;
        currentLossStreak = 0;
        if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
      } else if (t.pnl < 0) {
        currentLossStreak++;
        currentWinStreak = 0;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      } else {
        currentWinStreak = 0;
        currentLossStreak = 0;
      }
    }
    const totalFees = trades.reduce((s, t) => s + (t.fees || 0), 0);

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: breakeven.length,
      winRate: parseFloat((winRate * 100).toFixed(2)),
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      largestWin: wins.length > 0 ? parseFloat(Math.max(...wins.map(t => t.pnl)).toFixed(2)) : 0,
      largestLoss: losses.length > 0 ? parseFloat(Math.min(...losses.map(t => t.pnl)).toFixed(2)) : 0,
      profitFactor: parseFloat(profitFactor.toFixed(4)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      sharpeRatio: parseFloat(sharpe.toFixed(4)),
      sortinoRatio: parseFloat(sortino.toFixed(4)),
      calmarRatio: parseFloat(calmar.toFixed(4)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
      winLossRatio: parseFloat(winLossRatio.toFixed(4)),
      avgHoldTime: this._computeAvgHoldTime(trades),
      maxWinStreak,
      maxLossStreak,
      totalFees: parseFloat(totalFees.toFixed(2)),
    };
  }

  /**
   * Sharpe Ratio = (mean_return - risk_free) / std_dev_returns
   * Uses per-trade returns as the series.
   * @param {Array} trades  - Array of closed trade objects
   * @param {number} riskFreeRate - Annualized risk-free rate (default 0)
   * @returns {number}
   */
  computeSharpeRatio(trades, riskFreeRate = 0) {
    if (trades.length < 2) return 0;

    const returns = trades.map(t => {
      if (t.pnl_percent !== undefined && t.pnl_percent !== null) {
        return parseFloat(t.pnl_percent);
      }
      const notional = t.entry_price * t.quantity;
      return notional > 0 ? (t.pnl / notional) * 100 : 0;
    });
    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

    const variance = returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualize: assume ~288 five-minute bars per day, 252 trading days
    // But since we're using per-trade returns, we'll annualize by sqrt(trades per year estimate)
    // Simpler: just return the ratio without annualization for per-trade Sharpe
    const periodsPerYear = Math.min(trades.length * 12, 252 * 288); // rough estimate
    const adjustedRiskFree = riskFreeRate / periodsPerYear;

    return (meanReturn - adjustedRiskFree) / stdDev;
  }

  /**
   * Sortino Ratio — like Sharpe but only downside deviation in denominator.
   * @param {Array} trades
   * @param {number} riskFreeRate
   * @returns {number}
   */
  computeSortinoRatio(trades, riskFreeRate = 0) {
    if (trades.length < 2) return 0;

    const returns = trades.map(t => {
      if (t.pnl_percent !== undefined && t.pnl_percent !== null) {
        return parseFloat(t.pnl_percent);
      }
      const notional = t.entry_price * t.quantity;
      return notional > 0 ? (t.pnl / notional) * 100 : 0;
    });
    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

    // Downside deviation: only negative returns
    const downsideReturns = returns.filter(r => r < 0);
    if (downsideReturns.length === 0) return meanReturn > 0 ? 999 : 0; // no downside = infinite Sortino if positive

    const downsideVariance = downsideReturns.reduce((s, r) => s + Math.pow(r, 2), 0) / downsideReturns.length;
    const downsideDev = Math.sqrt(downsideVariance);

    if (downsideDev === 0) return 0;

    const periodsPerYear = Math.min(trades.length * 12, 252 * 288);
    const adjustedRiskFree = riskFreeRate / periodsPerYear;

    return (meanReturn - adjustedRiskFree) / downsideDev;
  }

  /**
   * Calmar Ratio = Annualized Return / Max Drawdown
   * @param {Array} trades
   * @param {number} peakEquity
   * @returns {number}
   */
  computeCalmarRatio(trades, peakEquity, equityHistory) {
    if (trades.length === 0 || peakEquity === 0) return 0;

    const maxDD = this.computeMaxDrawdown(equityHistory);
    if (maxDD === 0) return 0;

    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalReturn = totalPnl / peakEquity;

    // Estimate annualized return
    // Determine time span from first to last trade
    if (trades.length < 2) return totalReturn / maxDD;

    const firstTime = new Date(trades[trades.length - 1].opened_at).getTime();
    const lastTime = new Date(trades[0].closed_at || trades[0].opened_at).getTime();
    const daySpan = Math.max((lastTime - firstTime) / (1000 * 60 * 60 * 24), 1);
    const annualizedReturn = totalReturn * (365 / daySpan);

    return annualizedReturn / maxDD;
  }

  /**
   * Profit Factor = Sum of Wins / |Sum of Losses|
   * @param {Array} trades
   * @returns {number}
   */
  computeProfitFactor(trades) {
    const grossProfit = trades
      .filter(t => t.pnl > 0)
      .reduce((s, t) => s + t.pnl, 0);

    const grossLoss = Math.abs(
      trades
        .filter(t => t.pnl < 0)
        .reduce((s, t) => s + t.pnl, 0)
    );

    if (grossLoss === 0) return grossProfit > 0 ? 999 : 0;
    return grossProfit / grossLoss;
  }

  /**
   * Expectancy = (winRate * avgWin) - (lossRate * avgLoss)
   * @param {Array} trades
   * @returns {number}
   */
  computeExpectancy(trades) {
    if (trades.length === 0) return 0;

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);

    const winRate = wins.length / trades.length;
    const lossRate = losses.length / trades.length;

    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

    return (winRate * avgWin) - (lossRate * avgLoss);
  }

  /**
   * Max Drawdown = Peak-to-trough percentage from equity curve.
   * @param {Array} equityHistory - Array of { total_equity } objects
   * @returns {number} drawdown as a decimal (e.g., 0.05 = 5%)
   */
  computeMaxDrawdown(equityHistory) {
    if (!equityHistory || equityHistory.length < 2) return 0;

    let peak = equityHistory[0].total_equity;
    let maxDD = 0;

    for (const snap of equityHistory) {
      if (snap.total_equity > peak) {
        peak = snap.total_equity;
      }
      const dd = peak > 0 ? (peak - snap.total_equity) / peak : 0;
      if (dd > maxDD) {
        maxDD = dd;
      }
    }

    return maxDD;
  }

  /**
   * Win/Loss Ratio = avgWin / |avgLoss|
   * @param {Array} trades
   * @returns {number}
   */
  computeWinLossRatio(trades) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);

    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

    if (avgLoss === 0) return avgWin > 0 ? 999 : 0;
    return avgWin / avgLoss;
  }

  /**
   * Return formatted metrics for API/dashboard.
   * @returns {object}
   */
  async getMetrics() {
    return await this.computeAll();
  }

  /**
   * Compute average hold time in human-readable format.
   * @private
   */
  _computeAvgHoldTime(trades) {
    const closedWithTimes = trades.filter(t => t.opened_at && t.closed_at);
    if (closedWithTimes.length === 0) return 'N/A';

    const totalMs = closedWithTimes.reduce((sum, t) => {
      return sum + (new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime());
    }, 0);

    const avgMs = totalMs / closedWithTimes.length;
    const minutes = Math.floor(avgMs / 60000);

    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainMins = minutes % 60;
    if (hours < 24) return `${hours}h ${remainMins}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  /**
   * Compute the Go-Live readiness checklist.
   * @param {number} serverStartTime - Fallback start time if database is empty
   * @returns {object} Checklist items and progress
   */
  async getReadinessChecklist(serverStartTime) {
    const trades = await this.db.getAllClosedTrades();
    const equityHistory = await this.db.getEquityHistory(500);
    const metrics = await this.computeAll();

    // 1. Sample Size (>= 100 closed trades)
    const totalTrades = metrics.totalTrades;
    const sampleSizePassed = totalTrades >= 100;

    // 2. Win Rate (>= 52%)
    const winRate = metrics.winRate;
    const winRatePassed = winRate >= 52;

    // 3. Profit Factor (>= 1.3)
    const profitFactor = metrics.profitFactor;
    const profitFactorPassed = profitFactor >= 1.3;

    // 4. Sharpe Ratio (>= 1.0)
    const sharpe = metrics.sharpeRatio;
    const sharpePassed = sharpe >= 1.0;

    // 5. Max Drawdown (<= 15%)
    const maxDrawdownPct = metrics.maxDrawdown * 100;
    const maxDrawdownPassed = totalTrades > 0 ? (maxDrawdownPct <= 15) : false;

    // 6. Expectancy (> $0)
    const expectancy = metrics.expectancy;
    const expectancyPassed = expectancy > 0;

    // 7. Time in Paper (>= 14 days)
    const firstEventTime = await this.db.getFirstEventTime();
    const startMs = firstEventTime ? new Date(firstEventTime.replace(' ', 'T') + 'Z').getTime() : (serverStartTime || Date.now());
    const timeInPaperMs = Date.now() - startMs;
    const timeInPaperDays = Math.max(0, timeInPaperMs / (1000 * 60 * 60 * 24));
    const timeInPaperPassed = timeInPaperDays >= 14;

    // 8. Consecutive Loss Recovery
    const recovery = this.computeConsecutiveLossRecovery(trades);
    const recoveryPassed = recovery.passed;

    const checklist = [
      {
        id: 'sample_size',
        name: 'Sample Size',
        target: '\u2265 100 closed trades',
        current: `${totalTrades} closed`,
        value: totalTrades,
        why: 'Anything less is statistically meaningless',
        passed: sampleSizePassed
      },
      {
        id: 'win_rate',
        name: 'Win Rate',
        target: '\u2265 52.00%',
        current: `${winRate.toFixed(2)}%`,
        value: winRate,
        why: 'Proves edge exists after fees',
        passed: winRatePassed
      },
      {
        id: 'profit_factor',
        name: 'Profit Factor',
        target: '\u2265 1.30',
        current: profitFactor === 999 ? '\u221e' : profitFactor.toFixed(2),
        value: profitFactor,
        why: 'Gross wins / gross losses — below 1.0 means you\'re losing',
        passed: profitFactorPassed
      },
      {
        id: 'sharpe_ratio',
        name: 'Sharpe Ratio',
        target: '\u2265 1.00',
        current: sharpe.toFixed(2),
        value: sharpe,
        why: 'Risk-adjusted return — below 1.0 isn\'t worth the risk',
        passed: sharpePassed
      },
      {
        id: 'max_drawdown',
        name: 'Max Drawdown',
        target: '\u2264 15.00%',
        current: `${maxDrawdownPct.toFixed(2)}%`,
        value: maxDrawdownPct,
        why: 'If paper trading blows past this, live will be worse',
        passed: maxDrawdownPassed
      },
      {
        id: 'expectancy',
        name: 'Expectancy',
        target: '> $0.00',
        current: expectancy >= 0 ? `$${expectancy.toFixed(2)}` : `-$${Math.abs(expectancy).toFixed(2)}`,
        value: expectancy,
        why: '(WinRate × AvgWin) - (LossRate × AvgLoss) must be positive',
        passed: expectancyPassed
      },
      {
        id: 'time_in_paper',
        name: 'Time in Paper',
        target: '\u2265 14.0 days',
        current: `${timeInPaperDays.toFixed(1)} days`,
        value: timeInPaperDays,
        why: 'Must survive different market conditions (trending + ranging + choppy)',
        passed: timeInPaperPassed
      },
      {
        id: 'consecutive_loss_recovery',
        name: 'Loss Streak Recovery',
        target: 'Streak recovered',
        current: recovery.status,
        value: recovery.recoveredCount,
        why: 'System must have recovered from at least one 3-5 loss streak',
        passed: recoveryPassed
      }
    ];

    const passedCount = checklist.filter(item => item.passed).length;
    const progressPct = parseFloat(((passedCount / checklist.length) * 100).toFixed(2));

    return {
      checklist,
      passedCount,
      totalCount: checklist.length,
      progressPct,
      isReady: passedCount === checklist.length
    };
  }

  /**
   * Helper to compute if consecutive loss streaks were recovered.
   * @param {Array} trades
   * @returns {object}
   */
  computeConsecutiveLossRecovery(trades) {
    if (trades.length < 3) {
      return {
        passed: false,
        status: 'Need \u2265 3 trades',
        totalStreaks: 0,
        recoveredCount: 0,
        maxStreakLength: 0
      };
    }

    // trades are in DESC order (newest first). Let's reverse to process chronologically.
    const chronoTrades = [...trades].reverse();
    
    // We want to calculate the running equity after each trade.
    // Let's assume a starting equity of 10000.
    const initialEquity = 10000;
    const equities = [initialEquity];
    let currentEquity = initialEquity;
    
    for (const t of chronoTrades) {
      currentEquity += t.pnl;
      equities.push(currentEquity);
    }

    // Now, scan for streaks of >= 3 consecutive losses (pnl < 0).
    const streaks = [];
    let tempStreak = [];

    for (let i = 0; i < chronoTrades.length; i++) {
      const trade = chronoTrades[i];
      if (trade.pnl < 0) {
        tempStreak.push(i);
      } else {
        if (tempStreak.length >= 3) {
          const startIdx = tempStreak[0];
          streaks.push({
            startIdx,
            length: tempStreak.length,
            preStreakEquity: equities[startIdx], // Equity before the streak started (at startIdx)
            endIdx: i - 1,
            recovered: false
          });
        }
        tempStreak = [];
      }
    }

    // Handle streak at the end of trades list
    if (tempStreak.length >= 3) {
      const startIdx = tempStreak[0];
      streaks.push({
        startIdx,
        length: tempStreak.length,
        preStreakEquity: equities[startIdx],
        endIdx: chronoTrades.length - 1,
        recovered: false
      });
    }

    // Check if each streak recovered
    for (const streak of streaks) {
      // Check equities after the streak ended
      for (let j = streak.endIdx + 1; j < equities.length; j++) {
        if (equities[j] >= streak.preStreakEquity) {
          streak.recovered = true;
          break;
        }
      }
    }

    const totalStreaks = streaks.length;
    const recoveredStreaks = streaks.filter(s => s.recovered);
    const unrecoveredStreaks = streaks.filter(s => !s.recovered);

    let status = '';
    let passed = false;

    if (totalStreaks === 0) {
      passed = false;
      status = 'No loss streak of \u22653 trades yet';
    } else {
      if (recoveredStreaks.length > 0) {
        passed = true;
        const maxLen = Math.max(...recoveredStreaks.map(s => s.length));
        status = `Recovered from ${recoveredStreaks.length} streak(s) (max: ${maxLen} losses)`;
      } else {
        passed = false;
        status = `In drawdown from ${unrecoveredStreaks[0].length} loss streak`;
      }
    }

    return {
      passed,
      status,
      totalStreaks,
      recoveredCount: recoveredStreaks.length,
      maxStreakLength: totalStreaks > 0 ? Math.max(...streaks.map(s => s.length)) : 0
    };
  }

  /**
   * Return empty metrics when no trades exist.
   * @private
   */
  _emptyMetrics() {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      totalPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      profitFactor: 0,
      expectancy: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      maxDrawdown: 0,
      winLossRatio: 0,
      avgHoldTime: 'N/A',
    };
  }
}

module.exports = PerformanceTracker;
