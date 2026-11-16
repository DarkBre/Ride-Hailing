'use strict';

/**
 * DS03 - Kịch Bản Kiểm Thử Bù Trừ Phân Tán (E2E-02 Distributed Saga Compensation Loop)
 * Thực thi trên toàn bộ hệ thống live:
 * 1. Khởi tạo Passenger & Driver
 * 2. Đặt chuyến, khớp tài xế, giữ tiền ví -> Chuyến đạt CONFIRMED
 * 3. Khách hàng huỷ chuyến (CANCEL)
 * 4. Hệ thống kích hoạt bù trừ:
 *    - Giải phóng tài xế (Driver Reservation Release)
 *    - Bắn payment.event.refund_requested qua RabbitMQ
 *    - Payment Service hoàn tiền held_balance -> balance
 *    - Payment Outbox bắn payment.event.refund_success
 *    - Trip Saga Coordinator nhận event và cập nhật Saga sang COMPENSATED
 *    - Số dư ví khôi phục 100%, không bị thất thoát tiền
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
  console.log(' KHỞI CHẠY KIỂM THỬ SAGA BÙ TRỪ PHÂN TÁN (E2E-02 COMPENSATION LOOP)');
  console.log('='.repeat(75));

  const runId = crypto.randomBytes(4).toString('hex');
  const passengerEmail = `passenger_comp_${runId}@ds03.vn`;
  const driverEmail = `driver_comp_${runId}@ds03.vn`;
  const password = 'Password@123';

  // 1. Đăng ký & Nạp tiền Passenger
  console.log('\n[BƯỚC 1]: Đăng ký & Nạp tiền cho Hành khách...');
  const regPass = await api('/auth/register', {
    method: 'POST',
    body: { email: passengerEmail, password, role: 'PASSENGER', name: `Khách Huỷ ${runId}` },
  });
  assert.equal(regPass.status, 201);
  const passengerId = regPass.data.data.id;

  const loginPass = await api('/auth/login', {
    method: 'POST',
    body: { email: passengerEmail, password },
  });
  const passengerToken = loginPass.data.data.token;

  await api('/payments/topup', {
    method: 'POST',
    headers: { authorization: `Bearer ${passengerToken}` },
    body: { amount: 50000 },
  });
  console.log('  ✓ Đã nạp 50,000 đ vào ví hành khách');

  // 2. Đăng ký & Bật AVAILABLE Driver
  console.log('\n[BƯỚC 2]: Khởi tạo Tài xế AVAILABLE tại vị trí...');
  const regDriver = await api('/auth/register', {
    method: 'POST',
    body: { email: driverEmail, password, role: 'DRIVER', name: `Tài Xế Bù Trừ ${runId}` },
  });
  const loginDriver = await api('/auth/login', {
    method: 'POST',
    body: { email: driverEmail, password },
  });
  const driverToken = loginDriver.data.data.token;

  await api('/drivers', {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { name: `Tài Xế Bù Trừ ${runId}`, vehicle_plate: `30B-${runId}`, vehicle_model: 'Hyundai Ioniq' },
  });
  await api('/drivers/location', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { latitude: 21.0300, longitude: 105.8500 },
  });
  await api('/drivers/status', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { status: 'AVAILABLE' },
  });
  console.log('  ✓ Tài xế đã sẵn sàng nhận cuốc');

  // 3. Đặt chuyến xe
  console.log('\n[BƯỚC 3]: Hành khách đặt cuốc xe...');
  const createTrip = await api('/trips', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${passengerToken}`,
      'idempotency-key': `idem_comp_${runId}`,
    },
    body: {
      pickup_latitude: 21.0305,
      pickup_longitude: 105.8505,
      pickup_address: 'Vincom Bà Triệu',
      dropoff_latitude: 21.0400,
      dropoff_longitude: 105.8500,
      dropoff_address: 'Chợ Đồng Xuân',
    },
  });
  assert.equal(createTrip.status, 201);
  const tripId = createTrip.data.data.id;
  const fare = createTrip.data.data.estimated_fare;
  console.log(`  ✓ Cuốc xe tạo: ID=${tripId}, Cước=${fare} đ`);

  // 4. Chờ cuốc xe sang CONFIRMED (Đã giữ tiền)
  console.log('\n[BƯỚC 4]: Chờ chuyến xe ghép tài xế và tạm giữ tiền (CONFIRMED)...');
  let confirmedTrip = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const check = await api(`/trips/${tripId}`, {
      headers: { authorization: `Bearer ${passengerToken}` },
    });
    if (check.ok && check.data.data.status === 'CONFIRMED') {
      confirmedTrip = check.data.data;
      break;
    }
  }
  assert(confirmedTrip, 'Chuyến xe không đạt CONFIRMED trong thời hạn');
  console.log(`  ✓ Chuyến xe đạt CONFIRMED! Tiền cước ${fare} đ đã bị tạm giữ trong ví.`);

  // 5. Hành khách huỷ chuyến đi
  console.log('\n[BƯỚC 5]: Hành khách yêu cầu HUỶ chuyến xe (POST /trips/:id/cancel)...');
  const cancelRes = await api(`/trips/${tripId}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${passengerToken}` },
    body: { reason: 'Thay đổi kế hoạch cá nhân' },
  });
  assert.equal(cancelRes.status, 200, `Huỷ chuyến lỗi: ${JSON.stringify(cancelRes.data)}`);
  assert.equal(cancelRes.data.data.status, 'CANCELLED');
  console.log('  ✓ Trip Service xác nhận trạng thái CANCELLED');

  // 6. Chờ Saga Coordinator chuyển trạng thái sang COMPENSATED và ví được hoàn tiền
  console.log('\n[BƯỚC 6]: Kiểm tra luồng bù trừ qua RabbitMQ (Refund Request -> Refund Success -> COMPENSATED)...');
  let sagaCompensated = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const check = await api(`/trips/${tripId}`, {
      headers: { authorization: `Bearer ${passengerToken}` },
    });
    if (check.ok && check.data.data.saga?.status === 'COMPENSATED') {
      sagaCompensated = true;
      break;
    }
  }
  assert(sagaCompensated, 'Saga không đạt trạng thái COMPENSATED (Timeout 10s)');
  console.log('  ✓ Saga Coordinator đã xác nhận trạng thái COMPENSATED thành công!');

  // 7. Kiểm tra ví hành khách được hoàn 100% tiền
  console.log('\n[BƯỚC 7]: Kiểm tra số dư ví trên Payment Service...');
  const walletCheck = await api('/payments/wallet', {
    headers: { authorization: `Bearer ${passengerToken}` },
  });
  assert.equal(walletCheck.status, 200);
  assert.equal(walletCheck.data.data.balance, 50000, 'Số dư ví phải được hoàn lại 50,000 đ đầy đủ');
  assert.equal(walletCheck.data.data.held_balance, 0, 'Tiền tạm giữ (held_balance) phải trở về 0 đ');
  console.log(`  ✓ Số dư ví: ${walletCheck.data.data.balance} đ, Tiền tạm giữ: ${walletCheck.data.data.held_balance} đ (Hoàn trả nguyên vẹn)`);

  console.log('\n' + '='.repeat(75));
  console.log('🎉 KỊCH BẢN E2E-02 SAGA COMPENSATION ĐÃ HOÀN TẤT VÀ VƯỢT QUA 100% TIÊU CHÍ!');
  console.log('='.repeat(75));
}

main().catch((err) => {
  console.error('\n❌ KỊCH BẢN E2E-02 THẤT BẠI:', err.message);
  process.exit(1);
});
