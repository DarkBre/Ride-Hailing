'use strict';

const crypto = require('node:crypto');

/**
 * Trạng thái của một Saga Instance:
 * - STARTED: Khởi tạo khi tạo chuyến đi
 * - MATCHED: Đã ghép tài xế, chuyển sang giữ tiền
 * - HOLDING_PAYMENT: Đang gửi lệnh tạm giữ tiền ví
 * - CONFIRMED: Tạm giữ tiền thành công, chuyến đi xác nhận
 * - COMPENSATING: Đang thực hiện chuỗi bù trừ (Huỷ chuyến + Giải phóng tài xế)
 * - COMPENSATED: Hoàn tất toàn bộ bù trừ
 * - FAILED: Thất bại không thể tiếp tục (ví dụ không tìm thấy tài xế)
 */
const SAGA_STATUS = {
  STARTED: 'STARTED',
  MATCHED: 'MATCHED',
  HOLDING_PAYMENT: 'HOLDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
  FAILED: 'FAILED',
};

class SagaCoordinator {
  constructor(db, outboxManager) {
    this.db = db;
    this.outbox = outboxManager;
  }

  /**
   * Khởi tạo một phiên Saga mới khi cuốc xe vừa được tạo
   */
  startSaga({ tripId, passengerId, correlationId, fare, pickup, dropoff }) {
    const sagaId = crypto.randomUUID();
    const now = new Date().toISOString();
    const payload = JSON.stringify({
      tripId,
      passengerId,
      fare,
      pickup,
      dropoff,
    });

    this.db.run(
      `INSERT INTO saga_instances (saga_id, trip_id, current_step, status, correlation_id, payload, created_at, updated_at)
       VALUES (?, ?, 'MATCHING', ?, ?, ?, ?, ?);`,
      sagaId,
      tripId,
      SAGA_STATUS.STARTED,
      correlationId,
      payload,
      now,
      now
    );

    // Ghi nhận sự kiện trip.event.created vào Transactional Outbox
    this.outbox.insertEvent({
      aggregateType: 'TRIP',
      aggregateId: tripId,
      eventType: 'trip.event.created',
      payload: {
        trip_id: tripId,
        passenger_id: passengerId,
        pickup_latitude: pickup.latitude || pickup.lat,
        pickup_longitude: pickup.longitude || pickup.lon || pickup.lng,
        estimated_fare: fare,
      },
      correlationId,
    });

    return { sagaId, status: SAGA_STATUS.STARTED };
  }

  /**
   * Kiểm tra xem sự kiện đã từng được xử lý chưa (Idempotency)
   */
  isEventProcessed(eventId) {
    if (!eventId) return false;
    const row = this.db.get('SELECT event_id FROM processed_events WHERE event_id = ?;', eventId);
    return !!row;
  }

  /**
   * Đánh dấu sự kiện đã xử lý thành công (Phải chạy bên trong transaction DB để bảo đảm nguyên tử)
   */
  markEventProcessed(eventId, eventType) {
    if (!eventId) {
      throw new Error('eventId bắt buộc phải tồn tại khi ghi nhận processed_events');
    }
    this.db.run(
      'INSERT INTO processed_events (event_id, event_type, processed_at) VALUES (?, ?, ?);',
      eventId,
      eventType,
      new Date().toISOString()
    );
  }

  /**
   * Xử lý sự kiện: trip.event.driver_matched
   * Matching Service đã lock tài xế thành công -> Trip chuyển sang DRIVER_ASSIGNED và yêu cầu giữ tiền
   */
  handleDriverMatched({ eventId, tripId, driverId, fare, correlationId }) {
    return this.db.tx(() => {
      if (this.isEventProcessed(eventId)) {
        return { duplicate: true, action: 'IGNORED' };
      }

      const saga = this.db.get('SELECT * FROM saga_instances WHERE trip_id = ?;', tripId);
      if (!saga) {
        throw new Error(`Không tìm thấy Saga cho chuyến đi ${tripId}`);
      }

      const trip = this.db.get('SELECT * FROM trips WHERE id = ?;', tripId);
      if (!trip) {
        throw new Error(`Không tìm thấy chuyến đi ${tripId}`);
      }

      const now = new Date().toISOString();

      // 1. Nếu chuyến đi đã bị huỷ trước đó (khách huỷ / timeout / payment failed), phát lệnh giải phóng tài xế ngay lập tức
      if (trip.status === 'CANCELLED' || [SAGA_STATUS.COMPENSATING, SAGA_STATUS.COMPENSATED, SAGA_STATUS.FAILED].includes(saga.status)) {
        if (driverId) {
          this.outbox.insertEvent({
            aggregateType: 'TRIP',
            aggregateId: tripId,
            eventType: 'trip.event.release_driver',
            payload: {
              trip_id: tripId,
              driver_id: driverId,
              reason: 'TRIP_ALREADY_CANCELLED_OR_FAILED',
            },
            correlationId: correlationId || saga.correlation_id,
          });
        }
        this.db.run(
          `UPDATE saga_instances 
           SET status = ?, current_step = 'COMPENSATION_RELEASE_DRIVER', updated_at = ? 
           WHERE trip_id = ?;`,
          SAGA_STATUS.COMPENSATED,
          now,
          tripId
        );
        this.markEventProcessed(eventId, 'trip.event.driver_matched');
        return { action: 'STALE_EVENT_DRIVER_RELEASED', tripId };
      }

      // 2. Nếu chuyến đã có tài xế hoặc đã sang bước sau, không ghi đè; giải phóng tài xế dư thừa nếu khác người
      if (!['REQUESTED', 'MATCHING'].includes(trip.status)) {
        if (driverId && driverId !== trip.driver_id) {
          this.outbox.insertEvent({
            aggregateType: 'TRIP',
            aggregateId: tripId,
            eventType: 'trip.event.release_driver',
            payload: {
              trip_id: tripId,
              driver_id: driverId,
              reason: 'TRIP_ALREADY_DRIVER_ASSIGNED',
            },
            correlationId: correlationId || saga.correlation_id,
          });
        }
        this.markEventProcessed(eventId, 'trip.event.driver_matched');
        return { action: 'STALE_EVENT_DUPLICATE_MATCH_RELEASED', tripId };
      }

      // 3. Luồng chuẩn: Cập nhật chuyến đi -> DRIVER_ASSIGNED, Saga -> HOLDING_PAYMENT, Outbox -> payment.event.hold_requested
      this.db.run(
        `UPDATE trips 
         SET driver_id = ?, status = 'DRIVER_ASSIGNED', updated_at = ? 
         WHERE id = ?;`,
        driverId,
        now,
        tripId
      );

      this.db.run(
        `UPDATE saga_instances 
         SET status = ?, current_step = 'PAYMENT_HOLD', updated_at = ? 
         WHERE trip_id = ?;`,
        SAGA_STATUS.HOLDING_PAYMENT,
        now,
        tripId
      );

      this.outbox.insertEvent({
        aggregateType: 'TRIP',
        aggregateId: tripId,
        eventType: 'payment.event.hold_requested',
        payload: {
          trip_id: tripId,
          passenger_id: trip.passenger_id,
          driver_id: driverId,
          amount: fare || trip.fare,
        },
        correlationId: correlationId || saga.correlation_id,
      });

      this.markEventProcessed(eventId, 'trip.event.driver_matched');

      return { action: 'ADVANCED_TO_HOLDING_PAYMENT', tripId, driverId };
    });
  }

  /**
   * Xử lý sự kiện: payment.event.hold_success
   * Tạm giữ tiền thành công -> Chuyến đi chuyển sang CONFIRMED (Happy path)
   */
  handlePaymentHoldSuccess({ eventId, tripId, correlationId }) {
    return this.db.tx(() => {
      if (this.isEventProcessed(eventId)) {
        return { duplicate: true, action: 'IGNORED' };
      }

      const saga = this.db.get('SELECT * FROM saga_instances WHERE trip_id = ?;', tripId);
      if (!saga) {
        throw new Error(`Không tìm thấy Saga cho chuyến đi ${tripId}`);
      }

      const trip = this.db.get('SELECT * FROM trips WHERE id = ?;', tripId);
      if (!trip) {
        throw new Error(`Không tìm thấy chuyến đi ${tripId}`);
      }

      const now = new Date().toISOString();

      // 1. Race condition khi payment.event.hold_success đến sau khi chuyến đã bị huỷ:
      // Bắt buộc kích hoạt bù trừ giải phóng số tiền đã bị giữ, không được chỉ bỏ qua
      if (trip.status === 'CANCELLED' || [SAGA_STATUS.COMPENSATING, SAGA_STATUS.COMPENSATED, SAGA_STATUS.FAILED].includes(saga.status)) {
        const compensationEvent = this.outbox.insertEvent({
          aggregateType: 'TRIP',
          aggregateId: tripId,
          eventType: 'payment.event.refund_requested',
          payload: {
            trip_id: tripId,
            passenger_id: trip.passenger_id,
            amount: trip.fare,
            reason: 'TRIP_CANCELLED_COMPENSATION_RELEASE_HOLD',
          },
          correlationId: correlationId || saga.correlation_id,
        });

        this.db.run(
          `UPDATE saga_instances 
           SET status = ?, current_step = 'COMPENSATION_RELEASE_PAYMENT', updated_at = ? 
           WHERE trip_id = ?;`,
          SAGA_STATUS.COMPENSATED,
          now,
          tripId
        );

        this.markEventProcessed(eventId, 'payment.event.hold_success');

        return {
          action: 'STALE_EVENT_COMPENSATED_PAYMENT_RELEASED',
          tripId,
          refundEventId: compensationEvent ? compensationEvent.eventId : null,
        };
      }

      // 2. Nếu chuyến đã sang CONFIRMED hoặc bước tiến trình cao hơn (ACCEPTED/IN_PROGRESS/COMPLETED), không ghi đè lùi trạng thái
      if (['CONFIRMED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(trip.status)) {
        this.markEventProcessed(eventId, 'payment.event.hold_success');
        return { action: 'STALE_EVENT_ALREADY_CONFIRMED_OR_BEYOND', tripId };
      }

      // 3. Luồng chuẩn: Cập nhật Trip -> CONFIRMED & Saga -> CONFIRMED
      this.db.run(
        `UPDATE trips 
         SET status = 'CONFIRMED', updated_at = ? 
         WHERE id = ?;`,
        now,
        tripId
      );

      this.db.run(
        `UPDATE saga_instances 
         SET status = ?, current_step = 'CONFIRMED', updated_at = ? 
         WHERE trip_id = ?;`,
        SAGA_STATUS.CONFIRMED,
        now,
        tripId
      );

      this.markEventProcessed(eventId, 'payment.event.hold_success');

      return { action: 'CONFIRMED', tripId };
    });
  }

  /**
   * Xử lý sự kiện: payment.event.hold_failed
   * KÍCH HOẠT SAGA BÙ TRỪ (COMPENSATING ACTION):
   * 1. Huỷ cuốc xe: CANCELLED (Payment Failed)
   * 2. Phát lệnh bù trừ: trip.event.release_driver để giải phóng tài xế về AVAILABLE
   */
  handlePaymentHoldFailed({ eventId, tripId, driverId, reason, correlationId }) {
    return this.db.tx(() => {
      if (this.isEventProcessed(eventId)) {
        return { duplicate: true, action: 'IGNORED' };
      }

      const saga = this.db.get('SELECT * FROM saga_instances WHERE trip_id = ?;', tripId);
      if (!saga) {
        throw new Error(`Không tìm thấy Saga cho chuyến đi ${tripId}`);
      }

      const trip = this.db.get('SELECT id, driver_id, status FROM trips WHERE id = ?;', tripId);
      if (!trip) {
        throw new Error(`Không tìm thấy chuyến đi ${tripId}`);
      }

      // Chống chạy bù trừ hai lần hoặc huỷ nhầm chuyến đã vận hành/hoàn tất
      if (trip.status === 'CANCELLED' || saga.status === SAGA_STATUS.COMPENSATED) {
        this.markEventProcessed(eventId, 'payment.event.hold_failed');
        return { action: 'ALREADY_COMPENSATED', tripId };
      }

      if (['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(trip.status)) {
        this.markEventProcessed(eventId, 'payment.event.hold_failed');
        return { action: 'STALE_EVENT_IGNORED_ACTIVE_OR_COMPLETED_TRIP', tripId };
      }

      const assignedDriverId = driverId || trip.driver_id || null;
      const now = new Date().toISOString();
      const corrId = correlationId || saga.correlation_id;

      this.db.run(
        `UPDATE trips 
         SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ? 
         WHERE id = ?;`,
        `PAYMENT_HOLD_FAILED: ${reason || 'Không đủ số dư'}`,
        now,
        tripId
      );

      this.db.run(
        `UPDATE saga_instances 
         SET status = ?, current_step = 'COMPENSATION_RELEASE_DRIVER', error_reason = ?, updated_at = ? 
         WHERE trip_id = ?;`,
        SAGA_STATUS.COMPENSATED,
        reason || 'Payment failed',
        now,
        tripId
      );

      if (assignedDriverId) {
        this.outbox.insertEvent({
          aggregateType: 'TRIP',
          aggregateId: tripId,
          eventType: 'trip.event.release_driver',
          payload: {
            trip_id: tripId,
            driver_id: assignedDriverId,
            reason: 'SAGA_COMPENSATION_PAYMENT_FAILED',
          },
          correlationId: corrId,
        });
      }

      this.markEventProcessed(eventId, 'payment.event.hold_failed');

      return {
        action: 'COMPENSATED',
        tripId,
        releasedDriverId: assignedDriverId,
        reason,
      };
    });
  }

  /**
   * Xử lý sự kiện: trip.event.matching_failed (Không tìm thấy tài xế)
   */
  handleMatchingFailed({ eventId, tripId, reason, correlationId }) {
    return this.db.tx(() => {
      if (this.isEventProcessed(eventId)) {
        return { duplicate: true, action: 'IGNORED' };
      }

      const saga = this.db.get('SELECT * FROM saga_instances WHERE trip_id = ?;', tripId);
      if (!saga) {
        throw new Error(`Không tìm thấy Saga cho chuyến đi ${tripId}`);
      }

      const trip = this.db.get('SELECT id, status FROM trips WHERE id = ?;', tripId);
      if (!trip) {
        throw new Error(`Không tìm thấy chuyến đi ${tripId}`);
      }

      // Chặn stale matching_failed nếu chuyến đã ghép xe hoặc đã kết thúc/huỷ
      if (!['REQUESTED', 'MATCHING'].includes(trip.status)) {
        this.markEventProcessed(eventId, 'trip.event.matching_failed');
        return { action: 'STALE_MATCHING_FAILED_IGNORED', tripId };
      }

      const now = new Date().toISOString();

      this.db.run(
        `UPDATE trips 
         SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ? 
         WHERE id = ?;`,
        `NO_DRIVER_AVAILABLE: ${reason || 'Khu vực không có tài xế rảnh'}`,
        now,
        tripId
      );

      this.db.run(
        `UPDATE saga_instances 
         SET status = ?, current_step = 'FAILED', error_reason = ?, updated_at = ? 
         WHERE trip_id = ?;`,
        SAGA_STATUS.FAILED,
        reason || 'No driver available',
        now,
        tripId
      );

      this.markEventProcessed(eventId, 'trip.event.matching_failed');

      return { action: 'MATCHING_FAILED_TRIP_CANCELLED', tripId };
    });
  }

  /**
   * Lấy trạng thái hiện tại của một Saga
   */
  getSagaStatus(tripId) {
    return this.db.get('SELECT * FROM saga_instances WHERE trip_id = ?;', tripId);
  }
}

module.exports = {
  SagaCoordinator,
  SAGA_STATUS,
};
