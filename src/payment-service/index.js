'use strict';

const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { Pool } = require('pg');
const { serviceBroker } = require('../../services/_shared/amqp');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = value => typeof value === 'string' && uuid.test(value);
const money = value => Number.isSafeInteger(value) && value > 0;
const walletFields = 'balance, held_balance';
const wallet = row => ({ balance: Number(row?.balance ?? 0), held_balance: Number(row?.held_balance ?? 0) });

async function transaction(pool, work) {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    const value = await work(db);
    await db.query('COMMIT');
    return value;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    db.release(discard);
  }
}

async function handlePayment(pool, event) {
  const p = event.payload;
  const holding = event.event_type === 'payment.event.hold_requested';
  const refunding = event.event_type === 'payment.event.refund_requested';
  if (event.source_service !== 'trip-service' || event.version !== '1.0' ||
      !validId(event.event_id) || !validId(p?.trip_id) ||
      (holding && (!validId(p.passenger_id) || !money(p.amount))) ||
      (!holding && !refunding && event.event_type !== 'trip.event.completed')) throw new Error('Invalid payment event');

  return transaction(pool, async db => {
    const seen = await db.query('INSERT INTO payment_inbox VALUES ($1) ON CONFLICT DO NOTHING', [event.event_id]);
    if (!seen.rowCount) return;
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [p.trip_id]);
    const { rows: [hold] } = await db.query('SELECT * FROM payment_holds WHERE trip_id = $1', [p.trip_id]);
    const statedAmount = holding || refunding ? p.amount : p.fare;
    if (hold?.user_id && ((p.passenger_id && p.passenger_id !== hold.user_id) ||
        (statedAmount !== undefined && statedAmount !== Number(hold.amount)))) {
      throw new Error('Payment command does not match the recorded hold');
    }
    if (holding && !hold) {
      const debit = await db.query(`UPDATE wallets SET balance = balance - $2, held_balance = held_balance + $2
        WHERE user_id = $1 AND balance >= $2`, [p.passenger_id, p.amount]);
      const success = debit.rowCount === 1;
      await db.query('INSERT INTO payment_holds VALUES ($1, $2, $3, $4)',
        [p.trip_id, p.passenger_id, p.amount, success ? 'HELD' : 'FAILED']);
      const message = {
        event_id: randomUUID(), event_type: success ? 'payment.event.hold_success' : 'payment.event.hold_failed',
        timestamp: new Date().toISOString(), source_service: 'payment-service', version: '1.0',
        correlation_id: event.correlation_id, causation_id: event.event_id, aggregate_id: p.trip_id,
        payload: { trip_id: p.trip_id, passenger_id: p.passenger_id, driver_id: p.driver_id,
          ...(success ? { amount: p.amount } : { required_amount: p.amount, reason: 'INSUFFICIENT_FUNDS',
            current_balance: wallet((await db.query('SELECT balance FROM wallets WHERE user_id = $1',
              [p.passenger_id])).rows[0]).balance }) },
      };
      await db.query('INSERT INTO payment_outbox (event_id, envelope) VALUES ($1, $2)',
        [message.event_id, JSON.stringify(message)]);
    } else if (refunding && !hold) {
      // A compensating command can arrive before the original hold.
      await db.query("INSERT INTO payment_holds (trip_id, state) VALUES ($1, 'REFUNDED')", [p.trip_id]);
    } else if (!holding && hold?.state === 'HELD') {
      const change = await db.query(`UPDATE wallets SET held_balance = held_balance - $2,
        balance = balance + CASE WHEN $3::boolean THEN $2 ELSE 0 END WHERE user_id = $1 AND held_balance >= $2`,
      [hold.user_id, hold.amount, refunding]);
      if (change.rowCount !== 1) throw new Error('Wallet and hold diverged');
      await db.query('UPDATE payment_holds SET state = $2 WHERE trip_id = $1',
        [p.trip_id, refunding ? 'REFUNDED' : 'CAPTURED']);
    }
  });
}

function paymentServer(pool, identityUrl, ready) {
  return createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (req, res) => {
    const send = (status, data, code) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: status < 400, data, error: code ? { code } : null,
        meta: { correlation_id: req.headers['x-correlation-id'] || randomUUID(), timestamp: new Date().toISOString() } }));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') {
        await pool.query('SELECT 1');
        return send(ready() ? 200 : 503, { ready: ready() });
      }
      const topup = req.method === 'POST' && req.url === '/wallet/topup';
      if (!topup && !(req.method === 'GET' && req.url === '/wallet')) return send(404, null, 'NOT_FOUND');
      if (!req.headers.authorization) return send(401, null, 'UNAUTHORIZED');
      const identity = await fetch(new URL('/auth/me', identityUrl), {
        headers: { authorization: req.headers.authorization }, signal: AbortSignal.timeout(2000),
      });
      if (!identity.ok) return send(401, null, 'UNAUTHORIZED');
      const { data: user } = await identity.json();
      if (user?.role !== 'PASSENGER' || !validId(user.id)) return send(403, null, 'FORBIDDEN');
      if (!topup) {
        const { rows } = await pool.query(`SELECT ${walletFields} FROM wallets WHERE user_id = $1`, [user.id]);
        return send(200, wallet(rows[0]));
      }
      const key = req.headers['idempotency-key'] || randomUUID();
      if (typeof key !== 'string' || !/^[\w.-]{1,128}$/.test(key)) return send(400, null, 'INVALID_IDEMPOTENCY_KEY');
      const chunks = [];
      let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 4096) {
          req.resume();
          return send(413, null, 'PAYLOAD_TOO_LARGE');
        }
        chunks.push(chunk);
      }
      let amount;
      try { amount = JSON.parse(Buffer.concat(chunks)).amount; } catch { return send(400, null, 'INVALID_BODY'); }
      if (!money(amount)) return send(400, null, 'INVALID_AMOUNT');
      const result = await transaction(pool, async db => {
        const inserted = await db.query(`INSERT INTO wallet_topups (user_id, request_key, amount) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING`, [user.id, key, amount]);
        if (!inserted.rowCount) {
          const { rows: [previous] } = await db.query('SELECT * FROM wallet_topups WHERE user_id = $1 AND request_key = $2',
            [user.id, key]);
          return Number(previous.amount) === amount ? previous.result : null;
        }
        const { rows } = await db.query(`INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
          ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + EXCLUDED.balance RETURNING ${walletFields}`,
        [user.id, amount]);
        const saved = wallet(rows[0]);
        await db.query('UPDATE wallet_topups SET result = $3 WHERE user_id = $1 AND request_key = $2',
          [user.id, key, JSON.stringify(saved)]);
        return saved;
      });
      return result ? send(200, result) : send(409, null, 'IDEMPOTENCY_CONFLICT');
    } catch {
      return send(503, null, 'SERVICE_UNAVAILABLE');
    }
  });
}

async function start() {
  for (const name of ['RABBITMQ_URL', 'IDENTITY_URL', 'POSTGRES_HOST', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  const pool = new Pool({
    database: process.env.PAYMENT_DB_NAME || 'payment_db',
    host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 3000, statement_timeout: 5000,
  });
  pool.on('error', () => console.error('payment-service: PostgreSQL idle connection lost'));
  try {
    await pool.query(await readFile(join(__dirname, 'schema.sql'), 'utf8'));
  } catch {
    await pool.end();
    throw new Error('Payment migration failed');
  }
  const broker = serviceBroker({ url: process.env.RABBITMQ_URL, connect: require('amqplib').connect,
    queue: 'payment.queue', consume: event => handlePayment(pool, event) });
  const server = paymentServer(pool, process.env.IDENTITY_URL, broker.ready);
  server.listen(Number(process.env.PAYMENT_SERVICE_PORT || 8005));
  const transport = broker.loop();
  const stop = new AbortController();
  const worker = (async () => {
    while (!stop.signal.aborted) {
      if (broker.ready()) {
        try {
          const { rows } = await pool.query('SELECT * FROM payment_outbox WHERE published_at IS NULL LIMIT 20');
          for (const row of rows) {
            await broker.publish(row.envelope);
            await pool.query('UPDATE payment_outbox SET published_at = NOW() WHERE event_id = $1', [row.event_id]);
          }
        } catch {
          console.error('payment-service: outbox publish failed');
        }
      }
      await pause(250, undefined, { signal: stop.signal }).catch(() => {});
    }
  })();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      broker.stop();
      stop.abort();
      server.close(() => void Promise.allSettled([transport, worker]).then(() => pool.end()));
    });
  }
}

if (require.main === module) start().catch(() => {
  console.error('payment-service: startup failed');
  process.exitCode = 1;
});

module.exports = { handlePayment, paymentServer };
