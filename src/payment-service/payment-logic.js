'use strict';

const crypto = require('node:crypto');
const { withTransaction, getPool } = require('./db');
const { insertOutboxEvent } = require('./outbox');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(val) {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

/**
 * Handle incoming domain events from RabbitMQ
 */
async function handleBrokerEvent(envelope) {
  const { event_id, event_type, correlation_id, payload } = envelope;

  if (!event_id || !event_type || !payload) {
    throw new Error('Malformed event envelope received in payment-service');
  }

  const tripId = payload.trip_id;
  if (!tripId || !isValidUuid(tripId)) {
    throw new Error(`Invalid trip_id (${tripId}) in event ${event_type}`);
  }

  return withTransaction(async (client) => {
    // 1. Deduplication / Idempotency Check
    const inboxRes = await client.query(
      `INSERT INTO processed_events (event_id, event_type) 
       VALUES ($1, $2) 
       ON CONFLICT (event_id) DO NOTHING`,
      [event_id, event_type]
    );

    if (inboxRes.rowCount === 0) {
      console.log(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Duplicate event ignored (event_id: ${event_id})`
      );
      return { duplicate: true };
    }

    // 2. Acquire transaction advisory lock on tripId to serialize concurrent operations for same trip
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [tripId]);
    } catch (_) {
      // Non-Postgres fallback (e.g. mock DB in unit tests)
    }

    // 3. Event-specific handling
    if (event_type === 'payment.event.hold_requested') {
      return processHoldRequest(client, envelope);
    } else if (event_type === 'trip.event.completed') {
      return processCapture(client, envelope);
    } else if (event_type === 'payment.event.refund_requested') {
      return processRefund(client, envelope);
    } else {
      console.log(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Unhandled event type: ${event_type}`
      );
      return { handled: false };
    }
  });
}

/**
 * Process a Hold Request (Reservation of fare)
 */
async function processHoldRequest(client, envelope) {
  const { correlation_id, payload } = envelope;
  const tripId = payload.trip_id;
  const passengerId = payload.passenger_id;
  const driverId = payload.driver_id;
  const amount = Number(payload.amount ?? payload.estimated_fare ?? payload.fare);

  if (!passengerId || !isValidUuid(passengerId) || isNaN(amount) || amount <= 0) {
    throw new Error(`Invalid payload for hold request: passenger_id=${passengerId}, amount=${amount}`);
  }

  // Check if a hold for this trip already exists
  const existingHoldRes = await client.query(
    `SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1`,
    [tripId]
  );

  if (existingHoldRes.rows.length > 0) {
    const existingHold = existingHoldRes.rows[0];
    if (existingHold.state === 'REFUNDED') {
      // Out-of-order compensation already arrived before hold!
      console.warn(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Trip ${tripId} was already compensated/refunded. Aborting hold to protect balance.`
      );
      return { holdState: 'ALREADY_REFUNDED' };
    }
    if (existingHold.state === 'HELD') {
      console.log(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Hold already active for trip ${tripId}`
      );
      return { holdState: 'HELD' };
    }
  }

  // Row-level lock on passenger wallet to prevent concurrent balance overdrafts
  let walletRes = await client.query(
    `SELECT id, user_id, balance, held_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
    [passengerId]
  );

  let wallet;
  if (walletRes.rows.length === 0) {
    // Auto-create wallet with initial 0 balance
    const newWalletRes = await client.query(
      `INSERT INTO wallets (user_id, balance, held_balance) VALUES ($1, 0, 0) RETURNING id, user_id, balance, held_balance`,
      [passengerId]
    );
    wallet = newWalletRes.rows[0];
  } else {
    wallet = walletRes.rows[0];
  }

  const currentBalance = Number(wallet.balance);

  if (currentBalance >= amount) {
    // Sufficient balance -> Hold successful
    await client.query(
      `UPDATE wallets 
       SET balance = balance - $1, held_balance = held_balance + $1, updated_at = NOW() 
       WHERE id = $2 AND balance >= $1`,
      [amount, wallet.id]
    );

    await client.query(
      `INSERT INTO payment_holds (trip_id, user_id, amount, state, updated_at)
       VALUES ($1, $2, $3, 'HELD', NOW())
       ON CONFLICT (trip_id) DO UPDATE SET state = 'HELD', amount = $3, user_id = $2, updated_at = NOW()`,
      [tripId, passengerId, amount]
    );

    await client.query(
      `INSERT INTO transactions (wallet_id, trip_id, amount, type, status)
       VALUES ($1, $2, $3, 'HOLD', 'SUCCESS')`,
      [wallet.id, tripId, amount]
    );

    // Write payment.event.hold_success to Transactional Outbox
    await insertOutboxEvent(client, {
      aggregateType: 'PAYMENT',
      aggregateId: tripId,
      eventType: 'payment.event.hold_success',
      payload: {
        trip_id: tripId,
        passenger_id: passengerId,
        driver_id: driverId,
        amount,
      },
      correlationId: correlation_id,
    });

    console.log(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Hold SUCCESS for trip ${tripId}, amount: ${amount} VND. Remaining balance: ${currentBalance - amount} VND`
    );

    return { success: true, state: 'HELD', amount };
  } else {
    // Insufficient balance -> Hold failed (Contract trigger for Saga Compensation)
    await client.query(
      `INSERT INTO payment_holds (trip_id, user_id, amount, state, updated_at)
       VALUES ($1, $2, $3, 'FAILED', NOW())
       ON CONFLICT (trip_id) DO UPDATE SET state = 'FAILED', amount = $3, user_id = $2, updated_at = NOW()`,
      [tripId, passengerId, amount]
    );

    await client.query(
      `INSERT INTO transactions (wallet_id, trip_id, amount, type, status)
       VALUES ($1, $2, $3, 'HOLD', 'FAILED')`,
      [wallet.id, tripId, amount]
    );

    // Write payment.event.hold_failed to Transactional Outbox (Contract with Saga Coordinator)
    await insertOutboxEvent(client, {
      aggregateType: 'PAYMENT',
      aggregateId: tripId,
      eventType: 'payment.event.hold_failed',
      payload: {
        trip_id: tripId,
        passenger_id: passengerId,
        driver_id: driverId,
        reason: 'INSUFFICIENT_FUNDS',
        required_amount: amount,
        current_balance: currentBalance,
      },
      correlationId: correlation_id,
    });

    console.warn(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Hold FAILED for trip ${tripId}: required ${amount} VND, but balance is ${currentBalance} VND. Kích hoạt Saga Bù Trừ!`
    );

    return { success: false, state: 'FAILED', reason: 'INSUFFICIENT_FUNDS' };
  }
}

/**
 * Process Settlement / Capture when trip completes
 */
async function processCapture(client, envelope) {
  const { correlation_id, payload } = envelope;
  const tripId = payload.trip_id;

  const holdRes = await client.query(
    `SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1`,
    [tripId]
  );

  if (holdRes.rows.length === 0) {
    console.warn(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] No hold record found for trip ${tripId} during capture`
    );
    return { captured: false };
  }

  const hold = holdRes.rows[0];
  if (hold.state !== 'HELD') {
    console.warn(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Hold in state ${hold.state}, cannot capture trip ${tripId}`
    );
    return { captured: false, state: hold.state };
  }

  const amount = Number(hold.amount);
  const userId = hold.user_id;

  // Deduct from held_balance permanently
  await client.query(
    `UPDATE wallets 
     SET held_balance = held_balance - $1, updated_at = NOW() 
     WHERE user_id = $2 AND held_balance >= $1`,
    [amount, userId]
  );

  await client.query(
    `UPDATE payment_holds SET state = 'CAPTURED', updated_at = NOW() WHERE trip_id = $1`,
    [tripId]
  );

  const walletRes = await client.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId]);
  const walletId = walletRes.rows[0]?.id;

  if (walletId) {
    await client.query(
      `INSERT INTO transactions (wallet_id, trip_id, amount, type, status)
       VALUES ($1, $2, $3, 'CAPTURE', 'SUCCESS')`,
      [walletId, tripId, amount]
    );
  }

  console.log(
    `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Payment CAPTURED for trip ${tripId}: ${amount} VND`
  );

  return { captured: true, amount };
}

/**
 * Process Refund / Compensating Action (Releases held balance)
 */
async function processRefund(client, envelope) {
  const { correlation_id, payload } = envelope;
  const tripId = payload.trip_id;

  const holdRes = await client.query(
    `SELECT trip_id, user_id, amount, state FROM payment_holds WHERE trip_id = $1`,
    [tripId]
  );

  if (holdRes.rows.length === 0) {
    // Record preemptive refund in case hold event arrives late (out-of-order race condition)
    await client.query(
      `INSERT INTO payment_holds (trip_id, state, updated_at) VALUES ($1, 'REFUNDED', NOW())`,
      [tripId]
    );
    console.log(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Preemptive refund recorded for trip ${tripId}`
    );
    return { refunded: true, preemptive: true };
  }

  const hold = holdRes.rows[0];
  if (hold.state !== 'HELD') {
    console.log(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Hold state is ${hold.state}, no refund needed for trip ${tripId}`
    );
    return { refunded: false, state: hold.state };
  }

  const amount = Number(hold.amount);
  const userId = hold.user_id;

  // Release money: held_balance -> balance
  await client.query(
    `UPDATE wallets 
     SET held_balance = held_balance - $1, balance = balance + $1, updated_at = NOW() 
     WHERE user_id = $2 AND held_balance >= $1`,
    [amount, userId]
  );

  await client.query(
    `UPDATE payment_holds SET state = 'REFUNDED', updated_at = NOW() WHERE trip_id = $1`,
    [tripId]
  );

  const walletRes = await client.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId]);
  const walletId = walletRes.rows[0]?.id;

  if (walletId) {
    await client.query(
      `INSERT INTO transactions (wallet_id, trip_id, amount, type, status)
       VALUES ($1, $2, $3, 'REFUND', 'SUCCESS')`,
      [walletId, tripId, amount]
    );
  }

  console.log(
    `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Saga Refund/Compensation SUCCESS: Released ${amount} VND back to user ${userId} for trip ${tripId}`
  );

  return { refunded: true, amount };
}

/**
 * Query current wallet balances
 */
async function getWallet(userId) {
  const pool = getPool();
  let res = await pool.query(
    `SELECT id, user_id, balance, held_balance, updated_at FROM wallets WHERE user_id = $1`,
    [userId]
  );

  if (res.rows.length === 0) {
    // Create new wallet with 0 balance
    res = await pool.query(
      `INSERT INTO wallets (user_id, balance, held_balance) VALUES ($1, 0, 0) RETURNING id, user_id, balance, held_balance, updated_at`,
      [userId]
    );
  }

  const row = res.rows[0];
  return {
    user_id: row.user_id,
    balance: Number(row.balance),
    held_balance: Number(row.held_balance),
    updated_at: row.updated_at,
  };
}

/**
 * Top up wallet with Idempotency Key protection
 */
async function topupWallet(userId, amount, idempotencyKey) {
  if (!isValidUuid(userId)) {
    throw new Error('Invalid user_id');
  }
  const topupAmount = Number(amount);
  if (isNaN(topupAmount) || topupAmount <= 0) {
    throw new Error('Invalid topup amount');
  }

  const key = idempotencyKey || crypto.randomUUID();

  return withTransaction(async (client) => {
    // Check if this idempotency key was already used for this user
    const existingRes = await client.query(
      `INSERT INTO wallet_topups (user_id, request_key, amount) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, request_key) DO NOTHING 
       RETURNING id`,
      [userId, key, topupAmount]
    );

    if (existingRes.rowCount === 0) {
      // Key was already processed -> return previous result (Strict Idempotency)
      const prev = await client.query(
        `SELECT result, amount FROM wallet_topups WHERE user_id = $1 AND request_key = $2`,
        [userId, key]
      );
      if (prev.rows.length > 0 && prev.rows[0].result) {
        return typeof prev.rows[0].result === 'string'
          ? JSON.parse(prev.rows[0].result)
          : prev.rows[0].result;
      }
    }

    // Upsert wallet balance
    const walletRes = await client.query(
      `INSERT INTO wallets (user_id, balance, held_balance) 
       VALUES ($1, $2, 0) 
       ON CONFLICT (user_id) 
       DO UPDATE SET balance = wallets.balance + EXCLUDED.balance, updated_at = NOW() 
       RETURNING id, user_id, balance, held_balance, updated_at`,
      [userId, topupAmount]
    );

    const updatedWallet = {
      user_id: walletRes.rows[0].user_id,
      balance: Number(walletRes.rows[0].balance),
      held_balance: Number(walletRes.rows[0].held_balance),
      updated_at: walletRes.rows[0].updated_at,
    };

    // Save transaction
    await client.query(
      `INSERT INTO transactions (wallet_id, amount, type, status) 
       VALUES ($1, $2, 'TOPUP', 'SUCCESS')`,
      [walletRes.rows[0].id, topupAmount]
    );

    // Save cached result into wallet_topups for idempotency replay
    await client.query(
      `UPDATE wallet_topups SET result = $1 WHERE user_id = $2 AND request_key = $3`,
      [JSON.stringify(updatedWallet), userId, key]
    );

    return updatedWallet;
  });
}

module.exports = {
  handleBrokerEvent,
  processHoldRequest,
  processCapture,
  processRefund,
  getWallet,
  topupWallet,
};
