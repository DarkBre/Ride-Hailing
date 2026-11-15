'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const { getPool, initDb, healthCheck, closeDb } = require('./db');
const { PaymentBroker } = require('./broker');
const { OutboxWorker } = require('./outbox');
const { handleBrokerEvent, getWallet, topupWallet } = require('./payment-logic');
const { resolveWalletTarget } = require('./auth');

let server = null;
let broker = null;
let outboxWorker = null;
let isShuttingDown = false;

function sendJson(res, statusCode, data, error = null, correlationId = '') {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Correlation-ID': correlationId,
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

async function notifyGateway(eventData) {
  try {
    const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
    const parsed = new URL('/api/v1/simulation/broadcast', gatewayUrl);
    const bodyStr = JSON.stringify(eventData);

    const req = http.request(
      parsed,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'X-Correlation-ID': eventData.correlation_id || '',
          'X-Internal-Key': config.INTERNAL_KEY,
        },
        timeout: 1000,
      },
      (res) => {
        res.on('data', () => {});
      }
    );

    req.on('error', () => {});
    req.write(bodyStr);
    req.end();
  } catch (_) {}
}

function createPaymentHttpServer() {
  return http.createServer(async (req, res) => {
    const corrId = req.headers['x-correlation-id'] || `corr_${crypto.randomUUID()}`;
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    console.log(`[${new Date().toISOString()}] [${corrId}] [payment-service] [INFO] ${method} ${pathname}`);

    // Liveness & health probes
    if (method === 'GET' && (pathname === '/live' || pathname === '/health')) {
      return sendJson(res, 200, { status: 'UP', service: config.SERVICE_NAME }, null, corrId);
    }

    // Readiness probe
    if (method === 'GET' && pathname === '/ready') {
      try {
        await healthCheck();
        const brokerOk = broker ? broker.isReady() : false;
        if (brokerOk) {
          return sendJson(res, 200, { ready: true }, null, corrId);
        } else {
          return sendJson(res, 503, { ready: false, reason: 'BROKER_NOT_READY' }, { code: 'NOT_READY' }, corrId);
        }
      } catch (err) {
        return sendJson(res, 503, { ready: false, reason: err.message }, { code: 'DB_UNAVAILABLE' }, corrId);
      }
    }

    // Wallet balance query endpoints
    if (pathname === '/wallet' || pathname === '/api/v1/payments/wallet') {
      if (method === 'GET') {
        try {
          const requestedUserId = parsedUrl.searchParams.get('user_id');
          const { userId } = await resolveWalletTarget(req, requestedUserId);
          const wallet = await getWallet(userId);
          return sendJson(res, 200, wallet, null, corrId);
        } catch (err) {
          const status = err.status || 500;
          return sendJson(
            res,
            status,
            null,
            { code: err.code || 'INTERNAL_ERROR', message: err.message },
            corrId
          );
        }
      }
    }

    // Topup endpoints
    if (
      pathname === '/wallet/topup' ||
      pathname === '/topup' ||
      pathname === '/api/v1/payments/topup' ||
      pathname === '/api/v1/payments/wallet/topup'
    ) {
      if (method === 'POST') {
        // Read request body safely
        const chunks = [];
        let bodyBytes = 0;
        for await (const chunk of req) {
          bodyBytes += chunk.length;
          if (bodyBytes > 16384) {
            return sendJson(res, 413, null, { code: 'PAYLOAD_TOO_LARGE' }, corrId);
          }
          chunks.push(chunk);
        }

        let body = {};
        try {
          if (chunks.length > 0) {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          }
        } catch (_) {
          return sendJson(res, 400, null, { code: 'INVALID_JSON', message: 'Malformed JSON payload' }, corrId);
        }

        const amount = Number(body.amount);
        if (isNaN(amount) || amount <= 0) {
          return sendJson(
            res,
            400,
            null,
            { code: 'INVALID_AMOUNT', message: 'Amount must be a positive number' },
            corrId
          );
        }

        try {
          const requestedUserId = typeof body.user_id === 'string' ? body.user_id : null;
          const { userId: targetUserId } = await resolveWalletTarget(req, requestedUserId);
          const idempotencyKey =
            req.headers['idempotency-key'] || body.request_key || body.idempotency_key || crypto.randomUUID();

          const updatedWallet = await topupWallet(targetUserId, amount, idempotencyKey);

          notifyGateway({
            type: 'WALLET_TOPUP',
            service: config.SERVICE_NAME,
            userId: targetUserId,
            amount,
            newBalance: updatedWallet.balance,
            correlation_id: corrId,
          });

          return sendJson(res, 200, updatedWallet, null, corrId);
        } catch (err) {
          const status = err.status || 500;
          if (status >= 500) {
            console.error(`[${new Date().toISOString()}] [${corrId}] [payment-service] [ERROR] Topup error:`, err);
          }
          return sendJson(
            res,
            status,
            null,
            { code: err.code || 'TOPUP_FAILED', message: err.message },
            corrId
          );
        }
      }
    }

    // 404 for unknown routes
    sendJson(res, 404, null, { code: 'NOT_FOUND', message: `Route ${method} ${pathname} not found` }, corrId);
  });
}

async function start() {
  console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Starting Simulated Payment Microservice...`);

  // 1. Initialize PostgreSQL schema
  try {
    await initDb();
    console.log(`[${new Date().toISOString()}] [payment-service] [INFO] PostgreSQL payment_db schema initialized.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [payment-service] [WARN] Database init error:`, err.message);
  }

  // 2. Connect to RabbitMQ & setup topology
  broker = new PaymentBroker();
  try {
    await broker.connect();
    console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Connected to RabbitMQ at ${config.RABBITMQ.url}`);

    // Wrap event handler to also notify Gateway for real-time dashboard updates
    const wrappedHandler = async (envelope) => {
      const result = await handleBrokerEvent(envelope);
      notifyGateway({
        type: 'PAYMENT_EVENT_PROCESSED',
        service: config.SERVICE_NAME,
        event_type: envelope.event_type,
        event_id: envelope.event_id,
        correlation_id: envelope.correlation_id,
        result,
      });
      return result;
    };

    // Start Consumer for payment events
    await broker.startConsumer(wrappedHandler);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [payment-service] [WARN] RabbitMQ startup error:`, err.message);
    broker.scheduleReconnect();
  }

  // 3. Start Transactional Outbox Worker
  outboxWorker = new OutboxWorker(getPool(), broker);
  outboxWorker.start();

  // 4. Start HTTP Server
  server = createPaymentHttpServer();
  server.listen(config.PORT, () => {
    console.log(`[${new Date().toISOString()}] [payment-service] [INFO] HTTP Server listening on port ${config.PORT}`);
  });

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Received ${signal}. Shutting down gracefully...`);

    if (outboxWorker) outboxWorker.stop();
    if (broker) await broker.close();

    if (server) {
      server.close(() => {
        console.log(`[${new Date().toISOString()}] [payment-service] [INFO] HTTP Server closed.`);
      });
    }

    await closeDb();
    console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Payment Service shutdown complete.`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error(`[${new Date().toISOString()}] [payment-service] [FATAL] Startup fatal error:`, err);
    process.exit(1);
  });
}

module.exports = {
  createPaymentHttpServer,
  start,
};
