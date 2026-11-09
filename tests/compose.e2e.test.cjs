const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');

const base = process.env.GATEWAY_TEST_URL;
const docker = args => execFileSync('docker', ['compose', '--env-file', process.env.COMPOSE_TEST_ENV_FILE,
  '-p', process.env.COMPOSE_TEST_PROJECT, '-f', 'deploy/docker-compose.yml', ...args],
{ encoding: 'utf8', timeout: 15_000 });
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
}, () => {
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
  docker(['exec', '-T', 'matching', 'node', '-e', script]);
});
