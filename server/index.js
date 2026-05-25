// server/index.js — Quantum Edge main entry point
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const log = require('./utils/logger');
const QuantEngine = require('./engine/quantEngine');
const webhookRouter = require('./routes/webhook');
const apiRouter = require('./routes/api');

// ─── ASCII Art Banner ────────────────────────────────────────────
function printStartupBanner() {
  const CYAN = '\x1b[36m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';

  console.log('');
  console.log(`${CYAN}${BOLD}`);
  console.log('   ╔═══════════════════════════════════════════════════════╗');
  console.log('   ║                                                       ║');
  console.log('   ║     ██████  ██    ██  █████  ███    ██ ████████       ║');
  console.log('   ║    ██    ██ ██    ██ ██   ██ ████   ██    ██          ║');
  console.log('   ║    ██    ██ ██    ██ ███████ ██ ██  ██    ██          ║');
  console.log('   ║    ██ ▄▄ ██ ██    ██ ██   ██ ██  ██ ██    ██          ║');
  console.log('   ║     ██████   ██████  ██   ██ ██   ████    ██          ║');
  console.log('   ║        ▀▀                                             ║');
  console.log('   ║              ███████ ██████   ██████  ███████         ║');
  console.log('   ║              ██      ██   ██ ██       ██              ║');
  console.log('   ║              █████   ██   ██ ██   ███ █████           ║');
  console.log('   ║              ██      ██   ██ ██    ██ ██              ║');
  console.log('   ║              ███████ ██████   ██████  ███████         ║');
  console.log('   ║                                                       ║');
  console.log('   ║         Quant-Grade Autonomous Trading Engine         ║');
  console.log('   ║                    v2.0.0                             ║');
  console.log('   ╚═══════════════════════════════════════════════════════╝');
  console.log(`${RESET}`);
  console.log(`   ${DIM}─────────────────────────────────────────────────────${RESET}`);
  console.log(`   ${GREEN}●${RESET} Mode:     ${BOLD}${config.paperTrade ? `${YELLOW}PAPER TRADING${RESET}` : `${GREEN}LIVE TRADING${RESET}`}`);
  console.log(`   ${GREEN}●${RESET} Pair:     ${BOLD}${config.tradingPair}${RESET}`);
  console.log(`   ${GREEN}●${RESET} Balance:  ${BOLD}$${config.initialBalance.toLocaleString()}${RESET}`);
  console.log(`   ${GREEN}●${RESET} Port:     ${BOLD}${config.port}${RESET}`);
  console.log(`   ${GREEN}●${RESET} Risk:     ${BOLD}${(config.maxRiskPerTrade * 100).toFixed(1)}% per trade / ${(config.maxDailyDrawdown * 100).toFixed(1)}% daily max${RESET}`);
  console.log(`   ${GREEN}●${RESET} Kelly:    ${BOLD}${config.kellyFraction}x fractional${RESET}`);
  console.log(`   ${GREEN}●${RESET} Max Pos:  ${BOLD}${config.maxOpenPositions}${RESET}`);
  console.log(`   ${DIM}─────────────────────────────────────────────────────${RESET}`);
  console.log('');
}

// ─── Express App ─────────────────────────────────────────────────
const app = express();

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS for dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Request logging (only in debug mode)
app.use((req, res, next) => {
  if (config.logLevel === 'debug') {
    log.debug(`${req.method} ${req.url} from ${req.ip}`);
  }
  next();
});

// Static files for dashboard
app.use(express.static(config.dashboardPath));

// Mount routes
app.use(webhookRouter);
app.use(apiRouter);

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  log.error(`Unhandled error: ${err.message}`);
  log.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── HTTP Server ─────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket Server ────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Initialize Engine ──────────────────────────────────────────
const engine = new QuantEngine();
app.locals.engine = engine;

wss.on('connection', async (ws, req) => {
  engine.registerWsClient(ws);

  // Send initial status on connect
  try {
    const status = await engine.getStatus();
    ws.send(JSON.stringify({ type: 'init', data: status }));
  } catch (err) {
    log.error(`Error sending init status: ${err.message}`);
  }

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Handle ping/pong or status requests from dashboard
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (msg.type === 'status') {
        const status = await engine.getStatus();
        ws.send(JSON.stringify({ type: 'status', data: status }));
      }
    } catch (_) {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    engine.removeWsClient(ws);
  });

  ws.on('error', (err) => {
    log.error(`WebSocket error: ${err.message}`);
    engine.removeWsClient(ws);
  });
});

// ─── Scheduled Intervals ─────────────────────────────────────────
let equityInterval = null;
let performanceInterval = null;

function startIntervals() {
  // Equity snapshot every 5 minutes
  equityInterval = setInterval(async () => {
    try {
      await engine.takeEquitySnapshot();
    } catch (err) {
      log.error(`Equity snapshot error: ${err.message}`);
    }
  }, config.equitySnapshotIntervalMs);

  // Performance snapshot every hour
  performanceInterval = setInterval(async () => {
    try {
      await engine.takePerformanceSnapshot();
    } catch (err) {
      log.error(`Performance snapshot error: ${err.message}`);
    }
  }, config.performanceSnapshotIntervalMs);

  log.info(`Equity snapshots: every ${config.equitySnapshotIntervalMs / 60000} min`);
  log.info(`Performance snapshots: every ${config.performanceSnapshotIntervalMs / 3600000} hr`);
}

function clearIntervals() {
  if (equityInterval) clearInterval(equityInterval);
  if (performanceInterval) clearInterval(performanceInterval);
}

// ─── Graceful Shutdown ───────────────────────────────────────────
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.system(`\nReceived ${signal}. Initiating graceful shutdown...`);

  clearIntervals();

  // Close WebSocket server
  wss.close(() => {
    log.system('WebSocket server closed');
  });

  // Shutdown engine (saves snapshots, closes DB)
  try {
    await engine.shutdown();
  } catch (err) {
    log.error(`Engine shutdown error: ${err.message}`);
  }

  // Close HTTP server
  server.close(() => {
    log.system('HTTP server closed');
    log.banner('Quantum Edge Shutdown Complete');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    log.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${err.message}`);
  log.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled Rejection: ${reason}`);
});

// ─── Start Server ────────────────────────────────────────────────
server.listen(config.port, async () => {
  printStartupBanner();

  try {
    // Initialize the engine
    await engine.initialize();

    // Take initial equity snapshot
    await engine.takeEquitySnapshot();

    // Start scheduled intervals
    startIntervals();

    log.system(`Quantum Edge v2.0.0 listening on port ${config.port}`);
    log.system(`Webhook endpoint: http://localhost:${config.port}/webhook`);
    log.system(`Dashboard API:    http://localhost:${config.port}/api/status`);
    log.system(`WebSocket:        ws://localhost:${config.port}/ws`);
    log.system(`Health check:     http://localhost:${config.port}/health`);
    log.system('Awaiting signals...');
  } catch (err) {
    log.error(`Engine startup failed: ${err.message}`);
    process.exit(1);
  }
});

module.exports = { app, server };
