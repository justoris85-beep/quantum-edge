// server/engine/regimeDetector.js — Market regime detector from Pine Script signals
'use strict';

const log = require('../utils/logger');

class RegimeDetector {
  constructor() {
    this.currentRegime = 'unknown';
    this.regimeHistory = [];   // last 20 regime readings { regime, adx, atr, timestamp }
    this.regimeStartTime = null;
    this.regimeDuration = 0;   // in minutes
    this._maxHistory = 20;
  }

  /**
   * Update the regime from an incoming signal.
   * @param {string} regime   - 'trending' | 'ranging' | 'volatile' | 'unknown'
   * @param {number} adxValue - ADX indicator value
   * @param {number} atrValue - ATR indicator value
   */
  update(regime, adxValue, atrValue) {
    const normalized = (regime || 'unknown').toLowerCase().trim();
    const validRegimes = ['trending', 'ranging', 'volatile', 'unknown'];
    const finalRegime = validRegimes.includes(normalized) ? normalized : 'unknown';

    const previousRegime = this.currentRegime;

    // Track regime change timing
    if (finalRegime !== previousRegime) {
      this.regimeStartTime = Date.now();
      log.signal(`Regime change: ${previousRegime} → ${finalRegime} (ADX=${adxValue || '?'}, ATR=${atrValue || '?'})`);
    }

    this.currentRegime = finalRegime;

    // Push to history ring buffer
    this.regimeHistory.push({
      regime: finalRegime,
      adx: adxValue || null,
      atr: atrValue || null,
      timestamp: Date.now(),
    });

    // Keep only last N entries
    if (this.regimeHistory.length > this._maxHistory) {
      this.regimeHistory = this.regimeHistory.slice(-this._maxHistory);
    }

    // Update duration
    if (this.regimeStartTime) {
      this.regimeDuration = Math.floor((Date.now() - this.regimeStartTime) / 60000);
    }

    return {
      regime: finalRegime,
      changed: finalRegime !== previousRegime,
      previous: previousRegime,
      duration: this.regimeDuration,
    };
  }

  /**
   * Get the current detected regime.
   * @returns {string}
   */
  getCurrentRegime() {
    return this.currentRegime;
  }

  /**
   * How long the engine has been in the current regime (in minutes).
   * @returns {number}
   */
  getRegimeDuration() {
    if (!this.regimeStartTime) return 0;
    return Math.floor((Date.now() - this.regimeStartTime) / 60000);
  }

  /**
   * Risk multiplier based on current regime.
   *   trending  = 1.0  (full size, trend continuation)
   *   ranging   = 0.7  (reduced size, mean-reversion opportunities)
   *   volatile  = 0.0  (no trading, protect capital)
   *   unknown   = 0.5  (cautious)
   * @returns {number}
   */
  getRiskMultiplier() {
    switch (this.currentRegime) {
      case 'trending': return 1.0;
      case 'ranging':  return 0.7;
      case 'volatile': return 0.0;
      case 'unknown':  return 0.5;
      default:         return 0.5;
    }
  }

  /**
   * Whether the regime has been stable (same) for the last 5 readings.
   * @returns {boolean}
   */
  isRegimeStable() {
    if (this.regimeHistory.length < 5) return false;
    const last5 = this.regimeHistory.slice(-5);
    return last5.every(r => r.regime === this.currentRegime);
  }

  /**
   * Get the latest ADX value from history.
   * @returns {number|null}
   */
  getLatestAdx() {
    if (this.regimeHistory.length === 0) return null;
    return this.regimeHistory[this.regimeHistory.length - 1].adx;
  }

  /**
   * Get the latest ATR value from history.
   * @returns {number|null}
   */
  getLatestAtr() {
    if (this.regimeHistory.length === 0) return null;
    return this.regimeHistory[this.regimeHistory.length - 1].atr;
  }

  /**
   * Full status snapshot.
   * @returns {object}
   */
  getStatus() {
    return {
      currentRegime: this.currentRegime,
      regimeDuration: this.getRegimeDuration(),
      riskMultiplier: this.getRiskMultiplier(),
      isStable: this.isRegimeStable(),
      latestAdx: this.getLatestAdx(),
      latestAtr: this.getLatestAtr(),
      historyCount: this.regimeHistory.length,
      recentHistory: this.regimeHistory.slice(-5).map(r => ({
        regime: r.regime,
        adx: r.adx,
        atr: r.atr,
        time: new Date(r.timestamp).toISOString(),
      })),
    };
  }
}

module.exports = RegimeDetector;
