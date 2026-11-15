const assert = require('node:assert/strict');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { driverServer } = require('./dist/index.js');
const { expireReservations } = require('./dist/reservations.js');

test('Driver HTTP + PostgreSQL', { skip: !process.env.DRIVER_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.DRIVER_TEST_DATABASE_URL;
  const schema = `driver_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const settings = {
    jwtSecret: randomBytes(32).toString('hex'),
    internalKey: randomBytes(32).toString('hex'),
    tripKey: randomBytes(32).toString('hex'),
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

  await t.test('profile create, concurrent replay, ownership and update', async () => {
    const owner = randomUUID();
    const auth = { authorization: 'Bearer ' + token(owner), 'content-type': 'application/json' };
    const profile = (body, headers = auth) => fetch(base + '/drivers', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const me = () => fetch(base + '/drivers/me', { headers: auth });
    assert.equal((await me()).status, 404);
    assert.equal((await profile({}, { 'x-user-id': owner })).status, 401);
    assert.equal((await profile({}, { authorization: 'Bearer ' + token(owner, 'PASSENGER') })).status, 403);
    assert.equal((await profile({ name: ' ', vehicle_plate: 'SIM' })).status, 400);
    const body = { name: 'Tài xế mô phỏng', vehicle_plate: 'SIM-PROFILE', vehicle_model: 'Demo',
      user_id: otherId, status: 'BUSY', latitude: 10 };
    const responses = await Promise.all([profile(body), profile(body)]);
    assert.ok(responses.every(r => r.status === 200));
    const [first, second] = await Promise.all(responses.map(r => r.json().then(x => x.data)));
    assert.deepEqual(first, second);
    assert.equal(first.user_id, owner);
    assert.equal(first.status, 'OFFLINE');
    assert.equal(first.latitude, null);
    assert.equal((await row(otherId)).name, 'Demo Two');
    assert.equal((await put('location', { latitude: 0, longitude: 0 }, token(owner))).status, 200);
    assert.equal((await put('status', { status: 'AVAILABLE' }, token(owner))).status, 200);
    const updated = (await (await profile({ name: 'Tài xế mới', vehicle_plate: 'SIM-NEW' })).json()).data;
    assert.equal(updated.id, first.id);
    assert.equal(updated.name, 'Tài xế mới');
    assert.equal(updated.vehicle_model, 'Demo');
    assert.equal(updated.status, 'AVAILABLE');
    assert.equal(updated.latitude, 0);
    assert.deepEqual((await (await me()).json()).data, updated);
    await put('status', { status: 'OFFLINE' }, token(owner));
  });

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
    const [nearby] = (await result.json()).data;
    const driver = await row(userId);
    assert.equal(nearby.id, driver.id);
    assert.equal(nearby.user_id, userId);
    assert.equal(nearby.version, driver.version);
    assert.equal(nearby.location_updated_at, driver.location_updated_at.toISOString());
    assert.deepEqual([nearby.latitude, nearby.longitude, nearby.distance_km], [0, 0, 0]);
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
    await pool.query('ALTER TABLE drivers DROP CONSTRAINT test_offline_guard');
  });

  await t.test('reservation contention, retry, wrong owner, confirm, release and expiry', async () => {
    const call = async (suffix, payload, key = settings.internalKey) => {
      const response = await fetch(`${base}/internal/reservations${suffix}`, {
        method: 'POST', headers: { 'x-internal-key': key }, body: JSON.stringify(payload),
      });
      return { status: response.status, data: (await response.json()).data };
    };
    const snapshot = async () => {
      const current = await row(userId);
      return [{ id: current.id, version: current.version }];
    };
    const candidates = await snapshot();
    const trips = [randomUUID(), randomUUID()];
    const outcomes = await Promise.all(trips.map(trip_id => call('', { trip_id, candidates })));
    assert.equal(outcomes.filter(result => result.data?.state === 'HELD').length, 1);
    const winner = outcomes.find(result => result.data).data;
    const command = { trip_id: winner.trip_id, reservation_id: winner.id, driver_id: winner.driver_id };
    assert.equal((await row(userId)).status, 'RESERVED');
    assert.equal((await put('status', { status: 'AVAILABLE' })).status, 409);
    const retry = () => call('', { trip_id: winner.trip_id, candidates });
    assert.deepEqual((await Promise.all([retry(), retry()])).map(result => result.data.id), [winner.id, winner.id]);
    assert.equal((await call('/confirm', command)).status, 401);
    assert.equal((await call('/release', { ...command, reservation_id: randomUUID() }, settings.tripKey)).status, 404);
    assert.equal((await call('/confirm', command, settings.tripKey)).data.state, 'CONFIRMED');
    assert.equal((await call('/confirm', command, settings.tripKey)).data.state, 'CONFIRMED');
    assert.equal((await row(userId)).status, 'BUSY');
    await pool.query("UPDATE driver_reservations SET expires_at = NOW() - interval '1 second' WHERE id = $1", [winner.id]);
    assert.equal(await expireReservations(pool), 0);
    assert.equal((await call('/release', command, settings.tripKey)).data.state, 'RELEASED');
    assert.equal((await call('/release', command, settings.tripKey)).data.state, 'RELEASED');
    assert.equal((await row(userId)).status, 'AVAILABLE');
    const late = await call('', { trip_id: randomUUID(), candidates: await snapshot() });
    await pool.query("UPDATE driver_reservations SET expires_at = NOW() - interval '1 second' WHERE id = $1", [late.data.id]);
    assert.equal(await expireReservations(pool), 1);
    assert.equal((await call('/confirm', {
      trip_id: late.data.trip_id, reservation_id: late.data.id,
    }, settings.tripKey)).data.state, 'EXPIRED');
    const cancelled = { trip_id: randomUUID() };
    assert.equal((await call('/release', cancelled, settings.tripKey)).data.state, 'RELEASED');
    assert.equal((await call('', { ...cancelled, candidates: await snapshot() })).data.state, 'RELEASED');
    assert.equal((await row(userId)).status, 'AVAILABLE');
  });

  await t.test('SKIP LOCKED chooses the next ranked candidate while the first row is locked', async () => {
    await pool.query("UPDATE drivers SET status = 'AVAILABLE' WHERE user_id = $1", [otherId]);
    const candidates = [await row(userId), await row(otherId)].map(({ id, version }) => ({ id, version }));
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM drivers WHERE id = $1 FOR UPDATE', [candidates[0].id]);
      const response = await fetch(`${base}/internal/reservations`, {
        method: 'POST', headers: { 'x-internal-key': settings.internalKey },
        body: JSON.stringify({ trip_id: randomUUID(), candidates }),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.driver_id, candidates[1].id);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});
