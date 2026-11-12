'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const definitions = require(path.join(__dirname, '..', 'deploy', 'rabbitmq-definitions.json'));
const { PAYMENT_SUBSCRIPTIONS } = require('../src/payment-service/broker');

function queue(name) {
  return definitions.queues.find((item) => item.name === name);
}

function bindingsTo(destination, source = 'trip.exchange') {
  return definitions.bindings
    .filter((item) => item.source === source && item.destination === destination)
    .map((item) => item.routing_key);
}

test('Payment subscriptions exclude release_driver and driver_matched', () => {
  assert.deepStrictEqual(
    [...PAYMENT_SUBSCRIPTIONS].sort(),
    ['payment.event.hold_requested', 'payment.event.refund_requested', 'trip.event.completed']
  );
  assert.strictEqual(PAYMENT_SUBSCRIPTIONS.includes('trip.event.release_driver'), false);
  assert.strictEqual(PAYMENT_SUBSCRIPTIONS.includes('trip.event.driver_matched'), false);
});

test('RabbitMQ definitions do not route release_driver or driver_matched into payment.queue', () => {
  const keys = bindingsTo('payment.queue');
  assert.deepStrictEqual(
    keys.sort(),
    ['payment.event.hold_requested', 'payment.event.refund_requested', 'trip.event.completed']
  );
  assert.strictEqual(keys.includes('trip.event.release_driver'), false);
  assert.strictEqual(keys.includes('trip.event.driver_matched'), false);
});

test('RabbitMQ definitions route compensation to matching and notifications to notification.queue', () => {
  assert(bindingsTo('matching.queue').includes('trip.event.release_driver'));
  assert(bindingsTo('notification.queue').includes('#'));
  assert(bindingsTo('trip.queue').includes('payment.event.hold_success'));
  assert(bindingsTo('trip.queue').includes('payment.event.hold_failed'));
});

test('DLQ routing keys match the owning service code', () => {
  assert.strictEqual(
    queue('payment.queue').arguments['x-dead-letter-routing-key'],
    'payment.event.dlq'
  );
  assert.strictEqual(
    queue('trip.queue').arguments['x-dead-letter-routing-key'],
    'trip.event.dlq'
  );
  assert.strictEqual(
    queue('matching.queue').arguments['x-dead-letter-routing-key'],
    'matching.event.dlq'
  );
  assert.strictEqual(
    queue('notification.queue').arguments['x-dead-letter-routing-key'],
    'notification.event.dlq'
  );
});

test('Matching managed topology includes retry exchange and delay queues', () => {
  const exchange = definitions.exchanges.find((item) => item.name === 'matching.queue.retry');
  assert(exchange);
  assert.strictEqual(exchange.type, 'direct');

  for (const key of ['trip.event.created', 'trip.event.release_driver']) {
    for (const delay of [1000, 2000, 4000]) {
      const name = `matching.retry.${key}.${delay}`;
      assert(queue(name), `Thiếu retry queue ${name}`);
      assert(bindingsTo(name, 'matching.queue.retry').includes(name));
    }
  }
});
