'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const config = require('./config');

const sseClients = new Set();

function broadcastSimulationEvent(eventData) {
  const payload = `data: ${JSON.stringify(eventData)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// Heartbeat to keep SSE clients alive
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': heartbeat\n\n');
    } catch (_) {
      sseClients.delete(client);
    }
  }
}, 15000).unref();

function sendJson(res, statusCode, data, error = null, correlationId = '') {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Correlation-ID': correlationId,
    'Access-Control-Allow-Origin': config.CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Correlation-ID, Idempotency-Key, X-Internal-Key, X-User-Id',
    'Access-Control-Expose-Headers': 'X-Correlation-ID',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify({
      success: statusCode >= 200 && statusCode < 400,
      data,
      error,
      meta: {
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
      },
    })
  );
}

function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', config.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-ID, Idempotency-Key, X-Internal-Key, X-User-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-ID');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function resolveUpstreamRoute(pathname, method) {
  // Strip /api/v1 prefix
  const route = pathname.replace(/^\/api\/v1(?=\/|$)/, '');

  if (route.startsWith('/auth')) {
    return { target: config.SERVICES.identity, upstreamPath: route };
  }

  if (route.startsWith('/drivers')) {
    let upstreamPath = route;
    if (route === '/drivers/available') {
      upstreamPath = '/drivers/nearby';
    }
    return { target: config.SERVICES.driver, upstreamPath, isDriver: true };
  }

  if (route.startsWith('/trips')) {
    return { target: config.SERVICES.trip, upstreamPath: route };
  }

  if (route.startsWith('/matching')) {
    return { target: config.SERVICES.matching, upstreamPath: route };
  }

  if (route.startsWith('/payments')) {
    let upstreamPath = route.replace(/^\/payments/, '');
    if (upstreamPath === '' || upstreamPath === '/') {
      upstreamPath = '/wallet';
    }
    return { target: config.SERVICES.payment, upstreamPath };
  }

  return null;
}

function createGatewayServer() {
  return http.createServer(async (req, res) => {
    if (handleCors(req, res)) return;

    const suppliedCorrId = req.headers['x-correlation-id'];
    const corrId =
      typeof suppliedCorrId === 'string' && /^[\w.-]{1,100}$/.test(suppliedCorrId)
        ? suppliedCorrId
        : `corr_${crypto.randomUUID()}`;

    res.setHeader('X-Correlation-ID', corrId);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    console.log(`[${new Date().toISOString()}] [${corrId}] [api-gateway] [INFO] ${method} ${pathname}`);

    // Health probes
    if (pathname === '/health' || pathname === '/live') {
      return sendJson(res, 200, { status: 'UP', service: config.SERVICE_NAME }, null, corrId);
    }

    if (pathname === '/ready') {
      return sendJson(res, 200, { ready: true }, null, corrId);
    }

    // SSE Stream for Web Simulation Dashboard
    if (pathname === '/api/v1/simulation/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': config.CORS_ORIGIN,
        'X-Correlation-ID': corrId,
      });

      res.write(`: connected\n\n`);
      res.write(
        `data: ${JSON.stringify({
          type: 'SYSTEM',
          message: 'Connected to API Gateway Simulation Stream',
          correlation_id: corrId,
          timestamp: new Date().toISOString(),
        })}\n\n`
      );

      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // Broadcast endpoint for internal services or test runners
    if (pathname === '/api/v1/simulation/broadcast' && method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const eventData = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        broadcastSimulationEvent({
          ...eventData,
          correlation_id: eventData.correlation_id || corrId,
          timestamp: new Date().toISOString(),
        });
        return sendJson(res, 200, { broadcasted: true }, null, corrId);
      } catch (err) {
        return sendJson(res, 400, null, { code: 'INVALID_JSON', message: err.message }, corrId);
      }
    }

    // Upstream Resolution
    const resolved = resolveUpstreamRoute(pathname, method);
    if (!resolved) {
      return sendJson(
        res,
        404,
        null,
        { code: 'NOT_FOUND', message: `Cannot ${method} ${pathname}` },
        corrId
      );
    }

    const { target, upstreamPath, isDriver } = resolved;
    let targetUrl;
    try {
      targetUrl = new URL(upstreamPath + parsedUrl.search, target);
    } catch (urlErr) {
      return sendJson(
        res,
        500,
        null,
        { code: 'GATEWAY_ROUTING_ERROR', message: urlErr.message },
        corrId
      );
    }

    // Build headers to pass to upstream
    const forwardHeaders = {
      ...req.headers,
      host: targetUrl.host,
      'x-correlation-id': corrId,
      'x-forwarded-for': req.socket.remoteAddress || '',
      'x-forwarded-proto': 'http',
    };

    if (isDriver && config.DRIVER_INTERNAL_KEY) {
      forwardHeaders['x-internal-key'] = config.DRIVER_INTERNAL_KEY;
    }

    const proxyReq = http.request(
      targetUrl,
      {
        method,
        headers: forwardHeaders,
        timeout: config.REQUEST_TIMEOUT_MS,
      },
      (upstreamRes) => {
        // Broadcast trace event to Web Dashboard
        broadcastSimulationEvent({
          type: 'HTTP_TRACE',
          service: targetUrl.hostname,
          method,
          path: upstreamPath,
          statusCode: upstreamRes.statusCode,
          correlation_id: corrId,
          timestamp: new Date().toISOString(),
        });

        // Set response headers
        res.setHeader('Access-Control-Allow-Origin', config.CORS_ORIGIN);
        res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-ID');
        res.setHeader('X-Correlation-ID', corrId);

        for (const [key, val] of Object.entries(upstreamRes.headers)) {
          if (!key.toLowerCase().startsWith('access-control-')) {
            res.setHeader(key, val);
          }
        }

        res.writeHead(upstreamRes.statusCode);
        pipeline(upstreamRes, res, (err) => {
          if (err) {
            console.error(`[${new Date().toISOString()}] [${corrId}] [api-gateway] [ERROR] Pipeline error:`, err.message);
          }
        });
      }
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error(`Upstream timeout after ${config.REQUEST_TIMEOUT_MS}ms`));
      if (!res.headersSent) {
        sendJson(
          res,
          504,
          null,
          { code: 'GATEWAY_TIMEOUT', message: `Target service ${targetUrl.hostname} timed out` },
          corrId
        );
      }
    });

    proxyReq.on('error', (err) => {
      console.error(
        `[${new Date().toISOString()}] [${corrId}] [api-gateway] [ERROR] Upstream ${targetUrl.href} error:`,
        err.message
      );
      if (!res.headersSent) {
        sendJson(
          res,
          502,
          null,
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: `Service at ${targetUrl.hostname} is unavailable or unreachable`,
          },
          corrId
        );
      }
    });

    // Pipe client request body to upstream
    pipeline(req, proxyReq, (err) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] [${corrId}] [api-gateway] [ERROR] Request pipe error:`, err.message);
      }
    });
  });
}

function start() {
  const server = createGatewayServer();
  server.listen(config.PORT, () => {
    console.log(`[${new Date().toISOString()}] [api-gateway] [INFO] API Gateway running on port ${config.PORT}`);
    console.log(`[${new Date().toISOString()}] [api-gateway] [INFO] Upstream routing map:`);
    for (const [key, url] of Object.entries(config.SERVICES)) {
      console.log(`  - ${key.padEnd(10)}: ${url}`);
    }
  });

  const shutdown = (signal) => {
    console.log(`[${new Date().toISOString()}] [api-gateway] [INFO] Received ${signal}. Closing API Gateway...`);
    server.close(() => {
      console.log(`[${new Date().toISOString()}] [api-gateway] [INFO] API Gateway closed.`);
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  start();
}

module.exports = {
  createGatewayServer,
  broadcastSimulationEvent,
  start,
};
