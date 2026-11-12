'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const config = require('../src/payment-service/config');
const { verifyJwt, resolveRequestUser, resolveWalletTarget } = require('../src/payment-service/auth');
const { createPaymentHttpServer } = require('../src/payment-service/index');

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signToken(payload, { secret = config.JWT_SECRET, algorithm = 'HS256' } = {}) {
  const header = base64Url(JSON.stringify({ alg: algorithm, typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  if (algorithm === 'none') return `${header}.${body}.`;
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';

function futurePayload(userId) {
  return {
    sub: userId,
    userId,
    user_id: userId,
    email: 'user@example.com',
    role: 'PASSENGER',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

test('Payment JWT verification rejects forged, expired and alg=none tokens', () => {
  const valid = signToken(futurePayload(USER_A));
  assert.strictEqual(verifyJwt(valid).id, USER_A);

  const tampered = `${valid.slice(0, -2)}xx`;
  assert.strictEqual(verifyJwt(tampered), null);

  const wrongSecret = signToken(futurePayload(USER_A), { secret: 'wrong-secret' });
  assert.strictEqual(verifyJwt(wrongSecret), null);

  const expired = signToken({ ...futurePayload(USER_A), exp: Math.floor(Date.now() / 1000) - 1 });
  assert.strictEqual(verifyJwt(expired), null);

  const noneAlg = signToken(futurePayload(USER_A), { algorithm: 'none' });
  assert.strictEqual(verifyJwt(noneAlg), null);
});

test('Payment wallet ownership allows self, rejects other users, allows internal seed key', async () => {
  const unavailable = async () => ({ status: 'unavailable', user: null });
  const tokenA = signToken(futurePayload(USER_A));

  const selfReq = { headers: { authorization: `Bearer ${tokenA}` } };
  const self = await resolveWalletTarget(selfReq, USER_A, { identityLookup: unavailable });
  assert.strictEqual(self.userId, USER_A);
  assert.strictEqual(self.internal, false);

  await assert.rejects(
    resolveWalletTarget(selfReq, USER_B, { identityLookup: unavailable }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN'
  );

  const internalReq = { headers: { 'x-internal-key': config.INTERNAL_KEY } };
  const internal = await resolveWalletTarget(internalReq, USER_B, { identityLookup: unavailable });
  assert.strictEqual(internal.userId, USER_B);
  assert.strictEqual(internal.internal, true);

  await assert.rejects(
    resolveWalletTarget({ headers: {} }, USER_A, { identityLookup: unavailable }),
    (err) => err.status === 401
  );
});

test('Payment rejects a locally valid token revoked by Identity (blacklist)', async () => {
  const tokenA = signToken(futurePayload(USER_A));
  const req = { headers: { authorization: `Bearer ${tokenA}` } };
  const revoked = await resolveRequestUser(req, {
    identityLookup: async () => ({ status: 'invalid', user: null }),
  });
  assert.strictEqual(revoked, null);
});

test('Payment does not fall back to local JWT when Identity returns 401/403', async () => {
  const tokenA = signToken(futurePayload(USER_A));
  const req = { headers: { authorization: `Bearer ${tokenA}` } };
  const rejected = await resolveRequestUser(req, {
    identityLookup: async () => ({ status: 'rejected', user: null }),
  });
  assert.strictEqual(rejected, null);
});

test('Payment falls back to local JWT only when Identity is unavailable', async () => {
  const tokenA = signToken(futurePayload(USER_A));
  const req = { headers: { authorization: `Bearer ${tokenA}` } };
  const fallback = await resolveRequestUser(req, {
    identityLookup: async () => ({ status: 'unavailable', user: null }),
  });
  assert.strictEqual(fallback.id, USER_A);
});

test('Payment HTTP endpoints enforce 401/403 before touching the wallet DB', async (t) => {
  const originalIdentityUrl = config.IDENTITY_URL;
  const originalTimeout = config.IDENTITY_TIMEOUT_MS;
  config.IDENTITY_URL = 'http://127.0.0.1:1';
  config.IDENTITY_TIMEOUT_MS = 100;

  const server = createPaymentHttpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  t.after(() => {
    config.IDENTITY_URL = originalIdentityUrl;
    config.IDENTITY_TIMEOUT_MS = originalTimeout;
    server.close();
  });

  const noToken = await fetch(`${base}/api/v1/payments/wallet?user_id=${USER_A}`);
  assert.strictEqual(noToken.status, 401);

  const tokenA = signToken(futurePayload(USER_A));
  const otherUser = await fetch(`${base}/api/v1/payments/wallet?user_id=${USER_B}`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.strictEqual(otherUser.status, 403);
  const otherBody = await otherUser.json();
  assert.strictEqual(otherBody.error.code, 'FORBIDDEN');

  const topupOther = await fetch(`${base}/api/v1/payments/topup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokenA}`,
    },
    body: JSON.stringify({ user_id: USER_B, amount: 50000 }),
  });
  assert.strictEqual(topupOther.status, 403);
  const topupBody = await topupOther.json();
  assert.strictEqual(topupBody.error.code, 'FORBIDDEN');
});
