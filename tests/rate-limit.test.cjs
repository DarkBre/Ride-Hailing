const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { createIdentityService } = require('../src/identity-service');

test('Identity rate limits IP and account concurrently, ignores spoofing and resets after cooldown', async t => {
  const key = randomBytes(32).toString('hex');
  let now = 1_000;
  const service = createIdentityService({ dbPath: ':memory:',
    rateLimit: { key, now: () => now, windowMs: 2000, ipLimit: 3, accountLimit: 2, registerLimit: 2 } });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  t.after(() => service.stop());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  async function post(action, email, ip, trusted = true, password = 'wrong-password') {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip,
      'x-ds03-client-ip': ip,
      'x-ds03-client-signature': trusted ? createHmac('sha256', key).update(ip).digest('hex') : '0'.repeat(64) };
    const response = await fetch(`${url}/auth/${action}`, {
      method: 'POST', headers, body: JSON.stringify({ email, password, name: 'Test', role: 'PASSENGER' }),
    });
    await response.json();
    return { status: response.status, retry: response.headers.get('retry-after') };
  }
  const a = '192.0.2.1';
  const b = '192.0.2.2';
  assert.equal((await post('register', 'known@example.test', a, true, 'test-password')).status, 201);
  assert.equal((await post('login', 'known@example.test', a, true, 'test-password')).status, 200);
  const duplicate = await Promise.all([post('login', 'known@example.test', b), post('login', 'known@example.test', b)]);
  assert.deepEqual(duplicate.map(item => item.status).sort(), [401, 429]);
  assert.equal(duplicate.find(item => item.status === 429).retry, '2');
  assert.equal((await post('login', 'other@example.test', a)).status, 401);
  for (let i = 0; i < 3; i++) {
    assert.equal((await post('login', `unknown${i}@example.test`, `192.0.2.${10+i}`, false)).status, 401);
  }
  assert.equal((await post('login', 'unknown4@example.test', '192.0.2.19', false)).status, 429);
  assert.equal((await post('register', 'second@example.test', a)).status, 201);
  assert.equal((await post('register', 'third@example.test', a)).status, 429);
  now += 2001;
  assert.equal((await post('login', 'known@example.test', a, true, 'test-password')).status, 200);
});
