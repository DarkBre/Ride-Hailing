'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const TRIP_SUBSCRIPTIONS = [
  'trip.event.driver_matched',
  'trip.event.matching_failed',
  'payment.event.hold_success',
  'payment.event.hold_failed',
];

class TripBroker {
  constructor(options = {}) {
    this.url = options.url || config.RABBITMQ.url;
    this.exchange = options.exchange || config.RABBITMQ.exchange;
    this.dlx = options.dlx || config.RABBITMQ.dlx;
    this.dlq = options.dlq || config.RABBITMQ.dlq;
    this.queue = options.queue || config.RABBITMQ.queue;
    this.retryDelays = options.retryDelays || config.RABBITMQ.retryDelays;
    this.maxRetries = options.maxRetries ?? config.RABBITMQ.maxRetries;
    this.prefetch = options.prefetch || config.RABBITMQ.prefetch;
    this.amqpLib = options.amqpLib || null;
    this.reconnectDelayMs = options.reconnectDelayMs || 2000;

    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
    this.messageHandler = null;
    this.isStopping = false;
    this.reconnectTimer = null;
    this.inFlightMessages = new Set();
    this.returnedMessages = new Set();
  }

  _getAmqpLib() {
    if (!this.amqpLib) {
      // Lazy require để các suite test HTTP/SQLite cục bộ không cần cài sẵn amqplib
      this.amqpLib = require('amqplib');
    }
    return this.amqpLib;
  }

  isReady() {
    return Boolean(this.channel && !this.isStopping);
  }

  async connect() {
    if (!this.url) {
      throw new Error('RABBITMQ_URL chưa được cấu hình');
    }

    this.isStopping = false;
    const amqp = this._getAmqpLib();
    this.connection = await amqp.connect(this.url, { timeout: 5000 });

    this.connection.on('error', (err) => {
      console.error(`[TRIP-SERVICE] RabbitMQ connection error: ${err.message}`);
    });
    this.connection.on('close', () => {
      this.channel = null;
      this.consumerTag = null;
      if (!this.isStopping) {
        console.warn('[TRIP-SERVICE] Mất kết nối RabbitMQ. Đang lên lịch kết nối lại...');
        this._scheduleReconnect();
      }
    });

    const ch = await this.connection.createConfirmChannel();
    this.channel = ch;
    ch.on('error', (err) => {
      console.error(`[TRIP-SERVICE] RabbitMQ channel error: ${err.message}`);
    });
    ch.on('close', () => {
      this.channel = null;
      this.consumerTag = null;
    });
    ch.on('return', (returnedMsg) => {
      if (returnedMsg?.properties?.messageId) {
        this.returnedMessages.add(returnedMsg.properties.messageId);
      }
    });

    await this.setupTopology();
    await ch.prefetch(this.prefetch);
    return this;
  }

  async setupTopology() {
    const ch = this.channel;
    if (!ch) throw new Error('Channel chưa sẵn sàng để khởi tạo topology');

    await ch.assertExchange(this.exchange, 'topic', { durable: true });
    await ch.assertExchange(this.dlx, 'topic', { durable: true });
    await ch.assertQueue(this.dlq, { durable: true });
    await ch.bindQueue(this.dlq, this.dlx, '#');

    // Khớp x-dead-letter-routing-key trong deploy/rabbitmq-definitions.json để tránh PRECONDITION_FAILED
    await ch.assertQueue(this.queue, {
      durable: true,
      deadLetterExchange: this.dlx,
      deadLetterRoutingKey: 'trip.event.dlq',
    });

    for (const key of TRIP_SUBSCRIPTIONS) {
      await ch.bindQueue(this.queue, this.exchange, key);
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

  async publish(envelope) {
    if (!this.channel) {
      throw new Error('RabbitMQ channel chưa sẵn sàng để publish');
    }

    const payloadBuffer = Buffer.from(JSON.stringify(envelope));
    const routingKey = envelope.event_type;
    const messageId = envelope.event_id || crypto.randomUUID();
    const ch = this.channel;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.returnedMessages.delete(messageId);
        reject(new Error(`RabbitMQ publisher confirm timeout cho event ${messageId}`));
      }, 5000);

      try {
        ch.publish(
          this.exchange,
          routingKey,
          payloadBuffer,
          {
            messageId,
            correlationId: envelope.correlation_id || '',
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
            const unroutable = this.returnedMessages.delete(messageId);
            if (err || unroutable) {
              reject(err || new Error(`RabbitMQ không tìm thấy route cho ${routingKey}`));
            } else {
              resolve({ published: true, messageId });
            }
          }
        );
      } catch (pubErr) {
        clearTimeout(timer);
        this.returnedMessages.delete(messageId);
        reject(pubErr);
      }
    });
  }

  async startConsumer(messageHandler) {
    this.messageHandler = messageHandler;
    if (!this.channel) throw new Error('RabbitMQ channel chưa sẵn sàng để consume');

    const consumerResult = await this.channel.consume(this.queue, async (msg) => {
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
    console.log(`[TRIP-SERVICE] RabbitMQ consumer đang lắng nghe queue: ${this.queue}`);
  }

  async _processIncomingMessage(msg, messageHandler) {
    const ch = this.channel;
    if (!ch) return;

    let envelope;
    try {
      if (msg.content.length > 65536) {
        throw new Error('Payload vượt quá 64KB');
      }
      envelope = JSON.parse(msg.content.toString('utf8'));
      if (!envelope || !envelope.event_id || !envelope.event_type || !envelope.payload) {
        throw new Error('Envelope thiếu event_id, event_type hoặc payload');
      }
    } catch (parseErr) {
      console.error(`[TRIP-SERVICE] Poison message -> chuyển thẳng DLQ: ${parseErr.message}`);
      try {
        ch.nack(msg, false, false);
      } catch (_) {}
      return;
    }

    const currentRetries = Number(msg.properties?.headers?.['x-ds03-retry'] || 0);

    try {
      await messageHandler(envelope);
      ch.ack(msg);
    } catch (handlerErr) {
      if (currentRetries >= this.maxRetries) {
        console.error(
          `[TRIP-SERVICE] Hết ${this.maxRetries} lần retry cho ${envelope.event_type} (${envelope.event_id}) -> DLQ: ${handlerErr.message}`
        );
        try {
          ch.nack(msg, false, false);
        } catch (_) {}
        return;
      }

      const delay = this.retryDelays[Math.min(currentRetries, this.retryDelays.length - 1)];
      const retryQueueName = `${this.queue}.retry.${envelope.event_type}.${delay}`;

      try {
        await new Promise((resolve, reject) => {
          ch.sendToQueue(
            retryQueueName,
            msg.content,
            {
              persistent: true,
              contentType: 'application/json',
              messageId: envelope.event_id,
              correlationId: envelope.correlation_id || '',
              headers: {
                ...(msg.properties?.headers || {}),
                'x-ds03-retry': currentRetries + 1,
                'x-last-error': String(handlerErr.message || 'error').slice(0, 200),
              },
            },
            (err) => (err ? reject(err) : resolve())
          );
        });
        ch.ack(msg);
      } catch (retryErr) {
        console.error(`[TRIP-SERVICE] Không thể đẩy vào retry queue -> nack requeue: ${retryErr.message}`);
        try {
          ch.nack(msg, false, true);
        } catch (_) {}
      }
    }
  }

  _scheduleReconnect() {
    if (this.isStopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopping) return;
      try {
        await this.connect();
        if (this.messageHandler) {
          await this.startConsumer(this.messageHandler);
        }
        console.log('[TRIP-SERVICE] Đã kết nối lại RabbitMQ thành công.');
      } catch (err) {
        console.warn(`[TRIP-SERVICE] Chưa kết nối được RabbitMQ (${err.message}), thử lại sau ${this.reconnectDelayMs}ms`);
        this._scheduleReconnect();
      }
    }, this.reconnectDelayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  async connectWithRetry(messageHandler) {
    this.messageHandler = messageHandler || this.messageHandler;
    try {
      await this.connect();
      if (this.messageHandler) {
        await this.startConsumer(this.messageHandler);
      }
      return true;
    } catch (err) {
      console.warn(`[TRIP-SERVICE] RabbitMQ chưa sẵn sàng lúc khởi động (${err.message}). Sẽ tự kết nối lại ở chế độ nền.`);
      this._scheduleReconnect();
      return false;
    }
  }

  async close() {
    this.isStopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (this.channel && this.consumerTag) {
        await this.channel.cancel(this.consumerTag).catch(() => {});
      }
      if (this.inFlightMessages.size > 0) {
        await Promise.race([
          Promise.allSettled([...this.inFlightMessages]),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      if (this.channel) {
        await this.channel.close().catch(() => {});
      }
      if (this.connection) {
        await this.connection.close().catch(() => {});
      }
    } finally {
      this.channel = null;
      this.connection = null;
      this.consumerTag = null;
    }
  }
}

module.exports = {
  TripBroker,
  TRIP_SUBSCRIPTIONS,
};
