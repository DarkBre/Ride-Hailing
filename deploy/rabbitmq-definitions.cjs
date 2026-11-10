const vhost = 'ds03';
const exchange = 'trip.exchange';
const dlx = 'trip.dlx';
const subscriptions = {
  matching: ['trip.event.created', 'trip.event.release_driver'],
  trip: ['trip.event.driver_matched', 'trip.event.matching_failed',
    'payment.event.hold_success', 'payment.event.hold_failed'],
  payment: ['payment.event.hold_requested', 'payment.event.refund_requested', 'trip.event.completed'],
};
const topics = {
  matching: ['trip.event.driver_matched', 'trip.event.matching_failed'],
  trip: ['trip.event.created', 'trip.event.release_driver', 'payment.event.hold_requested',
    'payment.event.refund_requested', 'trip.event.completed'],
  payment: ['payment.event.hold_success', 'payment.event.hold_failed'],
};
const definitions = {
  vhosts: [{ name: vhost }], queues: [], exchanges: [], bindings: [], permissions: [], topic_permissions: [],
};
function addExchange(name, type) {
  definitions.exchanges.push({ vhost, name, type, durable: true, auto_delete: false, internal: false, arguments: {} });
}
function queue(name, args = {}) {
  definitions.queues.push({ vhost, name, durable: true, auto_delete: false, arguments: args });
}
function bind(source, destination, routing_key) {
  definitions.bindings.push({ vhost, source, destination, destination_type: 'queue', routing_key, arguments: {} });
}
addExchange(exchange, 'topic');
addExchange(dlx, 'topic');
queue('trip.dlq');
bind(dlx, 'trip.dlq', '#');
for (const [user, keys] of Object.entries(subscriptions)) {
  const main = `${user}.queue`;
  const retryExchange = `${main}.retry`;
  addExchange(retryExchange, 'direct');
  queue(main, { 'x-dead-letter-exchange': dlx });
  for (const key of keys) {
    bind(exchange, main, key);
    for (const delay of [1000, 2000, 4000]) {
      const prefix = user === 'matching' ? 'matching.retry' : `${main}.retry`;
      const retry = `${prefix}.${key}.${delay}`;
      queue(retry, { 'x-message-ttl': delay, 'x-dead-letter-exchange': exchange, 'x-dead-letter-routing-key': key });
      bind(retryExchange, retry, retry);
    }
  }
  definitions.permissions.push({ user, vhost, configure: '^$',
    write: `^(trip\\.exchange|${user}\\.queue\\.retry)$`, read: `^${user}\\.queue$` });
  definitions.topic_permissions.push({ user, vhost, exchange,
    write: `^(${topics[user].map(topic => topic.replaceAll('.', '\\.')).join('|')})$`, read: '^$' });
}
process.stdout.write(JSON.stringify(definitions));
