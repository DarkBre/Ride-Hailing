const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');
const { Pool } = require('../src/matching-service/node_modules/pg');
const { driverServer } = require('../src/driver-service/dist/index.js');
const { Matching, event } = require('../src/matching-service/dist/matching.js');
const { matchingServer } = require('../src/matching-service/dist/index.js');
const { gateway } = require('../src/api-gateway');

test('Booking across Gateway, Identity, Trip, Matching and Driver with PostgreSQL', {
  skip: !process.env.DRIVER_TEST_DATABASE_URL,
  timeout: 25_000,
}, async t => {
  const pool = new Pool({ connectionString: process.env.DRIVER_TEST_DATABASE_URL });
  const schemas = [];
  const servers = [];
  const pools = [];
  let identity;
  let trip;
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await trip?.stop();
    await identity?.stop();
    await Promise.all(pools.map(p => p.end()));
    for (const schema of schemas) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
  async function database(service) {
    const schema = `booking_${service}_${randomBytes(6).toString('hex')}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    const ownedPool = new Pool({
      connectionString: process.env.DRIVER_TEST_DATABASE_URL, options: `-c search_path=${schema}`,
    });
    pools.push(ownedPool);
    await ownedPool.query(await readFile(resolve(__dirname, `../src/${service}-service/schema.sql`), 'utf8'));
    return ownedPool;
  }
  async function listen(server) {
    servers.push(server.listen(0, '127.0.0.1'));
    await once(server, 'listening');
    return address(server);
  }
  function address(server) {
    return `http://127.0.0.1:${server.address().port}`;
  }
  const secret = () => randomBytes(32).toString('hex');
  process.env.JWT_SECRET = secret();
  process.env.INTERNAL_KEY = secret();
  process.env.DRIVER_TRIP_KEY = secret();
  const driverKey = secret();
  const matchKey = secret();
  const driverDb = await database('driver');
  const matchDb = await database('matching');
  process.env.URL_DRIVER = await listen(driverServer(driverDb, {
    jwtSecret: process.env.JWT_SECRET, internalKey: driverKey, tripKey: process.env.DRIVER_TRIP_KEY,
    locationMinIntervalMs: 100, locationMaxAgeMs: 60_000, reservationTtlMs: 10_000,
  }));
  const settings = {
    driverUrl: process.env.URL_DRIVER, driverKey, tripKey: process.env.DRIVER_TRIP_KEY, radiusKm: 5,
    maxAgeMs: 60_000, matchingTimeoutMs: 20_000,
  };
  let matching = new Matching(matchDb, settings);
  const matchUrl = await listen(matchingServer(matching, matchKey, () => false));
  const transportErrors = [];
  async function request(url, path, method, body, headers = {}) {
    const response = await fetch(url + path, {
      method, headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
    });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data.data ?? data;
  }
  async function deliverToMatching(envelope) {
    return request(matchUrl, '/internal/events', 'POST', envelope, { 'x-internal-key': matchKey });
  }
  identity = require('../src/identity-service').createIdentityService({ dbPath: ':memory:' });
  trip = require('../src/trip-service').createTripService({
    dbPath: ':memory:',
    // This suite exercises real HTTP and databases. RabbitMQ has a separate transport suite.
    onPublish: async envelope => {
      if (['trip.event.created', 'trip.event.release_driver'].includes(envelope.event_type)) {
        try {
          await deliverToMatching(envelope);
        } catch (error) {
          transportErrors.push(error);
          throw error;
        }
      }
    },
  });
  const identityUrl = await listen(identity.server);
  const tripUrl = await listen(trip.server);
  const gatewayUrl = await listen(gateway({
    identity: identityUrl, driver: process.env.URL_DRIVER, trip: tripUrl, driverKey,
  }));
  const api = (path, method, body, token) => request(gatewayUrl, '/api/v1' + path, method, body,
    token ? { authorization: `Bearer ${token}` } : {});
  async function login(role) {
    const email = `${randomUUID()}@example.test`;
    const password = secret();
    await api('/auth/register', 'POST', { role, email, password, name: role, phone: '0123456789' });
    return api('/auth/login', 'POST', { email, password });
  }
  const [driver, ...passengers] = await Promise.all([login('DRIVER'), login('PASSENGER'), login('PASSENGER')]);
  // Driver profile provisioning is a separate operator action.
  await driverDb.query("INSERT INTO drivers (user_id, name, vehicle_plate) VALUES ($1, 'Demo', 'SIM-001')",
    [driver.user.id]);
  await api('/drivers/location', 'PUT', { latitude: 0, longitude: 0 }, driver.token);
  await api('/drivers/status', 'PUT', { status: 'AVAILABLE' }, driver.token);
  const draft = { pickup_latitude: 0, pickup_longitude: 0, pickup_address: 'Demo pickup',
    dropoff_latitude: 0.01, dropoff_longitude: 0.01, dropoff_address: 'Demo dropoff' };
  const jobs = await Promise.all(passengers.map(p => api('/trips', 'POST', draft, p.token)));
  await trip.outboxManager.flushPending();
  if (transportErrors.length) throw transportErrors[0];
  const inbound = (await matchDb.query('SELECT envelope FROM matching_requests ORDER BY trip_id')).rows;
  assert.equal(inbound.length, 2);
  assert.throws(() => event({ ...inbound[0].envelope, payload: { trip_id: 'bad' } }), TypeError);
  await Promise.all([
    deliverToMatching(inbound[0].envelope),
    deliverToMatching({ ...inbound[0].envelope, event_id: randomUUID() }),
  ]);
  assert.equal((await matchDb.query('SELECT count(*)::int AS n FROM matching_requests')).rows[0].n, 2);
  // Create fresh workers over the same durable queues to simulate restart before processing.
  matching = new Matching(matchDb, settings);
  await Promise.all([matching.runOnce(), new Matching(matchDb, settings).runOnce()]);
  const outcomes = (await matchDb.query('SELECT trip_id, state, result FROM matching_requests')).rows;
  assert.deepEqual(outcomes.map(o => o.state).sort(), ['MATCHED', 'NO_DRIVER']);
  const winner = outcomes.find(o => o.state === 'MATCHED');
  const outbox = (await matchDb.query('SELECT envelope FROM outbox_events')).rows;
  assert.equal(outbox.length, 2);
  for (const { envelope } of outbox) {
    await request(tripUrl, '/internal/events', 'POST', envelope, { 'x-internal-key': process.env.INTERNAL_KEY });
    await request(tripUrl, '/internal/events', 'POST', envelope, { 'x-internal-key': process.env.INTERNAL_KEY });
  }
  const active = () => driverDb.query("SELECT * FROM driver_reservations WHERE state IN ('HELD', 'CONFIRMED')");
  assert.equal((await active()).rowCount, 1);
  assert.equal(trip.db.get('SELECT status FROM trips WHERE id = ?', winner.trip_id).status, 'DRIVER_ASSIGNED');
  assert.equal((await api(`/trips/${winner.trip_id}/accept`, 'POST', {}, driver.token)).status, 'ACCEPTED');
  assert.equal((await api(`/trips/${winner.trip_id}/accept`, 'POST', {}, driver.token)).status, 'ACCEPTED');
  assert.equal((await driverDb.query('SELECT status FROM drivers')).rows[0].status, 'BUSY');
  const passenger = passengers[jobs.findIndex(job => job.id === winner.trip_id)];
  await api(`/trips/${winner.trip_id}/cancel`, 'POST', {}, passenger.token);
  await trip.outboxManager.flushPending();
  assert.equal((await active()).rowCount, 0);
  assert.equal((await driverDb.query('SELECT status FROM drivers')).rows[0].status, 'AVAILABLE');

  const recovered = await api('/trips', 'POST', draft, passenger.token);
  await trip.outboxManager.flushPending();
  const snapshot = await request(process.env.URL_DRIVER, '/internal/candidates', 'GET', undefined,
    { 'x-internal-key': driverKey });
  const held = await request(process.env.URL_DRIVER, '/internal/reservations', 'POST', {
    trip_id: recovered.id, candidates: snapshot.map(({ id, version }) => ({ id, version })),
  }, { 'x-internal-key': driverKey });
  // Simulate a worker crash after the Driver commit and before the Matching commit.
  await new Matching(matchDb, settings).runOnce();
  const persisted = await request(matchUrl, `/internal/matches/${recovered.id}`, 'GET', undefined,
    { 'x-internal-key': matchKey });
  assert.equal(persisted.state, 'MATCHED');
  assert.equal(persisted.result.reservation_id, held.id);
  assert.equal((await active()).rowCount, 1);
});
