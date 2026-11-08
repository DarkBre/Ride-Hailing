'use strict';

const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');
const config = require('./config');
const { initDatabase } = require('./db');
const { OutboxManager } = require('./outbox');
const { SagaCoordinator } = require('./saga-coordinator');
const { createRoutes } = require('./routes');

function createTripService(options = {}) {
  const port = options.port || config.PORT;
  const db = initDatabase(options.dbPath || null);
  const outboxManager = new OutboxManager(db, { onPublish: options.onPublish || null });
  const sagaCoordinator = new SagaCoordinator(db, outboxManager);
  const routes = createRoutes(db, sagaCoordinator, outboxManager);

  const server = http.createServer(async (req, res) => {
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
          extracted[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
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

    // 4. Parse body JSON
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
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
      const code = err.code || 'INTERNAL_SERVER_ERROR';
      const message = err.message || 'Lỗi xử lý nội bộ';

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
        server.listen(port, '0.0.0.0', () => {
          console.log(`[TRIP-SERVICE] Đang chạy tại http://0.0.0.0:${port} (Port ${port})`);
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        outboxManager.stopWorker();
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
