'use strict';

const crypto = require('node:crypto');
const { PricingEngine } = require('./pricing-engine');
const { extractCaller, safeCompare } = require('./auth');
const { SAGA_STATUS } = require('./saga-coordinator');
const config = require('./config');
const { createDriverClient } = require('./driver-client');

function createError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Bắt buộc xác thực người gọi (JWT Bearer token hợp lệ hoặc X-Internal-Key nội bộ)
 */
function requireCaller(headers) {
  const caller = extractCaller(headers);
  if (!caller || caller.isInvalidToken || caller.isInvalidInternalKey) {
    throw createError(401, 'UNAUTHORIZED', 'Yêu cầu JWT token hoặc khoá nội bộ hợp lệ');
  }
  return caller;
}

/**
 * Parse toạ độ chặt chẽ, từ chối null, chuỗi rỗng, boolean hoặc ngoài khoảng
 */
function parseCoordinate(value, min, max) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return NaN;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    return NaN;
  }
  return num;
}

/**
 * Xác định caller có phải tài xế được gán cho chuyến (ưu tiên driver_user_id từ Driver Service, fallback driver_id)
 */
function isAssignedDriver(caller, trip) {
  const assignedUserId = trip.driver_user_id || trip.driver_id;
  return Boolean(assignedUserId && caller.userId === assignedUserId);
}

/**
 * Kiểm tra quyền thao tác tài xế được gán (ACCEPT / START / COMPLETE)
 */
function assertDriverOwnership(caller, trip, actionDesc) {
  if (caller.isInternal) return;
  if (caller.role !== 'DRIVER') {
    throw createError(403, 'FORBIDDEN', `Chỉ tài xế (DRIVER) mới có quyền ${actionDesc}`);
  }
  if (!isAssignedDriver(caller, trip)) {
    throw createError(403, 'FORBIDDEN', `Bạn không phải tài xế được gán cho cuốc xe này để ${actionDesc}`);
  }
}

function createRoutes(db, sagaCoordinator, outboxManager, options = {}) {
  const pricingEngine = new PricingEngine();
  const driverClient = options.driverClient || createDriverClient();
  const broker = options.broker || null;

  return [
    // 1. Health / Liveness / Readiness checks
    {
      method: 'GET',
      path: '/health',
      handler: async () => ({
        status: 'healthy',
        service: 'trip-service',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      method: 'GET',
      path: '/live',
      handler: async () => ({
        status: 'alive',
        service: 'trip-service',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      method: 'GET',
      path: '/ready',
      handler: async () => {
        try {
          db.get('SELECT 1 AS ok;');
        } catch (err) {
          throw createError(503, 'DB_NOT_READY', `SQLite chưa sẵn sàng: ${err.message}`);
        }
        if (broker && !broker.isReady()) {
          throw createError(503, 'BROKER_NOT_READY', 'RabbitMQ broker chưa sẵn sàng');
        }
        return {
          status: 'ready',
          service: 'trip-service',
          transport: broker ? 'rabbitmq' : config.EVENT_TRANSPORT,
          timestamp: new Date().toISOString(),
        };
      },
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

        // 2.1. Xác thực & Phân quyền chủ sở hữu (ST-01)
        const caller = requireCaller(headers);
        if (!caller.isInternal && caller.role !== 'PASSENGER') {
          throw createError(403, 'FORBIDDEN', 'Chỉ hành khách (PASSENGER) mới có quyền tạo cuốc xe');
        }

        // Tuyệt đối không tin passenger_id client gửi khi gọi bằng JWT người dùng
        const effectivePassengerId = caller.isInternal
          ? passenger_id
          : caller.userId;

        if (!effectivePassengerId || typeof effectivePassengerId !== 'string') {
          throw createError(400, 'MISSING_PASSENGER_ID', 'Thiếu định danh hành khách');
        }

        // 2.2. Validate input data (ST-02)
        const pLat = parseCoordinate(pickup_latitude, -90, 90);
        const pLon = parseCoordinate(pickup_longitude, -180, 180);
        const dLat = parseCoordinate(dropoff_latitude, -90, 90);
        const dLon = parseCoordinate(dropoff_longitude, -180, 180);

        if (isNaN(pLat) || isNaN(pLon) || isNaN(dLat) || isNaN(dLon)) {
          throw createError(400, 'INVALID_COORDINATES', 'Toạ độ GPS không hợp lệ (Latitude [-90, 90], Longitude [-180, 180])');
        }

        if (pLat === dLat && pLon === dLon) {
          throw createError(400, 'ZERO_DISTANCE', 'Điểm đón và điểm đến không được trùng nhau');
        }

        if (!pickup_address || typeof pickup_address !== 'string' || pickup_address.trim().length === 0) {
          throw createError(400, 'INVALID_PICKUP_ADDRESS', 'Địa chỉ điểm đón không được để trống');
        }

        if (!dropoff_address || typeof dropoff_address !== 'string' || dropoff_address.trim().length === 0) {
          throw createError(400, 'INVALID_DROPOFF_ADDRESS', 'Địa chỉ điểm đến không được để trống');
        }

        // 2.3. Kiểm tra Idempotency Key theo phạm vi từng hành khách (passenger_id + idempotency_key)
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

        const idempotencyKey = headers['idempotency-key'] ? String(headers['idempotency-key']) : null;
        if (idempotencyKey) {
          const existing = db.get(
            'SELECT * FROM trips WHERE passenger_id = ? AND idempotency_key = ?;',
            effectivePassengerId,
            idempotencyKey
          );
          if (existing) {
            if (existing.idempotency_payload_hash && existing.idempotency_payload_hash !== currentPayloadHash) {
              throw createError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency-Key đã được sử dụng cho một yêu cầu đặt xe khác');
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
        // Dùng mốc ISO-8601 UTC chính xác trong 5 phút gần nhất để khớp định dạng cột created_at
        const fiveMinutesAgoIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const demandRow = db.get(
          `SELECT COUNT(*) as count FROM trips 
           WHERE status IN ('REQUESTED', 'MATCHING') 
           AND created_at >= ?;`,
          fiveMinutesAgoIso
        );
        const demand = demandRow ? demandRow.count : 0;
        const liveSupply = await driverClient.fetchAvailableSupply(
          pLat,
          pLon,
          config.MATCHING_RADIUS_KM,
          correlationId
        );
        const supply = Number.isFinite(liveSupply) ? liveSupply : 3; // Fallback khi Driver Service offline

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
              id, passenger_id, driver_id, pickup_latitude, pickup_longitude, pickup_address,
              dropoff_latitude, dropoff_longitude, dropoff_address, distance_km,
              fare, surge_multiplier, status, idempotency_key, idempotency_payload_hash, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?);`,
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
        const caller = requireCaller(headers);

        const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!trip) {
          throw createError(404, 'TRIP_NOT_FOUND', `Không tìm thấy cuốc xe với ID: ${params.id}`);
        }

        if (!caller.isInternal) {
          if (caller.role === 'PASSENGER') {
            if (caller.userId !== trip.passenger_id) {
              throw createError(403, 'FORBIDDEN', 'Bạn không có quyền xem thông tin chuyến xe của người khác');
            }
          } else if (caller.role === 'DRIVER') {
            if (!isAssignedDriver(caller, trip)) {
              throw createError(403, 'FORBIDDEN', 'Bạn không có quyền xem chuyến xe không được gán cho bạn');
            }
          } else {
            throw createError(403, 'FORBIDDEN', 'Vai trò không hợp lệ để truy cập thông tin chuyến xe');
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
      handler: async ({ params, headers, correlationId }) => {
        const caller = requireCaller(headers);

        const initialTrip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
        if (!initialTrip) {
          throw createError(404, 'TRIP_NOT_FOUND', `Không tìm thấy cuốc xe với ID: ${params.id}`);
        }

        assertDriverOwnership(caller, initialTrip, 'nhận cuốc xe');

        if (!['DRIVER_ASSIGNED', 'CONFIRMED'].includes(initialTrip.status)) {
          throw createError(
            400,
            'INVALID_STATE_TRANSITION',
            `Không thể nhận chuyến ở trạng thái hiện tại: ${initialTrip.status}`
          );
        }

        if (initialTrip.reservation_id) {
          await driverClient.confirmReservation({
            tripId: params.id,
            driverId: initialTrip.driver_id,
            reservationId: initialTrip.reservation_id,
            correlationId,
          });
        }

        return db.tx(() => {
          const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
          if (!trip) {
            throw createError(404, 'TRIP_NOT_FOUND', `Không tìm thấy cuốc xe với ID: ${params.id}`);
          }

          assertDriverOwnership(caller, trip, 'nhận cuốc xe');

          if (!['DRIVER_ASSIGNED', 'CONFIRMED'].includes(trip.status)) {
            throw createError(400, 'INVALID_STATE_TRANSITION', `Không thể nhận chuyến ở trạng thái hiện tại: ${trip.status}`);
          }

          const now = new Date().toISOString();
          db.run("UPDATE trips SET status = 'ACCEPTED', updated_at = ? WHERE id = ?;", now, params.id);

          return { id: params.id, status: 'ACCEPTED' };
        });
      },
    })),

    // 5. Bắt đầu chuyến đi (POST /trips/:id/start)
    ...['/trips/:id/start', '/api/v1/trips/:id/start'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, headers }) => {
        const caller = requireCaller(headers);

        return db.tx(() => {
          const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
          if (!trip) {
            throw createError(404, 'TRIP_NOT_FOUND', `Không tìm thấy cuốc xe với ID: ${params.id}`);
          }

          assertDriverOwnership(caller, trip, 'bắt đầu chuyến xe');

          if (trip.status !== 'ACCEPTED') {
            throw createError(400, 'INVALID_STATE_TRANSITION', `Chỉ có thể bắt đầu khi chuyến đã ACCEPTED (Hiện tại: ${trip.status})`);
          }

          const now = new Date().toISOString();
          db.run("UPDATE trips SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?;", now, params.id);

          return { id: params.id, status: 'IN_PROGRESS' };
        });
      },
    })),

    // 6. Hoàn tất chuyến đi (POST /trips/:id/complete)
    ...['/trips/:id/complete', '/api/v1/trips/:id/complete'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, headers, correlationId }) => {
        const caller = requireCaller(headers);

        const txResult = db.tx(() => {
          const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
          if (!trip) {
            throw createError(404, 'TRIP_NOT_FOUND', `Không tìm thấy cuốc xe với ID: ${params.id}`);
          }

          assertDriverOwnership(caller, trip, 'hoàn tất chuyến xe');

          if (!['IN_PROGRESS', 'ACCEPTED'].includes(trip.status)) {
            throw createError(400, 'INVALID_STATE_TRANSITION', `Không thể hoàn tất chuyến ở trạng thái: ${trip.status}`);
          }

          const now = new Date().toISOString();
          db.run("UPDATE trips SET status = 'COMPLETED', updated_at = ? WHERE id = ?;", now, params.id);

          // Bắn sự kiện trip.event.completed để Payment Service trừ tiền thật
          outboxManager.insertEvent({
            aggregateType: 'TRIP',
            aggregateId: params.id,
            eventType: 'trip.event.completed',
            payload: {
              trip_id: params.id,
              driver_id: trip.driver_id,
              ...(trip.driver_user_id ? { driver_user_id: trip.driver_user_id } : {}),
              passenger_id: trip.passenger_id,
              fare: trip.fare,
            },
            correlationId,
          });

          if (trip.driver_id) {
            outboxManager.insertEvent({
              aggregateType: 'TRIP',
              aggregateId: params.id,
              eventType: 'trip.event.release_driver',
              payload: {
                trip_id: params.id,
                driver_id: trip.driver_id,
                ...(trip.reservation_id ? { reservation_id: trip.reservation_id } : {}),
                reason: 'TRIP_COMPLETED',
              },
              correlationId,
            });
          }

          return {
            response: { id: params.id, status: 'COMPLETED' },
            releaseInfo: trip.reservation_id
              ? { tripId: params.id, driverId: trip.driver_id, reservationId: trip.reservation_id }
              : null,
          };
        });

        if (txResult.releaseInfo) {
          await driverClient.releaseReservation({
            ...txResult.releaseInfo,
            correlationId,
          });
        }

        return txResult.response;
      },
    })),

    // 7. Huỷ chuyến đi (POST /trips/:id/cancel)
    ...['/trips/:id/cancel', '/api/v1/trips/:id/cancel'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ params, body, headers, correlationId }) => {
        const caller = requireCaller(headers);
        const { reason } = body || {};

        const txResult = db.tx(() => {
          const trip = db.get('SELECT * FROM trips WHERE id = ?;', params.id);
          if (!trip) {
            throw createError(404, 'TRIP_NOT_FOUND', `Không tìm thấy cuốc xe với ID: ${params.id}`);
          }

          if (!caller.isInternal) {
            if (caller.role === 'PASSENGER') {
              if (caller.userId !== trip.passenger_id) {
                throw createError(403, 'FORBIDDEN', 'Bạn không thể huỷ chuyến xe của người khác');
              }
            } else if (caller.role === 'DRIVER') {
              if (!isAssignedDriver(caller, trip)) {
                throw createError(403, 'FORBIDDEN', 'Bạn không phải tài xế của chuyến xe này để huỷ');
              }
            } else {
              throw createError(403, 'FORBIDDEN', 'Vai trò không hợp lệ để huỷ chuyến xe');
            }
          }

          if (['COMPLETED', 'CANCELLED'].includes(trip.status)) {
            throw createError(400, 'CANNOT_CANCEL', `Không thể huỷ chuyến xe đã kết thúc hoặc đã huỷ (Trạng thái: ${trip.status})`);
          }

          const now = new Date().toISOString();
          const cancelReason = reason || (caller.role === 'DRIVER' ? 'DRIVER_CANCELLED' : 'PASSENGER_CANCELLED');

          db.run(
            "UPDATE trips SET status = 'CANCELLED', cancellation_reason = ?, updated_at = ? WHERE id = ?;",
            cancelReason,
            now,
            params.id
          );

          let hasCompensation = false;

          // Nếu đã gán tài xế, phát lệnh bù trừ giải phóng tài xế
          if (trip.driver_id) {
            hasCompensation = true;
            outboxManager.insertEvent({
              aggregateType: 'TRIP',
              aggregateId: params.id,
              eventType: 'trip.event.release_driver',
              payload: {
                trip_id: params.id,
                driver_id: trip.driver_id,
                ...(trip.reservation_id ? { reservation_id: trip.reservation_id } : {}),
                reason: cancelReason,
              },
              correlationId,
            });
          }

          // Nếu chuyến đi đã được CONFIRMED trở đi (tiền đã bị tạm giữ), phát lệnh bù trừ giải phóng tiền
          if (['CONFIRMED', 'ACCEPTED', 'IN_PROGRESS'].includes(trip.status)) {
            hasCompensation = true;
            outboxManager.insertEvent({
              aggregateType: 'TRIP',
              aggregateId: params.id,
              eventType: 'payment.event.refund_requested',
              payload: {
                trip_id: params.id,
                passenger_id: trip.passenger_id,
                amount: trip.fare,
                reason: cancelReason,
              },
              correlationId,
            });
          }

          // Đồng bộ trạng thái Saga Instance nguyên tử trong cùng transaction
          db.run(
            `UPDATE saga_instances 
             SET status = ?, current_step = ?, error_reason = ?, updated_at = ? 
             WHERE trip_id = ?;`,
            hasCompensation ? SAGA_STATUS.COMPENSATED : SAGA_STATUS.FAILED,
            hasCompensation ? 'TRIP_CANCELLED_COMPENSATED' : 'TRIP_CANCELLED_BEFORE_MATCH',
            cancelReason,
            now,
            params.id
          );

          return {
            response: { id: params.id, status: 'CANCELLED', reason: cancelReason },
            releaseInfo: trip.reservation_id
              ? { tripId: params.id, driverId: trip.driver_id, reservationId: trip.reservation_id }
              : null,
          };
        });

        if (txResult.releaseInfo) {
          await driverClient.releaseReservation({
            ...txResult.releaseInfo,
            correlationId,
          });
        }

        return txResult.response;
      },
    })),

    // 8. Cổng nhận sự kiện bất đồng bộ / Webhook xử lý Saga từ Broker
    // Bảo vệ nghiêm ngặt bằng timing-safe x-internal-key và bắt buộc có event_id
    {
      method: 'POST',
      path: '/internal/events',
      status: 200,
      handler: async ({ headers, body }) => {
        const internalKey = headers['x-internal-key'];
        if (!safeCompare(internalKey, config.INTERNAL_KEY)) {
          throw createError(401, 'UNAUTHORIZED_INTERNAL', 'Yêu cầu x-internal-key hợp lệ để gửi sự kiện nội bộ');
        }

        const { event_id, event_type, payload, correlation_id } = body || {};

        if (!event_id || typeof event_id !== 'string' || !event_type || !payload || typeof payload !== 'object') {
          throw createError(400, 'INVALID_EVENT', 'Event envelope bắt buộc phải có event_id, event_type và payload');
        }

        return sagaCoordinator.dispatchEvent(body);
      },
    },
  ];
}

module.exports = {
  createRoutes,
};
