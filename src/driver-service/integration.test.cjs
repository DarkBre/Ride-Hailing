const assert = require('node:assert/strict');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { driverServer } = require('./dist/index.js');

test('Driver HTTP + PostgreSQL', { skip: !process.env.DRIVER_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.DRIVER_TEST_DATABASE_URL;
  const schema = `driver_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const settings = {
    jwtSecret: randomBytes(32).toString('hex'),
    internalKey: randomBytes(32).toString('hex'),
    locationMinIntervalMs: 10_000,
    locationMaxAgeMs: 60_000,
  };
  const server = driverServer(pool, settings).listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
    // The test owns this randomly named schema.
    try {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await once(server, 'listening');
  await pool.query(await readFile(join(__dirname, 'schema.sql'), 'utf8'));
  const userId = randomUUID();
  const otherId = randomUUID();
  await pool.query(`INSERT INTO drivers (user_id, name, vehicle_plate)
    VALUES ($1, 'Demo One', 'SIM-001'), ($2, 'Demo Two', 'SIM-002')`, [userId, otherId]);
  const base = `http://127.0.0.1:${server.address().port}`;
  function token(user_id, role = 'DRIVER') {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'HS256' })}.${encode({ user_id, role, exp: Date.now() / 1000 + 60 })}`;
    return `${unsigned}.${createHmac('sha256', settings.jwtSecret).update(unsigned).digest('base64url')}`;
  }
  function put(path, body, bearer = token(userId)) {
    return fetch(`${base}/drivers/${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const getNearby = (key = settings.internalKey) => fetch(
    `${base}/drivers/nearby?lat=0&lon=0&radius_km=1`, { headers: { 'x-internal-key': key } },
  );
  const row = async id => (await pool.query('SELECT * FROM drivers WHERE user_id = $1', [id])).rows[0];

  await t.test('FT-03: validates coordinates and updates only the JWT owner', async () => {
    const denied = await put('location', { latitude: 0, longitude: 0 }, token(userId, 'PASSENGER'));
    assert.equal(denied.status, 403);
    assert.equal((await put('location', {}, 'invalid')).status, 401);
    for (const body of [{}, { latitude: null, longitude: 0 }, { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 }, { latitude: '0', longitude: 0 }]) {
      assert.equal((await put('location', body)).status, 400);
    }
    assert.equal((await put('location', { latitude: 0, longitude: 0 }, token(randomUUID()))).status, 404);
    const response = await put('location', { latitude: 0, longitude: 0, driverId: (await row(otherId)).id });
    assert.equal(response.status, 200);
    const saved = await row(userId);
    assert.equal(saved.latitude, 0);
    assert.equal(saved.longitude, 0);
    assert.ok(saved.location_updated_at instanceof Date);
    assert.equal((await row(otherId)).location_updated_at, null);
  });

  await t.test('FT-04: authorizes state transitions and protects BUSY', async () => {
    assert.equal((await put('status', { status: 'UNKNOWN' })).status, 400);
    assert.equal((await put('status', { status: 'BUSY' })).status, 403);
    assert.equal((await put('status', { status: 'AVAILABLE' })).status, 200);
    assert.equal((await row(userId)).status, 'AVAILABLE');
    await pool.query("UPDATE drivers SET status = 'BUSY' WHERE user_id = $1", [userId]);
    assert.equal((await put('status', { status: 'OFFLINE' })).status, 409);
    assert.equal((await row(userId)).status, 'BUSY');
    await pool.query("UPDATE drivers SET status = 'AVAILABLE' WHERE user_id = $1", [userId]);
  });

  await t.test('nearby excludes stale, never updated and offline positions', async () => {
    assert.equal((await getNearby('invalid')).status, 401);
    let result = await getNearby();
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, [{ id: (await row(userId)).id, distance_km: 0 }]);
    await pool.query(`UPDATE drivers SET location_updated_at = NOW() - interval '2 minutes' WHERE user_id = $1`,
      [userId]);
    assert.equal((await put('status', { status: 'AVAILABLE' })).status, 200);
    result = await getNearby();
    assert.deepEqual((await result.json()).data, []);
    assert.equal((await put('location', { latitude: 0, longitude: 0 }, token(otherId))).status, 200);
    assert.deepEqual((await (await getNearby()).json()).data, []);
  });

  await t.test('concurrent GPS updates share a PostgreSQL rate limit', async () => {
    const before = await row(userId);
    const results = await Promise.all([
      put('location', { latitude: 0, longitude: 1 }),
      put('location', { latitude: 0, longitude: 2 }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
    assert.equal((await row(userId)).version, before.version + 1);
  });

  await t.test('a failed database write rolls back and returns a generic error', async () => {
    await pool.query("ALTER TABLE drivers ADD CONSTRAINT test_offline_guard CHECK (status <> 'OFFLINE') NOT VALID");
    const before = await row(userId);
    const response = await put('status', { status: 'OFFLINE' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
    assert.deepEqual(await row(userId), before);
  });
});
