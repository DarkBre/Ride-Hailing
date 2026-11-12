'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const amqp = require('amqplib');
const { NotificationStore } = require('./notification-logic');

const SERVICE_NAME = 'notification-service';
const PORT = Number(process.env.NOTIFICATION_SERVICE_PORT || process.env.PORT || 8006);
const RABBITMQ = {
  url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  exchange: process.env.RABBITMQ_EXCHANGE || 'trip.exchange',
  dlx: process.env.RABBITMQ_DLX || 'trip.dlx',
  dlq: process.env.RABBITMQ_DLQ || 'trip.dlq',
  queue: process.env.NOTIFICATION_QUEUE || 'notification.queue',
  prefetch: Number(process.env.RABBITMQ_PREFETCH || 10),
};
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_RETRIES = 3;

const store = new NotificationStore();
let brokerReady = false;
let channel = null;
let connection = null;
let consumerTag = null;
let stopping = false;
let reconnectTimer = null;

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

async function processMessage(msg) {
  if (!msg || !channel) return;

  let envelope;
  try {
    if (msg.content.length > 65536) throw new Error('payload exceeds 64KB');
    envelope = JSON.parse(msg.content.toString('utf8'));
    if (!envelope || !envelope.event_id || !envelope.event_type || !envelope.payload) {
      throw new Error('invalid envelope');
    }
  } catch (err) {
    log('error', 'poison_message_rejected', { reason: err.message });
    channel.nack(msg, false, false);
    return;
  }

  const correlationId = envelope.correlation_id || msg.properties.correlationId || 'no-corr-id';
  const retries = Number(msg.properties.headers?.['x-ds03-retry'] || 0);

  try {
    await handleEnvelope(envelope);
    channel.ack(msg);
  } catch (err) {
    if (retries >= MAX_RETRIES) {
      log('error', 'notification_dlq', {
        event_id: envelope.event_id,
        event_type: envelope.event_type,
        correlation_id: correlationId,
        reason: err.message,
      });
      channel.nack(msg, false, false);
      return;
    }

    const delay = RETRY_DELAYS[Math.min(retries, RETRY_DELAYS.length - 1)];
    try {
      const queue = await ensureRetryQueue(channel, envelope.event_type, delay);
      channel.sendToQueue(
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
          if (publishErr) {
            channel.nack(msg, false, false);
          } else {
            channel.ack(msg);
          }
        }
      );
    } catch (_) {
      channel.nack(msg, false, false);
    }
  }
}

async function connectBroker() {
  stopping = false;
  connection = await amqp.connect(RABBITMQ.url, { timeout: 5000 });
  connection.on('error', (err) => log('error', 'rabbitmq_connection_error', { reason: err.message }));
  connection.on('close', () => {
    brokerReady = false;
    channel = null;
    consumerTag = null;
    if (!stopping) scheduleReconnect();
  });

  channel = await connection.createConfirmChannel();
  channel.on('error', (err) => log('error', 'rabbitmq_channel_error', { reason: err.message }));
  channel.on('close', () => {
    brokerReady = false;
    channel = null;
  });

  await setupTopology(channel);
  await channel.prefetch(RABBITMQ.prefetch);
  const consumer = await channel.consume(RABBITMQ.queue, (msg) => {
    if (!msg) return;
    processMessage(msg).catch((err) => log('error', 'notification_handler_crash', { reason: err.message }));
  });
  consumerTag = consumer.consumerTag;
  brokerReady = true;
  log('info', 'consumer_started', { queue: RABBITMQ.queue });
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectBroker();
      log('info', 'reconnected');
    } catch (err) {
      log('warn', 'reconnect_failed', { reason: err.message });
      scheduleReconnect();
    }
  }, 2000);
  if (reconnectTimer.unref) reconnectTimer.unref();
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
      const limit = url.searchParams.get('limit');
      return sendJson(res, 200, store.list(limit), null, correlationId);
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
    try {
      if (channel && consumerTag) await channel.cancel(consumerTag);
      if (channel) await channel.close();
      if (connection) await connection.close();
    } catch (_) {}
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
};
