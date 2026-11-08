'use strict';

const http = require('node:http');
const url = require('node:url');
const config = require('./config');

class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 10000 }) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = new Map();
    this.openedUntil = new Map();
  }

  isOpen(serviceName) {
    const opened = this.openedUntil.get(serviceName);
    if (!opened) return false;
    if (Date.now() > opened) {
      this.openedUntil.delete(serviceName);
      this.failures.set(serviceName, 0);
      return false; // Half-open: thử lại
    }
    return true;
  }

  recordSuccess(serviceName) {
    this.failures.set(serviceName, 0);
    this.openedUntil.delete(serviceName);
  }

  recordFailure(serviceName) {
    const current = (this.failures.get(serviceName) || 0) + 1;
    this.failures.set(serviceName, current);
    if (current >= this.threshold) {
      this.openedUntil.set(serviceName, Date.now() + this.cooldownMs);
    }
  }
}

const defaultBreaker = new CircuitBreaker({});

async function request(serviceName, { method = 'GET', path: reqPath = '/', body = null, headers = {}, timeout = 5000, retries = 0, internal = false, correlationId = null }) {
  if (defaultBreaker.isOpen(serviceName)) {
    const err = new Error(`Circuit breaker đang mở cho service ${serviceName}`);
    err.code = 'CIRCUIT_BREAKER_OPEN';
    throw err;
  }

  const baseUrl = config.URLS[serviceName];
  if (!baseUrl) {
    throw new Error(`Không tìm thấy cấu hình URL cho service: ${serviceName}`);
  }

  const parsedBase = url.parse(baseUrl);
  const targetPath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;

  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (internal) {
    requestHeaders['X-Internal-Key'] = config.INTERNAL_KEY;
  }

  if (correlationId) {
    requestHeaders['X-Correlation-ID'] = correlationId;
  }

  let bodyStr = null;
  if (body !== null && body !== undefined) {
    bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    requestHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  let attempt = 0;
  const maxAttempts = 1 + retries;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsedBase.hostname,
            port: parsedBase.port,
            path: targetPath,
            method: method.toUpperCase(),
            headers: requestHeaders,
            timeout,
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const resRaw = Buffer.concat(chunks).toString('utf8');
              let parsedBody = null;
              try {
                parsedBody = resRaw.length ? JSON.parse(resRaw) : null;
              } catch (_) {
                parsedBody = resRaw;
              }
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: parsedBody,
              });
            });
          }
        );

        req.on('timeout', () => {
          req.destroy(new Error(`Timeout sau ${timeout}ms khi gọi ${serviceName} ${method} ${targetPath}`));
        });

        req.on('error', (e) => reject(e));

        if (bodyStr) {
          req.write(bodyStr);
        }
        req.end();
      });

      if (response.status < 500) {
        defaultBreaker.recordSuccess(serviceName);
        return response;
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 300));
        continue;
      }

      defaultBreaker.recordFailure(serviceName);
      return response;
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 300));
        continue;
      }
      defaultBreaker.recordFailure(serviceName);
      throw err;
    }
  }
}

module.exports = {
  request,
  CircuitBreaker,
  defaultBreaker,
};
