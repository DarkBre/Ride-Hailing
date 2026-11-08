'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL = LEVELS[config.LOG_LEVEL.toLowerCase()] || LEVELS.info;

class Logger {
  constructor(serviceName) {
    this.service = serviceName;
    this.logFile = config.getLogPath(serviceName);

    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
  }

  _log(level, event, meta = {}) {
    if (LEVELS[level] < CURRENT_LEVEL) return;

    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      service: this.service,
      event,
      ...meta,
    };

    // 1. Console in màu
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const reset = '\x1b[0m';
    const corr = meta.correlationId ? ` [${meta.correlationId}]` : '';
    console.log(
      `${color}[${timestamp}] [${this.service.toUpperCase()}] [${level.toUpperCase()}]${corr}${reset} ${event}`,
      Object.keys(meta).length ? JSON.stringify(meta) : ''
    );

    // 2. Ghi ra file JSONL
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {}
  }

  debug(event, meta) { this._log('debug', event, meta); }
  info(event, meta) { this._log('info', event, meta); }
  warn(event, meta) { this._log('warn', event, meta); }
  error(event, meta) { this._log('error', event, meta); }
}

function createLogger(serviceName) {
  return new Logger(serviceName);
}

module.exports = {
  createLogger,
};
