'use strict';

const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { connect } = require('amqplib');
const { serviceBroker } = require(process.env.TV2_SHARED_AMQP || '../../services/_shared/amqp.js');

const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const exchange = 'trip.exchange';
const dlx = 'trip.dlx';

async function until(check) {
  const end = Date.now() + 45000;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < end);
  throw new Error('Fixture deadline exceeded');
}

async function main() {
  const connection = await connect(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(exchange, 'topic', { durable: true });
  await channel.assertExchange(dlx, 'topic', { durable: true });
  await channel.assertQueue('trip.dlq', { durable: true });
  await channel.bindQueue('trip.dlq', dlx, '#');
  for (const service of ['trip', 'matching', 'payment']) {
    await channel.assertQueue(service + '.queue', {
      durable: true, deadLetterExchange: dlx, deadLetterRoutingKey: service + '.event.dlq',
    });
  }
  // The integration controller starts Matching only after these TV3-compatible queues exist.
  console.log('READY TV3 queue arguments');
  const trips = new Map();
  const payment = [];
  const failures = new Map();
  const tripBroker = serviceBroker({ url, connect, queue: 'trip.queue', consume: async event => {
    trips.set(event.payload.trip_id, event);
  } });
  const paymentBroker = serviceBroker({ url, connect, queue: 'payment.queue', consume: async event => {
    if (event.payload.force_retry) {
      failures.set(event.event_id, (failures.get(event.event_id) || 0) + 1);
      throw new Error('Synthetic handler failure');
    }
    payment.push(event);
  } });
  const loops = [tripBroker.loop(), paymentBroker.loop()];
  try {
    await until(async () => tripBroker.ready() && paymentBroker.ready());
    const driver = new URL(process.env.DRIVER_URL);
    await until(async () => (await fetch(new URL('/ready', process.env.MATCHING_URL || 'http://matching:8004'))
      .catch(() => null))?.ok);
    const user = randomUUID();
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({ alg: 'HS256' }) + '.' + encode({ userId: user, role: 'DRIVER', exp: Date.now()/1000+120 });
    const token = unsigned + '.' + createHmac('sha256', process.env.JWT_SECRET).update(unsigned).digest('base64url');
    async function request(path, method = 'GET', body) {
      const response = await fetch(new URL(path, driver), {
        method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    }
    await request('/drivers', 'POST', { name: 'Fixture', vehicle_plate: 'SIM-AMQP' });
    await request('/drivers/location', 'PUT', { latitude: 0, longitude: 0 });
    await request('/drivers/status', 'PUT', { status: 'AVAILABLE' });
    const envelope = (event_type, payload) => ({
      event_id: randomUUID(), event_type, payload, source_service: 'trip-service', version: '1.0',
      correlation_id: 'corr_' + randomUUID(), timestamp: new Date().toISOString(),
    });
    const create = () => envelope('trip.event.created', { trip_id: randomUUID(), passenger_id: randomUUID(),
      pickup_latitude: 0, pickup_longitude: 0, estimated_fare: 40000 });
    const inputs = [create(), create()];
    await Promise.all(inputs.map(event => tripBroker.publish(event)));
    await until(async () => inputs.every(event => trips.has(event.payload.trip_id)));
    const outputs = inputs.map(event => trips.get(event.payload.trip_id));
    assert.deepEqual(outputs.map(event => event.event_type).sort(), ['trip.event.driver_matched','trip.event.matching_failed']);
    const matched = outputs.find(event => event.event_type === 'trip.event.driver_matched');
    const winningInput = inputs.find(event => event.payload.trip_id === matched.payload.trip_id);
    assert.equal(matched.correlation_id, winningInput.correlation_id);
    assert.equal(matched.payload.passenger_id, winningInput.payload.passenger_id);
    assert.equal(matched.payload.driver_user_id, user);
    assert.equal(matched.payload.estimated_fare, 40000);
    assert.ok(Date.parse(matched.payload.expires_at) > Date.now());
    assert.equal((await request('/drivers/me')).id, matched.payload.driver_id);
    assert.equal((await request('/drivers/me')).status, 'RESERVED');
    console.log('PASS FT-06/CT-01 TV2 scope: real broker, one match, one loser, complete matched payload');

    await tripBroker.publish(envelope('trip.event.release_driver', { trip_id: matched.payload.trip_id,
      driver_id: matched.payload.driver_id, reservation_id: matched.payload.reservation_id }));
    await until(async () => (await request('/drivers/me')).status === 'AVAILABLE');
    const hold = envelope('payment.event.hold_requested', { trip_id: matched.payload.trip_id });
    await tripBroker.publish(hold);
    await until(async () => payment.length === 1);
    assert.equal(payment[0].event_id, hold.event_id);
    console.log('PASS AMQP routing: release returns driver to AVAILABLE and never reaches Payment');

    channel.publish(exchange, 'trip.event.created', Buffer.from('{'), { persistent: true });
    await channel.waitForConfirms();
    const dead = async () => {
      const message = await channel.get('trip.dlq', { noAck: true });
      return message || null;
    };
    const malformed = await until(dead);
    assert.equal(malformed.fields.routingKey, 'matching.event.dlq');
    const retry = envelope('payment.event.hold_requested', { trip_id: randomUUID(), force_retry: true });
    await tripBroker.publish(retry);
    const exhausted = await until(dead);
    assert.equal(exhausted.fields.routingKey, 'payment.event.dlq');
    assert.equal(JSON.parse(exhausted.content).event_id, retry.event_id);
    assert.equal(failures.get(retry.event_id), 4);
    console.log('PASS AMQP poison DLQ and three bounded retries preserving event_id');
  } finally {
    tripBroker.stop();
    paymentBroker.stop();
    await Promise.allSettled(loops);
    await connection.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
