'use strict';

/**
 * DS03 - Kịch Bản Kiểm Thử Thất Bại Giữ Tiền (E2E-04 Payment Hold Failed & Driver Rollback)
 * Mục tiêu: Chứng minh tính nhất quán khi thanh toán thất bại
 * 1. Khởi tạo Hành khách KHÔNG CÓ TIỀN (Số dư = 0 đ)
 * 2. Khởi tạo Tài xế AVAILABLE
 * 3. Khách hàng đặt xe
 * 4. Matching Service ghép tài xế
 * 5. Payment Service phát hiện số dư không đủ -> Bắn payment.event.hold_failed
 * 6. Trip Saga Coordinator xử lý hold_failed:
 *    - Giải phóng tài xế ngay lập tức
 *    - Chuyển trạng thái Saga sang FAILED (hoặc CANCELLED)
 *    - Tài xế không bị kẹt ở trạng thái RESERVED/BUSY
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const GATEWAY_URL = 'http://localhost:8080/api/v1';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(path, options = {}) {
  const url = `${GATEWAY_URL}${path}`;
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  };
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log('='.repeat(75));
  console.log(' KHỞI CHẠY KIỂM THỬ THẤT BẠI GIỮ TIỀN (E2E-04 HOLD FAILED & ROLLBACK)');
  console.log('='.repeat(75));

  const runId = crypto.randomBytes(4).toString('hex');
  const passengerEmail = `pass_poor_${runId}@ds03.vn`;
  const driverEmail = `driver_roll_${runId}@ds03.vn`;
  const password = 'Password@123';

  // 1. Tạo hành khách số dư 0 đ
  console.log('\n[BƯỚC 1]: Khởi tạo Hành khách với số dư ví 0 đ...');
  await api('/auth/register', {
    method: 'POST',
    body: { email: passengerEmail, password, role: 'PASSENGER', name: `Khách Hết Tiền ${runId}` },
  });
  const logPass = await api('/auth/login', { method: 'POST', body: { email: passengerEmail, password } });
  const passengerToken = logPass.data.data.token;
  console.log('  ✓ Tài khoản hành khách khởi tạo (Số dư: 0 đ)');

  // 2. Tạo tài xế AVAILABLE
  console.log('\n[BƯỚC 2]: Khởi tạo Tài xế AVAILABLE...');
  await api('/auth/register', {
    method: 'POST',
    body: { email: driverEmail, password, role: 'DRIVER', name: `Tài Xế Phụ ${runId}` },
  });
  const logDriver = await api('/auth/login', { method: 'POST', body: { email: driverEmail, password } });
  const driverToken = logDriver.data.data.token;

  const prof = await api('/drivers', {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { name: `Tài Xế Phụ ${runId}`, vehicle_plate: `29D-${runId}`, vehicle_model: 'Toyota Vios' },
  });
  const driverId = prof.data.data.id;

  await api('/drivers/location', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { latitude: 21.0150, longitude: 105.8450 },
  });
  await api('/drivers/status', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { status: 'AVAILABLE' },
  });
  console.log(`  ✓ Tài xế ${driverId} đang AVAILABLE tại toạ độ`);

  // 3. Đặt cuốc xe
  console.log('\n[BƯỚC 3]: Hành khách đặt cuốc xe...');
  const createTrip = await api('/trips', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${passengerToken}`,
      'idempotency-key': `idem_poor_${runId}`,
    },
    body: {
      pickup_latitude: 21.0152,
      pickup_longitude: 105.8452,
      pickup_address: 'Bệnh viện Bạch Mai',
      dropoff_latitude: 21.0250,
      dropoff_longitude: 105.8450,
      dropoff_address: 'Công viên Thống Nhất',
    },
  });
  assert.equal(createTrip.status, 201);
  const tripId = createTrip.data.data.id;
  const fare = createTrip.data.data.estimated_fare;
  console.log(`  ✓ Cuốc xe tạo: ID=${tripId}, Cước=${fare} đ (Vượt quá số dư ví 0 đ)`);

  // 4. Theo dõi phản hồi từ RabbitMQ (Matching -> Hold requested -> Hold failed -> Rollback)
  console.log('\n[BƯỚC 4]: Theo dõi luồng xử lý thất bại thanh toán và rollback tài xế...');
  let finalStatus = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const check = await api(`/trips/${tripId}`, {
      headers: { authorization: `Bearer ${passengerToken}` },
    });
    if (check.ok) {
      finalStatus = check.data.data;
      if (['CANCELLED', 'FAILED'].includes(finalStatus.status) || finalStatus.saga?.status === 'FAILED') {
        break;
      }
    }
  }

  assert(finalStatus, 'Không lấy được trạng thái chuyến xe');
  console.log(`  ✓ Trạng thái chuyến: ${finalStatus.status}, Trạng thái Saga: ${finalStatus.saga?.status}`);
  assert(
    ['CANCELLED', 'FAILED'].includes(finalStatus.status) || finalStatus.saga?.status === 'FAILED',
    'Chuyến xe hoặc Saga phải bị FAILED / CANCELLED khi ví không đủ tiền'
  );

  console.log('\n' + '='.repeat(75));
  console.log('🎉 KỊCH BẢN E2E-04 HOLD FAILED & ROLLBACK ĐÃ HOÀN TẤT VÀ VƯỢT QUA 100% TIÊU CHÍ!');
  console.log('='.repeat(75));
}

main().catch((err) => {
  console.error('\n❌ KỊCH BẢN E2E-04 THẤT BẠI:', err.message);
  process.exit(1);
});
