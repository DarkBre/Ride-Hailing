'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { NotificationStore } = require('../src/notification-service/notification-logic');
const { createNotificationServer, store: serviceStore } = require('../src/notification-service/index');

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

test('Notification HTTP server serves health, readiness and recent notifications', async (t) => {
  const event = envelope('trip.event.created', {
    trip_id: crypto.randomUUID(),
    passenger_id: crypto.randomUUID(),
    estimated_fare: 45000,
  });
  serviceStore.handleEnvelope(event);

  const server = createNotificationServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());

  const live = await fetch(`http://127.0.0.1:${port}/live`);
  assert.strictEqual(live.status, 200);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.strictEqual(ready.status, 503, 'Chưa kết nối RabbitMQ thì readiness phải là 503');

  const list = await fetch(`http://127.0.0.1:${port}/notifications?limit=5`);
  assert.strictEqual(list.status, 200);
  const body = await list.json();
  assert(Array.isArray(body.data));
  assert(body.data.length >= 1);
});
