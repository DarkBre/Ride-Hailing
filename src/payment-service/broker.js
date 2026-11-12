'use strict';

const amqp = require('amqplib');
const crypto = require('node:crypto');
const config = require('./config');

const PAYMENT_SUBSCRIPTIONS = [
  'payment.event.hold_requested',
  'trip.event.completed',
  'payment.event.refund_requested',
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
    this.messageHandler = null;
    this.isStopping = false;
    this.inFlightMessages = new Set();
    this.returnedMessages = new Set();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnectDelayBaseMs = options.reconnectDelayBaseMs || 1000;
    this.reconnectDelayMaxMs = options.reconnectDelayMaxMs || 30000;
    this.isReconnecting = false;
  }

  isReady() {
    return Boolean(this.channel && !this.isStopping && !this.isReconnecting);
  }

  _wireChannel(ch) {
    ch.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] [payment-service] [ERROR] RabbitMQ channel error:`, err.message);
    });
    ch.on('return', (message) => {
      const messageId = message?.properties?.messageId;
      if (messageId) this.returnedMessages.add(messageId);
    });
    ch.on('close', () => {
      if (this.channel === ch) this.channel = null;
      this.consumerTag = null;
      this.returnedMessages.clear();
      if (!this.isStopping) this.scheduleReconnect();
    });
  }

  async connect() {
    if (this.isStopping) throw new Error('RabbitMQ broker is stopping');
    const connection = await amqp.connect(this.url, { timeout: 5000 });
    this.connection = connection;
    connection.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] [payment-service] [ERROR] RabbitMQ connection error:`, err.message);
    });
    connection.on('close', () => {
      if (this.channel) {
        this.channel = null;
      }
      this.consumerTag = null;
      this.returnedMessages.clear();
      if (!this.isStopping) {
        console.warn(`[${new Date().toISOString()}] [payment-service] [WARN] RabbitMQ connection closed. Scheduling reconnect.`);
        this.scheduleReconnect();
      }
    });

    try {
      const ch = await connection.createConfirmChannel();
      this.channel = ch;
      this._wireChannel(ch);

      await this.setupTopology();
      await ch.prefetch(this.prefetch);
      await this.cleanupLegacyBindings();
      this.reconnectAttempts = 0;
      return this;
    } catch (err) {
      this.channel = null;
      this.consumerTag = null;
      try {
        await connection.close();
      } catch (_) {}
      this.connection = null;
      throw err;
    }
  }

  /**
   * Remove legacy bindings on a throwaway channel so a missing binding cannot kill
   * the main consumer channel.
   */
  async cleanupLegacyBindings() {
    if (!this.connection) return;
    let cleanupChannel;
    try {
      cleanupChannel = await this.connection.createChannel();
      for (const legacyKey of ['trip.event.release_driver', 'trip.event.driver_matched']) {
        try {
          await cleanupChannel.unbindQueue(this.queue, this.exchange, legacyKey);
        } catch (_) {
          // A 404 closes only the throwaway channel; the main channel stays intact.
        }
      }
    } catch (_) {
      // Cleanup is best-effort and must never block startup.
    } finally {
      if (cleanupChannel) {
        try {
          await cleanupChannel.close();
        } catch (_) {}
      }
    }
  }

  scheduleReconnect() {
    if (this.isStopping || this.reconnectTimer || this.isReconnecting) return;
    const attempt = this.reconnectAttempts;
    const base = Math.min(this.reconnectDelayMaxMs, this.reconnectDelayBaseMs * (2 ** Math.min(attempt, 5)));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
    const delay = Math.min(this.reconnectDelayMaxMs, base + jitter);
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopping) return;
      this.isReconnecting = true;
      try {
        await this.connect();
        if (this.messageHandler) {
          await this.startConsumer(this.messageHandler);
        }
        this.isReconnecting = false;
        console.log(`[${new Date().toISOString()}] [payment-service] [INFO] RabbitMQ reconnected`);
      } catch (err) {
        this.isReconnecting = false;
        console.warn(`[${new Date().toISOString()}] [payment-service] [WARN] RabbitMQ reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      }
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
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

    // Legacy binding cleanup happens on a throwaway channel in cleanupLegacyBindings().

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
   * Publish an event with Publisher Confirmation and mandatory-route verification.
   * A basic.return (unroutable message) must not be reported as success.
   */
  async publish(envelope) {
    const channel = this.channel;
    if (!channel) {
      throw new Error('RabbitMQ channel not ready to publish');
    }

    const payloadBuffer = Buffer.from(JSON.stringify(envelope));
    const routingKey = envelope.event_type;
    const messageId = crypto.randomUUID();
    const eventId = envelope.event_id || messageId;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.returnedMessages.delete(messageId);
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        finish(new Error(`RabbitMQ publisher confirmation timeout for event ${eventId}`));
      }, 5000);

      try {
        channel.publish(
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
              'x-event-id': eventId,
            },
          },
          (err) => {
            if (err) {
              finish(err);
              return;
            }
            // Give amqplib a turn to emit the basic.return frame before declaring success.
            setImmediate(() => {
              if (this.returnedMessages.delete(messageId)) {
                finish(new Error(`RabbitMQ message ${eventId} was unroutable (basic.return)`));
              } else {
                finish(null, { published: true, messageId, eventId });
              }
            });
          }
        );
      } catch (err) {
        finish(err);
      }
    });
  }

  /**
   * Start consuming messages from payment.queue with Bounded Retries and DLQ
   */
  async startConsumer(messageHandler) {
    this.messageHandler = messageHandler;
    if (!this.channel) throw new Error('RabbitMQ channel not ready to consume');

    const ch = this.channel;

    const consumerResult = await ch.consume(this.queue, async (msg) => {
      if (!msg) return;

      const promise = this._processIncomingMessage(msg, messageHandler)
        .catch((err) => {
          console.error(
            `[${new Date().toISOString()}] [payment-service] [ERROR] Consumer promise rejected:`,
            err.message
          );
        });
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

    const safeAck = () => {
      try { ch.ack(msg); } catch (_) {}
    };
    const safeNack = (requeue = false) => {
      try { ch.nack(msg, false, requeue); } catch (_) {}
    };

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
      safeNack(false);
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
      safeAck();
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
          safeAck();
          console.log(
            `[${new Date().toISOString()}] [${corrId}] [payment-service] [INFO] Message scheduled in retry queue (${retryQueueName}, delay ${delay}ms)`
          );
        } catch (publishErr) {
          console.error(
            `[${new Date().toISOString()}] [${corrId}] [payment-service] [ERROR] Failed to route to retry queue, nacking to DLQ:`,
            publishErr.message
          );
          safeNack(false);
        }
      } else {
        // Exceeded bounded retries -> Route directly to DLQ
        console.error(
          `[${new Date().toISOString()}] [${corrId}] [payment-service] [ERROR] Max retries (${this.maxRetries}) exceeded for event ${envelope.event_id}. Moving to DLQ.`
        );
        safeNack(false);
      }
    }
  }

  async close() {
    this.isStopping = true;
    this.isReconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.channel && this.consumerTag) {
      try {
        await this.channel.cancel(this.consumerTag);
      } catch (_) {}
    }

    if (this.inFlightMessages.size > 0) {
      await Promise.race([
        Promise.allSettled(Array.from(this.inFlightMessages)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
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
