// server/utils/logger.js — Structured, colored console logger
'use strict';

const COLORS = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',

  // Foreground
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  orange:  '\x1b[38;5;208m',

  // Background
  bgRed:     '\x1b[41m',
  bgGreen:   '\x1b[42m',
  bgYellow:  '\x1b[43m',
  bgBlue:    '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan:    '\x1b[46m',
};

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor() {
    const levelStr = (process.env.LOG_LEVEL || 'info').toLowerCase();
    this.level = LOG_LEVELS[levelStr] !== undefined ? LOG_LEVELS[levelStr] : LOG_LEVELS.info;
  }

  _timestamp() {
    return new Date().toISOString();
  }

  _format(color, prefix, msg) {
    const ts = `${COLORS.dim}${this._timestamp()}${COLORS.reset}`;
    const tag = `${color}${COLORS.bold}[${prefix}]${COLORS.reset}`;
    return `${ts} ${tag} ${msg}`;
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= this.level;
  }

  info(msg) {
    if (!this._shouldLog('info')) return;
    console.log(this._format(COLORS.cyan, 'INFO', msg));
  }

  warn(msg) {
    if (!this._shouldLog('warn')) return;
    console.warn(this._format(COLORS.yellow, 'WARN', msg));
  }

  error(msg) {
    if (!this._shouldLog('error')) return;
    console.error(this._format(COLORS.red, 'ERROR', msg));
  }

  debug(msg) {
    if (!this._shouldLog('debug')) return;
    console.log(this._format(COLORS.dim, 'DEBUG', msg));
  }

  trade(side, msg) {
    const color = side === 'buy' || side === 'long' ? COLORS.green : COLORS.red;
    const label = side.toUpperCase();
    console.log(this._format(color, `TRADE:${label}`, msg));
  }

  system(msg) {
    console.log(this._format(COLORS.magenta, 'SYSTEM', msg));
  }

  signal(msg) {
    console.log(this._format(COLORS.blue, 'SIGNAL', msg));
  }

  risk(msg) {
    console.log(this._format(COLORS.orange, 'RISK', msg));
  }

  banner(title) {
    const inner = `  ${title}  `;
    const width = inner.length + 2;
    const border = '═'.repeat(width);
    const pad = ' '.repeat(inner.length);

    console.log('');
    console.log(`${COLORS.cyan}${COLORS.bold}  ╔${border}╗${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bold}  ║ ${pad} ║${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bold}  ║ ${inner} ║${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bold}  ║ ${pad} ║${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bold}  ╚${border}╝${COLORS.reset}`);
    console.log('');
  }

  table(data) {
    if (typeof data === 'object' && data !== null) {
      const entries = Object.entries(data);
      const maxKey = Math.max(...entries.map(([k]) => k.length));
      for (const [key, value] of entries) {
        const paddedKey = key.padEnd(maxKey);
        console.log(`  ${COLORS.dim}│${COLORS.reset} ${COLORS.cyan}${paddedKey}${COLORS.reset}  ${value}`);
      }
    }
  }
}

module.exports = new Logger();
