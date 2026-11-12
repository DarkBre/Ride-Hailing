'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { OutboxWorker } = require('../src/payment-service/outbox');
const { PaymentBroker } = require('../src/payment-service/broker');

function outboxRow(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    aggregate_type: 'PAYMENT',
    aggregate_id: crypto.randomUUID(),
    event_type: 'payment.event.hold_success',
    payload: JSON.stringify({ trip_id: crypto.randomUUID(), amount: 45000 }),
    correlation_id: 'corr_outbox_test',
    retry_count: 0,
    created_at: new Date().toISOString(),
    status: 'PENDING',
    locked_by: null,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    last_error: null,
    ...overrides,
  };
}

class OutboxMockPool {
  constructor(rows = []) {
    this.rows = rows;
    this.claimCalls = 0;
  }

  eligible(row) {
    if (row.status === 'PENDING') {
      return !row.next_attempt_at || Date.parse(row.next_attempt_at) <= Date.now();
    }
    if (row.status === 'PUBLISHING') {
      return row.lease_expires_at && Date.parse(row.lease_expires_at) <= Date.now();
    }
    return false;
  }

  async query(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ');

    if (s.includes('UPDATE outbox_events') && s.includes('SET retry_count = $1')) {
      const [retryCount, status, id, leaseToken, delaySeconds, lastError] = params;
      const row = this.rows.find((item) => item.id === id);
      if (!row || (row.locked_by !== leaseToken && row.locked_by !== null)) return { rowCount: 0, rows: [] };
      row.retry_count = retryCount;
      row.status = status;
      row.locked_by = null;
      row.last_error = lastError;
      row.next_attempt_at = status === 'PENDING'
        ? new Date(Date.now() + Number(delaySeconds) * 1000).toISOString()
        : null;
      return { rowCount: 1, rows: [{ id }] };
    }

    if (s.includes('UPDATE outbox_events') && s.includes("SET status = 'PENDING', retry_count = 0")) {
      const limit = params[0] || 20;
      const failed = this.rows.filter((row) => row.status === 'FAILED').slice(0, limit);
      for (const row of failed) {
        row.status = 'PENDING';
        row.retry_count = 0;
        row.next_attempt_at = new Date().toISOString();
        row.locked_by = null;
        row.last_error = null;
      }
      return { rowCount: failed.length, rows: failed.map((row) => ({ id: row.id })) };
    }

    if (s.includes('UPDATE outbox_events') && s.includes("SET status = 'PENDING', locked_by = NULL")) {
      const stale = this.rows.filter((row) => row.status === 'PUBLISHING'
        && row.lease_expires_at && Date.parse(row.lease_expires_at) <= Date.now());
      for (const row of stale) {
        row.status = 'PENDING';
        row.locked_by = null;
        row.next_attempt_at = new Date().toISOString();
      }
      return { rowCount: stale.length, rows: [] };
    }

    if (s.includes('UPDATE outbox_events') && s.includes('FOR UPDATE SKIP LOCKED')) {
      this.claimCalls++;
      const leaseToken = params[0];
      const batchSize = Number(params[2]) || 20;
      const claimed = this.rows.filter((row) => this.eligible(row)).slice(0, batchSize);
      for (const row of claimed) {
        row.status = 'PUBLISHING';
        row.locked_by = leaseToken;
        row.lease_expires_at = new Date(Date.now() + 30000).toISOString();
      }
      return { rowCount: claimed.length, rows: claimed.map((row) => ({ ...row })) };
    }

    if (s.includes('UPDATE outbox_events') && s.includes("SET status = 'PUBLISHED'")) {
      const [id, leaseToken] = params;
      const row = this.rows.find((item) => item.id === id);
      if (!row || (row.locked_by !== leaseToken && row.locked_by !== null)) return { rowCount: 0, rows: [] };
      row.status = 'PUBLISHED';
      row.locked_by = null;
      row.next_attempt_at = null;
      row.last_error = null;
      return { rowCount: 1, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  }
}

class RecordingBroker {
  constructor() {
    this.calls = [];
    this.failures = 0;
    this.error = null;
  }

  isReady() {
    return true;
  }

  async publish(envelope) {
    this.calls.push(envelope);
    if (this.error) throw this.error;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('simulated confirm failure');
    }
    return { published: true };
  }
}

test('Outbox: successful claim and publish marks PUBLISHED', async () => {
  const row = outboxRow();
  const pool = new OutboxMockPool([row]);
  const broker = new RecordingBroker();
  const worker = new OutboxWorker(pool, broker, { workerId: 'w1' });

  const count = await worker.flushPending();
  assert.strictEqual(count, 1);
  assert.strictEqual(row.status, 'PUBLISHED');
  assert.strictEqual(broker.calls.length, 1);
});

test('Outbox: unroutable publish stays PENDING with backoff and last_error', async () => {
  const row = outboxRow();
  const pool = new OutboxMockPool([row]);
  const broker = new RecordingBroker();
  broker.error = new Error('RabbitMQ message was unroutable (basic.return)');
  const worker = new OutboxWorker(pool, broker, { workerId: 'w2' });

  const count = await worker.flushPending();
  assert.strictEqual(count, 0);
  assert.strictEqual(row.status, 'PENDING');
  assert.strictEqual(row.retry_count, 1);
  assert.match(row.last_error, /unroutable/);
  assert(Date.parse(row.next_attempt_at) > Date.now());
});

test('Outbox: broker unavailable remains recoverable', async () => {
  const row = outboxRow();
  const pool = new OutboxMockPool([row]);
  const worker = new OutboxWorker(pool, null, { workerId: 'w3' });

  const count = await worker.flushPending();
  assert.strictEqual(count, 0);
  assert.strictEqual(row.status, 'PENDING');
  assert.strictEqual(row.retry_count, 1);
  assert(row.last_error);
});

test('Outbox: publisher confirmation failure is retried, then recovers', async () => {
  const row = outboxRow();
  const pool = new OutboxMockPool([row]);
  const broker = new RecordingBroker();
  broker.failures = 1;
  const worker = new OutboxWorker(pool, broker, { workerId: 'w4' });

  const first = await worker.flushPending();
  assert.strictEqual(first, 0);
  assert.strictEqual(row.status, 'PENDING');
  assert.strictEqual(row.retry_count, 1);

  row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
  const second = await worker.flushPending();
  assert.strictEqual(second, 1);
  assert.strictEqual(row.status, 'PUBLISHED');
});

test('Outbox: malformed payload is marked FAILED and does not block the next event', async () => {
  const bad = outboxRow({ payload: '{not-json' });
  const good = outboxRow();
  const pool = new OutboxMockPool([bad, good]);
  const broker = new RecordingBroker();
  const worker = new OutboxWorker(pool, broker, { workerId: 'w5' });

  const count = await worker.flushPending();
  assert.strictEqual(count, 1);
  assert.strictEqual(bad.status, 'FAILED');
  assert.match(bad.last_error, /Malformed payload/);
  assert.strictEqual(good.status, 'PUBLISHED');
  assert.strictEqual(broker.calls.length, 1);
});

test('Outbox: two workers do not claim and publish the same row', async () => {
  const row = outboxRow();
  const pool = new OutboxMockPool([row]);
  const broker = new RecordingBroker();
  const worker1 = new OutboxWorker(pool, broker, { workerId: 'wa' });
  const worker2 = new OutboxWorker(pool, broker, { workerId: 'wb' });

  const [a, b] = await Promise.all([worker1.flushPending(), worker2.flushPending()]);
  assert.strictEqual(a + b, 1);
  assert.strictEqual(broker.calls.length, 1);
  assert.strictEqual(row.status, 'PUBLISHED');
});

test('Outbox: requeueFailed makes FAILED rows recoverable', async () => {
  const row = outboxRow({ status: 'FAILED', retry_count: 5, last_error: 'boom' });
  const pool = new OutboxMockPool([row]);
  const worker = new OutboxWorker(pool, new RecordingBroker(), { workerId: 'w6' });

  const count = await worker.requeueFailed();
  assert.strictEqual(count, 1);
  assert.strictEqual(row.status, 'PENDING');
  assert.strictEqual(row.retry_count, 0);
  assert.strictEqual(row.last_error, null);
});

class MockConfirmChannel {
  constructor() {
    this.handlers = new Map();
    this.returned = false;
    this.confirmError = null;
    this.lastPublish = null;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event, value) {
    const handler = this.handlers.get(event);
    if (handler) handler(value);
  }

  publish(exchange, routingKey, content, options, callback) {
    this.lastPublish = { exchange, routingKey, content, options };
    if (this.returned) {
      this.emit('return', { properties: { messageId: options.messageId } });
    }
    callback(this.confirmError);
    return true;
  }
}

function testBrokerWith(channel) {
  const broker = new PaymentBroker({ url: 'amqp://unused' });
  broker.channel = channel;
  broker._wireChannel(channel);
  return broker;
}

test('PaymentBroker.publish: confirms routed messages', async () => {
  const channel = new MockConfirmChannel();
  const broker = testBrokerWith(channel);
  const result = await broker.publish({
    event_id: crypto.randomUUID(),
    event_type: 'payment.event.hold_success',
    correlation_id: 'corr_route_ok',
    payload: { trip_id: crypto.randomUUID() },
  });
  assert.strictEqual(result.published, true);
  assert.strictEqual(channel.lastPublish.options.mandatory, true);
});

test('PaymentBroker.publish: rejects basic.return unroutable messages', async () => {
  const channel = new MockConfirmChannel();
  channel.returned = true;
  const broker = testBrokerWith(channel);
  await assert.rejects(
    broker.publish({
      event_id: crypto.randomUUID(),
      event_type: 'payment.event.hold_success',
      correlation_id: 'corr_route_fail',
      payload: { trip_id: crypto.randomUUID() },
    }),
    /unroutable/
  );
});

test('PaymentBroker.publish: rejects publisher confirmation failure', async () => {
  const channel = new MockConfirmChannel();
  channel.confirmError = new Error('broker nack');
  const broker = testBrokerWith(channel);
  await assert.rejects(
    broker.publish({
      event_id: crypto.randomUUID(),
      event_type: 'payment.event.hold_success',
      correlation_id: 'corr_confirm_fail',
      payload: { trip_id: crypto.randomUUID() },
    }),
    /broker nack/
  );
});

test('PaymentBroker.publish: rejects when channel is unavailable', async () => {
  const broker = new PaymentBroker({ url: 'amqp://unused' });
  await assert.rejects(
    broker.publish({ event_id: crypto.randomUUID(), event_type: 'x', payload: {} }),
    /not ready/
  );
});
