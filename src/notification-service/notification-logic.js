'use strict';

const crypto = require('node:crypto');

const MAX_NOTIFICATIONS = 500;

function safeText(value, fallback = '') {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function buildMessage(eventType, payload, audience) {
  const tripId = payload.trip_id || null;
  const amount = Number(payload.amount ?? payload.fare ?? payload.required_amount);

  switch (eventType) {
    case 'trip.event.created':
      return audience === 'PASSENGER'
        ? { title: 'Đã nhận yêu cầu đặt xe', message: 'Yêu cầu của bạn đã được ghi nhận, hệ thống đang tìm tài xế gần nhất.' }
        : null;
    case 'trip.event.driver_matched':
      return audience === 'PASSENGER'
        ? { title: 'Đã tìm thấy tài xế', message: 'Tài xế đã được giữ chỗ cho chuyến đi của bạn.' }
        : { title: 'Bạn có cuốc xe mới', message: 'Một chuyến xe vừa được ghép cho bạn. Hãy mở ứng dụng để nhận cuốc.' };
    case 'trip.event.matching_failed':
      return audience === 'PASSENGER'
        ? { title: 'Không tìm thấy tài xế', message: 'Hiện chưa có tài xế phù hợp. Chuyến đi đã được huỷ an toàn.' }
        : null;
    case 'payment.event.hold_requested':
      return audience === 'PASSENGER'
        ? { title: 'Đang tạm giữ cước', message: 'Hệ thống đang tạm giữ tiền cước cho chuyến đi của bạn.' }
        : null;
    case 'payment.event.hold_success':
      return audience === 'PASSENGER'
        ? {
            title: 'Đã tạm giữ cước',
            message: Number.isFinite(amount) && amount > 0
              ? `Đã tạm giữ ${amount.toLocaleString('vi-VN')} đ cho chuyến đi.`
              : 'Đã tạm giữ tiền cước cho chuyến đi.',
          }
        : null;
    case 'payment.event.hold_failed':
      return audience === 'PASSENGER'
        ? {
            title: 'Thanh toán không thành công',
            message: `Không đủ số dư để tạm giữ cước (${safeText(payload.reason, 'INSUFFICIENT_FUNDS')}). Chuyến đi sẽ được huỷ và bù trừ.`,
          }
        : null;
    case 'payment.event.refund_requested':
      return audience === 'PASSENGER'
        ? { title: 'Đã hoàn tiền tạm giữ', message: 'Khoản tiền tạm giữ cho chuyến đi đã được hoàn lại ví.' }
        : null;
    case 'trip.event.release_driver':
      return audience === 'DRIVER'
        ? { title: 'Đã giải phóng chuyến xe', message: 'Bạn đã sẵn sàng nhận chuyến mới.' }
        : null;
    case 'trip.event.completed':
      return audience === 'PASSENGER'
        ? { title: 'Chuyến đi hoàn tất', message: 'Cảm ơn bạn đã sử dụng dịch vụ. Tiền cước đã được thanh toán.' }
        : { title: 'Chuyến đi hoàn tất', message: 'Chuyến đi đã kết thúc, bạn đã được trả về trạng thái sẵn sàng.' };
    default:
      return null;
  }
}

function audiencesFor(eventType, payload) {
  switch (eventType) {
    case 'trip.event.created':
    case 'trip.event.matching_failed':
    case 'payment.event.hold_requested':
    case 'payment.event.hold_success':
    case 'payment.event.hold_failed':
    case 'payment.event.refund_requested':
      return [{ audience: 'PASSENGER', userId: payload.passenger_id || payload.user_id || null }];
    case 'trip.event.driver_matched':
      return [
        { audience: 'PASSENGER', userId: payload.passenger_id || null },
        { audience: 'DRIVER', userId: payload.driver_user_id || payload.driver_id || null },
      ];
    case 'trip.event.release_driver':
      return [{ audience: 'DRIVER', userId: payload.driver_user_id || payload.driver_id || null }];
    case 'trip.event.completed':
      return [
        { audience: 'PASSENGER', userId: payload.passenger_id || null },
        { audience: 'DRIVER', userId: payload.driver_user_id || payload.driver_id || null },
      ];
    default:
      return [];
  }
}

class NotificationStore {
  constructor(options = {}) {
    this.maxNotifications = options.maxNotifications || MAX_NOTIFICATIONS;
    this.maxProcessed = options.maxProcessed || 10000;
    this.processed = new Set();
    this.processedOrder = [];
    this.notifications = [];
  }

  isDuplicate(eventId) {
    return this.processed.has(eventId);
  }

  /**
   * Xử lý một envelope RabbitMQ. Trả về danh sách thông báo vừa tạo.
   * Ném lỗi nếu envelope hỏng để Broker đẩy vào retry/DLQ.
   */
  handleEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('Invalid notification envelope');
    }
    const { event_id, event_type, payload, correlation_id } = envelope;
    if (typeof event_id !== 'string' || event_id.length === 0) {
      throw new Error('Notification envelope missing event_id');
    }
    if (typeof event_type !== 'string' || event_type.length === 0) {
      throw new Error('Notification envelope missing event_type');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Notification envelope missing payload object');
    }

    if (this.processed.has(event_id)) {
      return { duplicate: true, notifications: [] };
    }
    this.processed.add(event_id);
    this.processedOrder.push(event_id);
    while (this.processed.size > this.maxProcessed) {
      const oldest = this.processedOrder.shift();
      if (oldest) this.processed.delete(oldest);
    }

    const created = [];
    for (const target of audiencesFor(event_type, payload)) {
      const built = buildMessage(event_type, payload, target.audience);
      if (!built) continue;

      const notification = {
        id: crypto.randomUUID(),
        event_id,
        event_type,
        correlation_id: correlation_id || null,
        audience: target.audience,
        user_id: target.userId,
        trip_id: payload.trip_id || null,
        title: built.title,
        message: built.message,
        created_at: new Date().toISOString(),
      };
      created.push(notification);
      this.notifications.unshift(notification);
    }

    while (this.notifications.length > this.maxNotifications) {
      this.notifications.pop();
    }

    return { duplicate: false, notifications: created };
  }

  list(limit = 100, userId = null) {
    const size = Math.max(1, Math.min(Number(limit) || 100, this.maxNotifications));
    const source = userId
      ? this.notifications.filter((item) => item.user_id === userId)
      : this.notifications;
    return source.slice(0, size);
  }

  listForUser(userId, limit = 100) {
    return this.list(limit, userId);
  }
}

module.exports = {
  NotificationStore,
  buildMessage,
  audiencesFor,
};
