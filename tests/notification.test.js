'use strict';

require('./test-env');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { NotificationStore } = require('../src/notification-service/notification-logic');
const notificationConfig = require('../src/notification-service/config');
const { createNotificationServer, store: serviceStore } = require('../src/notification-service/index');

function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', notificationConfig.JWT_SECRET)
    .update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function envelope(eventType, payload, eventId = crypto.randomUUID()) {
  return {
    event_id: eventId,
    event_type: eventType,
    correlation_id: `corr_${crypto.randomUUID()}`,
    payload,
  };
}

test('Notification deduplicates by event_id', () => {
  const store = new NotificationStore();
  const eventId = crypto.randomUUID();
  const event = envelope('trip.event.created', {
    trip_id: crypto.randomUUID(),
    passenger_id: crypto.randomUUID(),
    estimated_fare: 45000,
  }, eventId);

  const first = store.handleEnvelope(event);
  const second = store.handleEnvelope(event);

  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.notifications.length, 1);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.notifications.length, 0);
  assert.strictEqual(store.list().length, 1);
});

test('Notification creates Passenger and Driver messages for matching/complete events', () => {
  const store = new NotificationStore();
  const tripId = crypto.randomUUID();
  const passengerId = crypto.randomUUID();
  const driverUserId = crypto.randomUUID();

  const matched = store.handleEnvelope(envelope('trip.event.driver_matched', {
    trip_id: tripId,
    passenger_id: passengerId,
    driver_id: crypto.randomUUID(),
    driver_user_id: driverUserId,
  }));
  assert.strictEqual(matched.notifications.length, 2);
  assert.deepStrictEqual(matched.notifications.map((n) => n.audience).sort(), ['DRIVER', 'PASSENGER']);
  assert(matched.notifications.every((n) => n.user_id));

  const completed = store.handleEnvelope(envelope('trip.event.completed', {
    trip_id: tripId,
    passenger_id: passengerId,
    driver_user_id: driverUserId,
    fare: 45000,
  }));
  assert.strictEqual(completed.notifications.length, 2);
});

test('Notification emits compensation messages for failed hold and refund', () => {
  const store = new NotificationStore();
  const passengerId = crypto.randomUUID();

  const failed = store.handleEnvelope(envelope('payment.event.hold_failed', {
    trip_id: crypto.randomUUID(),
    passenger_id: passengerId,
    reason: 'INSUFFICIENT_FUNDS',
    required_amount: 45000,
    current_balance: 0,
  }));
  assert.strictEqual(failed.notifications.length, 1);
  assert.strictEqual(failed.notifications[0].audience, 'PASSENGER');
  assert.match(failed.notifications[0].message, /INSUFFICIENT_FUNDS/);

  const refund = store.handleEnvelope(envelope('payment.event.refund_requested', {
    trip_id: crypto.randomUUID(),
    passenger_id: passengerId,
    amount: 45000,
  }));
  assert.strictEqual(refund.notifications.length, 1);
  assert.match(refund.notifications[0].title, /hoàn tiền/i);
});

test('Notification rejects malformed envelopes for retry/DLQ handling', () => {
  const store = new NotificationStore();
  assert.throws(() => store.handleEnvelope(null), /Invalid/);
  assert.throws(() => store.handleEnvelope({ event_type: 'trip.event.created', payload: {} }), /event_id/);
  assert.throws(() => store.handleEnvelope({ event_id: 'x', event_type: 'trip.event.created' }), /payload/);
});

test('Notification dedup memory is bounded', () => {
  const store = new NotificationStore({ maxProcessed: 2, maxNotifications: 10 });
  const tripId = crypto.randomUUID();
  const passengerId = crypto.randomUUID();
  const first = crypto.randomUUID();

  store.handleEnvelope(envelope('trip.event.created', { trip_id: tripId, passenger_id: passengerId }, first));
  store.handleEnvelope(envelope('trip.event.created', { trip_id: tripId, passenger_id: passengerId }));
  store.handleEnvelope(envelope('trip.event.created', { trip_id: tripId, passenger_id: passengerId }));

  assert.strictEqual(store.processed.size, 2);
  const replay = store.handleEnvelope(envelope('trip.event.created', { trip_id: tripId, passenger_id: passengerId }, first));
  assert.strictEqual(replay.duplicate, false, 'Oldest ID is evicted once the bounded cache is exceeded');
});

test('Notification HTTP server serves health, readiness and scoped notifications', async (t) => {
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();
  const event = envelope('trip.event.created', {
    trip_id: crypto.randomUUID(),
    passenger_id: userId,
    estimated_fare: 45000,
  });
  serviceStore.handleEnvelope(event);

  const token = signToken({
    sub: userId,
    userId,
    user_id: userId,
    role: 'PASSENGER',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const server = createNotificationServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());

  const live = await fetch(`http://127.0.0.1:${port}/live`);
  assert.strictEqual(live.status, 200);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.strictEqual(ready.status, 503, 'Chưa kết nối RabbitMQ thì readiness phải là 503');

  const unauthorized = await fetch(`http://127.0.0.1:${port}/notifications?limit=5`);
  assert.strictEqual(unauthorized.status, 401);

  const list = await fetch(`http://127.0.0.1:${port}/notifications?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(list.status, 200);
  const body = await list.json();
  assert(Array.isArray(body.data));
  assert(body.data.length >= 1);
  assert(body.data.every((item) => item.user_id === userId));

  const crossUser = await fetch(
    `http://127.0.0.1:${port}/notifications?user_id=${otherUserId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert.strictEqual(crossUser.status, 401);

  const internal = await fetch(`http://127.0.0.1:${port}/notifications?limit=50`, {
    headers: { 'X-Internal-Key': notificationConfig.INTERNAL_KEY },
  });
  assert.strictEqual(internal.status, 200);
});
