'use strict';

const { createServer } = require('node:http');
const { createServer: createSecureServer } = require('node:https');
const { readFileSync } = require('node:fs');
const { createHmac, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

function gateway({ identity, driver, trip, payment, driverKey, rateProxyKey, tls }) {
  const serve = tls ? createSecureServer : createServer;
  return serve({ ...tls, requestTimeout: 10000, headersTimeout: 5000 }, async (req, res) => {
    const supplied = req.headers['x-correlation-id'];
    const trace = typeof supplied === 'string' && /^[\w.-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader('x-correlation-id', trace);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (tls && process.env.GATEWAY_HSTS === '1') {
      res.setHeader('strict-transport-security', 'max-age=31536000');
    }
    function reply(status, code) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: status < 400, error: code ? { code } : null, meta: { correlation_id: trace } }));
    }
    try {
      const path = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/health', '/live'].includes(path.pathname)) return reply(200);
      if (req.method === 'GET' && path.pathname === '/ready') {
        try {
          const responses = await Promise.all([identity, driver, trip, payment].filter(Boolean).map(url =>
            fetch(new URL('/ready', url), { signal: AbortSignal.timeout(1500) })));
          const ready = responses.every(response => response.ok);
          await Promise.all(responses.map(response => response.body?.cancel()));
          return reply(ready ? 200 : 503, ready ? null : 'DEPENDENCY_UNAVAILABLE');
        } catch {
          return reply(503, 'DEPENDENCY_UNAVAILABLE');
        }
      }
      const route = path.pathname.replace(/^\/api\/v1(?=\/)/, '');
      if (route === path.pathname) return reply(404, 'NOT_FOUND');
      const signature = `${req.method} ${route}`;
      const publicAuth = ['POST /auth/login', 'POST /auth/register'].includes(signature);
      let target;
      let upstream = route;
      if (publicAuth || ['GET /auth/me', 'POST /auth/logout'].includes(signature)) target = identity;
      else if (['PUT /drivers/location', 'PUT /drivers/status', 'GET /drivers/available'].includes(signature)) {
        target = driver;
        if (signature === 'GET /drivers/available') upstream = '/drivers/nearby';
      } else if (signature === 'POST /trips' ||
          /^GET \/trips\/[0-9a-f-]{36}$/i.test(signature) ||
          /^POST \/trips\/[0-9a-f-]{36}\/(accept|cancel|start|complete)$/i.test(signature)) target = trip;
      else if (['GET /payments/wallet', 'POST /payments/topup'].includes(signature)) {
        target = payment;
        upstream = route === '/payments/topup' ? '/wallet/topup' : '/wallet';
      } else return reply(404, 'NOT_FOUND');
      if (!target) return reply(503, 'UPSTREAM_UNAVAILABLE');
      const headers = { 'x-correlation-id': trace };
      if (publicAuth && rateProxyKey && req.socket.remoteAddress) {
        const address = req.socket.remoteAddress;
        headers['x-ds03-client-ip'] = address;
        headers['x-ds03-client-signature'] = createHmac('sha256', rateProxyKey).update(address).digest('hex');
      }
      for (const header of ['authorization', 'content-type', 'idempotency-key']) {
        if (typeof req.headers[header] === 'string') headers[header] = req.headers[header];
      }
      if (!publicAuth && !headers.authorization) return reply(401, 'UNAUTHORIZED');
      if (!publicAuth && target !== identity) {
        const auth = await fetch(new URL('/auth/me', identity), { headers, signal: AbortSignal.timeout(2000) });
        await auth.body?.cancel();
        if (!auth.ok) return reply(auth.status, 'UNAUTHORIZED');
      }
      if (upstream === '/drivers/nearby') {
        headers['x-internal-key'] = driverKey;
      }
      const chunks = [];
      let bytes = 0;
      if (req.method !== 'GET') {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 16_384) {
            req.resume();
            return reply(413, 'PAYLOAD_TOO_LARGE');
          }
          chunks.push(chunk);
        }
      }
      const response = await fetch(new URL(upstream + path.search, target), {
        method: req.method, headers, body: bytes ? Buffer.concat(chunks) : undefined,
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      for (const header of ['content-type', 'retry-after']) {
        const value = response.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.writeHead(response.status);
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch {
      if (!res.headersSent) reply(502, 'UPSTREAM_UNAVAILABLE');
      else res.destroy();
    }
  });
}

if (require.main === module) {
  const { IDENTITY_URL, DRIVER_URL, TRIP_URL, PAYMENT_URL, DRIVER_INTERNAL_KEY, GATEWAY_PORT } = process.env;
  if (!IDENTITY_URL || !DRIVER_URL || !TRIP_URL || !DRIVER_INTERNAL_KEY) throw new Error('Missing Gateway configuration');
  const cert = process.env.GATEWAY_TLS_CERT;
  const key = process.env.GATEWAY_TLS_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error('Both Gateway TLS files are required');
  const tls = cert && { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.2' };
  const server = gateway({ identity: IDENTITY_URL, driver: DRIVER_URL, trip: TRIP_URL, payment: PAYMENT_URL,
    driverKey: DRIVER_INTERNAL_KEY, rateProxyKey: process.env.RATE_PROXY_KEY, tls });
  server.listen(Number(GATEWAY_PORT || 8080));
  const shutdown = () => {
    const timeout = setTimeout(() => server.closeAllConnections(), 10_000).unref();
    server.close(() => clearTimeout(timeout));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { gateway };
