const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');

const base = process.env.GATEWAY_TEST_URL;
const composeArgs = args => ['compose', '--env-file', process.env.COMPOSE_TEST_ENV_FILE,
  '-p', process.env.COMPOSE_TEST_PROJECT, '-f', 'deploy/docker-compose.yml', ...args];
const docker = args => execFileSync('docker', composeArgs(args), { encoding: 'utf8', timeout: 15_000 });
const dockerAsync = args => promisify(execFile)('docker', composeArgs(args), { timeout: 35_000 });
const sql = (db, statement, vars = []) => docker(['exec', '-T', 'postgres', 'psql',
  '-X', '-qAt', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', ...vars, '-c', statement]).trim();

async function request(path, method, body, token, headers = {}) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: { ...headers, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result.data;
}

async function account(role) {
  const email = `${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('hex');
  await request('/auth/register', 'POST', { email, password, name: role, phone: '0123456789', role });
  return request('/auth/login', 'POST', { email, password });
}

async function waitFor(read, expected, ms = 15_000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await read();
    if (expected(value)) return value;
    await pause(100);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for expected state. Last result: ${JSON.stringify(value)}`);
}

const enabled = Boolean(base && process.env.COMPOSE_TEST_PROJECT && process.env.COMPOSE_TEST_ENV_FILE);
test('Compose E2E, FT-06 and CT-01 on real RabbitMQ/PostgreSQL', { skip: !enabled, timeout: 70_000 }, async t => {
  const [driver, ...passengers] = await Promise.all([account('DRIVER'), account('PASSENGER'), account('PASSENGER')]);
  const id = driver.user.id;
  assert.match(id, /^[a-f0-9-]{36}$/i);
  const driverId = sql('driver_db', `INSERT INTO drivers (user_id, name, vehicle_plate)
    VALUES ('${id}', 'Demo', 'SIM-CT01') RETURNING id`);
  assert.match(driverId, /^[a-f0-9-]{36}$/i);
  // Coordinates near the pole isolate this test's driver from previous runs.
  const coordinate = { latitude: 89.4, longitude: 123.4 };
  const draft = { pickup_latitude: coordinate.latitude, pickup_longitude: coordinate.longitude, pickup_address: 'Demo A',
    dropoff_latitude: 89.42, dropoff_longitude: 123.4, dropoff_address: 'Demo B' };
  await request('/drivers/location', 'PUT', coordinate, driver.token);
  await request('/drivers/status', 'PUT', { status: 'AVAILABLE' }, driver.token);
  await Promise.all(passengers.map(p => request('/payments/topup', 'POST', { amount: 100000 }, p.token,
    { 'idempotency-key': randomUUID() })));
  const trips = await Promise.all(passengers.map(p => request('/trips', 'POST', draft, p.token)));
  const final = await waitFor(() => Promise.all(trips.map((trip, i) =>
    request(`/trips/${trip.id}`, 'GET', undefined, passengers[i].token))),
  rows => rows.every(row => ['CONFIRMED', 'CANCELLED'].includes(row.status)));
  assert.deepEqual(final.map(row => row.status).sort(), ['CANCELLED', 'CONFIRMED']);
  const winner = final.find(row => row.status === 'CONFIRMED');
  assert.equal(winner.driver_id, driverId);
  assert.equal(sql('driver_db', `SELECT count(*) FROM driver_reservations
    WHERE driver_id = '${driverId}' AND state IN ('HELD','CONFIRMED')`), '1');
  assert.equal((await request(`/trips/${winner.id}/accept`, 'POST', {}, driver.token)).status, 'ACCEPTED');
  assert.equal(sql('driver_db', `SELECT status FROM drivers WHERE id = '${driverId}'`), 'BUSY');
  assert.equal((await request(`/trips/${winner.id}/accept`, 'POST', {}, driver.token)).status, 'ACCEPTED');
  await request(`/trips/${winner.id}/start`, 'POST', {}, driver.token);
  await request(`/trips/${winner.id}/complete`, 'POST', {}, driver.token);
  await waitFor(() => sql('driver_db', `SELECT status FROM drivers WHERE id = '${driverId}'`),
    status => status === 'AVAILABLE');
  const winnerIndex = trips.findIndex(trip => trip.id === winner.id);
  const buyer = passengers[winnerIndex];
  const receipt = await waitFor(() => request('/payments/wallet', 'GET', undefined, buyer.token),
    balance => balance.held_balance === 0);
  assert.equal(receipt.balance, 100000 - trips[winnerIndex].estimated_fare);
  await request('/drivers/status', 'PUT', { status: 'OFFLINE' }, driver.token);
  t.diagnostic(`Exactly one assignment for driver ${driverId}, winning trip ${winner.id}`);
});

test('CT-02: two 40000 holds against a 50000 wallet', { skip: !enabled, timeout: 25_000 }, async () => {
  const passenger = await account('PASSENGER');
  const token = passenger.token;
  const topupKey = randomUUID();
  const deposit = () => request('/payments/topup', 'POST', { amount: 50000 }, token,
    { 'idempotency-key': topupKey });
  assert.deepEqual(await Promise.all([deposit(), deposit()]), [
    { balance: 50000, held_balance: 0 }, { balance: 50000, held_balance: 0 },
  ]);
  const trips = [randomUUID(), randomUUID()];
  const envelopes = trips.map(trip_id => {
    const id = randomUUID();
    return { event_id: id, correlation_id: id, event_type: 'payment.event.hold_requested',
      timestamp: new Date().toISOString(), source_service: 'trip-service', version: '1.0',
      payload: { trip_id, passenger_id: passenger.user.id, amount: 40000 } };
  });
  const script = `
    (async () => {
      const c = await require('amqplib').connect(process.env.RABBITMQ_URL);
      try {
        const ch = await c.createConfirmChannel();
        for (const event of JSON.parse(process.argv[1])) {
          ch.publish('trip.exchange', event.event_type, Buffer.from(JSON.stringify(event)), {persistent:true});
        }
        await ch.waitForConfirms();
      } finally { await c.close(); }
    })().catch(err => { console.error(err.message); process.exitCode = 1; });`;
  // The same event is delivered twice in addition to the independent competing hold.
  docker(['exec', '-T', 'payment', 'node', '-e', script, JSON.stringify([...envelopes, envelopes[0]])]);
  const states = () => sql('payment_db', `SELECT state FROM payment_holds WHERE trip_id IN ('${trips[0]}','${trips[1]}')
    ORDER BY state`).split(/\r?\n/);
  assert.deepEqual(await waitFor(states, rows => rows.length === 2), ['FAILED', 'HELD']);
  assert.deepEqual(await request('/payments/wallet', 'GET', undefined, token), { balance: 10000, held_balance: 40000 });
});

test('Matching restart, driver rejection, passenger cancellation and reservation expiry', {
  skip: !enabled, timeout: 95_000,
}, async () => {
  const [driver, fartherDriver, passenger] = await Promise.all([
    account('DRIVER'), account('DRIVER'), account('PASSENGER'),
  ]);
  const driverId = sql('driver_db', `INSERT INTO drivers (user_id, name, vehicle_plate)
    VALUES ('${driver.user.id}', 'Demo', 'SIM-RECOVERY') RETURNING id`);
  const coordinate = { latitude: -71.2, longitude: 5 };
  sql('driver_db', `INSERT INTO drivers (user_id, name, vehicle_plate)
    VALUES ('${fartherDriver.user.id}', 'Demo farther driver', 'SIM-FARTHER')`);
  const draft = { pickup_latitude: coordinate.latitude, pickup_longitude: coordinate.longitude, pickup_address: 'Demo',
    dropoff_latitude: -71.21, dropoff_longitude: 5, dropoff_address: 'Demo destination' };
  await request('/drivers/status', 'PUT', { status: 'AVAILABLE' }, driver.token);
  await request('/drivers/location', 'PUT', coordinate, driver.token);
  await request('/drivers/status', 'PUT', { status: 'AVAILABLE' }, fartherDriver.token);
  await request('/drivers/location', 'PUT', { latitude: -71.22, longitude: 5 }, fartherDriver.token);
  await request('/payments/topup', 'POST', { amount: 200000 }, passenger.token);
  const book = () => request('/trips', 'POST', draft, passenger.token);
  const get = trip => request(`/trips/${trip.id}`, 'GET', undefined, passenger.token);
  const driverStatus = () => sql('driver_db', `SELECT status FROM drivers WHERE id = '${driverId}'`);
  const refunded = async () => {
    await waitFor(driverStatus, status => status === 'AVAILABLE');
    await waitFor(() => request('/payments/wallet', 'GET', undefined, passenger.token),
      wallet => wallet.balance === 200000 && wallet.held_balance === 0);
  };
  let queuedTrip;
  docker(['stop', 'matching']);
  try {
    queuedTrip = await book();
    await pause(1500);
    assert.equal((await get(queuedTrip)).status, 'REQUESTED');
  } finally {
    docker(['start', 'matching']);
  }
  const matched = await waitFor(() => get(queuedTrip), trip => trip.status === 'CONFIRMED');
  assert.equal(matched.driver_id, driverId);
  await request(`/trips/${queuedTrip.id}/cancel`, 'POST', { reason: 'DRIVER_REJECTED' }, driver.token);
  await refunded();

  const cancelled = await book();
  await waitFor(() => get(cancelled), trip => trip.status === 'CONFIRMED');
  await request(`/trips/${cancelled.id}/cancel`, 'POST', { reason: 'PASSENGER_CANCELLED' }, passenger.token);
  await refunded();

  const timedOut = await book();
  await waitFor(() => get(timedOut), trip => trip.status === 'CONFIRMED');
  const expired = await waitFor(() => get(timedOut), trip => trip.status === 'CANCELLED', 40_000);
  assert.equal(expired.cancellation_reason, 'DRIVER_TIMEOUT');
  await refunded();
  await request('/drivers/status', 'PUT', { status: 'OFFLINE' }, driver.token);
  await request('/drivers/status', 'PUT', { status: 'OFFLINE' }, fartherDriver.token);
});

test('RabbitMQ retry is bounded and a failing release reaches DLQ', {
  skip: !enabled, timeout: 25_000,
}, async () => {
  const script = `
    const assert = require('node:assert/strict');
    const { randomUUID } = require('node:crypto');
    const { setTimeout: sleep } = require('node:timers/promises');
    (async () => {
      const connection = await require('amqplib').connect(process.env.RABBITMQ_URL);
      try {
        const ch = await connection.createConfirmChannel();
        const id = randomUUID();
        const event = {event_id:id,event_type:'trip.event.release_driver',timestamp:new Date().toISOString(),
          version:'1.0',source_service:'trip-service',correlation_id:id,
          payload:{trip_id:randomUUID(),reservation_id:randomUUID()}};
        ch.publish('trip.exchange', event.event_type, Buffer.from(JSON.stringify(event)), {persistent:true});
        await ch.waitForConfirms();
        const deadline = Date.now() + 13000;
        while (Date.now() < deadline) {
          const msg = await ch.get('trip.dlq', {noAck:false});
          if (!msg) { await sleep(250); continue; }
          if (JSON.parse(msg.content).event_id === id) {
            assert.equal(msg.properties.headers['x-ds03-retry'], 3);
            ch.ack(msg);
            return;
          }
        }
        throw new Error('Test event missing from DLQ');
      } finally { await connection.close(); }
    })().catch(err => { console.error(err.message); process.exitCode = 1; });`;
  await dockerAsync(['exec', '-T', 'matching', 'node', '-e', script]);
});

test('Chaos: RabbitMQ outage, Driver and PostgreSQL restarts preserve committed state', {
  skip: !enabled || process.env.RUN_CHAOS_TEST !== '1', timeout: 120_000,
}, async () => {
  const [driver, passenger] = await Promise.all([account('DRIVER'), account('PASSENGER')]);
  const driverId = sql('driver_db', `INSERT INTO drivers (user_id, name, vehicle_plate)
    VALUES ('${driver.user.id}', 'Chaos driver', 'SIM-CHAOS') RETURNING id`);
  const coordinate = { latitude: 33.1, longitude: -162 };
  await request('/drivers/location', 'PUT', coordinate, driver.token);
  await request('/drivers/status', 'PUT', { status: 'AVAILABLE' }, driver.token);
  await request('/payments/topup', 'POST', { amount: 150000 }, passenger.token);
  let trip;
  await dockerAsync(['stop', 'rabbitmq']);
  try {
    trip = await request('/trips', 'POST', {
      pickup_latitude: coordinate.latitude, pickup_longitude: coordinate.longitude, pickup_address: 'Chaos pickup',
      dropoff_latitude: 33.11, dropoff_longitude: -162, dropoff_address: 'Chaos dropoff',
    }, passenger.token);
    assert.equal((await request(`/trips/${trip.id}`, 'GET', undefined, passenger.token)).status, 'REQUESTED');
  } finally {
    await dockerAsync(['start', 'rabbitmq']);
  }
  const assigned = await waitFor(() => request(`/trips/${trip.id}`, 'GET', undefined, passenger.token),
    row => row.status === 'CONFIRMED', 25_000);
  assert.equal(assigned.driver_id, driverId);
  await request(`/trips/${trip.id}/accept`, 'POST', {}, driver.token);
  const reservation = () => sql('driver_db', `SELECT id || ':' || state FROM driver_reservations WHERE trip_id = '${trip.id}'`);
  const before = reservation();
  assert.match(before, /:CONFIRMED$/);
  await dockerAsync(['restart', 'driver']);
  await dockerAsync(['start', '--wait', 'driver']);
  assert.equal(reservation(), before);
  assert.equal(sql('driver_db', `SELECT status FROM drivers WHERE id = '${driverId}'`), 'BUSY');
  await dockerAsync(['restart', 'postgres']);
  await dockerAsync(['start', '--wait', 'postgres']);
  assert.equal(reservation(), before);
  assert.equal((await request('/payments/wallet', 'GET', undefined, passenger.token)).held_balance, trip.estimated_fare);
  await request(`/trips/${trip.id}/complete`, 'POST', {}, driver.token);
  const wallet = await waitFor(() => request('/payments/wallet', 'GET', undefined, passenger.token),
    value => value.held_balance === 0);
  assert.equal(wallet.balance, 150000 - trip.estimated_fare);
  await waitFor(reservation, value => value.endsWith(':RELEASED'));
  await request('/drivers/status', 'PUT', { status: 'OFFLINE' }, driver.token);
});

test('Load: concurrent GPS, nearby, booking and wallet traffic', {
  skip: !enabled || process.env.RUN_LOAD_TEST !== '1', timeout: 130_000,
}, async t => {
  const users = 8;
  const durationMs = 60_000;
  const drivers = await Promise.all(Array.from({ length: 4 }, () => account('DRIVER')));
  const passengers = await Promise.all(Array.from({ length: 4 }, () => account('PASSENGER')));
  const location = { latitude: 17, longitude: -141 };
  for (const driver of drivers) {
    sql('driver_db', `INSERT INTO drivers (user_id, name, vehicle_plate)
      VALUES ('${driver.user.id}', 'Load driver', 'SIM-LOAD')`);
    await request('/drivers/status', 'PUT', { status: 'AVAILABLE' }, driver.token);
  }
  const observations = {};
  async function measure(name, run) {
    const started = performance.now();
    let failed = false;
    try { return await run(); } catch { failed = true; return undefined; } finally {
      (observations[name] ??= []).push({ ms: performance.now() - started, failed });
    }
  }
  const draft = { pickup_latitude: location.latitude, pickup_longitude: location.longitude,
    pickup_address: 'Load pickup', dropoff_latitude: 17.01, dropoff_longitude: -141,
    dropoff_address: 'Load dropoff' };
  const start = performance.now();
  const deadline = start + durationMs;
  const queueSamples = [];
  const connectionSamples = [];
  const sample = setInterval(() => {
    try {
      const output = docker(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', 'list_queues',
        'name', 'messages_ready', 'messages_unacknowledged']);
      queueSamples.push(output.split(/\r?\n/).filter(line => /^(trip|payment|matching)\.queue\s/.test(line)));
      connectionSamples.push(sql('postgres', `SELECT datname || ':' || count(*) FROM pg_stat_activity
        WHERE datname IN ('driver_db','match_db','payment_db') GROUP BY datname ORDER BY datname`));
    } catch { /* Retain the samples already captured. */ }
  }, 15_000);
  try {
    await Promise.all([
      ...drivers.map(async driver => {
        while (performance.now() < deadline) {
          await measure('gps', () => request('/drivers/location', 'PUT', location, driver.token));
          await pause(1150);
        }
      }),
      ...passengers.map(async passenger => {
        while (performance.now() < deadline) {
          await measure('nearby', () => request('/drivers/available?lat=17&lon=-141&radius_km=5',
            'GET', undefined, passenger.token));
          await measure('wallet', () => request('/payments/wallet', 'GET', undefined, passenger.token));
          await measure('booking', () => request('/trips', 'POST', draft, passenger.token));
          // Zero-balance wallets exercise hold failure and compensating release under contention.
          await pause(1600);
        }
      }),
    ]);
  } finally {
    clearInterval(sample);
  }
  const seconds = (performance.now() - start) / 1000;
  const metrics = Object.fromEntries(Object.entries(observations).map(([name, samples]) => {
    const times = samples.map(item => item.ms).sort((a, b) => a - b);
    const percentile = p => Math.round(times[Math.ceil(times.length * p) - 1] * 10) / 10;
    return [name, { requests: times.length, errors: samples.filter(item => item.failed).length,
      average_ms: Math.round(times.reduce((a, b) => a + b, 0) / times.length * 10) / 10,
      p95_ms: percentile(.95), p99_ms: percentile(.99) }];
  }));
  t.diagnostic(JSON.stringify({ users, seconds, metrics, queueSamples, connectionSamples }));
  assert.ok(Object.values(metrics).every(item => item.requests > 0));
  await waitFor(() => sql('driver_db', `SELECT count(*) FROM driver_reservations WHERE state IN ('HELD','CONFIRMED')
    AND driver_id IN (SELECT id FROM drivers WHERE user_id IN (${drivers.map(d => `'${d.user.id}'`).join(',')}))`),
  count => count === '0', 30_000);
  for (const driver of drivers) await request('/drivers/status', 'PUT', { status: 'OFFLINE' }, driver.token);
});
