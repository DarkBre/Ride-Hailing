const { createHmac, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.JWT_ISSUER = 'test-issuer';
process.env.JWT_AUDIENCE = 'test-audience';
const identity = require('../src/identity-service/auth');
const trip = require('../src/trip-service/auth');

test('Identity and Trip reject signed tokens with invalid security claims', () => {
  const claims = { userId: 'test-driver', role: 'DRIVER', iss: 'test-issuer',
    aud: 'test-audience', exp: Math.floor(Date.now() / 1000) + 60 };
  function token(payload, alg = 'HS256') {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg })}.${encode(payload)}`;
    return `${body}.${createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url')}`;
  }
  const rejected = [
    token({ ...claims, exp: undefined }), token({ ...claims, exp: 1 }),
    token({ ...claims, iss: 'wrong' }), token({ ...claims, aud: 'wrong' }),
    token({ ...claims, role: 'ADMIN' }), token({ ...claims, userId: undefined }),
    token(claims, 'none'),
  ];
  for (const verify of [identity.verifyToken, trip.verifyToken]) {
    assert.equal(verify(identity.signToken({ userId: claims.userId, role: claims.role })).userId, claims.userId);
    for (const invalid of rejected) assert.equal(verify(invalid), null);
  }
  assert.equal(identity.verifyToken(token(claims), { get() { throw new Error('SQLite unavailable'); } }), null);
});
