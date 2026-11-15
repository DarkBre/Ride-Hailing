'use strict';

require('./test-env');
process.env.RABBITMQ_RECONNECT_BASE_MS = '10';
process.env.RABBITMQ_RECONNECT_MAX_MS = '20';
process.env.GATEWAY_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');

class FakeChannel {
  constructor() {
    this.handlers = new Map();
    this.acked = [];
    this.nacked = [];
    this.closed = false;
    this.consumerTag = `consumer_${crypto.randomUUID()}`;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event, value) {
    const handler = this.handlers.get(event);
    if (handler) handler(value);
  }

  async assertExchange() {}
  async assertQueue() {}
  async bindQueue() {}
  async prefetch() {}
  async consume() { return { consumerTag: this.consumerTag }; }
  async cancel() {}
  async close() { this.closed = true; }
  ack(message) { this.acked.push(message); }
  nack(message, allUpTo, requeue) { this.nacked.push({ message, allUpTo, requeue }); }
  sendToQueue(queue, content, options, callback) { if (callback) callback(null); }
}

function fakeConnection(channel) {
  return {
    handlers: new Map(),
    on(event, handler) { this.handlers.set(event, handler); return this; },
    emit(event, value) { const handler = this.handlers.get(event); if (handler) handler(value); },
    async createConfirmChannel() { return channel; },
    async close() {},
  };
}

const amqp = require(require.resolve('amqplib', {
  paths: [path.join(__dirname, '..', 'src', 'notification-service')],
}));
const originalConnect = amqp.connect;
let connectCalls = 0;

amqp.connect = async () => {
  connectCalls += 1;
  const channel = new FakeChannel();
  const connection = fakeConnection(channel);
  connection.channel = channel;
  return connection;
};

const { __test } = require('../src/notification-service/index');
const { PaymentBroker } = require('../src/payment-service/broker');

test.after(() => {
  amqp.connect = originalConnect;
});

test('Notification reconnects and recreates the consumer after a channel-level close', async () => {
  await __test.connectBroker();
  const firstState = __test.state();
  assert.strictEqual(firstState.brokerReady, true);
  assert(firstState.consumerTag);

  const firstConnection = firstState.connection;
  const firstChannel = firstState.channel;
  firstChannel.emit('close');

  await new Promise((resolve) => setTimeout(resolve, 120));

  const nextState = __test.state();
  assert(connectCalls >= 2, 'Expected a reconnect attempt');
  assert.strictEqual(nextState.brokerReady, true);
  assert(nextState.consumerTag, 'Consumer must be recreated');
  assert.notStrictEqual(nextState.connection, firstConnection);
});

test('Notification in-flight handler ACKs through its original channel only', async () => {
  const oldChannel = new FakeChannel();
  const envelope = {
    event_id: crypto.randomUUID(),
    event_type: 'trip.event.created',
    correlation_id: 'corr_old_channel',
    payload: {
      trip_id: crypto.randomUUID(),
      passenger_id: crypto.randomUUID(),
      estimated_fare: 45000,
    },
  };
  const message = {
    content: Buffer.from(JSON.stringify(envelope)),
    properties: { headers: {}, correlationId: 'corr_old_channel' },
  };

  await __test.processMessage(message, oldChannel);
  assert.strictEqual(oldChannel.acked.length, 1);
  assert.strictEqual(oldChannel.nacked.length, 0);
});

test('Payment legacy binding cleanup uses a throwaway channel and survives 404s', async () => {
  const broker = new PaymentBroker({ url: 'amqp://unused' });
  let mainUnbindCalls = 0;
  broker.channel = {
    unbindQueue() {
      mainUnbindCalls += 1;
      throw new Error('main channel must not be used');
    },
  };

  const cleanupChannel = {
    unbindCalls: 0,
    closed: false,
    async unbindQueue() {
      this.unbindCalls += 1;
      throw new Error('404 no binding');
    },
    async close() {
      this.closed = true;
    },
  };
  broker.connection = {
    async createChannel() {
      return cleanupChannel;
    },
  };

  await broker.cleanupLegacyBindings();
  assert.strictEqual(mainUnbindCalls, 0);
  assert.strictEqual(cleanupChannel.unbindCalls, 2);
  assert.strictEqual(cleanupChannel.closed, true);
});

test('Payment reconnect uses bounded retries rather than a rapid infinite loop', async () => {
  const broker = new PaymentBroker({
    url: 'amqp://unused',
    reconnectDelayBaseMs: 10,
    reconnectDelayMaxMs: 20,
  });
  let attempts = 0;
  broker.connect = async () => {
    attempts += 1;
    throw new Error('broker down');
  };

  broker.scheduleReconnect();
  await new Promise((resolve) => setTimeout(resolve, 90));
  broker.isStopping = true;
  if (broker.reconnectTimer) clearTimeout(broker.reconnectTimer);

  assert(attempts >= 1);
  assert(broker.reconnectAttempts >= 1);
  assert(broker.reconnectAttempts <= 10, 'Backoff attempts must remain bounded');
});
