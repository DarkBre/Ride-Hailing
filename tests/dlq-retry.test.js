'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { PaymentBroker } = require('../src/payment-service/broker');

/**
 * Mock AMQP Channel simulating RabbitMQ exchanges, delay queues, and DLQ
 */
class MockChannel {
  constructor() {
    this.publishedMessages = [];
    this.ackedMessages = [];
    this.nackedMessages = [];
    this.queues = new Map();
  }

  async assertExchange() { return {}; }
  async assertQueue(name, options = {}) {
    this.queues.set(name, options);
    return { queue: name };
  }
  async bindQueue() { return {}; }
  async prefetch() { return {}; }

  publish(exchange, routingKey, content, options, callback) {
    this.publishedMessages.push({
      exchange,
      routingKey,
      content,
      options,
    });
    if (callback) callback(null);
    return true;
  }

  ack(msg) {
    this.ackedMessages.push(msg);
  }

  nack(msg, allUpTo = false, requeue = false) {
    this.nackedMessages.push({ msg, allUpTo, requeue });
  }
}

test('DLQ & Bounded Retries with Exponential Backoff', async (t) => {
  const broker = new PaymentBroker({
    maxRetries: 3,
    retryDelays: [1000, 2000, 4000],
  });
  const mockChannel = new MockChannel();
  broker.channel = mockChannel;

  await t.test('1. Poison message (malformed JSON) bị NACK ngay sang DLQ mà không requeue', async () => {
    const poisonMsg = {
      content: Buffer.from('{ corrupt json content ...'),
      properties: {
        headers: {},
        correlationId: 'corr_poison_1',
      },
    };

    let handlerCalled = false;
    await broker._processIncomingMessage(poisonMsg, async () => {
      handlerCalled = true;
    });

    assert.strictEqual(handlerCalled, false, 'Handler nghiệp vụ không được gọi khi message hỏng');
    assert.strictEqual(mockChannel.nackedMessages.length, 1);
    assert.strictEqual(mockChannel.nackedMessages[0].requeue, false, 'Requeue phải bằng false để RabbitMQ đẩy thẳng vào DLQ');
  });

  await t.test('2. Lỗi tạm thời (Attempt 1): Lên lịch vào queue trễ 1000ms với header retry = 1', async () => {
    mockChannel.publishedMessages = [];
    mockChannel.ackedMessages = [];
    mockChannel.nackedMessages = [];

    const validEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_retry_test',
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: crypto.randomUUID(), amount: 50000 },
    };

    const msg = {
      content: Buffer.from(JSON.stringify(validEnvelope)),
      properties: {
        headers: {}, // Attempt 0
        correlationId: 'corr_retry_test',
      },
    };

    // Handler ném lỗi tạm thời
    await broker._processIncomingMessage(msg, async () => {
      throw new Error('Database connection timeout (transient)');
    });

    // Phải được publish vào queue trễ 1000ms
    assert.strictEqual(mockChannel.publishedMessages.length, 1);
    const pub = mockChannel.publishedMessages[0];
    assert.strictEqual(pub.routingKey, 'payment.queue.retry.payment.event.hold_requested.1000');
    assert.strictEqual(pub.options.headers['x-ds03-retry'], 1);
    assert.strictEqual(pub.options.headers['x-ds03-last-error'], 'Database connection timeout (transient)');

    // Message ban đầu phải được ACK khỏi queue chính để nhường chỗ
    assert.strictEqual(mockChannel.ackedMessages.length, 1);
  });

  await t.test('3. Lỗi tạm thời (Attempt 2): Lên lịch vào queue trễ 2000ms với header retry = 2', async () => {
    mockChannel.publishedMessages = [];
    mockChannel.ackedMessages = [];

    const validEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_retry_test',
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: crypto.randomUUID(), amount: 50000 },
    };

    const msg = {
      content: Buffer.from(JSON.stringify(validEnvelope)),
      properties: {
        headers: { 'x-ds03-retry': 1 }, // Attempt 1
        correlationId: 'corr_retry_test',
      },
    };

    await broker._processIncomingMessage(msg, async () => {
      throw new Error('Lock acquisition failed (transient)');
    });

    assert.strictEqual(mockChannel.publishedMessages.length, 1);
    const pub = mockChannel.publishedMessages[0];
    assert.strictEqual(pub.routingKey, 'payment.queue.retry.payment.event.hold_requested.2000');
    assert.strictEqual(pub.options.headers['x-ds03-retry'], 2);
    assert.strictEqual(mockChannel.ackedMessages.length, 1);
  });

  await t.test('4. Vượt quá Bounded Retries (Attempt 3+): NACK thẳng sang DLQ, không lặp vô hạn', async () => {
    mockChannel.publishedMessages = [];
    mockChannel.nackedMessages = [];

    const validEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_retry_exhausted',
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: crypto.randomUUID(), amount: 50000 },
    };

    const msg = {
      content: Buffer.from(JSON.stringify(validEnvelope)),
      properties: {
        headers: { 'x-ds03-retry': 3 }, // Đã thử 3 lần
        correlationId: 'corr_retry_exhausted',
      },
    };

    await broker._processIncomingMessage(msg, async () => {
      throw new Error('Persistent failure');
    });

    // Không được publish thêm lần nữa vào queue trễ
    assert.strictEqual(mockChannel.publishedMessages.length, 0);

    // Bị NACK với requeue = false -> RabbitMQ tự động đẩy vào trip.dlx -> trip.dlq
    assert.strictEqual(mockChannel.nackedMessages.length, 1);
    assert.strictEqual(mockChannel.nackedMessages[0].requeue, false);
  });
});
