'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createGatewayServer } = require('../src/api-gateway/index');
const config = require('../src/api-gateway/config');

test('API Gateway Routing, CORS, Timeouts and Distributed Tracing', async (t) => {
  let gatewayServer;
  let mockPaymentServer;
  let mockTripServer;
  let mockTimeoutServer;

  const GATEWAY_TEST_PORT = 18080;
  const PAYMENT_TEST_PORT = 18005;
  const TRIP_TEST_PORT = 18003;
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

    // Mock Upstream that never replies (to test timeout)
    mockTimeoutServer = http.createServer((req, res) => {
      // do not reply
    });
    await new Promise((r) => mockTimeoutServer.listen(TIMEOUT_TEST_PORT, r));

    // Configure Gateway targets for test
    config.SERVICES.payment = `http://127.0.0.1:${PAYMENT_TEST_PORT}`;
    config.SERVICES.trip = `http://127.0.0.1:${TRIP_TEST_PORT}`;
    config.SERVICES.identity = `http://127.0.0.1:${TIMEOUT_TEST_PORT}`; // maps timeout
    config.REQUEST_TIMEOUT_MS = 500; // fast timeout for test

    gatewayServer = createGatewayServer();
    await new Promise((r) => gatewayServer.listen(GATEWAY_TEST_PORT, r));
  }

  t.after(() => {
    gatewayServer.close();
    mockPaymentServer.close();
    mockTripServer.close();
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

  await t.test('5. Trả về HTTP 504 GATEWAY_TIMEOUT khi Upstream bị treo', async () => {
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

  await t.test('6. Trả về HTTP 502 UPSTREAM_UNAVAILABLE khi Upstream bị sập (Offline)', async () => {
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
