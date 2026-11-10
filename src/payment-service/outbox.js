'use strict';

const crypto = require('node:crypto');
const config = require('./config');

/**
 * Insert an outbox event within an existing database transaction client
 */
async function insertOutboxEvent(client, { aggregateType, aggregateId, eventType, payload, correlationId }) {
  const eventId = crypto.randomUUID();
  const corrId = correlationId || `corr_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  await client.query(
    `INSERT INTO outbox_events 
     (id, aggregate_type, aggregate_id, event_type, payload, correlation_id, status, retry_count, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 0, $7)`,
    [eventId, aggregateType, aggregateId, eventType, JSON.stringify(payload), corrId, now]
  );

  return {
    eventId,
    eventType,
    correlationId: corrId,
  };
}

class OutboxWorker {
  constructor(pool, broker, options = {}) {
    this.pool = pool;
    this.broker = broker;
    this.pollIntervalMs = options.pollIntervalMs || config.OUTBOX_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize || 20;
    this.maxRetries = options.maxRetries || 5;
    this.timer = null;
    this.isRunning = false;
    this.isFlushing = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(async () => {
      if (this.isFlushing || !this.broker.isReady()) return;
      this.isFlushing = true;
      try {
        await this.flushPending();
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] [payment-service] [ERROR] Outbox worker flush error:`,
          err.message
        );
      } finally {
        this.isFlushing = false;
      }
    }, this.pollIntervalMs);

    if (this.timer.unref) this.timer.unref();
    console.log(
      `[${new Date().toISOString()}] [payment-service] [INFO] Outbox worker started (poll: ${this.pollIntervalMs}ms)`
    );
  }

  async flushPending() {
    const client = await this.pool.connect();
    let events = [];
    try {
      // Use FOR UPDATE SKIP LOCKED to prevent duplicate fetching if scaled horizontally
      const result = await client.query(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, correlation_id, retry_count, created_at 
         FROM outbox_events 
         WHERE status = 'PENDING' 
         ORDER BY created_at ASC 
         LIMIT $1 
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize]
      );
      events = result.rows;
    } finally {
      client.release();
    }

    if (!events || events.length === 0) return 0;

    let publishedCount = 0;

    for (const evt of events) {
      const envelope = {
        event_id: evt.id,
        correlation_id: evt.correlation_id,
        event_type: evt.event_type,
        timestamp: evt.created_at,
        source_service: config.SERVICE_NAME,
        version: '1.0',
        payload: typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload,
      };

      try {
        // Publish to broker with publisher confirmation
        await this.broker.publish(envelope);

        // Mark as published
        await this.pool.query(
          `UPDATE outbox_events 
           SET status = 'PUBLISHED', published_at = NOW() 
           WHERE id = $1`,
          [evt.id]
        );

        publishedCount++;
        console.log(
          `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [INFO] Outbox event published: ${evt.event_type} (${evt.id})`
        );
      } catch (publishErr) {
        const nextRetry = (evt.retry_count || 0) + 1;
        const newStatus = nextRetry >= this.maxRetries ? 'FAILED' : 'PENDING';

        console.error(
          `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [WARN] Outbox publish failed for event ${evt.id}: ${publishErr.message}. Attempt ${nextRetry}/${this.maxRetries}`
        );

        await this.pool.query(
          `UPDATE outbox_events 
           SET retry_count = $1, status = $2 
           WHERE id = $3`,
          [nextRetry, newStatus, evt.id]
        );
      }
    }

    return publishedCount;
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  insertOutboxEvent,
  OutboxWorker,
};
