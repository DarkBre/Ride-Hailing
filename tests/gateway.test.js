'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createGatewayServer, broadcastSimulationEvent, __test } = require('../src/api-gateway/index');
const config = require('../src/api-gateway/config');

function signGatewayToken(userId) {
  const payload = {
    sub: userId,
    userId,
    user_id: userId,
    role: 'PASSENGER',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

test('API Gateway Routing, CORS, Timeouts and Distributed Tracing', async (t) => {
  let gatewayServer;
  let mockPaymentServer;
  let mockTripServer;
  let mockTimeoutServer;
  let mockDriverServer;
  const driverRequests = [];

  const GATEWAY_TEST_PORT = 18080;
  const PAYMENT_TEST_PORT = 18005;
  const TRIP_TEST_PORT = 18003;
  const DRIVER_TEST_PORT = 18002;
  const TIMEOUT_TEST_PORT = 18009;

  // Setup Mock Upstream Servers
  before: {
    mockPaymentServer = http.createServer((req, res) => {
      const corrId = req.headers['x-correlation-id'];
      if (req.url.startsWith('/wallet')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Correlation-ID': corrId });
        return res.end(JSON.stringify({ balance: 150000, held_balance: 0 }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => mockPaymentServer.listen(PAYMENT_TEST_PORT, r));

    mockTripServer = http.createServer((req, res) => {
      const corrId = req.headers['x-correlation-id'];
      if (req.method === 'POST' && req.url === '/trips') {
        res.writeHead(201, { 'Content-Type': 'application/json', 'X-Correlation-ID': corrId });
        return res.end(JSON.stringify({ id: 'trip-123', status: 'REQUESTED' }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => mockTripServer.listen(TRIP_TEST_PORT, r));

    mockDriverServer = http.createServer((req, res) => {
      driverRequests.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((r) => mockDriverServer.listen(DRIVER_TEST_PORT, r));

    // Mock Upstream that never replies (to test timeout)
    mockTimeoutServer = http.createServer((req, res) => {
      // do not reply
    });
    await new Promise((r) => mockTimeoutServer.listen(TIMEOUT_TEST_PORT, r));

    // Configure Gateway targets for test
    config.SERVICES.payment = `http://127.0.0.1:${PAYMENT_TEST_PORT}`;
    config.SERVICES.trip = `http://127.0.0.1:${TRIP_TEST_PORT}`;
    config.SERVICES.driver = `http://127.0.0.1:${DRIVER_TEST_PORT}`;
    config.SERVICES.identity = `http://127.0.0.1:${TIMEOUT_TEST_PORT}`; // maps timeout
    config.REQUEST_TIMEOUT_MS = 500; // fast timeout for test

    gatewayServer = createGatewayServer();
    await new Promise((r) => gatewayServer.listen(GATEWAY_TEST_PORT, r));
  }

  t.after(() => {
    gatewayServer.close();
    mockPaymentServer.close();
    mockTripServer.close();
    mockDriverServer.close();
    mockTimeoutServer.close();
  });

  await t.test('1. CORS OPTIONS preflight trả về 204 với đầy đủ headers', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/payments/wallet`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert(res.headers.get('access-control-allow-methods').includes('GET'));
  });

  await t.test('2. Tự sinh Correlation-ID mới khi request chưa có header', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/health`);
    assert.strictEqual(res.status, 200);
    const corrId = res.headers.get('x-correlation-id');
    assert(corrId && corrId.startsWith('corr_'), 'Gateway phải tự động sinh Correlation-ID dạng corr_<uuid>');
  });

  await t.test('3. Bảo tồn Correlation-ID do client truyền vào và chuyển tiếp sang Upstream', async () => {
    const customCorr = 'corr_custom_trace_12345';
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/payments/wallet`, {
      headers: { 'X-Correlation-ID': customCorr },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-correlation-id'), customCorr);

    const body = await res.json();
    assert.strictEqual(body.balance, 150000);
  });

  await t.test('4. Định tuyến chính xác POST /api/v1/trips sang Trip Service', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/trips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passenger_id: 'p1' }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.id, 'trip-123');
  });

  await t.test('5. Chặn mọi request /internal đi qua Gateway', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/internal/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'anything' }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'INTERNAL_ROUTE_BLOCKED');
    assert.strictEqual(driverRequests.length, 0, 'Không được proxy request nội bộ tới upstream');
  });

  await t.test('6. Không gắn X-Internal-Key cho PUT /drivers/location và xoá key client giả mạo', async () => {
    driverRequests.length = 0;
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/drivers/location`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': 'attacker-supplied-key',
      },
      body: JSON.stringify({ latitude: 21.0285, longitude: 105.8544 }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(driverRequests.length, 1);
    assert.strictEqual(driverRequests[0].headers['x-internal-key'], undefined);
  });

  await t.test('7. Chỉ gắn X-Internal-Key cho projection GET /drivers/available', async () => {
    driverRequests.length = 0;
    const res = await fetch(
      `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/drivers/available?lat=21.0285&lon=105.8544&radius_km=5`
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(driverRequests.length, 1);
    assert.strictEqual(driverRequests[0].url.startsWith('/drivers/nearby'), true);
    assert.strictEqual(driverRequests[0].headers['x-internal-key'], config.DRIVER_INTERNAL_KEY);
  });

  await t.test('8. Chặn broadcast, notification và SSE khi thiếu xác thực', async () => {
    const broadcast = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/simulation/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'NOTIFICATION', user_id: 'x' }),
    });
    assert.strictEqual(broadcast.status, 401);

    const broadcastInternal = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/simulation/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': config.INTERNAL_KEY,
      },
      body: JSON.stringify({ type: 'NOTIFICATION', user_id: 'x' }),
    });
    assert.strictEqual(broadcastInternal.status, 200);

    const notifications = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/notifications`);
    assert.strictEqual(notifications.status, 401);

    const stream = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/simulation/stream`);
    assert.strictEqual(stream.status, 401);
    await stream.body?.cancel();
  });

  await t.test('9. Cho phép SSE khi có JWT hợp lệ', async () => {
    const token = signGatewayToken('11111111-1111-4111-a111-111111111111');
    const statusCode = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/simulation/stream?token=${encodeURIComponent(token)}`,
        (res) => {
          resolve(res.statusCode);
          res.destroy();
        }
      );
      req.on('error', reject);
    });
    assert.strictEqual(statusCode, 200);
  });

  await t.test('10. Trả về HTTP 504 GATEWAY_TIMEOUT khi Upstream bị treo', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    assert.strictEqual(res.status, 504);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'GATEWAY_TIMEOUT');
    assert(res.headers.get('x-correlation-id'));
  });

  await t.test('11. Trả về HTTP 502 UPSTREAM_UNAVAILABLE khi Upstream bị sập (Offline)', async () => {
    // Port 18099 is offline
    config.SERVICES.driver = 'http://127.0.0.1:18099';

    const res = await fetch(`http://127.0.0.1:${GATEWAY_TEST_PORT}/api/v1/drivers/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'AVAILABLE' }),
    });

    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'UPSTREAM_UNAVAILABLE');
    assert(res.headers.get('x-correlation-id'));
  });
});

test('Gateway SSE broadcast scopes notification payloads to the authenticated user', () => {
  const userA = '11111111-1111-4111-a111-111111111111';
  const userB = '22222222-2222-4222-a222-222222222222';
  const userClient = { written: [], write(payload) { this.written.push(payload); } };
  const internalClient = { written: [], write(payload) { this.written.push(payload); } };

  __test.sseClients.clear();
  __test.sseClients.set(userClient, { internal: false, userId: userA });
  __test.sseClients.set(internalClient, { internal: true, userId: null });

  broadcastSimulationEvent({ type: 'NOTIFICATION', user_id: userB, message: 'for B' });
  assert.strictEqual(userClient.written.length, 0);
  assert.strictEqual(internalClient.written.length, 1);

  broadcastSimulationEvent({ type: 'NOTIFICATION', user_id: userA, message: 'for A' });
  assert.strictEqual(userClient.written.length, 1);
  assert.strictEqual(internalClient.written.length, 2);

  broadcastSimulationEvent({ type: 'HTTP_TRACE', path: '/health' });
  assert.strictEqual(userClient.written.length, 2);

  __test.sseClients.clear();
});
