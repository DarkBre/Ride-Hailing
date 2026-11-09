'use strict';

const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');
const config = require('./config');
const { initDatabase } = require('./db');
const { OutboxManager } = require('./outbox');
const { SagaCoordinator } = require('./saga-coordinator');
const { createRoutes } = require('./routes');
const { extractCaller } = require('./auth');

function createTripService(options = {}) {
  const port = options.port || config.PORT;
  const db = initDatabase(options.dbPath || null);
  const broker = options.onPublish === undefined && process.env.RABBITMQ_URL
    ? require('../../services/_shared/amqp').serviceBroker({
        url: process.env.RABBITMQ_URL, connect: require('amqplib').connect, queue: 'trip.queue',
        consume: body => internalEvents.handler({ body, headers: { 'x-internal-key': config.INTERNAL_KEY } }),
      })
    : null;
  const outboxManager = new OutboxManager(db, {
    onPublish: broker ? broker.publish : options.onPublish, maxRetries: broker ? Infinity : undefined,
  });
  const sagaCoordinator = new SagaCoordinator(db, outboxManager);
  const routes = createRoutes(db, sagaCoordinator, outboxManager);
  const internalEvents = routes.find(route => route.path === '/internal/events');
  let timeoutWorker;

  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 1. CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-ID, X-Internal-Key, Idempotency-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Correlation ID
    const correlationId = req.headers['x-correlation-id'] || `corr_${crypto.randomBytes(8).toString('hex')}`;
    res.setHeader('X-Correlation-ID', correlationId);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    const sendJson = (statusCode, success, data, error = null) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success,
          data,
          error,
          meta: {
            correlation_id: correlationId,
            timestamp: new Date().toISOString(),
          },
        })
      );
    };

    // 3. Khớp routes kèm path params (ví dụ: /trips/:id, /trips/:id/accept)
    let matchedRoute = null;
    let params = {};

    for (const r of routes) {
      if (r.method !== method) continue;

      const routeParts = r.path.split('/');
      const pathParts = pathname.split('/');
      if (routeParts.length !== pathParts.length) continue;

      let match = true;
      const extracted = {};

      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) {
          extracted[routeParts[i].slice(1)] = pathParts[i];
        } else if (routeParts[i] !== pathParts[i]) {
          match = false;
          break;
        }
      }

      if (match) {
        matchedRoute = r;
        params = extracted;
        break;
      }
    }

    if (!matchedRoute) {
      sendJson(404, false, null, {
        code: 'NOT_FOUND',
        message: `Endpoint ${method} ${pathname} không tồn tại`,
      });
      return;
    }
    if (process.env.DRIVER_TRIP_KEY && pathname !== '/health' && pathname !== '/internal/events') {
      const caller = extractCaller(req.headers);
      if (!caller || caller.isInvalidToken) {
        sendJson(401, false, null, { code: 'UNAUTHORIZED', message: 'Yêu cầu xác thực' });
        return;
      }
    }

    // 4. Parse body JSON
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 16_384) {
            req.resume();
            sendJson(413, false, null, { code: 'PAYLOAD_TOO_LARGE', message: 'Payload vượt giới hạn' });
            return;
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim().length > 0) {
          body = JSON.parse(raw);
        }
      } catch (_) {
        sendJson(400, false, null, {
          code: 'INVALID_JSON',
          message: 'Dữ liệu JSON không hợp lệ',
        });
        return;
      }
    }

    // 5. Thực thi handler
    try {
      const data = await matchedRoute.handler({
        req,
        res,
        pathname,
        params,
        query: parsedUrl.query,
        body,
        headers: req.headers,
        correlationId,
      });

      if (!res.writableEnded) {
        sendJson(matchedRoute.status || 200, true, data, null);
      }
    } catch (err) {
      const status = err.status || 500;
      const code = status >= 500 ? 'INTERNAL_SERVER_ERROR' : err.code || 'REQUEST_FAILED';
      const message = status >= 500 ? 'Lỗi xử lý nội bộ' : err.message;

      sendJson(status, false, null, {
        code,
        message,
      });
    }
  });

  return {
    server,
    db,
    sagaCoordinator,
    outboxManager,
    start() {
      return new Promise((resolve) => {
        outboxManager.startWorker(1000);
        if (broker) void broker.loop();
        if (process.env.DRIVER_TRIP_KEY) {
          timeoutWorker = setInterval(() => {
            try { sagaCoordinator.expireReservations(); } catch { console.error('trip-service: expiry failed'); }
          }, 500);
          timeoutWorker.unref();
        }
        server.listen(port, '0.0.0.0', () => {
          console.log(`[TRIP-SERVICE] Đang chạy tại http://0.0.0.0:${port} (Port ${port})`);
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        outboxManager.stopWorker();
        clearInterval(timeoutWorker);
        broker?.stop();
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => {
          try {
            db.close();
          } catch (_) {}
          resolve();
        });
      });
    },
  };
}

if (require.main === module) {
  const service = createTripService();
  service.start();
}

module.exports = {
  createTripService,
};
