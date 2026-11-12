'use strict';

const crypto = require('node:crypto');
const { withTransaction, getPool } = require('./db');
const { insertOutboxEvent } = require('./outbox');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(val) {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

async function markPendingCapture(client, tripId, correlationId) {
  await client.query(
    `INSERT INTO pending_captures (trip_id, correlation_id)
     VALUES ($1, $2)
     ON CONFLICT (trip_id) DO NOTHING`,
    [tripId, correlationId || null]
  );
}

async function deletePendingCapture(client, tripId) {
  await client.query('DELETE FROM pending_captures WHERE trip_id = $1', [tripId]);
}

async function hasPendingCapture(client, tripId) {
  const res = await client.query('SELECT trip_id FROM pending_captures WHERE trip_id = $1', [tripId]);
  return res.rows.length > 0;
}

async function hasRecoverableHoldSuccess(client, tripId) {
  const res = await client.query(
    `SELECT id FROM outbox_events
     WHERE aggregate_id = $1
       AND event_type = 'payment.event.hold_success'
       AND status IN ('PENDING', 'PUBLISHING', 'PUBLISHED')
     LIMIT 1`,
    [tripId]
  );
  return res.rows.length > 0;
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
    const existingAmount = Number(existingHold.amount);
    const recoveredCorrelation = correlation_id || `corr_${crypto.randomBytes(8).toString('hex')}`;

    if (existingHold.state === 'REFUNDED') {
      // Out-of-order compensation already arrived before hold!
      await deletePendingCapture(client, tripId);
      console.warn(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Trip ${tripId} was already compensated/refunded. Aborting hold to protect balance.`
      );
      return { holdState: 'ALREADY_REFUNDED' };
    }

    if (existingHold.state === 'CAPTURED') {
      await deletePendingCapture(client, tripId);
      console.warn(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Trip ${tripId} was already CAPTURED. Ignoring duplicate hold without deducting again.`
      );
      return { holdState: 'CAPTURED', duplicate: true, amount: existingAmount };
    }

    if (existingHold.state === 'FAILED') {
      await deletePendingCapture(client, tripId);
      console.warn(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Trip ${tripId} already has a terminal FAILED hold. Ignoring duplicate hold; no supported retry.`
      );
      return { holdState: 'FAILED', reason: 'PREVIOUS_HOLD_FAILED', duplicate: true };
    }

    if (existingHold.state === 'HELD') {
      if (Number.isFinite(existingAmount) && existingAmount !== amount) {
        console.warn(
          `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Duplicate hold amount ${amount} differs from existing ${existingAmount} for trip ${tripId}; keeping existing hold.`
        );
      }

      // If hold_success was lost or exhausted retries, re-create a recoverable outbox event.
      if (!(await hasRecoverableHoldSuccess(client, tripId))) {
        await insertOutboxEvent(client, {
          aggregateType: 'PAYMENT',
          aggregateId: tripId,
          eventType: 'payment.event.hold_success',
          payload: {
            trip_id: tripId,
            passenger_id: existingHold.user_id,
            driver_id: driverId,
            amount: existingAmount,
          },
          correlationId: recoveredCorrelation,
        });
        console.log(
          `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Re-created missing hold_success outbox event for trip ${tripId}`
        );
      }

      if (await hasPendingCapture(client, tripId)) {
        const captured = await processCapture(client, envelope);
        await deletePendingCapture(client, tripId);
        console.log(
          `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Reconciled pending capture for trip ${tripId} after duplicate hold`
        );
        return {
          holdState: 'HELD',
          captured: Boolean(captured.captured),
          reconciled: true,
          amount: existingAmount,
        };
      }

      console.log(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Hold already active for trip ${tripId}`
      );
      return { holdState: 'HELD', amount: existingAmount };
    }

    throw new Error(`Unknown payment hold state ${existingHold.state} for trip ${tripId}`);
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
    const walletUpdate = await client.query(
      `UPDATE wallets 
       SET balance = balance - $1, held_balance = held_balance + $1, updated_at = NOW() 
       WHERE id = $2 AND balance >= $1`,
      [amount, wallet.id]
    );
    if (walletUpdate.rowCount !== 1) {
      throw new Error(`Wallet hold update affected ${walletUpdate.rowCount} rows for trip ${tripId}`);
    }

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

    // A capture may have arrived before this hold. Reconcile it in the same transaction.
    let captured = false;
    if (await hasPendingCapture(client, tripId)) {
      const captureResult = await processCapture(client, envelope);
      await deletePendingCapture(client, tripId);
      captured = Boolean(captureResult.captured);
      console.log(
        `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Reconciled pending capture for trip ${tripId} after successful hold`
      );
    }

    console.log(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Hold SUCCESS for trip ${tripId}, amount: ${amount} VND. Remaining balance: ${currentBalance - amount} VND`
    );

    return { success: true, state: 'HELD', amount, captured };
  } else {
    await deletePendingCapture(client, tripId);
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
    // Capture before hold: persist a durable marker and let the hold transaction reconcile it.
    await markPendingCapture(client, tripId, correlation_id);
    console.warn(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] No hold record found for trip ${tripId} during capture; recorded pending capture for reconciliation`
    );
    return { captured: false, deferred: true };
  }

  const hold = holdRes.rows[0];
  if (hold.state !== 'HELD') {
    if (hold.state === 'CAPTURED') {
      await deletePendingCapture(client, tripId);
      return { captured: false, state: hold.state, duplicate: true };
    }
    await deletePendingCapture(client, tripId);
    console.warn(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [WARN] Hold in state ${hold.state}, cannot capture trip ${tripId}`
    );
    return { captured: false, state: hold.state };
  }

  const amount = Number(hold.amount);
  const userId = hold.user_id;

  // Deduct from held_balance permanently
  const walletUpdate = await client.query(
    `UPDATE wallets 
     SET held_balance = held_balance - $1, updated_at = NOW() 
     WHERE user_id = $2 AND held_balance >= $1`,
    [amount, userId]
  );
  if (walletUpdate.rowCount !== 1) {
    throw new Error(`Wallet capture update affected ${walletUpdate.rowCount} rows for trip ${tripId}`);
  }

  const holdUpdate = await client.query(
    `UPDATE payment_holds SET state = 'CAPTURED', updated_at = NOW() WHERE trip_id = $1 AND state = 'HELD'`,
    [tripId]
  );
  if (holdUpdate.rowCount !== 1) {
    throw new Error(`Payment hold capture state update affected ${holdUpdate.rowCount} rows for trip ${tripId}`);
  }
  await deletePendingCapture(client, tripId);

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
    await deletePendingCapture(client, tripId);
    console.log(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Preemptive refund recorded for trip ${tripId}`
    );
    return { refunded: true, preemptive: true };
  }

  const hold = holdRes.rows[0];
  if (hold.state !== 'HELD') {
    await deletePendingCapture(client, tripId);
    console.log(
      `[${new Date().toISOString()}] [${correlation_id}] [payment-service] [INFO] Hold state is ${hold.state}, no refund needed for trip ${tripId}`
    );
    return { refunded: false, state: hold.state };
  }

  const amount = Number(hold.amount);
  const userId = hold.user_id;

  // Release money: held_balance -> balance
  const walletUpdate = await client.query(
    `UPDATE wallets 
     SET held_balance = held_balance - $1, balance = balance + $1, updated_at = NOW() 
     WHERE user_id = $2 AND held_balance >= $1`,
    [amount, userId]
  );
  if (walletUpdate.rowCount !== 1) {
    throw new Error(`Wallet refund update affected ${walletUpdate.rowCount} rows for trip ${tripId}`);
  }

  const holdUpdate = await client.query(
    `UPDATE payment_holds SET state = 'REFUNDED', updated_at = NOW() WHERE trip_id = $1 AND state = 'HELD'`,
    [tripId]
  );
  if (holdUpdate.rowCount !== 1) {
    throw new Error(`Payment hold refund state update affected ${holdUpdate.rowCount} rows for trip ${tripId}`);
  }
  await deletePendingCapture(client, tripId);

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
