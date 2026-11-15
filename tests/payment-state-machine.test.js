'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { processHoldRequest, processCapture, processRefund } = require('../src/payment-service/payment-logic');

/**
 * Minimal high-fidelity DB mock for terminal-state, pending-capture and row-count regressions.
 * It intentionally mirrors the SQL branches used by payment-logic.js.
 */
class StateMachineMockDb {
  constructor() {
    this.wallets = new Map();
    this.payment_holds = new Map();
    this.transactions = [];
    this.outbox_events = [];
    this.pending_captures = new Set();
    this.forceWalletUpdateMiss = false;
  }

  async query(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ');

    if (s.includes('INSERT INTO pending_captures')) {
      const existed = this.pending_captures.has(params[0]);
      this.pending_captures.add(params[0]);
      return { rowCount: existed ? 0 : 1, rows: [] };
    }
    if (s.includes('DELETE FROM pending_captures WHERE trip_id = $1')) {
      const deleted = this.pending_captures.delete(params[0]);
      return { rowCount: deleted ? 1 : 0, rows: [] };
    }
    if (s.includes('SELECT trip_id FROM pending_captures WHERE trip_id = $1')) {
      return { rows: this.pending_captures.has(params[0]) ? [{ trip_id: params[0] }] : [] };
    }
    if (s.includes('SELECT id FROM outbox_events') && s.includes("event_type = 'payment.event.hold_success'")) {
      return {
        rows: this.outbox_events
          .filter((event) => event.aggregate_id === params[0]
            && event.event_type === 'payment.event.hold_success'
            && ['PENDING', 'PUBLISHING', 'PUBLISHED'].includes(event.status))
          .map((event) => ({ id: event.id })),
      };
    }
    if (s.includes('SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1')) {
      const hold = this.payment_holds.get(params[0]);
      return { rows: hold ? [{ ...hold }] : [] };
    }
    if (s.includes('SELECT id, user_id, balance, held_balance FROM wallets WHERE user_id = $1')) {
      const wallet = this.wallets.get(params[0]);
      return { rows: wallet ? [{ ...wallet }] : [] };
    }
    if (s.includes('INSERT INTO wallets (user_id, balance, held_balance) VALUES ($1, 0, 0)')) {
      const wallet = { id: crypto.randomUUID(), user_id: params[0], balance: 0, held_balance: 0 };
      this.wallets.set(params[0], wallet);
      return { rows: [{ ...wallet }] };
    }
    if (s.includes('UPDATE wallets SET balance = balance - $1, held_balance = held_balance + $1')) {
      if (this.forceWalletUpdateMiss) return { rowCount: 0, rows: [] };
      const [amount, walletId] = params;
      for (const wallet of this.wallets.values()) {
        if (wallet.id === walletId) {
          if (wallet.balance < amount) throw new Error('balance constraint');
          wallet.balance -= amount;
          wallet.held_balance += amount;
          return { rowCount: 1 };
        }
      }
      return { rowCount: 0 };
    }
    if (s.includes('INSERT INTO payment_holds')) {
      const [tripId, userId, amount, state] = params;
      const inferred = s.includes("'FAILED'") ? 'FAILED' : s.includes("'REFUNDED'") ? 'REFUNDED' : s.includes("'HELD'") ? 'HELD' : state;
      this.payment_holds.set(tripId, { trip_id: tripId, user_id: userId, amount, state: inferred });
      return { rowCount: 1 };
    }
    if (s.includes('INSERT INTO transactions')) {
      this.transactions.push({ params, sql: s });
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
    if (s.includes('UPDATE wallets SET held_balance = held_balance - $1') && !s.includes('balance = balance + $1')) {
      if (this.forceWalletUpdateMiss) return { rowCount: 0, rows: [] };
      const [amount, userId] = params;
      const wallet = this.wallets.get(userId);
      if (!wallet || wallet.held_balance < amount) return { rowCount: 0 };
      wallet.held_balance -= amount;
      return { rowCount: 1 };
    }
    if (s.includes('UPDATE wallets SET held_balance = held_balance - $1, balance = balance + $1')) {
      if (this.forceWalletUpdateMiss) return { rowCount: 0, rows: [] };
      const [amount, userId] = params;
      const wallet = this.wallets.get(userId);
      if (!wallet || wallet.held_balance < amount) return { rowCount: 0 };
      wallet.held_balance -= amount;
      wallet.balance += amount;
      return { rowCount: 1 };
    }
    if (s.includes('UPDATE payment_holds SET state =')) {
      const hold = this.payment_holds.get(params[0]);
      if (!hold) return { rowCount: 0 };
      if (s.includes("AND state = 'HELD'") && hold.state !== 'HELD') return { rowCount: 0 };
      hold.state = s.includes("'CAPTURED'") ? 'CAPTURED' : 'REFUNDED';
      return { rowCount: 1 };
    }

    return { rowCount: 0, rows: [] };
  }
}

function seedWallet(db, userId, balance) {
  db.wallets.set(userId, { id: crypto.randomUUID(), user_id: userId, balance, held_balance: 0 });
}

function holdEnvelope(tripId, passengerId, driverId, amount) {
  return {
    event_id: crypto.randomUUID(),
    correlation_id: 'corr_state_machine',
    event_type: 'payment.event.hold_requested',
    payload: { trip_id: tripId, passenger_id: passengerId, driver_id: driverId, amount },
  };
}

test('Payment state machine: terminal states, pending capture and row-count safety', async (t) => {
  await t.test('1. Duplicate hold after CAPTURED never deducts again', async () => {
    const db = new StateMachineMockDb();
    const passengerId = crypto.randomUUID();
    const driverId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    seedWallet(db, passengerId, 100000);

    const first = await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    assert.strictEqual(first.success, true);
    const captured = await processCapture(db, {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_capture',
      event_type: 'trip.event.completed',
      payload: { trip_id: tripId },
    });
    assert.strictEqual(captured.captured, true);

    const duplicate = await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    assert.strictEqual(duplicate.holdState, 'CAPTURED');
    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 60000);
    assert.strictEqual(wallet.held_balance, 0);
  });

  await t.test('2. Duplicate hold after FAILED is terminal and never deducts', async () => {
    const db = new StateMachineMockDb();
    const passengerId = crypto.randomUUID();
    const driverId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    seedWallet(db, passengerId, 10000);

    const failed = await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    assert.strictEqual(failed.success, false);
    const duplicate = await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    assert.strictEqual(duplicate.holdState, 'FAILED');
    assert.strictEqual(duplicate.reason, 'PREVIOUS_HOLD_FAILED');

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 10000);
    assert.strictEqual(wallet.held_balance, 0);
  });

  await t.test('3. Capture before hold is deferred then reconciled by the hold', async () => {
    const db = new StateMachineMockDb();
    const passengerId = crypto.randomUUID();
    const driverId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    seedWallet(db, passengerId, 100000);

    const deferred = await processCapture(db, {
      event_id: crypto.randomUUID(),
      correlation_id: 'corr_early_capture',
      event_type: 'trip.event.completed',
      payload: { trip_id: tripId },
    });
    assert.strictEqual(deferred.captured, false);
    assert.strictEqual(deferred.deferred, true);
    assert.strictEqual(db.pending_captures.has(tripId), true);

    const held = await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    assert.strictEqual(held.success, true);
    assert.strictEqual(held.captured, true);
    assert.strictEqual(db.payment_holds.get(tripId).state, 'CAPTURED');
    assert.strictEqual(db.pending_captures.has(tripId), false);

    const wallet = db.wallets.get(passengerId);
    assert.strictEqual(wallet.balance, 60000);
    assert.strictEqual(wallet.held_balance, 0);
  });

  await t.test('4. Capture wallet update with rowCount 0 throws and leaves hold HELD', async () => {
    const db = new StateMachineMockDb();
    const passengerId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    seedWallet(db, passengerId, 100000);
    await processHoldRequest(db, holdEnvelope(tripId, passengerId, crypto.randomUUID(), 40000));

    db.forceWalletUpdateMiss = true;
    await assert.rejects(
      processCapture(db, {
        event_id: crypto.randomUUID(),
        correlation_id: 'corr_capture_miss',
        event_type: 'trip.event.completed',
        payload: { trip_id: tripId },
      }),
      /Wallet capture update affected 0 rows/
    );
    assert.strictEqual(db.payment_holds.get(tripId).state, 'HELD');
    assert.strictEqual(db.wallets.get(passengerId).held_balance, 40000);
  });

  await t.test('5. Refund wallet update with rowCount 0 throws and leaves hold HELD', async () => {
    const db = new StateMachineMockDb();
    const passengerId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    seedWallet(db, passengerId, 100000);
    await processHoldRequest(db, holdEnvelope(tripId, passengerId, crypto.randomUUID(), 40000));

    db.forceWalletUpdateMiss = true;
    await assert.rejects(
      processRefund(db, {
        event_id: crypto.randomUUID(),
        correlation_id: 'corr_refund_miss',
        event_type: 'payment.event.refund_requested',
        payload: { trip_id: tripId },
      }),
      /Wallet refund update affected 0 rows/
    );
    assert.strictEqual(db.payment_holds.get(tripId).state, 'HELD');
    assert.strictEqual(db.wallets.get(passengerId).held_balance, 40000);
  });

  await t.test('6. Duplicate HELD recovers a missing hold_success without deducting again', async () => {
    const db = new StateMachineMockDb();
    const passengerId = crypto.randomUUID();
    const driverId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    seedWallet(db, passengerId, 100000);

    await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    db.outbox_events = db.outbox_events.filter((event) => event.event_type !== 'payment.event.hold_success');

    const duplicate = await processHoldRequest(db, holdEnvelope(tripId, passengerId, driverId, 40000));
    assert.strictEqual(duplicate.holdState, 'HELD');
    assert.strictEqual(db.outbox_events.filter((event) => event.event_type === 'payment.event.hold_success').length, 1);
    assert.strictEqual(db.wallets.get(passengerId).held_balance, 40000);
    assert.strictEqual(db.wallets.get(passengerId).balance, 60000);
  });
});
