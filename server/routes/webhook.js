// server/routes/webhook.js — TradingView webhook receiver
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const log = require('../utils/logger');

const router = express.Router();

// Rate limiter: max 10 requests per minute per IP
const webhookLimiter = rateLimit({
  windowMs: config.webhookRateWindow,
  max: config.webhookRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit exceeded. Max 10 requests per minute.' },
  handler: (req, res, next, options) => {
    log.warn(`Webhook rate limit exceeded from ${req.ip}`);
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * POST /webhook
 * Receives TradingView alerts and forwards to the trading engine.
 *
 * Expected payload:
 * {
 *   "passphrase": "...",
 *   "action": "buy" | "sell" | "close_long" | "close_short" | "close_all",
 *   "ticker": "BTC/USDT",
 *   "price": 67500.00,
 *   "regime": "trending" | "ranging" | "volatile",
 *   "signal_score": 7.5,
 *   "confidence": 0.82,
 *   "factors": { ... },
 *   "atr": 450.0,
 *   "adx": 28.5,
 *   "stop_loss": 66800.0,
 *   "take_profit": 69000.0,
 *   "comment": "Strong trend continuation"
 * }
 */
router.post('/webhook', webhookLimiter, (req, res) => {
  const startTime = Date.now();

  try {
    const payload = req.body;

    // 1. Validate passphrase
    if (!payload || !payload.passphrase) {
      log.warn(`Webhook rejected: Missing passphrase from ${req.ip}`);
      return res.status(401).json({
        success: false,
        error: 'Missing passphrase',
      });
    }

    if (payload.passphrase !== config.webhookPassphrase) {
      log.warn(`Webhook rejected: Invalid passphrase from ${req.ip}`);
      return res.status(403).json({
        success: false,
        error: 'Invalid passphrase',
      });
    }

    // 2. Validate action
    const validActions = ['buy', 'sell', 'long', 'short', 'close_long', 'close_short', 'close_all'];
    const action = (payload.action || '').toLowerCase().trim();

    if (!action || !validActions.includes(action)) {
      log.warn(`Webhook rejected: Invalid action "${payload.action}"`);
      return res.status(400).json({
        success: false,
        error: `Invalid action. Must be one of: ${validActions.join(', ')}`,
      });
    }

    // 3. Validate price
    const price = parseFloat(payload.price);
    if (!price || isNaN(price) || price <= 0) {
      log.warn(`Webhook rejected: Invalid price "${payload.price}"`);
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing price. Must be a positive number.',
      });
    }

    // 4. Normalize payload
    const normalizedPayload = {
      action: action,
      ticker: payload.ticker || config.tradingPair,
      price: price,
      regime: payload.regime || null,
      signal_score: payload.signal_score !== undefined ? parseFloat(payload.signal_score) : null,
      confidence: payload.confidence !== undefined ? parseFloat(payload.confidence) : null,
      factors: payload.factors || null,
      atr: payload.atr !== undefined ? parseFloat(payload.atr) : null,
      adx: payload.adx !== undefined ? parseFloat(payload.adx) : null,
      stop_loss: payload.stop_loss !== undefined ? parseFloat(payload.stop_loss) : null,
      take_profit: payload.take_profit !== undefined ? parseFloat(payload.take_profit) : null,
      comment: payload.comment || null,
    };

    // 5. Check engine reference (attached by server/index.js)
    if (!req.app.locals.engine) {
      log.error('Webhook received but engine not initialized');
      return res.status(503).json({
        success: false,
        error: 'Trading engine not initialized',
      });
    }

    // 6. Process signal through engine
    const result = req.app.locals.engine.processSignal(normalizedPayload);

    const elapsed = Date.now() - startTime;
    log.info(`Webhook processed in ${elapsed}ms`);

    return res.status(200).json({
      success: result.success,
      signalId: result.signalId,
      tradeId: result.tradeId || null,
      action: normalizedPayload.action,
      reason: result.reason || null,
      processingTimeMs: elapsed,
    });

  } catch (err) {
    log.error(`Webhook error: ${err.message}`);
    log.error(err.stack);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

module.exports = router;
