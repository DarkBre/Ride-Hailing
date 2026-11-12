'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  processHoldRequest,
  processCapture,
  processRefund,
  handleBrokerEvent,
} = require('../src/payment-service/payment-logic');

/**
 * High-fidelity Mock DB simulating PostgreSQL locking, constraints, and atomic transactions
 */
class HighFidelityMockDb {
  constructor() {
    this.wallets = new Map();
    this.payment_holds = new Map();
    this.wallet_topups = new Map();
    this.transactions = [];
    this.outbox_events = [];
    this.pending_captures = new Set();
    this.processed_events = new Set();
    this.advisoryLocks = new Set();
    this.forceWalletUpdateMiss = false;
  }

  async query(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ');

    // 1. Transaction Advisory Lock
    if (s.includes('pg_advisory_xact_lock')) {
      const lockKey = params[0];
      this.advisoryLocks.add(lockKey);
      return { rows: [] };
    }

    // 2. Processed events (Idempotency)
    if (s.includes('INSERT INTO processed_events')) {
      const [eventId, eventType] = params;
      if (this.processed_events.has(eventId)) {
        return { rowCount: 0, rows: [] };
      }
      this.processed_events.add(eventId);
      return { rowCount: 1, rows: [] };
    }

    // 2b. Pending captures
    if (s.includes('INSERT INTO pending_captures')) {
      const tripId = params[0];
      const existed = this.pending_captures.has(tripId);
      this.pending_captures.add(tripId);
      return { rowCount: existed ? 0 : 1, rows: [] };
    }
    if (s.includes('DELETE FROM pending_captures WHERE trip_id = $1')) {
      const deleted = this.pending_captures.delete(params[0]);
      return { rowCount: deleted ? 1 : 0, rows: [] };
    }
    if (s.includes('SELECT trip_id FROM pending_captures WHERE trip_id = $1')) {
      return { rows: this.pending_captures.has(params[0]) ? [{ trip_id: params[0] }] : [] };
    }

    // 2c. Existing hold_success outbox lookup
    if (s.includes('SELECT id FROM outbox_events') && s.includes("event_type = 'payment.event.hold_success'")) {
      const tripId = params[0];
      const rows = this.outbox_events
        .filter((event) => event.aggregate_id === tripId
          && event.event_type === 'payment.event.hold_success'
          && ['PENDING', 'PUBLISHING', 'PUBLISHED'].includes(event.status))
        .map((event) => ({ id: event.id }));
      return { rows };
    }

    // 3. Select hold
    if (s.includes('SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1')) {
      const tripId = params[0];
      const hold = this.payment_holds.get(tripId);
      return { rows: hold ? [{ ...hold }] : [] };
    }

    // 4. Select wallet FOR UPDATE
    if (s.includes('SELECT id, user_id, balance, held_balance FROM wallets WHERE user_id = $1')) {
      const userId = params[0];
      const w = this.wallets.get(userId);
      return { rows: w ? [{ ...w }] : [] };
    }

    // 5. Insert wallet
    if (s.includes('INSERT INTO wallets (user_id, balance, held_balance) VALUES ($1, 0, 0)')) {
      const userId = params[0];
      const newW = { id: crypto.randomUUID(), user_id: userId, balance: 0, held_balance: 0 };
      this.wallets.set(userId, newW);
      return { rows: [{ ...newW }] };
    }

    // 6. Update wallet (hold success)
    if (s.includes('UPDATE wallets SET balance = balance - $1, held_balance = held_balance + $1')) {
      if (this.forceWalletUpdateMiss) return { rowCount: 0, rows: [] };
      const [amount, walletId] = params;
      for (const w of this.wallets.values()) {
        if (w.id === walletId) {
          if (w.balance < amount) throw new Error('CHECK constraint violation: balance >= 0');
          w.balance -= amount;
          w.held_balance += amount;
          break;
        }
      }
      return { rowCount: 1 };
    }

    // 7. Insert or update payment_holds
    if (s.includes('INSERT INTO payment_holds')) {
      const [tripId, userId, amount, state] = params;
      const inferredState = s.includes("'FAILED'")
        ? 'FAILED'
        : s.includes("'REFUNDED'")
          ? 'REFUNDED'
          : s.includes("'HELD'")
            ? 'HELD'
            : state;
      this.payment_holds.set(tripId, {
        trip_id: tripId,
        user_id: userId,
        amount,
        state: inferredState,
      });
      return { rowCount: 1 };
    }

    // 8. Insert transactions
    if (s.includes('INSERT INTO transactions')) {
      const [walletId, tripId, amount, type, status] = params;
      this.transactions.push({ wallet_id: walletId, trip_id: tripId, amount, type, status });
      return { rowCount: 1 };
    }

    // 9. Insert outbox_events
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

    // 10. Capture settlement (debited from held_balance)
    if (s.includes('UPDATE wallets SET held_balance = held_balance - $1') && !s.includes('balance = balance + $1')) {
      if (this.forceWalletUpdateMiss) return { rowCount: 0, rows: [] };
      const [amount, userId] = params;
      const w = this.wallets.get(userId);
      if (w) {
        if (w.held_balance < amount) throw new Error('CHECK constraint violation: held_balance >= 0');
        w.held_balance -= amount;
      }
      return { rowCount: w ? 1 : 0 };
    }

    // 11. Refund compensation (held_balance -> balance)
    if (s.includes('UPDATE wallets SET held_balance = held_balance - $1, balance = balance + $1')) {
      if (this.forceWalletUpdateMiss) return { rowCount: 0, rows: [] };
      const [amount, userId] = params;
      const w = this.wallets.get(userId);
      if (w) {
        if (w.held_balance < amount) throw new Error('CHECK constraint violation: held_balance >= 0');
        w.held_balance -= amount;
        w.balance += amount;
      }
      return { rowCount: w ? 1 : 0 };
    }

    // 12. Update hold state
    if (s.includes('UPDATE payment_holds SET state =')) {
      const tripId = params[0];
      const state = s.includes("'CAPTURED'") ? 'CAPTURED' : s.includes("'REFUNDED'") ? 'REFUNDED' : params[1];
      const h = this.payment_holds.get(tripId);
      if (!h) return { rowCount: 0 };
      if (s.includes("AND state = 'HELD'") && h.state !== 'HELD') return { rowCount: 0 };
      h.state = state;
      return { rowCount: 1 };
    }

    return { rowCount: 0, rows: [] };
  }
}

test('FT-07: Payment Consistency, Concurrency & State Machine Integrity', async (t) => {
  const db = new HighFidelityMockDb();
  const passengerId = crypto.randomUUID();
  const driverId = crypto.randomUUID();
  const tripId = crypto.randomUUID();
  const correlationId = 'corr_audit_ft07';

  // Seed passenger wallet with 100,000 VND
  db.wallets.set(passengerId, {
    id: crypto.randomUUID(),
    user_id: passengerId,
    balance: 100000,
    held_balance: 0,
  });

  await t.test('1. Successful HOLD: Reserves balance and writes payment.event.hold_success to Outbox', async () => {
    const envelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: tripId, passenger_id: passengerId, driver_id: driverId, amount: 45000 },
    };

    const res = await processHoldRequest(db, envelope);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'HELD');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000);
    assert.strictEqual(wallet.held_balance, 45000);

    const outbox = db.outbox_events.find((e) => e.event_type === 'payment.event.hold_success');
    assert(outbox);
    assert.strictEqual(outbox.payload.amount, 45000);
    assert.strictEqual(outbox.correlation_id, correlationId);
  });

  await t.test('2. Concurrent / Duplicate HOLD on same trip: Idempotent without double debiting', async () => {
    const dupEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: tripId, passenger_id: passengerId, driver_id: driverId, amount: 45000 },
    };

    const res = await processHoldRequest(db, dupEnvelope);
    assert.strictEqual(res.holdState, 'HELD');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000, 'Balance must not be decremented twice');
    assert.strictEqual(wallet.held_balance, 45000, 'Held balance must not be incremented twice');
  });

  await t.test('3. Insufficient Balance: Emits payment.event.hold_failed for Saga Compensation', async () => {
    const poorId = crypto.randomUUID();
    const poorTripId = crypto.randomUUID();
    db.wallets.set(poorId, { id: crypto.randomUUID(), user_id: poorId, balance: 10000, held_balance: 0 });

    const envelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_insufficient',
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: poorTripId, passenger_id: poorId, driver_id: driverId, amount: 45000 },
    };

    const res = await processHoldRequest(db, envelope);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'INSUFFICIENT_FUNDS');

    const outbox = db.outbox_events.find((e) => e.event_type === 'payment.event.hold_failed' && e.aggregate_id === poorTripId);
    assert(outbox);
    assert.strictEqual(outbox.payload.required_amount, 45000);
    assert.strictEqual(outbox.payload.current_balance, 10000);

    const wallet = db.wallets.get(poorId);
    assert.strictEqual(wallet.balance, 10000, 'Balance must remain positive');
    assert.strictEqual(wallet.held_balance, 0);
  });

  await t.test('4. Duplicate CAPTURE: Settles once and ignores repeated calls', async () => {
    const captureEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: correlationId,
      event_type: 'trip.event.completed',
      payload: { trip_id: tripId },
    };

    const res1 = await processCapture(db, captureEnvelope);
    assert.strictEqual(res1.captured, true);

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000);
    assert.strictEqual(wallet.held_balance, 0);

    // Repeated capture
    const res2 = await processCapture(db, captureEnvelope);
    assert.strictEqual(res2.captured, false, 'Second capture must be ignored');
    assert.strictEqual(res2.state, 'CAPTURED');
    assert.strictEqual(wallet.held_balance, 0);
  });

  await t.test('5. REFUND arriving BEFORE HOLD (Out-of-Order Race): Aborts hold and protects money', async () => {
    const racingTripId = crypto.randomUUID();

    // Compensation arrives first!
    const refundEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_racing_refund',
      event_type: 'trip.event.release_driver',
      payload: { trip_id: racingTripId },
    };

    const refundRes = await processRefund(db, refundEnvelope);
    assert.strictEqual(refundRes.refunded, true);
    assert.strictEqual(refundRes.preemptive, true);

    // Delayed hold request arrives second!
    const delayedHoldEnvelope = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_delayed_hold',
      event_type: 'payment.event.hold_requested',
      payload: { trip_id: racingTripId, passenger_id: passengerId, driver_id: driverId, amount: 20000 },
    };

    const holdRes = await processHoldRequest(db, delayedHoldEnvelope);
    assert.strictEqual(holdRes.holdState, 'ALREADY_REFUNDED', 'Hold must detect prior compensation and abort');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 55000, 'Balance must NOT be deducted for a cancelled trip');
  });

  await t.test('6. Duplicate REFUND: Does not refund twice', async () => {
    const tripToRefund = crypto.randomUUID();
    db.payment_holds.set(tripToRefund, { trip_id: tripToRefund, user_id: passengerId, amount: 15000, state: 'HELD' });
    const wallet = db.wallets.get(passengerId);
    wallet.held_balance = 15000;

    const env = {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_dup_refund',
      event_type: 'payment.event.refund_requested',
      payload: { trip_id: tripToRefund },
    };

    const r1 = await processRefund(db, env);
    assert.strictEqual(r1.refunded, true);
    assert.strictEqual(wallet.balance, 70000);
    assert.strictEqual(wallet.held_balance, 0);

    const r2 = await processRefund(db, env);
    assert.strictEqual(r2.refunded, false, 'Second refund must not add money again');
    assert.strictEqual(wallet.balance, 70000);
  });
});
