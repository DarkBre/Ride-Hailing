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
     (id, aggregate_type, aggregate_id, event_type, payload, correlation_id, status, retry_count, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 0, $7, $7)`,
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
    this.retryDelaysMs = options.retryDelaysMs || [1000, 2000, 4000, 8000, 16000];
    this.leaseDurationSeconds = options.leaseDurationSeconds || 30;

    this.timer = null;
    this.isRunning = false;
    this.isFlushing = false;
    this.inFlightFlushes = new Set();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.recoverStaleLeases().catch((err) => {
      console.warn(`[${new Date().toISOString()}] [payment-service] [WARN] Initial outbox lease recovery error:`, err.message);
    });

    this.timer = setInterval(async () => {
      if (this.isFlushing || !this.isRunning || !this.broker || !this.broker.isReady()) return;
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

  async recoverStaleLeases() {
    try {
      const res = await this.pool.query(
        `UPDATE outbox_events 
         SET status = 'PENDING', locked_by = NULL, lease_expires_at = NULL, next_attempt_at = NOW()
         WHERE status = 'PUBLISHING' AND lease_expires_at < NOW()`
      );
      if (res.rowCount > 0) {
        console.log(`[${new Date().toISOString()}] [payment-service] [INFO] Reclaimed ${res.rowCount} expired outbox event lease(s) back to PENDING`);
      }
    } catch (_) {}
  }

  /**
   * Operator recovery hook: move FAILED events back to PENDING.
   */
  async requeueFailed(limit = 20) {
    const res = await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', retry_count = 0, next_attempt_at = NOW(),
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE status = 'FAILED'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [limit]
    );
    return res.rowCount || 0;
  }

  /**
   * Atomic claim with fencing token. No fallback path: if the claim query fails,
   * the next poll retries it instead of publishing unclaimed rows.
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
           WHERE (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
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
      console.error(
        `[${new Date().toISOString()}] [payment-service] [ERROR] Outbox claim failed; will retry on the next poll:`,
        err.message
      );
      return 0;
    }

    if (!events || events.length === 0) return 0;

    let publishedCount = 0;

    for (const evt of events) {
      let payload;
      try {
        payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
      } catch (parseErr) {
        await this._markFailure(evt, leaseToken, (evt.retry_count || 0), 'FAILED', 0,
          `Malformed payload: ${parseErr.message}`);
        console.error(
          `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [ERROR] Outbox event ${evt.id} has malformed payload; marked FAILED`
        );
        continue;
      }

      const envelope = {
        event_id: evt.id,
        correlation_id: evt.correlation_id,
        event_type: evt.event_type,
        timestamp: evt.created_at,
        source_service: config.SERVICE_NAME,
        version: '1.0',
        payload,
      };

      try {
        await this.broker.publish(envelope);

        const updateRes = await this.pool.query(
          `UPDATE outbox_events 
           SET status = 'PUBLISHED', 
               published_at = NOW(), 
               locked_by = NULL, 
               lease_expires_at = NULL,
               next_attempt_at = NULL,
               last_error = NULL
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
        const delayIndex = Math.min(nextRetry - 1, this.retryDelaysMs.length - 1);
        const delayMs = this.retryDelaysMs[delayIndex];
        const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));

        console.error(
          `[${new Date().toISOString()}] [${evt.correlation_id}] [payment-service] [WARN] Outbox publish failed for event ${evt.id}: ${publishErr.message}. Attempt ${nextRetry}/${this.maxRetries}`
        );

        await this._markFailure(evt, leaseToken, nextRetry, newStatus, delaySeconds,
          String(publishErr.message || 'publish failed').slice(0, 1000));
      }
    }

    return publishedCount;
  }

  async _markFailure(evt, leaseToken, retryCount, status, delaySeconds, lastError) {
    await this.pool.query(
      `UPDATE outbox_events
       SET retry_count = $1,
           status = $2,
           locked_by = NULL,
           locked_at = NULL,
           lease_expires_at = NULL,
           next_attempt_at = CASE WHEN $2::text = 'PENDING' THEN NOW() + ($5 || ' seconds')::INTERVAL ELSE NULL END,
           last_error = $6
       WHERE id = $3 AND (locked_by = $4 OR locked_by IS NULL)`,
      [retryCount, status, evt.id, leaseToken, String(delaySeconds || 0), lastError]
    );
  }

  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlightFlushes.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightFlushes));
    }
  }
}

module.exports = {
  insertOutboxEvent,
  OutboxWorker,
};
