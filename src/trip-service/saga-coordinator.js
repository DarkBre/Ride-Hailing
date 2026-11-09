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
        pickup_latitude: pickup.latitude ?? pickup.lat,
        pickup_longitude: pickup.longitude ?? pickup.lon ?? pickup.lng,
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
   * Đánh dấu sự kiện đã xử lý thành công
   */
  markEventProcessed(eventId, eventType) {
    if (!eventId) return;
    this.db.run(
      'INSERT INTO processed_events (event_id, event_type, processed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING;',
      eventId,
      eventType,
      new Date().toISOString()
    );
  }

  /**
   * Xử lý sự kiện: trip.event.driver_matched
   * Matching Service đã lock tài xế thành công -> Trip chuyển sang DRIVER_ASSIGNED và yêu cầu giữ tiền
   */
  handleDriverMatched({ eventId, tripId, driverId, fare, correlationId, reservationId, expiresAt, driverUserId }) {
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

    // Nếu chuyến đi đã bị huỷ trước đó (ví dụ khách huỷ hoặc timeout), phát lệnh giải phóng tài xế ngay lập tức
    if (trip.status === 'CANCELLED' || [SAGA_STATUS.COMPENSATING, SAGA_STATUS.COMPENSATED, SAGA_STATUS.FAILED].includes(saga.status)) {
      this.db.tx(() => {
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
        this.markEventProcessed(eventId, 'trip.event.driver_matched');
      });
      return { action: 'STALE_EVENT_DRIVER_RELEASED', tripId };
    }

    if (!['REQUESTED', 'MATCHING'].includes(trip.status)) {
      this.markEventProcessed(eventId, 'trip.event.driver_matched');
      return { action: 'ALREADY_MATCHED', tripId };
    }
    if (reservationId && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      return this.handleMatchingFailed({ eventId, tripId, reason: 'DRIVER_TIMEOUT' });
    }
    const now = new Date().toISOString();

    this.db.tx(() => {
      // 1. Cập nhật chuyến đi
      this.db.run(
        `UPDATE trips
         SET driver_id = ?, status = 'DRIVER_ASSIGNED', updated_at = ?,
             reservation_id = ?, reservation_expires_at = ?, driver_user_id = ?
         WHERE id = ?;`,
        driverId,
        now,
        reservationId ?? null,
        expiresAt ?? null,
        driverUserId ?? null,
        tripId
      );

      // 2. Cập nhật Saga Instance
      this.db.run(
        `UPDATE saga_instances
         SET status = ?, current_step = 'PAYMENT_HOLD', updated_at = ?
         WHERE trip_id = ?;`,
        SAGA_STATUS.HOLDING_PAYMENT,
        now,
        tripId
      );

      // 3. Ghi Outbox: payment.event.hold_requested
      this.outbox.insertEvent({
        aggregateType: 'TRIP',
        aggregateId: tripId,
        eventType: 'payment.event.hold_requested',
        payload: {
          trip_id: tripId,
          driver_id: driverId,
          passenger_id: trip.passenger_id,
          amount: fare || trip.fare,
        },
        correlationId: correlationId || saga.correlation_id,
      });

      // 4. Đánh dấu đã xử lý event
      this.markEventProcessed(eventId, 'trip.event.driver_matched');
    });

    return { action: 'ADVANCED_TO_HOLDING_PAYMENT', tripId, driverId };
  }

  /**
   * Xử lý sự kiện: payment.event.hold_success
   * Tạm giữ tiền thành công -> Chuyến đi chuyển sang CONFIRMED (Happy path)
   */
  handlePaymentHoldSuccess({ eventId, tripId, correlationId }) {
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

    // Xử lý race condition khi payment.event.hold_success đến sau khi chuyến đã bị huỷ:
    // Tuyệt đối không chỉ bỏ qua mà phải kích hoạt bù trừ giải phóng số tiền đã bị giữ
    if (trip.status === 'CANCELLED' || [SAGA_STATUS.COMPENSATING, SAGA_STATUS.COMPENSATED, SAGA_STATUS.FAILED].includes(saga.status)) {
      const now = new Date().toISOString();
      let compensationEvent = null;

      this.db.tx(() => {
        // 1. Ghi nhận sự kiện bù trừ vào Transactional Outbox để giải phóng khoản hold ở Payment Service
        compensationEvent = this.outbox.insertEvent({
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

        // 2. Cập nhật Saga Instance sang COMPENSATED với bước giải phóng tiền
        this.db.run(
          `UPDATE saga_instances
           SET status = ?, current_step = 'COMPENSATION_RELEASE_PAYMENT', updated_at = ?
           WHERE trip_id = ?;`,
          SAGA_STATUS.COMPENSATED,
          now,
          tripId
        );

        // 3. Đánh dấu event đã xử lý (chống trùng lặp Idempotency)
        this.markEventProcessed(eventId, 'payment.event.hold_success');
      });

      return {
        action: 'STALE_EVENT_COMPENSATED_PAYMENT_RELEASED',
        tripId,
        refundEventId: compensationEvent ? compensationEvent.eventId : null,
      };
    }

    const now = new Date().toISOString();

    this.db.tx(() => {
      this.db.run(
        `UPDATE trips
         SET status = CASE WHEN status = 'DRIVER_ASSIGNED' THEN 'CONFIRMED' ELSE status END, updated_at = ?
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
    });

    return { action: 'CONFIRMED', tripId };
  }

  expireReservations() {
    this.db.tx(() => {
      const now = new Date().toISOString();
      const overdue = this.db.all(`SELECT id, driver_id, reservation_id, passenger_id, fare
        FROM trips WHERE status IN ('DRIVER_ASSIGNED', 'CONFIRMED')
          AND reservation_expires_at <= ? LIMIT 50`, now);
      for (const trip of overdue) {
        const saga = this.getSagaStatus(trip.id);
        this.db.run(`UPDATE trips SET status = 'CANCELLED', cancellation_reason = 'DRIVER_TIMEOUT',
          updated_at = ? WHERE id = ?`, now, trip.id);
        this.db.run(`UPDATE saga_instances SET status = 'COMPENSATED', updated_at = ? WHERE trip_id = ?`, now, trip.id);
        this.outbox.insertEvent({
          aggregateType: 'TRIP', aggregateId: trip.id, eventType: 'trip.event.release_driver',
          payload: { trip_id: trip.id, driver_id: trip.driver_id, reservation_id: trip.reservation_id },
          correlationId: saga?.correlation_id,
        });
        this.outbox.insertEvent({
          aggregateType: 'TRIP', aggregateId: trip.id, eventType: 'payment.event.refund_requested',
          payload: { trip_id: trip.id, passenger_id: trip.passenger_id, amount: trip.fare, reason: 'DRIVER_TIMEOUT' },
          correlationId: saga?.correlation_id,
        });
      }
    });
  }

  /**
   * Xử lý sự kiện: payment.event.hold_failed
   * KÍCH HOẠT SAGA BÙ TRỪ (COMPENSATING ACTION):
   * 1. Huỷ cuốc xe: CANCELLED (Payment Failed)
   * 2. Phát lệnh bù trừ: trip.event.release_driver để giải phóng tài xế về AVAILABLE
   */
  handlePaymentHoldFailed({ eventId, tripId, driverId, reason, correlationId }) {
    if (this.isEventProcessed(eventId)) {
      return { duplicate: true, action: 'IGNORED' };
    }

    const saga = this.db.get('SELECT * FROM saga_instances WHERE trip_id = ?;', tripId);
    if (!saga) {
      throw new Error(`Không tìm thấy Saga cho chuyến đi ${tripId}`);
    }

    // Chống chạy bù trừ hai lần do message retry
    if (saga.status === SAGA_STATUS.COMPENSATED) {
      return { action: 'ALREADY_COMPENSATED' };
    }

    const trip = this.db.get('SELECT status, driver_id, reservation_id FROM trips WHERE id = ?;', tripId);
    if (!trip || !['DRIVER_ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'].includes(trip.status) ||
        saga.status !== SAGA_STATUS.HOLDING_PAYMENT || (driverId && driverId !== trip.driver_id)) {
      this.markEventProcessed(eventId, 'payment.event.hold_failed');
      return { action: 'STALE_PAYMENT_FAILURE_IGNORED', tripId };
    }
    const assignedDriverId = trip.driver_id;
    const now = new Date().toISOString();
    const corrId = correlationId || saga.correlation_id;

    this.db.tx(() => {
      // 1. Huỷ chuyến đi
      this.db.run(
        `UPDATE trips
         SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ?
         WHERE id = ?;`,
        `PAYMENT_HOLD_FAILED: ${reason || 'Không đủ số dư'}`,
        now,
        tripId
      );

      // 2. Chuyển trạng thái Saga sang COMPENSATING rồi COMPENSATED
      this.db.run(
        `UPDATE saga_instances
         SET status = ?, current_step = 'COMPENSATION_RELEASE_DRIVER', error_reason = ?, updated_at = ?
         WHERE trip_id = ?;`,
        SAGA_STATUS.COMPENSATED,
        reason || 'Payment failed',
        now,
        tripId
      );

      // 3. PHÁT LỆNH BÙ TRỪ: trip.event.release_driver
      if (assignedDriverId) {
        this.outbox.insertEvent({
          aggregateType: 'TRIP',
          aggregateId: tripId,
          eventType: 'trip.event.release_driver',
          payload: {
            trip_id: tripId,
            driver_id: assignedDriverId,
            reservation_id: trip.reservation_id || undefined,
            reason: 'SAGA_COMPENSATION_PAYMENT_FAILED',
          },
          correlationId: corrId,
        });
      }

      this.markEventProcessed(eventId, 'payment.event.hold_failed');
    });

    return {
      action: 'COMPENSATED',
      tripId,
      releasedDriverId: assignedDriverId,
      reason,
    };
  }

  /**
   * Xử lý sự kiện: trip.event.matching_failed (Không tìm thấy tài xế)
   */
  handleMatchingFailed({ eventId, tripId, reason, correlationId }) {
    if (this.isEventProcessed(eventId)) {
      return { duplicate: true, action: 'IGNORED' };
    }

    const now = new Date().toISOString();

    this.db.tx(() => {
      const changed = this.db.run(
        `UPDATE trips
         SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ?
         WHERE id = ? AND status IN ('REQUESTED', 'MATCHING');`,
        `NO_DRIVER_AVAILABLE: ${reason || 'Khu vực không có tài xế rảnh'}`,
        now,
        tripId
      );
      if (!changed.changes) {
        this.markEventProcessed(eventId, 'trip.event.matching_failed');
        return;
      }

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
    });

    return { action: 'MATCHING_FAILED_TRIP_CANCELLED', tripId };
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
