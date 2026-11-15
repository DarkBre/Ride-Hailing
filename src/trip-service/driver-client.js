'use strict';

const config = require('./config');

async function requestJson(url, options = {}, timeoutMs = 2000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

function createDriverClient(customConfig = {}) {
  const driverBaseUrl = customConfig.driverUrl || config.SERVICES.driver;
  const driverInternalKey = customConfig.internalKey || config.DRIVER_INTERNAL_KEY;
  const driverTripKey = customConfig.tripKey || config.DRIVER_TRIP_KEY;

  return {
    /**
     * Lấy số tài xế rảnh quanh điểm đón cho Dynamic Pricing; trả về null nếu Driver offline để fallback an toàn.
     */
    async fetchAvailableSupply(lat, lon, radiusKm = config.MATCHING_RADIUS_KM, correlationId = '') {
      try {
        const url = new URL('/drivers/nearby', driverBaseUrl);
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lon', String(lon));
        url.searchParams.set('radius_km', String(radiusKm));

        const res = await requestJson(
          url.toString(),
          {
            method: 'GET',
            headers: {
              'x-internal-key': driverInternalKey,
              'x-correlation-id': correlationId,
            },
          },
          1500
        );
        if (res.ok && Array.isArray(res.body?.data)) {
          return res.body.data.length;
        }
        return null;
      } catch (_) {
        return null;
      }
    },

    /**
     * Xác nhận giữ chỗ tài xế khi tài xế nhấn Accept (chuyển Driver RESERVED -> BUSY).
     */
    async confirmReservation({ tripId, driverId, reservationId, correlationId = '' }) {
      let res;
      try {
        const url = new URL('/internal/reservations/confirm', driverBaseUrl);
        res = await requestJson(
          url.toString(),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-key': driverTripKey,
              'x-correlation-id': correlationId,
            },
            body: JSON.stringify({
              trip_id: tripId,
              driver_id: driverId || undefined,
              reservation_id: reservationId,
            }),
          },
          2500
        );
      } catch (err) {
        const serviceErr = new Error(`Không thể kết nối Driver Service để xác nhận reservation: ${err.message}`);
        serviceErr.status = 503;
        serviceErr.code = 'DRIVER_SERVICE_UNAVAILABLE';
        throw serviceErr;
      }

      if (!res.ok) {
        const msg = res.body?.error?.message || `Driver Service từ chối xác nhận reservation (HTTP ${res.status})`;
        const err = new Error(msg);
        err.status = res.status === 404 || res.status === 409 ? 409 : res.status;
        err.code = res.body?.error?.code || 'RESERVATION_INVALID_OR_EXPIRED';
        throw err;
      }

      const state = res.body?.data?.state;
      if (state && state !== 'CONFIRMED') {
        const err = new Error(`Reservation không còn hiệu lực để nhận chuyến (Trạng thái Driver: ${state})`);
        err.status = 409;
        err.code = 'RESERVATION_INVALID_OR_EXPIRED';
        throw err;
      }

      return res.body?.data || { state: 'CONFIRMED' };
    },

    /**
     * Giải phóng tài xế đồng bộ (best-effort) khi hoàn tất hoặc huỷ chuyến; Outbox trip.event.release_driver bảo đảm bù trừ cuối cùng.
     */
    async releaseReservation({ tripId, driverId, reservationId, correlationId = '' }) {
      try {
        const url = new URL('/internal/reservations/release', driverBaseUrl);
        const res = await requestJson(
          url.toString(),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-key': driverTripKey,
              'x-correlation-id': correlationId,
            },
            body: JSON.stringify({
              trip_id: tripId,
              ...(driverId ? { driver_id: driverId } : {}),
              ...(reservationId ? { reservation_id: reservationId } : {}),
            }),
          },
          2000
        );
        return { released: res.ok, data: res.body?.data || null };
      } catch (_) {
        return { released: false, fallbackToOutbox: true };
      }
    },
  };
}

module.exports = {
  createDriverClient,
};
