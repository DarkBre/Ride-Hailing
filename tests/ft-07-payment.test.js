'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Import payment logic
const {
  processHoldRequest,
  processCapture,
  processRefund,
  topupWallet,
  getWallet,
} = require('../src/payment-service/payment-logic');

/**
 * In-memory Mock DB Client simulating PostgreSQL with row locks, transactions & constraints
 */
class MockDbClient {
  constructor() {
    this.wallets = new Map();
    this.payment_holds = new Map();
    this.wallet_topups = new Map();
    this.transactions = [];
    this.outbox_events = [];
    this.processed_events = new Set();
  }

  async query(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ');

    // 1. Processed events (Idempotency)
    if (s.includes('INSERT INTO processed_events')) {
      const [eventId, eventType] = params;
      if (this.processed_events.has(eventId)) {
        return { rowCount: 0, rows: [] };
      }
      this.processed_events.add(eventId);
      return { rowCount: 1, rows: [] };
    }

    // 2. Select hold
    if (s.includes('SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1')) {
      const tripId = params[0];
      const hold = this.payment_holds.get(tripId);
      return { rows: hold ? [hold] : [] };
    }

    // 3. Select wallet for update
    if (s.includes('SELECT id, user_id, balance, held_balance FROM wallets WHERE user_id = $1')) {
      const userId = params[0];
      let w = this.wallets.get(userId);
      return { rows: w ? [w] : [] };
    }

    // 4. Insert wallet
    if (s.includes('INSERT INTO wallets (user_id, balance, held_balance) VALUES ($1, 0, 0)')) {
      const userId = params[0];
      const newW = { id: crypto.randomUUID(), user_id: userId, balance: 0, held_balance: 0 };
      this.wallets.set(userId, newW);
      return { rows: [newW] };
    }

    // 5. Update wallet (hold success)
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

    // 6. Insert hold HELD or FAILED
    if (s.includes('INSERT INTO payment_holds')) {
      const [tripId, userId, amount, state] = params;
      const hold = { trip_id: tripId, user_id: userId, amount, state };
      this.payment_holds.set(tripId, hold);
      return { rowCount: 1 };
    }

    // 7. Insert transaction
    if (s.includes('INSERT INTO transactions')) {
      const [walletId, tripId, amount, type, status] = params;
      this.transactions.push({ wallet_id: walletId, trip_id: tripId, amount, type, status });
      return { rowCount: 1 };
    }

    // 8. Insert outbox_events
    if (s.includes('INSERT INTO outbox_events')) {
      const [id, aggregate_type, aggregate_id, event_type, payload, correlation_id, now] = params;
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

    // 9. Capture settlement
    if (s.includes('UPDATE wallets SET held_balance = held_balance - $1') && !s.includes('balance = balance + $1')) {
      const [amount, userId] = params;
      const w = this.wallets.get(userId);
      if (w) w.held_balance -= amount;
      return { rowCount: 1 };
    }

    // 10. Refund compensation
    if (s.includes('UPDATE wallets SET held_balance = held_balance - $1, balance = balance + $1')) {
      const [amount, userId] = params;
      const w = this.wallets.get(userId);
      if (w) {
        w.held_balance -= amount;
        w.balance += amount;
      }
      return { rowCount: 1 };
    }

    // 11. Update hold state
    if (s.includes('UPDATE payment_holds SET state = $2 WHERE trip_id = $1') || s.includes('UPDATE payment_holds SET state = \'CAPTURED\'') || s.includes('UPDATE payment_holds SET state = \'REFUNDED\'')) {
      const tripId = params[0];
      const state = s.includes('CAPTURED') ? 'CAPTURED' : s.includes('REFUNDED') ? 'REFUNDED' : params[1];
      const h = this.payment_holds.get(tripId);
      if (h) h.state = state;
      return { rowCount: 1 };
    }

    return { rowCount: 0, rows: [] };
  }
}

test('FT-07: Payment Service Lifecycle & Transactional Outbox', async (t) => {
  const db = new MockDbClient();

  const passengerId = crypto.randomUUID();
  const driverId = crypto.randomUUID();
  const tripId = crypto.randomUUID();
  const correlationId = 'corr_test_ft07';

  // Seed passenger wallet with 100,000 VND
  db.wallets.set(passengerId, {
    id: crypto.randomUUID(),
    user_id: passengerId,
    balance: 100000,
    held_balance: 0,
  });

  await t.test('1. Hold cước thành công khi ví có đủ tiền', async () => {
    const holdEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'payment.event.hold_requested',
      payload: {
        trip_id: tripId,
        passenger_id: passengerId,
        driver_id: driverId,
        amount: 45000,
      },
    };

    const res = await processHoldRequest(db, holdEnvelope);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'HELD');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000, 'Số dư khả dụng phải giảm còn 55,000 đ');
    assert.strictEqual(wallet.held_balance, 45000, 'Số tiền tạm giữ phải tăng lên 45,000 đ');

    // Kiểm tra Outbox Event
    const outboxEvt = db.outbox_events.find((e) => e.event_type === 'payment.event.hold_success');
    assert(outboxEvt, 'Outbox phải ghi nhận event payment.event.hold_success');
    assert.strictEqual(outboxEvt.payload.amount, 45000);
    assert.strictEqual(outboxEvt.correlation_id, correlationId);
  });

  await t.test('2. Không trừ/giữ tiền lặp khi nhận event trùng lặp (Idempotency)', async () => {
    const holdEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'payment.event.hold_requested',
      payload: {
        trip_id: tripId,
        passenger_id: passengerId,
        driver_id: driverId,
        amount: 45000,
      },
    };

    const res = await processHoldRequest(db, holdEnvelope);
    assert.strictEqual(res.holdState, 'HELD');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000, 'Số dư khả dụng không được bị trừ lần 2');
    assert.strictEqual(wallet.held_balance, 45000, 'Số tiền tạm giữ không bị cộng dồn lần 2');
  });

  await t.test('3. Hold thất bại và phát event hold_failed khi ví không đủ tiền', async () => {
    const poorPassengerId = crypto.randomUUID();
    const poorTripId = crypto.randomUUID();

    // Ví chỉ có 10,000 đ
    db.wallets.set(poorPassengerId, {
      id: crypto.randomUUID(),
      user_id: poorPassengerId,
      balance: 10000,
      held_balance: 0,
    });

    const failedEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_test_failed',
      event_type: 'payment.event.hold_requested',
      payload: {
        trip_id: poorTripId,
        passenger_id: poorPassengerId,
        driver_id: driverId,
        amount: 45000,
      },
    };

    const res = await processHoldRequest(db, failedEnvelope);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'INSUFFICIENT_FUNDS');

    // Kiểm tra Outbox Event kích hoạt Saga Bù Trừ
    const outboxEvt = db.outbox_events.find((e) => e.event_type === 'payment.event.hold_failed');
    assert(outboxEvt, 'Outbox phải ghi nhận event payment.event.hold_failed');
    assert.strictEqual(outboxEvt.payload.reason, 'INSUFFICIENT_FUNDS');
    assert.strictEqual(outboxEvt.payload.required_amount, 45000);
    assert.strictEqual(outboxEvt.payload.current_balance, 10000);

    const wallet = db.wallets.get(poorPassengerId);
    assert.strictEqual(wallet.balance, 10000, 'Số dư không bị âm');
    assert.strictEqual(wallet.held_balance, 0);
  });

  await t.test('4. Capture trừ tiền thật khi chuyến đi hoàn tất (trip.event.completed)', async () => {
    const captureEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'trip.event.completed',
      payload: {
        trip_id: tripId,
      },
    };

    const res = await processCapture(db, captureEnvelope);
    assert.strictEqual(res.captured, true);

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000, 'Số dư khả dụng giữ nguyên');
    assert.strictEqual(wallet.held_balance, 0, 'Held balance được trừ dứt điểm');

    const hold = db.payment_holds.get(tripId);
    assert.strictEqual(hold.state, 'CAPTURED');
  });

  await t.test('5. Saga Bù Trừ / Refund giải phóng tiền về ví khả dụng khi có lỗi', async () => {
    const refundTripId = crypto.randomUUID();
    // Tạo hold 30,000 đ
    db.payment_holds.set(refundTripId, {
      trip_id: refundTripId,
      user_id: passengerId,
      amount: 30000,
      state: 'HELD',
    });
    const w = db.wallets.get(passengerId);
    w.held_balance = 30000;

    const refundEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_test_refund',
      event_type: 'trip.event.release_driver',
      payload: {
        trip_id: refundTripId,
      },
    };

    const res = await processRefund(db, refundEnvelope);
    assert.strictEqual(res.refunded, true);

    assert.strictEqual(w.balance, 85000, 'Số dư khả dụng phải được hoàn trả 30,000 đ (55k + 30k = 85k)');
    assert.strictEqual(w.held_balance, 0, 'Held balance trở về 0');

    const hold = db.payment_holds.get(refundTripId);
    assert.strictEqual(hold.state, 'REFUNDED');
  });
});
