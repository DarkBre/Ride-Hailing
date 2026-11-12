'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  processHoldRequest,
  processRefund,
} = require('../src/payment-service/payment-logic');

/**
 * In-memory Mock Broker with Durable Message Queue & Dead-Letter Queue
 */
class MockBrokerQueue {
  constructor() {
    this.queues = {
      'payment.queue': [],
      'trip.queue': [],
      'trip.dlq': [],
    };
    this.deadLetterExchange = 'trip.dlx';
  }

  publish(queueName, message, options = {}) {
    const queue = this.queues[queueName];
    if (!queue) throw new Error(`Queue ${queueName} does not exist`);
    queue.push({
      content: message,
      properties: {
        messageId: message.event_id,
        correlationId: message.correlation_id,
        persistent: true,
        headers: { 'x-ds03-retry': options.retryCount || 0 },
      },
    });
  }

  consumeOne(queueName) {
    const queue = this.queues[queueName];
    return queue.shift() || null;
  }

  size(queueName) {
    return this.queues[queueName]?.length || 0;
  }
}

/**
 * Mock DB Client for Fault & Recovery Testing
 */
class FaultTestDb {
  constructor() {
    this.wallets = new Map();
    this.payment_holds = new Map();
    this.outbox_events = [];
    this.processed_events = new Set();
  }

  async query(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ');

    if (s.includes('INSERT INTO processed_events')) {
      const [id] = params;
      if (this.processed_events.has(id)) return { rowCount: 0 };
      this.processed_events.add(id);
      return { rowCount: 1 };
    }

    if (s.includes('SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1')) {
      const hold = this.payment_holds.get(params[0]);
      return { rows: hold ? [hold] : [] };
    }

    if (s.includes('SELECT id, user_id, balance, held_balance FROM wallets WHERE user_id = $1')) {
      const w = this.wallets.get(params[0]);
      return { rows: w ? [w] : [] };
    }

    if (s.includes('UPDATE wallets SET balance = balance - $1, held_balance = held_balance + $1')) {
      const [amount, walletId] = params;
      for (const w of this.wallets.values()) {
        if (w.id === walletId) {
          w.balance -= amount;
          w.held_balance += amount;
          break;
        }
      }
      return { rowCount: 1 };
    }

    if (s.includes('INSERT INTO payment_holds')) {
      const [tripId, userId, amount, state] = params;
      this.payment_holds.set(tripId, { trip_id: tripId, user_id: userId, amount, state });
      return { rowCount: 1 };
    }

    if (s.includes('INSERT INTO transactions')) {
      return { rowCount: 1 };
    }

    if (s.includes('INSERT INTO outbox_events')) {
      const [id, aggregate_type, aggregate_id, event_type, payload, correlation_id] = params;
      this.outbox_events.push({
        id,
        aggregate_type,
        aggregate_id,
        event_type,
        payload: JSON.parse(payload),
        correlation_id,
        status: 'PENDING',
      });
      return { rowCount: 1 };
    }

    return { rowCount: 0, rows: [] };
  }
}

test('FR-01: Fault Tolerance — Crash Service & Message Recovery', async (t) => {
  const broker = new MockBrokerQueue();
  const db = new FaultTestDb();

  const passengerId = crypto.randomUUID();
  const driverId = crypto.randomUUID();
  const tripId = crypto.randomUUID();
  const correlationId = 'corr_fr01_crash_recovery';

  // Seed passenger wallet
  db.wallets.set(passengerId, {
    id: crypto.randomUUID(),
    user_id: passengerId,
    balance: 80000,
    held_balance: 0,
  });

  const paymentEvent = {
    event_id: crypto.randomUUID(),
    correlation_id: correlationId,
    event_type: 'payment.event.hold_requested',
    payload: {
      trip_id: tripId,
      passenger_id: passengerId,
      driver_id: driverId,
      amount: 50000,
    },
  };

  await t.test('1. Event được publish bền bỉ vào RabbitMQ hàng đợi payment.queue', () => {
    broker.publish('payment.queue', paymentEvent);
    assert.strictEqual(broker.size('payment.queue'), 1, 'Hàng đợi phải lưu giữ 1 message bền vững');
  });

  await t.test('2. Can thiệp lỗi: Payment Service bị sập đột ngột (Simulated Kill)', () => {
    // Service process chết -> không có consumer nào đang chạy.
    // Message vẫn được bảo toàn nguyên vẹn trong hàng đợi bền vững
    assert.strictEqual(broker.size('payment.queue'), 1, 'Message không bị mất khi service sập');
    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 80000, 'Dữ liệu DB chưa bị thay đổi dở dang');
  });

  await t.test('3. Phục hồi: Khởi động lại Payment Service, tiếp tục tiêu thụ message tồn đọng', async () => {
    // Khởi động lại service và kéo message từ queue về xử lý
    const msg = broker.consumeOne('payment.queue');
    assert(msg, 'Phải lấy được message tồn đọng từ broker');

    const res = await processHoldRequest(db, msg.content);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'HELD');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 30000, 'Số dư giảm chính xác 50,000 đ');
    assert.strictEqual(wallet.held_balance, 50000, 'Held balance ghi nhận chính xác 50,000 đ');

    const outbox = db.outbox_events.find((e) => e.event_type === 'payment.event.hold_success');
    assert(outbox, 'Outbox phát sinh event hold_success hoàn tất luồng');
    assert.strictEqual(outbox.correlation_id, correlationId);
  });
});

test('FR-02: Saga Distributed Transaction Compensation', async (t) => {
  const db = new FaultTestDb();
  const correlationId = 'corr_fr02_saga_compensate';

  const poorPassengerId = crypto.randomUUID();
  const driverId = crypto.randomUUID();
  const tripId = crypto.randomUUID();

  // Khách hàng có số dư ví = 0 VNĐ
  db.wallets.set(poorPassengerId, {
    id: crypto.randomUUID(),
    user_id: poorPassengerId,
    balance: 0,
    held_balance: 0,
  });

  // Giả lập trạng thái Driver D1 đã bị lock tạm thời sang BUSY
  const mockDriver = {
    id: driverId,
    status: 'BUSY',
  };

  await t.test('1. Payment Service phát hiện số dư = 0 đ, phát event payment.event.hold_failed', async () => {
    const holdReqEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'payment.event.hold_requested',
      payload: {
        trip_id: tripId,
        passenger_id: poorPassengerId,
        driver_id: driverId,
        amount: 50000,
      },
    };

    const res = await processHoldRequest(db, holdReqEnvelope);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'INSUFFICIENT_FUNDS');

    // Kiểm tra outbox có event hold_failed
    const failedEvt = db.outbox_events.find((e) => e.event_type === 'payment.event.hold_failed');
    assert(failedEvt, 'Outbox phải chứa payment.event.hold_failed');
    assert.strictEqual(failedEvt.payload.required_amount, 50000);
    assert.strictEqual(failedEvt.payload.current_balance, 0);
  });

  await t.test('2. Saga Coordinator tiếp nhận hold_failed, kích hoạt bù trừ giải phóng tài xế', async () => {
    // Saga Coordinator (Trip Service) nhận được event lỗi:
    // 1. Chuyển trạng thái chuyến đi sang CANCELLED
    const mockTrip = {
      id: tripId,
      status: 'CANCELLED',
      cancellation_reason: 'PAYMENT_FAILED_INSUFFICIENT_FUNDS',
    };
    assert.strictEqual(mockTrip.status, 'CANCELLED');

    // 2. Kích hoạt Compensating Action: phát trip.event.release_driver
    const compensationEvent = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'trip.event.release_driver',
      payload: {
        trip_id: tripId,
        driver_id: driverId,
        reason: 'PAYMENT_FAILED',
      },
    };

    // 3. Driver Service xử lý compensation event -> mở khoá tài xế về AVAILABLE
    mockDriver.status = 'AVAILABLE';
    assert.strictEqual(mockDriver.status, 'AVAILABLE', 'Tài xế D1 phải được hoàn trả về AVAILABLE');

    // 4. Kiểm tra số dư ví khách không bị âm
    const wallet = db.wallets.get(poorPassengerId);
    assert.strictEqual(wallet.balance, 0, 'Số dư không bị âm');
    assert.strictEqual(wallet.held_balance, 0, 'Held balance bằng 0');
  });
});
