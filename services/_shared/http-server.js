'use strict';

const http = require('node:http');
const url = require('node:url');
const auth = require('./auth');
const config = require('./config');
const { correlationId } = require('./id');

class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function createServer({ serviceName, port, routes = [], logger }) {
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
    const corrId = req.headers['x-correlation-id'] || correlationId();
    res.setHeader('X-Correlation-ID', corrId);

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    const sendJson = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // 3. Khớp Route
    let matchedRoute = null;
    let params = {};

    for (const r of routes) {
      if (r.method !== method) continue;

      const routeParts = r.path.split('/');
      const pathParts = pathname.split('/');

      if (routeParts.length !== pathParts.length) continue;

      let match = true;
      const extractedParams = {};

      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) {
          extractedParams[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (routeParts[i] !== pathParts[i]) {
          match = false;
          break;
        }
      }

      if (match) {
        matchedRoute = r;
        params = extractedParams;
        break;
      }
    }

    if (!matchedRoute) {
      sendJson(404, {
        error: { code: 'NOT_FOUND', message: `Không tìm thấy endpoint ${method} ${pathname}` },
        correlationId: corrId,
      });
      return;
    }

    // 4. Parse Body
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const raw = Buffer.concat(buffers).toString('utf8');
        if (raw.trim().length > 0) {
          body = JSON.parse(raw);
        }
      } catch (err) {
        sendJson(400, {
          error: { code: 'INVALID_JSON', message: 'Dữ liệu JSON không hợp lệ' },
          correlationId: corrId,
        });
        return;
      }
    }

    // 5. Auth Middleware
    let user = null;
    if (matchedRoute.auth === 'internal') {
      const key = req.headers['x-internal-key'];
      if (!key || key !== config.INTERNAL_KEY) {
        sendJson(401, {
          error: { code: 'UNAUTHORIZED_INTERNAL', message: 'Yêu cầu khóa giao tiếp nội bộ hợp lệ' },
          correlationId: corrId,
        });
        return;
      }
    } else if (matchedRoute.auth === 'user') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      user = auth.verifyToken(token);

      if (!user) {
        sendJson(401, {
          error: { code: 'UNAUTHENTICATED', message: 'Token xác thực không hợp lệ hoặc đã hết hạn' },
          correlationId: corrId,
        });
        return;
      }

      if (matchedRoute.roles && matchedRoute.roles.length > 0 && !matchedRoute.roles.includes(user.role)) {
        sendJson(403, {
          error: { code: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện hành động này' },
          correlationId: corrId,
        });
        return;
      }
    }

    // 6. Build Context & Run Handler
    const ctx = {
      req,
      res,
      pathname,
      query: parsedUrl.query,
      params,
      body,
      headers: req.headers,
      user,
      correlationId: corrId,
      idempotencyKey: req.headers['idempotency-key'] || null,
      logger,
    };

    try {
      const result = await matchedRoute.handler(ctx);
      if (!res.writableEnded) {
        sendJson(matchedRoute.status || 200, result);
      }
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || 'INTERNAL_SERVER_ERROR';
      const message = err.message || 'Lỗi xử lý nội bộ';

      if (status >= 500 && logger) {
        logger.error('request_exception', { error: message, stack: err.stack, correlationId: corrId });
      }

      sendJson(status, {
        error: { code, message, details: err.details },
        correlationId: corrId,
      });
    }
  });

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => {
          if (logger) {
            logger.info('service_started', { service: serviceName, port });
          }
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(resolve);
      });
    },
    raw: server,
  };
}

module.exports = {
  createServer,
  HttpError,
};
