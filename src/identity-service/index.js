'use strict';

const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');
const config = require('./config');
const { initDatabase } = require('./db');
const { createRoutes } = require('./routes');

function createIdentityService(options = {}) {
  const port = options.port || config.PORT;
  const db = initDatabase(options.dbPath || null);
  const routes = createRoutes(db);

  const server = http.createServer(async (req, res) => {
    // 1. CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-ID, X-Internal-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Correlation ID & Metadata
    const correlationId = req.headers['x-correlation-id'] || `corr_${crypto.randomBytes(8).toString('hex')}`;
    res.setHeader('X-Correlation-ID', correlationId);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // Chuẩn format JSON theo CONTRACTS.md Section 1.1
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

    // 3. Khớp route
    const matched = routes.find((r) => r.method === method && r.path === pathname);
    if (!matched) {
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
      const data = await matched.handler({
        req,
        res,
        pathname,
        query: parsedUrl.query,
        body,
        headers: req.headers,
        correlationId,
      });

      if (!res.writableEnded) {
        sendJson(matched.status || 200, true, data, null);
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
    start() {
      return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => {
          console.log(`[IDENTITY-SERVICE] Đang chạy tại http://0.0.0.0:${port} (Port ${port})`);
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        db.close();
        server.close(resolve);
      });
    },
  };
}

// Chạy trực tiếp qua node src/identity-service/index.js
if (require.main === module) {
  const service = createIdentityService();
  service.start();
}

module.exports = {
  createIdentityService,
};
