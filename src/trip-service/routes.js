'use strict';

const crypto = require('node:crypto');
const { PricingEngine } = require('./pricing-engine');
const { extractCaller } = require('./auth');
const config = require('./config');

function createRoutes(db, sagaCoordinator, outboxManager) {
  const pricingEngine = new PricingEngine();

  return [
    // 1. Health check
    {
      method: 'GET',
      path: '/health',
      handler: async () => ({
        status: 'healthy',
        service: 'trip-service',
        timestamp: new Date().toISOString(),
      }),
    },

    // 2. Tạo cuốc xe mới (POST /trips và /api/v1/trips)
    ...['/trips', '/api/v1/trips'].map((path) => ({
      method: 'POST',
      path,
      status: 201,
      handler: async ({ body, headers, correlationId }) => {
        const {
          pickup_latitude,
          pickup_longitude,
          pickup_address,
          dropoff_latitude,
          dropoff_longitude,
          dropoff_address,
          passenger_id,
        } = body || {};

        // 2.1. Xác thực & Phân quyền chủ sở hữu (ST-01, Section 6.1)
        const caller = extractCaller(headers);
        if (caller && caller.isInvalidToken) {
          const err = new Error('Token xác thực không hợp lệ hoặc đã hết hạn');
          err.status = 401;
          err.code = 'UNAUTHORIZED';
          throw err;
        }

        if (caller && !caller.isInternal) {
          if (caller.role !== 'PASSENGER') {
            const err = new Error('Chỉ hành khách (PASSENGER) mới có quyền tạo cuốc xe');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
        }

        // Không tin passenger_id tuỳ ý từ body nếu có token xác thực
        const effectivePassengerId = caller && !caller.isInternal
          ? caller.userId
          : (passenger_id || `passenger_${crypto.randomBytes(4).toString('hex')}`);

        // 2.2. Validate input data (ST-02, Section 8.1)
        const pLat = Number(pickup_latitude);
        const pLon = Number(pickup_longitude);
        const dLat = Number(dropoff_latitude);
        const dLon = Number(dropoff_longitude);

        if (
          isNaN(pLat) || isNaN(pLon) || isNaN(dLat) || isNaN(dLon) ||
          pLat < -90 || pLat > 90 || dLat < -90 || dLat > 90 ||
          pLon < -180 || pLon > 180 || dLon < -180 || dLon > 180
        ) {
          const err = new Error('Toạ độ GPS không hợp lệ (Latitude [-90, 90], Longitude [-180, 180])');
          err.status = 400;
          err.code = 'INVALID_COORDINATES';
          throw err;
        }

        if (pLat === dLat && pLon === dLon) {
          const err = new Error('Điểm đón và điểm đến không được trùng nhau');
          err.status = 400;
          err.code = 'ZERO_DISTANCE';
          throw err;
        }

        if (!pickup_address || typeof pickup_address !== 'string' || pickup_address.trim().length === 0) {
          const err = new Error('Địa chỉ điểm đón không được để trống');
          err.status = 400;
          err.code = 'INVALID_PICKUP_ADDRESS';
          throw err;
        }

        if (!dropoff_address || typeof dropoff_address !== 'string' || dropoff_address.trim().length === 0) {
          const err = new Error('Địa chỉ điểm đến không được để trống');
          err.status = 400;
          err.code = 'INVALID_DROPOFF_ADDRESS';
          throw err;
        }

        // 2.3. Kiểm tra Idempotency Key kèm so sánh Payload Hash (Section 6.3)
        const currentPayloadHash = crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              pLat,
              pLon,
              dLat,
              dLon,
              pickup: pickup_address.trim(),
              dropoff: dropoff_address.trim(),
            })
          )
          .digest('hex');

        const idempotencyKey = headers['idempotency-key'] || null;
        if (idempotencyKey) {
          const existing = db.get('SELECT * FROM trips WHERE idempotency_key = ?;', idempotencyKey);
          if (existing) {
            // Cùng key nhưng payload khác nhau -> Trả về 409 Conflict
            if (existing.idempotency_payload_hash && existing.idempotency_payload_hash !== currentPayloadHash) {
              const err = new Error('Idempotency-Key đã được sử dụng cho một yêu cầu đặt xe khác');
              err.status = 409;
              err.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
              throw err;
            }

            return {
              id: existing.id,
              status: existing.status,
              estimated_fare: existing.fare,
              distance_km: existing.distance_km,
              surge_multiplier: existing.surge_multiplier,
              duplicate: true,
            };
          }
        }

        // 2.4. Tính toán giá cước động (Dynamic Pricing Engine - Mục 4.4 ARCHITECTURE.md)
        // Thống kê số lượng chuyến PENDING/MATCHING trong 5 phút vừa qua làm chỉ số Demand thực tế
        const demandRow = db.get(
          `SELECT COUNT(*) as count FROM trips 
           WHERE status IN ('REQUESTED', 'MATCHING') 
           AND created_at >= datetime('now', '-5 minutes');`
        );
        const demand = demandRow ? demandRow.count : 0;
        const supply = 3; // Mặc định vùng hoạt động nếu Driver Service chưa kết nối trực tiếp

        const fareResult = pricingEngine.calculateFare({
          pickup: { lat: pLat, lon: pLon },
          dropoff: { lat: dLat, lon: dLon },
          demand,
          supply,
        });

        // 2.5. Lưu dữ liệu cuốc xe nguyên tử và kích hoạt Saga (Transactional Outbox)
        const tripId = crypto.randomUUID();
        const now = new Date().toISOString();

        db.tx(() => {
          db.run(
            `INSERT INTO trips (
              id, passenger_id, pickup_latitude, pickup_longitude, pickup_address,
              dropoff_latitude, dropoff_longitude, dropoff_address, distance_km,
              fare, surge_multiplier, status, idempotency_key, idempotency_payload_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?);`,
            tripId,
            effectivePassengerId,
            pLat,
            pLon,
            pickup_address.trim(),
            dLat,
            dLon,
            dropoff_address.trim(),
            fareResult.distance_km,
            fareResult.estimated_fare,
            fareResult.surge_multiplier,
            idempotencyKey,
            currentPayloadHash,
            now,
            now
          );

          // Khởi động Saga Coordinator & ghi Outbox trip.event.created
          sagaCoordinator.startSaga({
            tripId,
            passengerId: effectivePassengerId,
            correlationId,
            fare: fareResult.estimated_fare,
            pickup: { lat: pLat, lon: pLon },
            dropoff: { lat: dLat, lon: dLon },
          });
        });

        return {
          id: tripId,
          status: 'REQUESTED',
          estimated_fare: fareResult.estimated_fare,
          distance_km: fareResult.distance_km,
          surge_multiplier: fareResult.surge_multiplier,
        };
      },
    })),

    // 3. Lấy thông tin chuyến đi (/trips/:id và /api/v1/trips/:id)
    ...['/trips/:id', '/api/v1/trips/:id'].map((path) => ({
      method: 'GET',
      path,
      status: 200,
      handler: async ({ params, headers }) => {
        const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!trip) {
          const err = new Error(`Không tìm thấy cuốc xe với ID: ${params.id}`);
          err.status = 404;
          err.code = 'TRIP_NOT_FOUND';
          throw err;
        }

        // Kiểm tra quyền truy cập (ST-01)
        const caller = extractCaller(headers);
        if (caller && caller.isInvalidToken) {
          const err = new Error('Token xác thực không hợp lệ');
          err.status = 401;
          err.code = 'UNAUTHORIZED';
          throw err;
        }
        if (caller && !caller.isInternal) {
          if (caller.role === 'PASSENGER' && caller.userId !== trip.passenger_id) {
            const err = new Error('Bạn không có quyền xem thông tin chuyến xe của người khác');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
          if (caller.role === 'DRIVER' && trip.driver_id && caller.userId !== trip.driver_id) {
            const err = new Error('Bạn không có quyền xem chuyến xe không được gán cho bạn');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
        }

        const saga = sagaCoordinator.getSagaStatus(params.id);

        return {
          ...trip,
          saga: saga ? { status: saga.status, current_step: saga.current_step } : null,
        };
      },
    })),

    // 4. Tài xế nhận cuốc xe (POST /trips/:id/accept)
    ...['/trips/:id/accept', '/api/v1/trips/:id/accept'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, headers }) => {
        const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!trip) {
          const err = new Error(`Không tìm thấy cuốc xe với ID: ${params.id}`);
          err.status = 404;
          err.code = 'TRIP_NOT_FOUND';
          throw err;
        }

        const caller = extractCaller(headers);
        if (caller && caller.isInvalidToken) {
          const err = new Error('Token xác thực không hợp lệ');
          err.status = 401;
          err.code = 'UNAUTHORIZED';
          throw err;
        }
        if (caller && !caller.isInternal) {
          if (caller.role === 'PASSENGER') {
            const err = new Error('Hành khách không thể nhận cuốc xe');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
          if (caller.role === 'DRIVER' && trip.driver_id && caller.userId !== trip.driver_id) {
            const err = new Error('Bạn không phải tài xế được gán cho cuốc xe này');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
        }

        if (!['DRIVER_ASSIGNED', 'CONFIRMED'].includes(trip.status)) {
          const err = new Error(`Không thể nhận chuyến ở trạng thái hiện tại: ${trip.status}`);
          err.status = 400;
          err.code = 'INVALID_STATE_TRANSITION';
          throw err;
        }

        const now = new Date().toISOString();
        db.run("UPDATE trips SET status = 'ACCEPTED', updated_at = ? WHERE id = ?;", now, params.id);

        return { id: params.id, status: 'ACCEPTED' };
      },
    })),

    // 5. Bắt đầu chuyến đi (POST /trips/:id/start)
    ...['/trips/:id/start', '/api/v1/trips/:id/start'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, headers }) => {
        const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!trip) {
          const err = new Error(`Không tìm thấy cuốc xe với ID: ${params.id}`);
          err.status = 404;
          err.code = 'TRIP_NOT_FOUND';
          throw err;
        }

        const caller = extractCaller(headers);
        if (caller && !caller.isInternal && caller.role === 'DRIVER' && trip.driver_id && caller.userId !== trip.driver_id) {
          const err = new Error('Chỉ tài xế được gán mới có quyền bắt đầu chuyến xe');
          err.status = 403;
          err.code = 'FORBIDDEN';
          throw err;
        }

        if (trip.status !== 'ACCEPTED') {
          const err = new Error(`Chỉ có thể bắt đầu khi chuyến đã ACCEPTED (Hiện tại: ${trip.status})`);
          err.status = 400;
          err.code = 'INVALID_STATE_TRANSITION';
          throw err;
        }

        const now = new Date().toISOString();
        db.run("UPDATE trips SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?;", now, params.id);

        return { id: params.id, status: 'IN_PROGRESS' };
      },
    })),

    // 6. Hoàn tất chuyến đi (POST /trips/:id/complete)
    ...['/trips/:id/complete', '/api/v1/trips/:id/complete'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, headers, correlationId }) => {
        const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!trip) {
          const err = new Error(`Không tìm thấy cuốc xe với ID: ${params.id}`);
          err.status = 404;
          err.code = 'TRIP_NOT_FOUND';
          throw err;
        }

        const caller = extractCaller(headers);
        if (caller && !caller.isInternal) {
          if (caller.role === 'PASSENGER') {
            const err = new Error('Hành khách không thể hoàn tất cuốc xe');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
          if (caller.role === 'DRIVER' && trip.driver_id && caller.userId !== trip.driver_id) {
            const err = new Error('Chỉ tài xế được gán mới có quyền hoàn tất chuyến xe');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
        }

        if (!['IN_PROGRESS', 'ACCEPTED'].includes(trip.status)) {
          const err = new Error(`Không thể hoàn tất chuyến ở trạng thái: ${trip.status}`);
          err.status = 400;
          err.code = 'INVALID_STATE_TRANSITION';
          throw err;
        }

        const now = new Date().toISOString();
        db.tx(() => {
          db.run("UPDATE trips SET status = 'COMPLETED', updated_at = ? WHERE id = ?;", now, params.id);

          // Bắn sự kiện trip.event.completed để Payment Service trừ tiền thật
          outboxManager.insertEvent({
            aggregateType: 'TRIP',
            aggregateId: params.id,
            eventType: 'trip.event.completed',
            payload: {
              trip_id: params.id,
              driver_id: trip.driver_id,
              passenger_id: trip.passenger_id,
              fare: trip.fare,
            },
            correlationId,
          });
        });

        return { id: params.id, status: 'COMPLETED' };
      },
    })),

    // 7. Huỷ chuyến đi (POST /trips/:id/cancel)
    ...['/trips/:id/cancel', '/api/v1/trips/:id/cancel'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, body, headers, correlationId }) => {
        const { reason } = body || {};
        const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!trip) {
          const err = new Error(`Không tìm thấy cuốc xe với ID: ${params.id}`);
          err.status = 404;
          err.code = 'TRIP_NOT_FOUND';
          throw err;
        }

        const caller = extractCaller(headers);
        if (caller && !caller.isInternal) {
          if (caller.role === 'PASSENGER' && caller.userId !== trip.passenger_id) {
            const err = new Error('Bạn không thể huỷ chuyến xe của người khác');
            err.status = 403;
            err.code = 'FORBIDDEN';
            throw err;
          }
        }

        if (['COMPLETED', 'CANCELLED'].includes(trip.status)) {
          const err = new Error(`Không thể huỷ chuyến xe đã kết thúc hoặc đã huỷ (Trạng thái: ${trip.status})`);
          err.status = 400;
          err.code = 'CANNOT_CANCEL';
          throw err;
        }

        const now = new Date().toISOString();
        db.tx(() => {
          db.run(
            "UPDATE trips SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ? WHERE id = ?;",
            reason || 'Hành khách huỷ chuyến',
            now,
            params.id
          );

          // Nếu đã gán tài xế, phát lệnh bù trừ giải phóng tài xế
          if (trip.driver_id) {
            outboxManager.insertEvent({
              aggregateType: 'TRIP',
              aggregateId: params.id,
              eventType: 'trip.event.release_driver',
              payload: {
                trip_id: params.id,
                driver_id: trip.driver_id,
                reason: reason || 'PASSENGER_CANCELLED',
              },
              correlationId,
            });
          }

          // Nếu chuyến đi đã được CONFIRMED trở đi (tiền đã bị tạm giữ), phát lệnh bù trừ giải phóng tiền
          if (['CONFIRMED', 'ACCEPTED', 'IN_PROGRESS'].includes(trip.status)) {
            outboxManager.insertEvent({
              aggregateType: 'TRIP',
              aggregateId: params.id,
              eventType: 'payment.event.refund_requested',
              payload: {
                trip_id: params.id,
                passenger_id: trip.passenger_id,
                amount: trip.fare,
                reason: reason || 'PASSENGER_CANCELLED',
              },
              correlationId,
            });
          }
        });

        return { id: params.id, status: 'CANCELLED', reason: reason || 'Hành khách huỷ chuyến' };
      },
    })),

    // 8. Cổng nhận sự kiện bất đồng bộ / Webhook xử lý Saga từ Broker
    // Bảo vệ bằng x-internal-key
    {
      method: 'POST',
      path: '/internal/events',
      status: 200,
      handler: async ({ headers, body }) => {
        const internalKey = headers['x-internal-key'];
        if (!internalKey || internalKey !== config.INTERNAL_KEY) {
          const err = new Error('Yêu cầu x-internal-key hợp lệ để gửi sự kiện nội bộ');
          err.status = 401;
          err.code = 'UNAUTHORIZED_INTERNAL';
          throw err;
        }

        const { event_id, event_type, payload, correlation_id } = body || {};

        if (!event_type || !payload) {
          const err = new Error('Event envelope thiếu event_type hoặc payload');
          err.status = 400;
          err.code = 'INVALID_EVENT';
          throw err;
        }

        let result = null;

        switch (event_type) {
          case 'trip.event.driver_matched':
            result = sagaCoordinator.handleDriverMatched({
              eventId: event_id,
              tripId: payload.trip_id,
              driverId: payload.driver_id,
              fare: payload.estimated_fare,
              correlationId: correlation_id,
            });
            break;

          case 'payment.event.hold_success':
            result = sagaCoordinator.handlePaymentHoldSuccess({
              eventId: event_id,
              tripId: payload.trip_id,
              correlationId: correlation_id,
            });
            break;

          case 'payment.event.hold_failed':
            result = sagaCoordinator.handlePaymentHoldFailed({
              eventId: event_id,
              tripId: payload.trip_id,
              driverId: payload.driver_id,
              reason: payload.reason,
              correlationId: correlation_id,
            });
            break;

          case 'trip.event.matching_failed':
            result = sagaCoordinator.handleMatchingFailed({
              eventId: event_id,
              tripId: payload.trip_id,
              reason: payload.reason,
              correlationId: correlation_id,
            });
            break;

          default:
            result = { action: 'UNKNOWN_EVENT_IGNORED', event_type };
        }

        return result;
      },
    },
  ];
}

module.exports = {
  createRoutes,
};
