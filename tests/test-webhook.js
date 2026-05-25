// tests/test-webhook.js — Integration test for Quantum Edge webhook
'use strict';

const http = require('http');
require('dotenv').config();

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const PASSPHRASE = process.env.WEBHOOK_PASSPHRASE || 'changeme';

// ─── Test Utilities ──────────────────────────────────────────────
const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

let testsPassed = 0;
let testsFailed = 0;

function formatResult(name, passed, detail) {
  const icon = passed ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
  const nameStr = passed
    ? `${COLORS.green}${name}${COLORS.reset}`
    : `${COLORS.red}${name}${COLORS.reset}`;
  console.log(`  ${icon} ${nameStr}`);
  if (detail) {
    console.log(`    ${COLORS.dim}${detail}${COLORS.reset}`);
  }
}

function postWebhook(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL('/webhook', BASE_URL);
    const body = JSON.stringify(payload);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(data),
          });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    http.get(url.href, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Test Cases ──────────────────────────────────────────────────

async function test1_healthCheck() {
  const name = 'Health check endpoint';
  try {
    const res = await httpGet('/health');
    const passed = res.status === 200 && res.body.status === 'healthy';
    formatResult(name, passed, `status=${res.body.status}, version=${res.body.version}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test2_longEntry() {
  const name = 'Long entry signal (trending, score 7.5)';
  try {
    const res = await postWebhook({
      passphrase: PASSPHRASE,
      action: 'buy',
      ticker: 'BTC/USDT',
      price: 67500.00,
      regime: 'trending',
      signal_score: 7.5,
      confidence: 0.82,
      factors: {
        ema: 1.5,
        rsi: 1.2,
        macd: 1.8,
        bb: 0.5,
        volume: 1.0,
        squeeze: 0.0,
        htf: 1.0,
      },
      atr: 450.0,
      adx: 28.5,
      stop_loss: 66800.00,
      take_profit: 69000.00,
      comment: 'Strong trend continuation — EMA cross + MACD alignment',
    });

    const passed = res.status === 200 && res.body.success === true && res.body.tradeId;
    formatResult(name, passed, `tradeId=${res.body.tradeId || 'none'}, signalId=${res.body.signalId || 'none'}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test3_shortEntry() {
  const name = 'Short entry signal (ranging, score 6.0)';
  try {
    // Wait for cooldown
    await sleep(31000);

    const res = await postWebhook({
      passphrase: PASSPHRASE,
      action: 'sell',
      ticker: 'BTC/USDT',
      price: 68200.00,
      regime: 'ranging',
      signal_score: 6.0,
      confidence: 0.65,
      factors: {
        ema: 1.0,
        rsi: 1.5,
        macd: 0.8,
        bb: 1.2,
        volume: 0.5,
        squeeze: 0.0,
        htf: 0.0,
      },
      atr: 380.0,
      adx: 18.2,
      stop_loss: 68900.00,
      take_profit: 67000.00,
      comment: 'Mean reversion play — RSI overbought at BB upper',
    });

    const passed = res.status === 200 && res.body.success === true && res.body.tradeId;
    formatResult(name, passed, `tradeId=${res.body.tradeId || 'none'}, action=${res.body.action}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test4_closeLong() {
  const name = 'Close long signal';
  try {
    const res = await postWebhook({
      passphrase: PASSPHRASE,
      action: 'close_long',
      ticker: 'BTC/USDT',
      price: 68800.00,
      comment: 'Take profit target reached',
    });

    const passed = res.status === 200 && res.body.success === true;
    formatResult(name, passed, `closedCount=${res.body.body?.closedCount || 'N/A'}, action=${res.body.action}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test5_invalidPassphrase() {
  const name = 'Invalid passphrase (should reject with 403)';
  try {
    const res = await postWebhook({
      passphrase: 'wrong_passphrase_123',
      action: 'buy',
      ticker: 'BTC/USDT',
      price: 67000.00,
    });

    const passed = res.status === 403 && res.body.success === false;
    formatResult(name, passed, `status=${res.status}, error="${res.body.error}"`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test6_missingPassphrase() {
  const name = 'Missing passphrase (should reject with 401)';
  try {
    const res = await postWebhook({
      action: 'buy',
      ticker: 'BTC/USDT',
      price: 67000.00,
    });

    const passed = res.status === 401 && res.body.success === false;
    formatResult(name, passed, `status=${res.status}, error="${res.body.error}"`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test7_volatileRegime() {
  const name = 'Volatile regime signal (should be rejected by risk manager)';
  try {
    // Wait for cooldown
    await sleep(31000);

    const res = await postWebhook({
      passphrase: PASSPHRASE,
      action: 'buy',
      ticker: 'BTC/USDT',
      price: 65000.00,
      regime: 'volatile',
      signal_score: 8.0,
      confidence: 0.90,
      factors: {
        ema: 1.5,
        rsi: 1.0,
        macd: 1.5,
        bb: 0.0,
        volume: 1.5,
        squeeze: 1.0,
        htf: 1.0,
      },
      atr: 1200.0,
      adx: 45.0,
      stop_loss: 63000.00,
      take_profit: 70000.00,
      comment: 'High volatility event',
    });

    // Should fail because volatile regime has risk multiplier = 0
    const passed = res.status === 200 && res.body.success === false && res.body.reason && res.body.reason.toLowerCase().includes('volatile');
    formatResult(name, passed, `rejected: ${res.body.reason || 'no reason'}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test8_invalidAction() {
  const name = 'Invalid action (should reject with 400)';
  try {
    const res = await postWebhook({
      passphrase: PASSPHRASE,
      action: 'invalid_action',
      ticker: 'BTC/USDT',
      price: 67000.00,
    });

    const passed = res.status === 400 && res.body.success === false;
    formatResult(name, passed, `status=${res.status}, error="${res.body.error}"`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test9_missingPrice() {
  const name = 'Missing price (should reject with 400)';
  try {
    const res = await postWebhook({
      passphrase: PASSPHRASE,
      action: 'buy',
      ticker: 'BTC/USDT',
    });

    const passed = res.status === 400 && res.body.success === false;
    formatResult(name, passed, `status=${res.status}, error="${res.body.error}"`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test10_apiStatus() {
  const name = 'API status endpoint';
  try {
    const res = await httpGet('/api/status');
    const passed = res.status === 200 && res.body.success === true && res.body.data.engine;
    formatResult(name, passed, `mode=${res.body.data?.engine?.mode}, balance=$${res.body.data?.account?.balance}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test11_apiPerformance() {
  const name = 'API performance endpoint';
  try {
    const res = await httpGet('/api/performance');
    const passed = res.status === 200 && res.body.success === true && res.body.data !== undefined;
    formatResult(name, passed, `totalTrades=${res.body.data?.totalTrades}, sharpe=${res.body.data?.sharpeRatio}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

async function test12_apiSignals() {
  const name = 'API signals endpoint';
  try {
    const res = await httpGet('/api/signals?limit=10');
    const passed = res.status === 200 && res.body.success === true && Array.isArray(res.body.data);
    formatResult(name, passed, `count=${res.body.count}`);
    return passed;
  } catch (err) {
    formatResult(name, false, `Error: ${err.message}`);
    return false;
  }
}

// ─── Runner ──────────────────────────────────────────────────────
async function runTests() {
  console.log('');
  console.log(`${COLORS.cyan}${COLORS.bold}  ╔═══════════════════════════════════════════════╗${COLORS.reset}`);
  console.log(`${COLORS.cyan}${COLORS.bold}  ║   Quantum Edge — Webhook Integration Tests    ║${COLORS.reset}`);
  console.log(`${COLORS.cyan}${COLORS.bold}  ╚═══════════════════════════════════════════════╝${COLORS.reset}`);
  console.log('');
  console.log(`  ${COLORS.dim}Target: ${BASE_URL}${COLORS.reset}`);
  console.log(`  ${COLORS.dim}Passphrase: ${PASSPHRASE.slice(0, 3)}...${COLORS.reset}`);
  console.log('');

  const tests = [
    test1_healthCheck,
    test2_longEntry,
    test5_invalidPassphrase,
    test6_missingPassphrase,
    test8_invalidAction,
    test9_missingPrice,
    test10_apiStatus,
    test11_apiPerformance,
    test12_apiSignals,
    test3_shortEntry,      // requires 31s cooldown wait
    test4_closeLong,
    test7_volatileRegime,  // requires 31s cooldown wait
  ];

  console.log(`  ${COLORS.yellow}Running ${tests.length} tests...${COLORS.reset}`);
  console.log(`  ${COLORS.dim}(Some tests include 30s cooldown waits)${COLORS.reset}`);
  console.log('');

  for (const testFn of tests) {
    const passed = await testFn();
    if (passed) testsPassed++;
    else testsFailed++;
  }

  console.log('');
  console.log(`  ${COLORS.dim}─────────────────────────────────────────${COLORS.reset}`);
  console.log(`  ${COLORS.bold}Results: ${COLORS.green}${testsPassed} passed${COLORS.reset}, ${testsFailed > 0 ? COLORS.red : COLORS.dim}${testsFailed} failed${COLORS.reset}`);
  console.log(`  ${COLORS.dim}Total:   ${testsPassed + testsFailed} tests${COLORS.reset}`);
  console.log('');

  if (testsFailed > 0) {
    console.log(`  ${COLORS.red}${COLORS.bold}⚠  Some tests failed. Ensure the server is running.${COLORS.reset}`);
    process.exit(1);
  } else {
    console.log(`  ${COLORS.green}${COLORS.bold}✓  All tests passed!${COLORS.reset}`);
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error(`\n  ${COLORS.red}Fatal error: ${err.message}${COLORS.reset}`);
  console.error(`  ${COLORS.dim}Make sure the server is running: npm start${COLORS.reset}\n`);
  process.exit(1);
});
