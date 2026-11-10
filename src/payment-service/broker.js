'use strict';

const amqp = require('amqplib');
const crypto = require('node:crypto');
const config = require('./config');

const PAYMENT_SUBSCRIPTIONS = [
  'payment.event.hold_requested',
  'trip.event.driver_matched',
  'trip.event.completed',
  'payment.event.refund_requested',
  'trip.event.release_driver',
];

class PaymentBroker {
  constructor(options = {}) {
    this.url = options.url || config.RABBITMQ.url;
    this.exchange = options.exchange || config.RABBITMQ.exchange;
    this.dlx = options.dlx || config.RABBITMQ.dlx;
    this.dlq = options.dlq || config.RABBITMQ.dlq;
    this.queue = options.queue || config.RABBITMQ.queue;
    this.retryDelays = options.retryDelays || config.RABBITMQ.retryDelays;
    this.maxRetries = options.maxRetries || config.RABBITMQ.maxRetries;
    this.prefetch = options.prefetch || config.RABBITMQ.prefetch;

    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
    this.isStopping = false;
    this.inFlightMessages = new Set();
  }

  isReady() {
    return Boolean(this.channel && !this.isStopping);
  }

  async connect() {
    this.isStopping = false;
    this.connection = await amqp.connect(this.url, { timeout: 5000 });
    this.connection.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] [payment-service] [ERROR] RabbitMQ connection error:`, err.message);
    });
    this.connection.on('close', () => {
      if (!this.isStopping) {
        console.warn(`[${new Date().toISOString()}] [payment-service] [WARN] RabbitMQ connection closed. Channel invalidated.`);
        this.channel = null;
      }
    });

    const ch = await this.connection.createConfirmChannel();
    this.channel = ch;
    ch.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] [payment-service] [ERROR] RabbitMQ channel error:`, err.message);
    });
    ch.on('close', () => {
      this.channel = null;
    });

    await this.setupTopology();
    await ch.prefetch(this.prefetch);
    return this;
  }

  async setupTopology() {
    const ch = this.channel;
    if (!ch) throw new Error('Channel not available for topology setup');

    // 1. Declare Main Topic Exchange (Durable)
    await ch.assertExchange(this.exchange, 'topic', { durable: true });

    // 2. Declare Dead-Letter Exchange (DLX) & Dead-Letter Queue (DLQ)
    await ch.assertExchange(this.dlx, 'topic', { durable: true });
    await ch.assertQueue(this.dlq, { durable: true });
    await ch.bindQueue(this.dlq, this.dlx, '#');

    // 3. Declare Payment Main Queue with DLX configuration.
    // deadLetterRoutingKey must match rabbitmq-definitions.json to avoid PRECONDITION_FAILED
    // when RabbitMQ pre-creates the queue from load_definitions at container startup.
    await ch.assertQueue(this.queue, {
      durable: true,
      deadLetterExchange: this.dlx,
      deadLetterRoutingKey: 'payment.event.dlq',
    });

    // 4. Bind Payment Queue to relevant topics
    for (const key of PAYMENT_SUBSCRIPTIONS) {
      await ch.bindQueue(this.queue, this.exchange, key);
    }

    // 5. Declare Retry Delay Queues for Bounded Retries with Exponential Backoff
    for (const key of PAYMENT_SUBSCRIPTIONS) {
      for (const delay of this.retryDelays) {
        const retryQueueName = `${this.queue}.retry.${key}.${delay}`;
        await ch.assertQueue(retryQueueName, {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: this.exchange,
          deadLetterRoutingKey: key,
        });
      }
    }
  }

  /**
   * Publish an event to the main exchange with Publisher Confirmation
   */
  async publish(envelope) {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not ready to publish');
    }

    const payloadBuffer = Buffer.from(JSON.stringify(envelope));
    const routingKey = envelope.event_type;
    const messageId = envelope.event_id || crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RabbitMQ publisher confirmation timeout for event ${messageId}`));
      }, 5000);

      this.channel.publish(
        this.exchange,
        routingKey,
        payloadBuffer,
        {
          messageId,
          correlationId: envelope.correlation_id,
          contentType: 'application/json',
          persistent: true,
          mandatory: true,
          timestamp: Date.now(),
          headers: {
            'x-source-service': config.SERVICE_NAME,
            'x-correlation-id': envelope.correlation_id || '',
          },
        },
        (err) => {
          clearTimeout(timer);
          if (err) {
            reject(err);
          } else {
            resolve({ published: true, messageId });
          }
        }
      );
    });
  }

  /**
   * Start consuming messages from payment.queue with Bounded Retries and DLQ
   */
  async startConsumer(messageHandler) {
    if (!this.channel) throw new Error('RabbitMQ channel not ready to consume');

    const ch = this.channel;

    const consumerResult = await ch.consume(this.queue, async (msg) => {
      if (!msg) return;

      const promise = this._processIncomingMessage(msg, messageHandler);
      this.inFlightMessages.add(promise);
      try {
        await promise;
      } finally {
        this.inFlightMessages.delete(promise);
      }
    });

    this.consumerTag = consumerResult.consumerTag;
    console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Consumer active on queue: ${this.queue}`);
  }

  async _processIncomingMessage(msg, messageHandler) {
    const ch = this.channel;
    if (!ch) return;

    let envelope;
    try {
      if (msg.content.length > 65536) {
        throw new Error('Message payload exceeds maximum allowed size (64KB)');
      }
      envelope = JSON.parse(msg.content.toString('utf8'));
      if (!envelope.event_id || !envelope.event_type) {
        throw new Error('Invalid message envelope: missing event_id or event_type');
      }
    } catch (parseErr) {
      console.error(
        `[${new Date().toISOString()}] [payment-service] [ERROR] Poison message detected. Rejecting to DLQ:`,
        parseErr.message
      );
      // Poison message -> reject without requeue, moving it straight to DLQ
      try {
        ch.nack(msg, false, false);
      } catch (_) {}
      return;
    }

    const corrId = envelope.correlation_id || msg.properties.correlationId || 'no-corr-id';
    const currentRetries = Number(msg.properties.headers?.['x-ds03-retry'] || 0);

    try {
      console.log(
        `[${new Date().toISOString()}] [${corrId}] [payment-service] [INFO] Processing event: ${envelope.event_type} (${envelope.event_id})`
      );

      // Execute business handler
      await messageHandler(envelope);

      // Acknowledge successfully processed message
      ch.ack(msg);
      console.log(
        `[${new Date().toISOString()}] [${corrId}] [payment-service] [INFO] Event handled successfully: ${envelope.event_type}`
      );
    } catch (handlerErr) {
      console.error(
        `[${new Date().toISOString()}] [${corrId}] [payment-service] [WARN] Handler error for event ${envelope.event_type}: ${handlerErr.message}. Attempt ${currentRetries + 1}/${this.maxRetries}`
      );

      if (currentRetries < this.maxRetries) {
        // Bounded Retry via Delay Queue with Exponential Backoff
        const delay = this.retryDelays[Math.min(currentRetries, this.retryDelays.length - 1)];
        const retryQueueName = `${this.queue}.retry.${envelope.event_type}.${delay}`;

        try {
          await new Promise((resolve, reject) => {
            ch.publish(
              '', // default direct exchange
              retryQueueName,
              msg.content,
              {
                persistent: true,
                headers: {
                  ...msg.properties.headers,
                  'x-ds03-retry': currentRetries + 1,
                  'x-ds03-last-error': handlerErr.message,
                  'x-ds03-failed-at': new Date().toISOString(),
                },
              },
              (err) => (err ? reject(err) : resolve())
            );
          });

          // Acknowledge original message from main queue since it is parked safely in retry queue
          ch.ack(msg);
          console.log(
            `[${new Date().toISOString()}] [${corrId}] [payment-service] [INFO] Message scheduled in retry queue (${retryQueueName}, delay ${delay}ms)`
          );
        } catch (publishErr) {
          console.error(
            `[${new Date().toISOString()}] [${corrId}] [payment-service] [ERROR] Failed to route to retry queue, nacking to DLQ:`,
            publishErr.message
          );
          ch.nack(msg, false, false);
        }
      } else {
        // Exceeded bounded retries -> Route directly to DLQ
        console.error(
          `[${new Date().toISOString()}] [${corrId}] [payment-service] [ERROR] Max retries (${this.maxRetries}) exceeded for event ${envelope.event_id}. Moving to DLQ.`
        );
        ch.nack(msg, false, false);
      }
    }
  }

  async close() {
    this.isStopping = true;
    if (this.channel && this.consumerTag) {
      try {
        await this.channel.cancel(this.consumerTag);
      } catch (_) {}
    }

    if (this.inFlightMessages.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightMessages));
    }

    if (this.channel) {
      try {
        await this.channel.close();
      } catch (_) {}
      this.channel = null;
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch (_) {}
      this.connection = null;
    }
  }
}

module.exports = {
  PaymentBroker,
  PAYMENT_SUBSCRIPTIONS,
};
