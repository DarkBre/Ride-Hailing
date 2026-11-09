import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { connect, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { created, event, Matching, released } from './matching';

const matchingQueue = 'matching.queue';
const retryDelays = [1000, 2000, 4000];

function publisher(channel: ConfirmChannel) {
  const returned = new Set<string>();
  channel.on('return', message => returned.add(message.properties.messageId));
  return async (exchange: string, key: string, body: Buffer, headers?: Record<string, number>) => {
    const messageId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Publisher confirm timeout'));
        void channel.close().catch(() => {});
      }, 5000);
      try {
        channel.publish(exchange, key, body, {
          persistent: true, mandatory: true, contentType: 'application/json', messageId, headers,
        }, error => {
          clearTimeout(timer);
          const unroutable = returned.delete(messageId);
          if (error || unroutable) reject(new Error('RabbitMQ did not route and confirm message'));
          else resolve();
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  };
}

export async function brokerLoop(matching: Matching, url: string, exchange: string, dlx: string, dlq: string,
  signal: AbortSignal, setReady: (ready: boolean) => void) {
  while (!signal.aborted) {
    let connection;
    let closed = false;
    try {
      connection = await connect(url, { timeout: 3000 });
      connection.on('error', () => {});
      connection.on('close', () => { closed = true; });
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      channel.on('close', () => { closed = true; });
      const publish = publisher(channel);
      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.assertExchange(dlx, 'topic', { durable: true });
      await channel.assertQueue(dlq, { durable: true });
      await channel.bindQueue(dlq, dlx, '#');
      await channel.assertQueue(matchingQueue, { durable: true, deadLetterExchange: dlx });
      for (const key of [created, released]) {
        await channel.bindQueue(matchingQueue, exchange, key);
        for (const delay of retryDelays) {
          await channel.assertQueue(retryQueue(key, delay), {
            durable: true, messageTtl: delay, deadLetterExchange: exchange, deadLetterRoutingKey: key,
          });
        }
      }
      await channel.prefetch(8);
      const consume = async (message: ConsumeMessage) => {
        let parsed;
        try {
          if (message.content.length > 16_384) throw new Error();
          parsed = event(JSON.parse(message.content.toString()));
          if (parsed.event_type !== message.fields.routingKey) throw new Error();
        } catch {
          channel.nack(message, false, false);
          return;
        }
        try {
          await matching.receive(parsed);
        } catch {
          const count = message.properties.headers?.['x-ds03-retry'];
          const attempt = Number.isInteger(count) && count >= 0 ? count as number : 0;
          if (attempt >= retryDelays.length) {
            channel.nack(message, false, false);
            return;
          }
          await publish('', retryQueue(parsed.event_type, retryDelays[attempt]), message.content,
            { 'x-ds03-retry': attempt + 1 });
        }
        channel.ack(message);
      };
      await channel.consume(matchingQueue, message => {
        if (!message) { closed = true; return; }
        void consume(message).catch(() => {
          // Close the channel so RabbitMQ can redeliver unacknowledged messages.
          closed = true;
        });
      });
      setReady(true);
      while (!closed && !signal.aborted) {
        const { rows } = await matching.pool.query(`
          SELECT event_id, envelope FROM outbox_events WHERE published_at IS NULL
          ORDER BY created_at, event_id LIMIT 20`);
        for (const row of rows) {
          await publish(exchange, row.envelope.event_type, Buffer.from(JSON.stringify(row.envelope)));
          await matching.pool.query('UPDATE outbox_events SET published_at = NOW() WHERE event_id = $1', [row.event_id]);
        }
        await pause(200, undefined, { signal });
      }
    } catch {
      if (!signal.aborted) console.error('matching-service: RabbitMQ disconnected or publish failed');
    } finally {
      setReady(false);
      await connection?.close().catch(() => {});
    }
    if (!signal.aborted) await pause(1000, undefined, { signal }).catch(() => {});
  }
}

function retryQueue(key: string, delay: number) {
  return `matching.retry.${key}.${delay}`;
}
