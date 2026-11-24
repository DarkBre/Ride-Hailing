'use strict';

// =========================================================================
// [TV1] Transactional Outbox Pattern (Trip Service)
// Giải quyết bài toán Dual-Write: Lưu event vào outbox_events trong cùng DB transaction,
// Background worker quét định kỳ để gửi lên RabbitMQ với cam kết At-least-once delivery
// =========================================================================

const crypto = require('node:crypto');
const http = require('node:http');
const config = require('./config');

function normalizeCorrelationId(value) {
  if (typeof value === 'string' && /^[\w.-]{1,100}$/.test(value)) {
    return value;
  }
  return `corr_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Tạo HTTP Publisher gửi envelope sự kiện sang Message Broker (mặc định Port 4000)
 * Xác nhận Publisher Acknowledgment dựa trên HTTP Status 2xx từ Broker
 */
function createHttpPublisher(customBrokerUrl = null) {
  return function httpPublisher(envelope) {
    if (['amqp', 'rabbitmq'].includes(config.EVENT_TRANSPORT) && !customBrokerUrl) {
      return Promise.reject(
        new Error('EVENT_TRANSPORT=rabbitmq/amqp yêu cầu TripBroker (RABBITMQ_URL) thay vì HTTP Broker')
      );
    }

    const brokerUrl = customBrokerUrl || config.SERVICES.broker || 'http://127.0.0.1:4000';
    const parsed = new URL('/events', brokerUrl);

    return new Promise((resolve, reject) => {
      const payloadStr = JSON.stringify(envelope);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 4000,
          path: parsed.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payloadStr),
            'X-Internal-Key': config.INTERNAL_KEY,
            'X-Correlation-ID': envelope.correlation_id || '',
          },
          timeout: 5000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ acknowledged: true, statusCode: res.statusCode });
            } else {
              const errBody = Buffer.concat(chunks).toString('utf8');
              reject(new Error(`Broker từ chối event (${envelope.event_type}) với HTTP ${res.statusCode}: ${errBody}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        reject(new Error(`Không thể kết nối tới Broker (${brokerUrl}): ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Kết nối tới Broker (${brokerUrl}) bị quá hạn (Timeout 5000ms)`));
      });

      req.write(payloadStr);
      req.end();
    });
  };
}

const defaultHttpPublisher = createHttpPublisher();

class OutboxManager {
  constructor(db, options = {}) {
    this.db = db;
    this.batchSize = options.batchSize || 50;
    this.maxRetries = options.maxRetries || 5;
    this.publishHandler = options.onPublish !== undefined ? options.onPublish : defaultHttpPublisher;
    this.timer = null;
    this.isFlushing = false;
  }

  /**
   * Cập nhật publish handler lúc khởi động (ví dụ gắn RabbitMQ TripBroker)
   */
  setPublishHandler(handler) {
    this.publishHandler = handler;
  }

  // [TV1] Ghi nhận sự kiện vào outbox_events (gọi trong db.tx cùng nghiệp vụ)
  insertEvent({ aggregateType, aggregateId, eventType, payload, correlationId }) {
    const eventId = crypto.randomUUID(); // Mã định danh UUID duy nhất cho từng event
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const corrId = normalizeCorrelationId(correlationId); // Chuẩn hoá correlation ID để trace luồng
    const now = new Date().toISOString();

    // Lưu sự kiện vào bảng outbox_events với trạng thái PENDING
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

  // [TV1] Quét các sự kiện PENDING, gửi lên Broker và xác nhận Publisher Acknowledgment
  async flushPending(customPublishHandler = null) {
    if (this.isFlushing) return 0;

    const handler = customPublishHandler !== null ? customPublishHandler : this.publishHandler;
    if (!handler) {
      // Không có publish handler nào được cấu hình -> giữ nguyên PENDING để không fake PUBLISHED
      return 0;
    }

    this.isFlushing = true;
    try {
      // Quét theo lô 50 sự kiện PENDING theo thứ tự tạo cũ nhất trước
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

          // Đóng gói Envelope chuẩn của hệ phân tán
          const envelope = {
            event_id: evt.id,
            correlation_id: evt.correlation_id,
            event_type: evt.event_type,
            timestamp: evt.created_at,
            source_service: 'trip-service',
            version: '1.0',
            payload,
          };

          // Gửi lên Broker và chờ Publisher Acknowledgment
          await handler(envelope);

          // Nhận ACK thành công -> Đánh dấu sự kiện đã PUBLISHED
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
          // Gửi thất bại -> Tăng số lần thử lại, nếu >= 5 lần chuyển sang FAILED
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
    } finally {
      this.isFlushing = false;
    }
  }

  // [TV1] Background Worker: Quét và gửi sự kiện outbox định kỳ mỗi 1000ms
  startWorker(intervalMs = 1000) {
    if (this.timer) return;
    // Chạy vòng lặp định kỳ mỗi giây để giải phóng các sự kiện PENDING
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
  createHttpPublisher,
  defaultHttpPublisher,
  normalizeCorrelationId,
};
