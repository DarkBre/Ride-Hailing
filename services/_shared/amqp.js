'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

const tripTopics = [
  'trip.event.driver_matched', 'trip.event.matching_failed',
  'payment.event.hold_success', 'payment.event.hold_failed',
];
const paymentTopics = ['payment.event.hold_requested', 'payment.event.refund_requested', 'trip.event.completed'];
const retryDelays = [1000, 2000, 4000];
const retryQueue = (queue, key, delay) => `${queue}.retry.${key}.${delay}`;

function serviceBroker({ url, connect, queue, consume }) {
  const subscriptions = queue === 'trip.queue' ? tripTopics : paymentTopics;
  const exchange = process.env.RABBITMQ_EXCHANGE || 'trip.exchange';
  const dlx = process.env.RABBITMQ_DLX || 'trip.dlx';
  const dlq = process.env.RABBITMQ_DLQ || 'trip.dlq';
  const managed = process.env.RABBITMQ_MANAGED_TOPOLOGY === '1';
  const retryExchange = managed ? `${queue}.retry` : '';
  const abort = new AbortController();
  let channel;
  let send;

  async function loop() {
    while (!abort.signal.aborted) {
      let connection;
      let consumer;
      let activeChannel;
      const inFlight = new Set();
      let closed = false;
      try {
        connection = await connect(url, { timeout: 3000 });
        connection.on('error', () => {});
        connection.on('close', () => { closed = true; });
        const ch = await connection.createConfirmChannel();
        activeChannel = ch;
        ch.on('error', () => {});
        ch.on('close', () => { closed = true; });
        if (!managed) {
          await ch.assertExchange(exchange, 'topic', { durable: true });
          await ch.assertExchange(dlx, 'topic', { durable: true });
          await ch.assertQueue(dlq, { durable: true });
          await ch.bindQueue(dlq, dlx, '#');
          await ch.assertQueue('trip.queue', { durable: true, deadLetterExchange: dlx });
          for (const key of tripTopics) await ch.bindQueue('trip.queue', exchange, key);
          await ch.assertQueue('payment.queue', { durable: true, deadLetterExchange: dlx });
          for (const key of paymentTopics) {
            await ch.bindQueue('payment.queue', exchange, key);
          }
          for (const key of subscriptions) {
            for (const delay of retryDelays) {
              await ch.assertQueue(retryQueue(queue, key, delay), {
                durable: true, messageTtl: delay, deadLetterExchange: exchange, deadLetterRoutingKey: key,
              });
            }
          }
        }
        await ch.prefetch(queue === 'payment.queue' ? 8 : 1);
        const returned = new Set();
        ch.on('return', message => returned.add(message.properties.messageId));
        const publish = (target, key, content, headers) => new Promise((resolve, reject) => {
          const messageId = randomUUID();
          const timer = setTimeout(() => {
            reject(new Error('RabbitMQ confirm timeout'));
            closed = true;
          }, 5000);
          try {
            ch.publish(target, key, content, {
              messageId, mandatory: true, persistent: true, contentType: 'application/json', headers,
            }, error => {
              clearTimeout(timer);
              const unroutable = returned.delete(messageId);
              if (error || unroutable) reject(new Error('RabbitMQ did not confirm routing'));
              else resolve();
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        async function handle(message) {
          if (!message) { closed = true; return; }
          let body;
          try {
            if (message.content.length > 16_384) throw new Error('Event too large');
            body = JSON.parse(message.content.toString());
            if (!body.event_id || !subscriptions.includes(body.event_type) ||
                body.event_type !== message.fields.routingKey) throw new Error('Invalid event');
          } catch {
            try { ch.nack(message, false, false); } catch { closed = true; }
            return;
          }
          try {
            try {
              await consume(body);
            } catch {
              const count = message.properties.headers?.['x-ds03-retry'];
              const attempt = Number.isInteger(count) && count >= 0 ? count : 0;
              if (attempt >= retryDelays.length) {
                ch.nack(message, false, false);
                return;
              }
              await publish(retryExchange, retryQueue(queue, body.event_type, retryDelays[attempt]), message.content,
                { 'x-ds03-retry': attempt + 1 });
            }
            ch.ack(message);
          } catch {
            closed = true;
          }
        }
        consumer = await ch.consume(queue, message => {
          const pending = handle(message);
          inFlight.add(pending);
          void pending.then(() => inFlight.delete(pending), () => {
            inFlight.delete(pending);
            closed = true;
          });
        });
        channel = ch;
        send = envelope => publish(exchange, envelope.event_type, Buffer.from(JSON.stringify(envelope)));
        while (!closed && !abort.signal.aborted) await pause(200, undefined, { signal: abort.signal });
      } catch {
        if (!abort.signal.aborted) console.error(`${queue}: RabbitMQ disconnected`);
      } finally {
        channel = undefined;
        send = undefined;
        if (abort.signal.aborted && consumer) {
          await Promise.race([
            activeChannel.cancel(consumer.consumerTag).then(() => Promise.allSettled(inFlight)).catch(() => {}),
            pause(8000, undefined, { ref: false }),
          ]);
        }
        await connection?.close().catch(() => {});
      }
      if (!abort.signal.aborted) await pause(1000, undefined, { signal: abort.signal }).catch(() => {});
    }
  }

  return {
    loop,
    stop: () => abort.abort(),
    ready: () => Boolean(channel),
    publish(envelope) {
      if (!channel) throw new Error('RabbitMQ unavailable');
      return send(envelope);
    },
  };
}

module.exports = { serviceBroker };
