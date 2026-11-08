'use strict';

const crypto = require('node:crypto');

class OutboxManager {
  constructor(db, options = {}) {
    this.db = db;
    this.batchSize = options.batchSize || 50;
    this.maxRetries = options.maxRetries || 5;
    this.publishHandler = options.onPublish || null;
    this.timer = null;
  }

  /**
   * Ghi nhận sự kiện vào bảng outbox_events (Thường gọi cùng trong 1 DB Transaction)
   */
  insertEvent({ aggregateType, aggregateId, eventType, payload, correlationId }) {
    const eventId = crypto.randomUUID();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const corrId = correlationId || `corr_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, correlation_id, status, retry_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?);`,
      eventId,
      aggregateType,
      aggregateId,
      eventType,
      payloadStr,
      corrId,
      now
    );

    return {
      eventId,
      eventType,
      correlationId: corrId,
    };
  }

  /**
   * Quét và bắn các sự kiện đang PENDING
   */
  async flushPending(customPublishHandler = null) {
    const handler = customPublishHandler || this.publishHandler;
    const events = this.db.all(
      `SELECT * FROM outbox_events 
       WHERE status = 'PENDING' 
       ORDER BY created_at ASC 
       LIMIT ?;`,
      this.batchSize
    );

    if (!events || events.length === 0) return 0;

    let successCount = 0;

    for (const evt of events) {
      try {
        let payload = null;
        try {
          payload = JSON.parse(evt.payload);
        } catch (_) {
          payload = evt.payload;
        }

        const envelope = {
          event_id: evt.id,
          correlation_id: evt.correlation_id,
          event_type: evt.event_type,
          timestamp: evt.created_at,
          source_service: 'trip-service',
          version: '1.0',
          payload,
        };

        if (handler) {
          await handler(envelope);
        }

        // Đánh dấu đã publish thành công
        const now = new Date().toISOString();
        this.db.run(
          `UPDATE outbox_events 
           SET status = 'PUBLISHED', published_at = ? 
           WHERE id = ?;`,
          now,
          evt.id
        );
        successCount++;
      } catch (err) {
        const nextRetry = (evt.retry_count || 0) + 1;
        const newStatus = nextRetry >= this.maxRetries ? 'FAILED' : 'PENDING';
        this.db.run(
          `UPDATE outbox_events 
           SET retry_count = ?, status = ? 
           WHERE id = ?;`,
          nextRetry,
          newStatus,
          evt.id
        );
      }
    }

    return successCount;
  }

  /**
   * Bật worker định kỳ quét outbox
   */
  startWorker(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        await this.flushPending();
      } catch (_) {}
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Tắt worker
   */
  stopWorker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  OutboxManager,
};
