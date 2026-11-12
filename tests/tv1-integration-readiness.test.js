'use strict';

/**
 * TEST SUITE 4: ADR-007 INTEGRATION READINESS (TV1)
 * Kiểm tra: Probes (/live, /ready), Optional JWT iss/aud, TripBroker (RabbitMQ Topology/Confirm/DLQ/Retry),
 * Driver Service Sync Contract (driver_user_id, supply nearby, /reservations/confirm & /release), Correlation ID.
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { createIdentityService } = require('../src/identity-service');
const { signToken } = require('../src/identity-service/auth');
const { createTripService } = require('../src/trip-service');
const { TripBroker, TRIP_SUBSCRIPTIONS } = require('../src/trip-service/broker');
const { createDriverClient } = require('../src/trip-service/driver-client');
const { normalizeCorrelationId } = require('../src/trip-service/outbox');
const config = require('../src/trip-service/config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILES = [
  path.join(DATA_DIR, 'test_tv1_ready_id.sqlite'),
  path.join(DATA_DIR, 'test_tv1_ready_trip_rmq.sqlite'),
  path.join(DATA_DIR, 'test_tv1_ready_trip_drv.sqlite'),
];

function cleanDbFiles() {
  for (const file of DB_FILES) {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(file + ext)) fs.unlinkSync(file + ext);
      } catch (_) {}
    }
  }
}

function makeRequest(port, { method = 'GET', path: reqPath = '/', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payloadStr = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (payloadStr) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payloadStr);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {
            parsed = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (payloadStr) req.write(payloadStr);
    req.end();
  });
}

function createMockAmqp() {
  const state = {
    exchanges: [],
    queues: [],
    bindings: [],
    published: [],
    sentToQueue: [],
    acked: [],
    nacked: [],
    returnOnNextPublish: false,
    consumeCallback: null,
    channel: null,
  };

  const listeners = new Map();
  const channel = {
    prefetchCount: 0,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    async assertExchange(name, type, opts) {
      state.exchanges.push({ name, type, opts });
    },
    async assertQueue(name, opts) {
      state.queues.push({ name, opts });
    },
    async bindQueue(queue, exchange, key) {
      state.bindings.push({ queue, exchange, key });
    },
    async prefetch(n) {
      channel.prefetchCount = n;
    },
    publish(exchange, routingKey, content, props, cb) {
      state.published.push({ exchange, routingKey, content: JSON.parse(content.toString('utf8')), props });
      if (state.returnOnNextPublish) {
        state.returnOnNextPublish = false;
        const retFns = listeners.get('return') || [];
        for (const fn of retFns) fn({ properties: { messageId: props.messageId } });
      }
      queueMicrotask(() => cb(null));
      return true;
    },
    sendToQueue(queue, content, opts, cb) {
      state.sentToQueue.push({ queue, content, opts });
      if (typeof cb === 'function') queueMicrotask(() => cb(null));
      return true;
    },
    async consume(queue, fn) {
      state.consumeCallback = fn;
      return { consumerTag: 'ctag-mock-1' };
    },
    ack(msg) {
      state.acked.push(msg);
    },
    nack(msg, allUpTo, requeue) {
      state.nacked.push({ msg, allUpTo, requeue });
    },
    async cancel() {},
    async close() {},
  };

  state.channel = channel;

  const amqpLib = {
    async connect() {
      return {
        on() {},
        async createConfirmChannel() {
          return channel;
        },
        async close() {},
      };
    },
  };

  return { amqpLib, state };
}

async function runTests() {
  console.log('=================================================================');
  console.log(' [TEST SUITE 4] ADR-007 INTEGRATION READINESS (TV1)');
  console.log('=================================================================');

  cleanDbFiles();
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  ✓ [PASS] ${name}`);
    } catch (err) {
      console.error(`  ✗ [FAIL] ${name}`);
      console.error('   ', err.stack || err.message);
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Phần 1: Identity Probes + Optional JWT iss/aud
  // ------------------------------------------------------------------
  const identitySvc = createIdentityService({ port: 8905, dbPath: DB_FILES[0] });
  await identitySvc.start();

  try {
    await test('Identity Probes: GET /live và GET /ready phản hồi HTTP 200 đúng schema', async () => {
      const liveRes = await makeRequest(8905, { path: '/live' });
      assert.strictEqual(liveRes.status, 200);
      assert.strictEqual(liveRes.body.data.status, 'UP');

      const readyRes = await makeRequest(8905, { path: '/ready' });
      assert.strictEqual(readyRes.status, 200);
      assert.strictEqual(readyRes.body.data.ready, true);
    });

    await test('Optional JWT iss/aud: Ký & kiểm tra thành công khi bật, từ chối khi sai iss/aud', async () => {
      const script = `
        const assert = require('node:assert');
        const crypto = require('node:crypto');
        const config = require('./src/identity-service/config');
        const idAuth = require('./src/identity-service/auth');
        const tripAuth = require('./src/trip-service/auth');
        const b64u = (s) => Buffer.from(s).toString('base64url');
        const rawSign = (claims) => {
          const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
          const p = b64u(JSON.stringify(claims));
          const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(h + '.' + p).digest('base64url');
          return h + '.' + p + '.' + sig;
        };
        const tok = idAuth.signToken({ userId: 'u1', role: 'PASSENGER', email: 'a@b.com' });
        const okPayload = tripAuth.verifyToken(tok);
        assert.ok(okPayload, 'Token hợp lệ với iss/aud phải verify thành công');
        assert.strictEqual(okPayload.iss, 'ds03-identity');
        assert.strictEqual(okPayload.aud, 'ds03-clients');
        const now = Math.floor(Date.now() / 1000);
        const wrongIss = rawSign({ userId: 'u1', role: 'PASSENGER', iss: 'evil-iss', aud: 'ds03-clients', iat: now, exp: now + 3600 });
        const wrongAud = rawSign({ userId: 'u1', role: 'PASSENGER', iss: 'ds03-identity', aud: 'wrong-aud', iat: now, exp: now + 3600 });
        assert.strictEqual(tripAuth.verifyToken(wrongIss), null, 'Sai iss phải bị từ chối');
        assert.strictEqual(tripAuth.verifyToken(wrongAud), null, 'Sai aud phải bị từ chối');
        assert.strictEqual(idAuth.verifyToken(wrongIss), null, 'Identity phải từ chối sai iss');
      `;
      const res = spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          JWT_ISSUER: 'ds03-identity',
          JWT_AUDIENCE: 'ds03-clients',
        },
        encoding: 'utf8',
      });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    });
  } finally {
    await identitySvc.stop();
  }

  // ------------------------------------------------------------------
  // Phần 2: TripBroker AMQP Topology, Confirm, Retry, DLQ
  // ------------------------------------------------------------------
  await test('TripBroker AMQP Topology: Khớp exchange, DLX, queue và deadLetterRoutingKey=trip.event.dlq', async () => {
    const { amqpLib, state } = createMockAmqp();
    const broker = new TripBroker({
      url: 'amqp://mock:5672',
      retryDelays: [10, 20, 40],
      maxRetries: 3,
      amqpLib,
    });

    await broker.connectWithRetry(async () => ({ action: 'OK' }));
    assert.strictEqual(broker.isReady(), true);

    assert.ok(state.exchanges.some((e) => e.name === 'trip.exchange' && e.type === 'topic' && e.opts.durable));
    assert.ok(state.exchanges.some((e) => e.name === 'trip.dlx' && e.type === 'topic' && e.opts.durable));

    const mainQueue = state.queues.find((q) => q.name === 'trip.queue');
    assert.ok(mainQueue, 'Phải khai báo queue trip.queue');
    assert.strictEqual(mainQueue.opts.deadLetterExchange, 'trip.dlx');
    assert.strictEqual(mainQueue.opts.deadLetterRoutingKey, 'trip.event.dlq');

    for (const key of TRIP_SUBSCRIPTIONS) {
      assert.ok(
        state.bindings.some((b) => b.queue === 'trip.queue' && b.exchange === 'trip.exchange' && b.key === key),
        `Phải bind routing key ${key}`
      );
    }

    const pub = await broker.publish({
      event_id: 'evt-1',
      event_type: 'trip.event.created',
      correlation_id: 'corr_test_1',
      payload: { trip_id: 't-1' },
    });
    assert.strictEqual(pub.published, true);
    assert.strictEqual(state.published.length, 1);
    assert.strictEqual(state.published[0].props.mandatory, true);

    // Unroutable basic.return -> reject để Outbox giữ PENDING
    state.returnOnNextPublish = true;
    await assert.rejects(
      () =>
        broker.publish({
          event_id: 'evt-unroutable',
          event_type: 'trip.event.created',
          correlation_id: 'corr_test_2',
          payload: {},
        }),
      /không tìm thấy route/
    );

    await broker.close();
  });

  await test('TripBroker Error Handling: Poison JSON -> DLQ trực tiếp; Transient error -> Retry -> DLQ', async () => {
    const { amqpLib, state } = createMockAmqp();
    const broker = new TripBroker({
      url: 'amqp://mock:5672',
      retryDelays: [10, 20, 40],
      maxRetries: 3,
      amqpLib,
    });

    await broker.connectWithRetry(async () => {
      throw new Error('Simulated DB lock');
    });

    // Poison message -> nack(msg, false, false) vào DLQ
    const poisonMsg = {
      content: Buffer.from('{bad json'),
      fields: { routingKey: 'trip.event.driver_matched' },
      properties: { headers: {} },
    };
    await state.consumeCallback(poisonMsg);
    assert.strictEqual(state.nacked.length, 1);
    assert.strictEqual(state.nacked[0].requeue, false);
    assert.strictEqual(state.sentToQueue.length, 0);

    // Retry lần 1 -> đẩy vào retry queue TTL 10ms, ack bản gốc
    const failOnceMsg = {
      content: Buffer.from(JSON.stringify({ event_id: 'e-retry-1', event_type: 'trip.event.driver_matched', payload: {} })),
      fields: { routingKey: 'trip.event.driver_matched' },
      properties: { headers: {} },
    };
    await state.consumeCallback(failOnceMsg);
    assert.strictEqual(state.sentToQueue.length, 1);
    assert.strictEqual(state.sentToQueue[0].queue, 'trip.queue.retry.trip.event.driver_matched.10');
    assert.strictEqual(state.sentToQueue[0].opts.headers['x-ds03-retry'], 1);
    assert.strictEqual(state.acked.length, 1);

    // Vượt quá maxRetries (retry=3) -> đẩy sang DLQ (nack requeue=false)
    const exhaustedMsg = {
      content: Buffer.from(JSON.stringify({ event_id: 'e-retry-max', event_type: 'trip.event.driver_matched', payload: {} })),
      fields: { routingKey: 'trip.event.driver_matched' },
      properties: { headers: { 'x-ds03-retry': 3 } },
    };
    await state.consumeCallback(exhaustedMsg);
    assert.strictEqual(state.nacked.length, 2);
    assert.strictEqual(state.nacked[1].msg, exhaustedMsg);
    assert.strictEqual(state.nacked[1].requeue, false);

    await broker.close();
  });

  // ------------------------------------------------------------------
  // Phần 3: TripService trong chế độ RabbitMQ + Readiness 503/200 + Correlation ID
  // ------------------------------------------------------------------
  await test('TripService RabbitMQ Mode: /ready 503/200, Correlation ID, Outbox -> AMQP & Consumer -> Saga', async () => {
    const { amqpLib, state } = createMockAmqp();
    const tripSvc = createTripService({
      port: 8906,
      dbPath: DB_FILES[1],
      useRabbitMq: true,
      amqpLib,
      brokerOptions: { url: 'amqp://mock:5672' },
      driverClient: {
        fetchAvailableSupply: async () => null,
        confirmReservation: async () => ({ state: 'CONFIRMED' }),
        releaseReservation: async () => ({ released: true }),
      },
    });
    await tripSvc.start();

    try {
      const liveRes = await makeRequest(8906, { path: '/live' });
      assert.strictEqual(liveRes.status, 200);
      assert.strictEqual(liveRes.body.data.status, 'alive');

      const readyOk = await makeRequest(8906, { path: '/ready' });
      assert.strictEqual(readyOk.status, 200);
      assert.strictEqual(readyOk.body.data.transport, 'rabbitmq');

      // Mô phỏng mất kết nối RabbitMQ -> /ready trả HTTP 503
      const savedCh = tripSvc.broker.channel;
      tripSvc.broker.channel = null;
      const readyDown = await makeRequest(8906, { path: '/ready' });
      assert.strictEqual(readyDown.status, 503);
      tripSvc.broker.channel = savedCh;

      // Correlation ID normalization
      assert.strictEqual(normalizeCorrelationId('corr.tv1-ok_99'), 'corr.tv1-ok_99');
      assert.match(normalizeCorrelationId('bad corr/<script>'), /^[\w.-]{1,100}$/);

      const paxToken = signToken({ userId: 'pax-rmq-1', role: 'PASSENGER', email: 'paxrmq@test.com' });
      const createRes = await makeRequest(8906, {
        method: 'POST',
        path: '/trips',
        headers: {
          Authorization: `Bearer ${paxToken}`,
          'x-correlation-id': 'bad/corr header',
        },
        body: {
          pickup_latitude: 10.77,
          pickup_longitude: 106.7,
          pickup_address: 'A',
          dropoff_latitude: 10.79,
          dropoff_longitude: 106.72,
          dropoff_address: 'B',
        },
      });
      assert.strictEqual(createRes.status, 201);
      assert.match(createRes.headers['x-correlation-id'], /^[\w.-]{1,100}$/);

      const tripId = createRes.body.data.id;
      await tripSvc.outboxManager.flushPending();
      assert.ok(state.published.some((p) => p.routingKey === 'trip.event.created' && p.content.payload.trip_id === tripId));

      // Tiêu thụ event từ RabbitMQ consumer callback -> cập nhật Saga -> Trip CONFIRMED
      await state.consumeCallback({
        content: Buffer.from(
          JSON.stringify({
            event_id: 'evt-rmq-matched-1',
            event_type: 'trip.event.driver_matched',
            correlation_id: 'corr_rmq_1',
            payload: {
              trip_id: tripId,
              driver_id: 'drv-rmq-prof',
              driver_user_id: 'drv-rmq-usr',
              reservation_id: 'res-rmq-1',
              estimated_fare: createRes.body.data.estimated_fare,
            },
          })
        ),
        fields: { routingKey: 'trip.event.driver_matched' },
        properties: { headers: {} },
      });

      await state.consumeCallback({
        content: Buffer.from(
          JSON.stringify({
            event_id: 'evt-rmq-hold-1',
            event_type: 'payment.event.hold_success',
            correlation_id: 'corr_rmq_1',
            payload: { trip_id: tripId },
          })
        ),
        fields: { routingKey: 'payment.event.hold_success' },
        properties: { headers: {} },
      });

      const getRes = await makeRequest(8906, {
        path: `/trips/${tripId}`,
        headers: { Authorization: `Bearer ${paxToken}` },
      });
      assert.strictEqual(getRes.status, 200);
      assert.strictEqual(getRes.body.data.status, 'CONFIRMED');
      assert.strictEqual(getRes.body.data.driver_user_id, 'drv-rmq-usr');
      assert.strictEqual(getRes.body.data.reservation_id, 'res-rmq-1');
    } finally {
      await tripSvc.stop();
    }
  });

  // ------------------------------------------------------------------
  // Phần 4: Driver Service HTTP Contract + driver_user_id + /confirm & /release + release_driver
  // ------------------------------------------------------------------
  const driverCalls = [];
  let confirmShouldFail409 = false;
  let nearbyOnline = true;

  const mockDriverServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const reqUrl = new URL(req.url, 'http://127.0.0.1:8907');

    driverCalls.push({
      method: req.method,
      pathname: reqUrl.pathname,
      search: reqUrl.search,
      internalKey: req.headers['x-internal-key'],
      body,
    });

    if (reqUrl.pathname === '/drivers/nearby') {
      if (!nearbyOnline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [{ id: 'drv-prof-1', user_id: 'usr-drv-1' }] }));
      return;
    }

    if (reqUrl.pathname === '/internal/reservations/confirm') {
      if (confirmShouldFail409) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            error: { code: 'RESERVATION_EXPIRED', message: 'Reservation đã hết hạn' },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { state: 'CONFIRMED' } }));
      return;
    }

    if (reqUrl.pathname === '/internal/reservations/release') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { state: 'RELEASED' } }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockDriverServer.listen(8907, '127.0.0.1', resolve));

  const tripWithDriverSvc = createTripService({
    port: 8908,
    dbPath: DB_FILES[2],
    useRabbitMq: false,
    onPublish: async () => {},
    driverClient: createDriverClient({ driverUrl: 'http://127.0.0.1:8907' }),
  });
  await tripWithDriverSvc.start();

  try {
    await test('Driver Contract: Dynamic supply thật vs fallback, driver_user_id RBAC, /confirm 409 & 200, /complete release_driver', async () => {
      const paxToken = signToken({ userId: 'pax-drv-1', role: 'PASSENGER', email: 'paxdrv@test.com' });
      const wrongProfileToken = signToken({ userId: 'drv-prof-1', role: 'DRIVER', email: 'prof@test.com' });
      const rightUserToken = signToken({ userId: 'usr-drv-1', role: 'DRIVER', email: 'usrdrv@test.com' });

      // 1. Live supply = 1 từ /drivers/nearby
      nearbyOnline = true;
      const t1 = await makeRequest(8908, {
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${paxToken}` },
        body: {
          pickup_latitude: 10.77,
          pickup_longitude: 106.7,
          pickup_address: 'Pick 1',
          dropoff_latitude: 10.78,
          dropoff_longitude: 106.71,
          dropoff_address: 'Drop 1',
        },
      });
      assert.strictEqual(t1.status, 201);
      const nearbyCall = driverCalls.find((c) => c.pathname === '/drivers/nearby');
      assert.ok(nearbyCall);
      assert.strictEqual(nearbyCall.internalKey, config.DRIVER_INTERNAL_KEY);

      // 2. Fallback an toàn khi Driver Service lỗi 503
      nearbyOnline = false;
      const t2 = await makeRequest(8908, {
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${paxToken}` },
        body: {
          pickup_latitude: 10.77,
          pickup_longitude: 106.7,
          pickup_address: 'Pick 2',
          dropoff_latitude: 10.78,
          dropoff_longitude: 106.71,
          dropoff_address: 'Drop 2',
        },
      });
      assert.strictEqual(t2.status, 201);

      const tripId = t1.body.data.id;

      // 3. Matched với driver_id !== driver_user_id + reservation_id
      const matchRes = await makeRequest(8908, {
        method: 'POST',
        path: '/internal/events',
        headers: { 'x-internal-key': config.INTERNAL_KEY },
        body: {
          event_id: 'evt-drv-match-1',
          event_type: 'trip.event.driver_matched',
          correlation_id: 'corr_drv_1',
          payload: {
            trip_id: tripId,
            driver_id: 'drv-prof-1',
            driver_user_id: 'usr-drv-1',
            reservation_id: 'res-abc-1',
            reservation_expires_at: '2026-11-12T18:00:00Z',
          },
        },
      });
      assert.strictEqual(matchRes.status, 200);

      const holdRes = await makeRequest(8908, {
        method: 'POST',
        path: '/internal/events',
        headers: { 'x-internal-key': config.INTERNAL_KEY },
        body: {
          event_id: 'evt-drv-hold-1',
          event_type: 'payment.event.hold_success',
          correlation_id: 'corr_drv_1',
          payload: { trip_id: tripId },
        },
      });
      assert.strictEqual(holdRes.status, 200);

      // 4. Token mang profile ID (drv-prof-1) thay vì user_id (usr-drv-1) phải bị chặn 403
      const forbidAccept = await makeRequest(8908, {
        method: 'POST',
        path: `/trips/${tripId}/accept`,
        headers: { Authorization: `Bearer ${wrongProfileToken}` },
      });
      assert.strictEqual(forbidAccept.status, 403);

      // 5. Khi Driver /confirm trả 409 RESERVATION_EXPIRED -> /accept trả 409 và giữ nguyên CONFIRMED
      confirmShouldFail409 = true;
      const expiredAccept = await makeRequest(8908, {
        method: 'POST',
        path: `/trips/${tripId}/accept`,
        headers: { Authorization: `Bearer ${rightUserToken}` },
      });
      assert.strictEqual(expiredAccept.status, 409);

      // 6. Khi Driver /confirm trả 200 -> /accept thành công
      confirmShouldFail409 = false;
      const okAccept = await makeRequest(8908, {
        method: 'POST',
        path: `/trips/${tripId}/accept`,
        headers: { Authorization: `Bearer ${rightUserToken}` },
      });
      assert.strictEqual(okAccept.status, 200);
      assert.strictEqual(okAccept.body.data.status, 'ACCEPTED');

      const confirmCalls = driverCalls.filter((c) => c.pathname === '/internal/reservations/confirm');
      assert.strictEqual(confirmCalls.length, 2);
      assert.strictEqual(confirmCalls[1].internalKey, config.DRIVER_TRIP_KEY);
      assert.deepStrictEqual(confirmCalls[1].body, {
        trip_id: tripId,
        driver_id: 'drv-prof-1',
        reservation_id: 'res-abc-1',
      });

      // 7. Start -> Complete -> phát BOTH trip.event.completed & trip.event.release_driver + gọi /release
      const startRes = await makeRequest(8908, {
        method: 'POST',
        path: `/trips/${tripId}/start`,
        headers: { Authorization: `Bearer ${rightUserToken}` },
      });
      assert.strictEqual(startRes.status, 200);

      const completeRes = await makeRequest(8908, {
        method: 'POST',
        path: `/trips/${tripId}/complete`,
        headers: { Authorization: `Bearer ${rightUserToken}` },
      });
      assert.strictEqual(completeRes.status, 200);
      assert.strictEqual(completeRes.body.data.status, 'COMPLETED');

      const outboxEvents = tripWithDriverSvc.db.all(
        'SELECT event_type, payload FROM outbox_events WHERE aggregate_id = ?;',
        tripId
      );
      const types = outboxEvents.map((e) => e.event_type);
      assert.ok(types.includes('trip.event.completed'));
      assert.ok(types.includes('trip.event.release_driver'));

      const releaseEvt = JSON.parse(outboxEvents.find((e) => e.event_type === 'trip.event.release_driver').payload);
      assert.strictEqual(releaseEvt.reservation_id, 'res-abc-1');
      assert.strictEqual(releaseEvt.reason, 'TRIP_COMPLETED');

      const releaseCall = driverCalls.find((c) => c.pathname === '/internal/reservations/release');
      assert.ok(releaseCall);
      assert.strictEqual(releaseCall.internalKey, config.DRIVER_TRIP_KEY);
      assert.deepStrictEqual(releaseCall.body, {
        trip_id: tripId,
        driver_id: 'drv-prof-1',
        reservation_id: 'res-abc-1',
      });
    });
  } finally {
    await tripWithDriverSvc.stop();
    await new Promise((resolve) => mockDriverServer.close(resolve));
    cleanDbFiles();
  }

  console.log(`\n🎉 KẾT QUẢ: ${passed}/${total} TESTS PASSED CHO ADR-007 INTEGRATION READINESS!`);
  return { passed, total };
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runTests };
