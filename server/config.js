// server/config.js — Centralized configuration from environment variables
'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function env(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  return val;
}

function envFloat(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const config = Object.freeze({
  // Server
  port: envInt('PORT', 3000),
  webhookPassphrase: env('WEBHOOK_PASSPHRASE', 'changeme'),

  // Trading
  tradingPair: env('TRADING_PAIR', 'BTC/USDT'),
  initialBalance: envFloat('INITIAL_BALANCE', 10000),

  // Risk Management
  maxRiskPerTrade: envFloat('MAX_RISK_PER_TRADE', 0.01),
  maxDailyDrawdown: envFloat('MAX_DAILY_DRAWDOWN', 0.03),
  maxOpenPositions: envInt('MAX_OPEN_POSITIONS', 3),
  tradeCooldownSeconds: envInt('TRADE_COOLDOWN_SECONDS', 30),
  kellyFraction: envFloat('KELLY_FRACTION', 0.25),
  maxConsecutiveLosses: envInt('MAX_CONSECUTIVE_LOSSES', 5),

  // Mode
  paperTrade: envBool('PAPER_TRADE', true),

  // Logging
  logLevel: env('LOG_LEVEL', 'info'),

  // Paths
  dbPath: env('DB_PATH', path.resolve(__dirname, '..', 'data', 'quantum-edge.db')),
  databaseUrl: env('DATABASE_URL', ''),
  dashboardPath: path.resolve(__dirname, '..', 'dashboard'),

  // Rate Limits
  webhookRateLimit: envInt('WEBHOOK_RATE_LIMIT', 10),
  webhookRateWindow: envInt('WEBHOOK_RATE_WINDOW_MS', 60000),

  // Intervals
  equitySnapshotIntervalMs: envInt('EQUITY_SNAPSHOT_INTERVAL_MS', 5 * 60 * 1000),
  performanceSnapshotIntervalMs: envInt('PERFORMANCE_SNAPSHOT_INTERVAL_MS', 60 * 60 * 1000),
});

module.exports = config;
