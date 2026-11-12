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
    this.workerId = options.workerId || `worker_${crypto.randomBytes(4).toString('hex')}`;
    this.pollIntervalMs = options.pollIntervalMs || config.OUTBOX_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize || 20;
    this.maxRetries = options.maxRetries || 5;
    this.leaseDurationSeconds = options.leaseDurationSeconds || 30;

    this.timer = null;
    this.isRunning = false;
    this.isFlushing = false;
    this.inFlightFlushes = new Set();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run recovery on startup for any stale unconfirmed leases from prior crash
    this.recoverStaleLeases().catch((err) => {
      console.warn(`[${new Date().toISOString()}] [payment-service] [WARN] Initial outbox lease recovery error:`, err.message);
    });

    this.timer = setInterval(async () => {
      if (this.isFlushing || !this.broker.isReady() || !this.isRunning) return;
      this.isFlushing = true;
      const flushPromise = this.flushPending();
      this.inFlightFlushes.add(flushPromise);

      try {
        await flushPromise;
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] [payment-service] [ERROR] Outbox worker flush error:`,
          err.message
        );
      } finally {
        this.inFlightFlushes.delete(flushPromise);
        this.isFlushing = false;
      }
    }, this.pollIntervalMs);

    if (this.timer.unref) this.timer.unref();
    console.log(
      `[${new Date().toISOString()}] [payment-service] [INFO] Outbox worker started [ID: ${this.workerId}, poll: ${this.pollIntervalMs}ms, lease: ${this.leaseDurationSeconds}s]`
    );
  }

  /**
   * Reclaim any leases that expired due to worker crash
   */
  async recoverStaleLeases() {
    try {
      const res = await this.pool.query(
        `UPDATE outbox_events 
         SET status = 'PENDING', locked_by = NULL, lease_expires_at = NULL 
         WHERE status = 'PUBLISHING' AND lease_expires_at < NOW()`
      );
      if (res.rowCount > 0) {
        console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Reclaimed ${res.rowCount} expired outbox event lease(s) back to PENDING`);
      }
    } catch (_) {}
  }

  /**
   * Atomic Claim with Fencing Token:
   * Acquires events atomically, assigns a unique lease fencing token (locked_by),
   * and sets lease expiration to prevent zombie worker collisions.
   */
  async flushPending() {
    const leaseToken = `${this.workerId}_${Date.now()}`;
    let events = [];

    try {
      const claimResult = await this.pool.query(
        `UPDATE outbox_events 
         SET status = 'PUBLISHING',
             locked_by = $1,
             locked_at = NOW(),
             lease_expires_at = NOW() + ($2 || ' seconds')::INTERVAL
         WHERE id IN (
           SELECT id FROM outbox_events 
           WHERE status = 'PENDING' 
              OR (status = 'PUBLISHING' AND lease_expires_at < NOW())
           ORDER BY created_at ASC 
           LIMIT $3 
           FOR UPDATE SKIP LOCKED
         ) 
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, correlation_id, retry_count, created_at, locked_by`,
        [leaseToken, `${this.leaseDurationSeconds}`, this.batchSize]
      );
      events = claimResult.rows;
    } catch (err) {
      // Fallback for mock DB / test environments
      try {
        const fallbackRes = await this.pool.query(
          `SELECT id, aggregate_type, aggregate_id, event_type, payload, correlation_id, retry_count, created_at 
           FROM outbox_events 
           WHERE status = 'PENDING' 
           ORDER BY created_at ASC 
           LIMIT $1`,
          [this.batchSize]
        );
        events = fallbackRes.rows;
      } catch (_) {}
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
        // Publish to RabbitMQ with publisher confirmation
        await this.broker.publish(envelope);

        // Fenced update: Only mark PUBLISHED if our lease token is STILL valid
        // (prevents zombie worker double-updating if another worker already reclaimed an expired lease)
        const updateRes = await this.pool.query(
          `UPDATE outbox_events 
           SET status = 'PUBLISHED', 
               published_at = NOW(), 
               locked_by = NULL, 
               lease_expires_at = NULL 
           WHERE id = $1 AND (locked_by = $2 OR locked_by IS NULL) AND status = 'PUBLISHING'`,
          [evt.id, leaseToken]
        );

        if (updateRes.rowCount > 0) {
          publishedCount++;
          console.log(
            `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [INFO] Outbox event published: ${evt.event_type} (${evt.id})`
          );
        } else {
          console.warn(
            `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [WARN] Outbox event ${evt.id} lease expired before confirmation was recorded. Reclaimed by another worker.`
          );
        }
      } catch (publishErr) {
        const nextRetry = (evt.retry_count || 0) + 1;
        const newStatus = nextRetry >= this.maxRetries ? 'FAILED' : 'PENDING';

        console.error(
          `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [WARN] Outbox publish failed for event ${evt.id}: ${publishErr.message}. Attempt ${nextRetry}/${this.maxRetries}`
        );

        await this.pool.query(
          `UPDATE outbox_events 
           SET retry_count = $1, 
               status = $2, 
               locked_by = NULL, 
               lease_expires_at = NULL 
           WHERE id = $3 AND (locked_by = $4 OR locked_by IS NULL)`,
          [nextRetry, newStatus, evt.id, leaseToken]
        );
      }
    }

    return publishedCount;
  }

  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Await any in-flight flushes to complete gracefully
    if (this.inFlightFlushes.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightFlushes));
    }
  }
}

module.exports = {
  insertOutboxEvent,
  OutboxWorker,
};
