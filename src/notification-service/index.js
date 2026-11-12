'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const amqp = require('amqplib');
const { NotificationStore } = require('./notification-logic');
const config = require('./config');
const { authenticateRequest } = require('./auth');

const SERVICE_NAME = config.SERVICE_NAME;
const PORT = config.PORT;
const RABBITMQ = config.RABBITMQ;
const GATEWAY_URL = config.GATEWAY_URL;
const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_RETRIES = 3;
const RECONNECT_BASE_MS = config.RECONNECT_BASE_MS;
const RECONNECT_MAX_MS = config.RECONNECT_MAX_MS;

const store = new NotificationStore();
let brokerReady = false;
let channel = null;
let connection = null;
let consumerTag = null;
let stopping = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isReconnecting = false;
const inFlightMessages = new Set();

function log(level, event, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, service: SERVICE_NAME, event, ...meta };
  console.log(JSON.stringify(entry));
}

function retryQueueName(eventType, delay) {
  return `${RABBITMQ.queue}.retry.${eventType}.${delay}`;
}

async function broadcast(notification) {
  try {
    const url = new URL('/api/v1/simulation/broadcast', GATEWAY_URL);
    const body = JSON.stringify({
      type: 'NOTIFICATION',
      service: SERVICE_NAME,
      event_type: notification.event_type,
      audience: notification.audience,
      user_id: notification.user_id,
      trip_id: notification.trip_id,
      title: notification.title,
      message: `[${notification.audience}] ${notification.title}: ${notification.message}`,
      correlation_id: notification.correlation_id,
      timestamp: notification.created_at,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': notification.correlation_id || '',
          'x-internal-key': config.INTERNAL_KEY,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    // Dashboard/Gateway có thể chưa mở; thông báo vẫn được lưu trong bộ nhớ service.
  }
}

async function handleEnvelope(envelope) {
  const result = store.handleEnvelope(envelope);
  if (result.duplicate) {
    log('info', 'notification_duplicate_ignored', { event_id: envelope.event_id });
    return;
  }
  for (const notification of result.notifications) {
    log('info', 'notification_sent', {
      event_id: notification.event_id,
      event_type: notification.event_type,
      audience: notification.audience,
      user_id: notification.user_id,
      trip_id: notification.trip_id,
      message: notification.message,
      correlation_id: notification.correlation_id,
    });
    await broadcast(notification);
  }
}

async function setupTopology(ch) {
  await ch.assertExchange(RABBITMQ.exchange, 'topic', { durable: true });
  await ch.assertExchange(RABBITMQ.dlx, 'topic', { durable: true });
  await ch.assertQueue(RABBITMQ.dlq, { durable: true });
  await ch.bindQueue(RABBITMQ.dlq, RABBITMQ.dlx, '#');

  await ch.assertQueue(RABBITMQ.queue, {
    durable: true,
    deadLetterExchange: RABBITMQ.dlx,
    deadLetterRoutingKey: 'notification.event.dlq',
  });
  await ch.bindQueue(RABBITMQ.queue, RABBITMQ.exchange, '#');
}

async function ensureRetryQueue(ch, eventType, delay) {
  const queue = retryQueueName(eventType, delay);
  await ch.assertQueue(queue, {
    durable: true,
    messageTtl: delay,
    deadLetterExchange: RABBITMQ.exchange,
    deadLetterRoutingKey: eventType,
  });
  return queue;
}

async function processMessage(msg, ch) {
  if (!msg || !ch) return;

  let envelope;
  try {
    if (msg.content.length > 65536) throw new Error('payload exceeds 64KB');
    envelope = JSON.parse(msg.content.toString('utf8'));
    if (!envelope || !envelope.event_id || !envelope.event_type || !envelope.payload) {
      throw new Error('invalid envelope');
    }
  } catch (err) {
    log('error', 'poison_message_rejected', { reason: err.message });
    try { ch.nack(msg, false, false); } catch (_) {}
    return;
  }

  const correlationId = envelope.correlation_id || msg.properties.correlationId || 'no-corr-id';
  const retries = Number(msg.properties.headers?.['x-ds03-retry'] || 0);

  try {
    await handleEnvelope(envelope);
    ch.ack(msg);
  } catch (err) {
    if (retries >= MAX_RETRIES) {
      log('error', 'notification_dlq', {
        event_id: envelope.event_id,
        event_type: envelope.event_type,
        correlation_id: correlationId,
        reason: err.message,
      });
      try { ch.nack(msg, false, false); } catch (_) {}
      return;
    }

    const delay = RETRY_DELAYS[Math.min(retries, RETRY_DELAYS.length - 1)];
    try {
      const queue = await ensureRetryQueue(ch, envelope.event_type, delay);
      ch.sendToQueue(
        queue,
        msg.content,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.event_id,
          correlationId,
          headers: {
            ...(msg.properties.headers || {}),
            'x-ds03-retry': retries + 1,
            'x-ds03-last-error': String(err.message || 'error').slice(0, 200),
          },
        },
        (publishErr) => {
          try {
            if (publishErr) ch.nack(msg, false, false);
            else ch.ack(msg);
          } catch (_) {}
        }
      );
    } catch (_) {
      try { ch.nack(msg, false, false); } catch (_) {}
    }
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer || isReconnecting) return;
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempts, 5)));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
  const delay = Math.min(RECONNECT_MAX_MS, base + jitter);
  reconnectAttempts += 1;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (stopping) return;
    isReconnecting = true;
    try {
      await connectBroker();
      isReconnecting = false;
      log('info', 'reconnected');
    } catch (err) {
      isReconnecting = false;
      log('warn', 'reconnect_failed', { reason: err.message });
      scheduleReconnect();
    }
  }, delay);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

async function connectBroker() {
  if (stopping) throw new Error('Notification broker is stopping');

  const conn = await amqp.connect(RABBITMQ.url, { timeout: 5000 });
  connection = conn;
  conn.on('error', (err) => log('error', 'rabbitmq_connection_error', { reason: err.message }));
  conn.on('close', () => {
    brokerReady = false;
    channel = null;
    consumerTag = null;
    if (!stopping) scheduleReconnect();
  });

  let ch = null;
  try {
    ch = await conn.createConfirmChannel();
    channel = ch;
    ch.on('error', (err) => log('error', 'rabbitmq_channel_error', { reason: err.message }));
    ch.on('close', () => {
      if (channel === ch) channel = null;
      brokerReady = false;
      consumerTag = null;
      if (!stopping) scheduleReconnect();
    });

    await setupTopology(ch);
    await ch.prefetch(RABBITMQ.prefetch);
    const consumer = await ch.consume(RABBITMQ.queue, (msg) => {
      if (!msg) return;
      const promise = processMessage(msg, ch).catch((err) => {
        log('error', 'notification_handler_crash', { reason: err.message });
      });
      inFlightMessages.add(promise);
      promise.finally(() => inFlightMessages.delete(promise));
    });
    consumerTag = consumer.consumerTag;
    brokerReady = true;
    reconnectAttempts = 0;
    log('info', 'consumer_started', { queue: RABBITMQ.queue });
  } catch (err) {
    brokerReady = false;
    if (channel === ch) channel = null;
    consumerTag = null;
    if (ch) {
      try { await ch.close(); } catch (_) {}
    }
    try { await conn.close(); } catch (_) {}
    connection = null;
    throw err;
  }
}

function sendJson(res, status, data, error = null, correlationId = '') {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-correlation-id': correlationId,
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({
    success: status >= 200 && status < 400,
    data,
    error,
    meta: { correlation_id: correlationId, timestamp: new Date().toISOString() },
  }));
}

function createNotificationServer() {
  return http.createServer(async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || `corr_${crypto.randomUUID()}`;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/live' || url.pathname === '/health')) {
      return sendJson(res, 200, { status: 'UP', service: SERVICE_NAME }, null, correlationId);
    }
    if (req.method === 'GET' && url.pathname === '/ready') {
      if (!brokerReady) {
        return sendJson(res, 503, { ready: false, reason: 'BROKER_NOT_READY' }, { code: 'NOT_READY' }, correlationId);
      }
      return sendJson(res, 200, { ready: true }, null, correlationId);
    }
    if (req.method === 'GET' && url.pathname === '/notifications') {
      const auth = authenticateRequest(req, url);
      if (!auth) {
        return sendJson(
          res,
          401,
          null,
          { code: 'UNAUTHORIZED', message: 'A valid JWT or internal service key is required' },
          correlationId
        );
      }
      const limit = url.searchParams.get('limit');
      const notifications = auth.internal
        ? store.list(limit, auth.userId)
        : store.listForUser(auth.userId, limit);
      return sendJson(res, 200, notifications, null, correlationId);
    }

    return sendJson(
      res,
      404,
      null,
      { code: 'NOT_FOUND', message: `Route ${req.method} ${url.pathname} not found` },
      correlationId
    );
  });
}

async function start() {
  const server = createNotificationServer();
  server.listen(PORT, () => log('info', 'http_server_started', { port: PORT }));

  try {
    await connectBroker();
  } catch (err) {
    log('warn', 'broker_startup_failed', { reason: err.message });
    scheduleReconnect();
  }

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      if (channel && consumerTag) await channel.cancel(consumerTag);
      if (channel) await channel.close();
      if (connection) await connection.close();
    } catch (_) {}
    if (inFlightMessages.size > 0) {
      await Promise.race([
        Promise.allSettled(Array.from(inFlightMessages)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    log('error', 'startup_failed', { reason: err.message });
    process.exit(1);
  });
}

module.exports = {
  createNotificationServer,
  start,
  handleEnvelope,
  store,
  __test: {
    connectBroker,
    scheduleReconnect,
    processMessage,
    state: () => ({
      brokerReady,
      channel,
      connection,
      consumerTag,
      stopping,
      reconnectAttempts,
      isReconnecting,
      inFlightSize: inFlightMessages.size,
    }),
  },
};
