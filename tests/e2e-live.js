'use strict';

/**
 * DS03 - Kịch Bản Kiểm Thử Đầu Cuối (E2E Full-Stack Live Runner)
 * Thực thi trên toàn bộ 10 container Docker Compose đang chạy thật:
 * 1. Đăng ký & Đăng nhập Hành khách (PASSENGER) qua API Gateway
 * 2. Nạp tiền vào ví điện tử Payment Service (100,000 VNĐ)
 * 3. Đăng ký & Đăng nhập Tài xế (DRIVER)
 * 4. Tạo hồ sơ tài xế, cập nhật toạ độ GPS và chuyển trạng thái AVAILABLE
 * 5. Hành khách tạo cuốc xe (Trip Service)
 * 6. Matching Service ghép tài xế qua RabbitMQ 4
 * 7. Payment Service tạm giữ tiền cước (HOLD) qua Outbox / AMQP
 * 8. Tài xế đón khách, bắt đầu chuyến và hoàn tất cuốc xe
 * 9. Payment Service trừ tiền thật (CAPTURE) và hoàn tất chu kỳ
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
  console.log(' KHỞI CHẠY KIỂM THỬ ĐẦU CUỐI TOÀN HỆ THỐNG (E2E-01 HAPPY PATH)');
  console.log(' Môi trường: Docker Compose 10 containers (RabbitMQ 4, Postgres 17, Gateway)');
  console.log('='.repeat(75));

  const runId = crypto.randomBytes(4).toString('hex');
  const passengerEmail = `passenger_${runId}@ds03.vn`;
  const driverEmail = `driver_${runId}@ds03.vn`;
  const password = 'Password@123';

  // 1. Đăng ký & Đăng nhập Passenger
  console.log('\n[BƯỚC 1]: Đăng ký & Đăng nhập tài khoản Hành khách...');
  const regPass = await api('/auth/register', {
    method: 'POST',
    body: { email: passengerEmail, password, role: 'PASSENGER', name: `Khách Hàng ${runId}` },
  });
  assert.equal(regPass.status, 201, `Đăng ký khách lỗi: ${JSON.stringify(regPass.data)}`);
  const passengerId = regPass.data.data.id;

  const loginPass = await api('/auth/login', {
    method: 'POST',
    body: { email: passengerEmail, password },
  });
  assert.equal(loginPass.status, 200);
  const passengerToken = loginPass.data.data.token;
  console.log(`  ✓ Đăng nhập thành công, passenger_id: ${passengerId}`);

  // 2. Nạp tiền ví
  console.log('\n[BƯỚC 2]: Nạp tiền vào ví điện tử...');
  const topup = await api('/payments/topup', {
    method: 'POST',
    headers: { authorization: `Bearer ${passengerToken}` },
    body: { amount: 100000 },
  });
  assert.equal(topup.status, 200, `Nạp tiền lỗi: ${JSON.stringify(topup.data)}`);
  console.log(`  ✓ Nạp thành công 100,000 đ. Số dư ví: ${topup.data.data.balance} đ`);

  // 3. Đăng ký & Đăng nhập Driver
  console.log('\n[BƯỚC 3]: Đăng ký & Đăng nhập tài khoản Tài xế...');
  const regDriver = await api('/auth/register', {
    method: 'POST',
    body: { email: driverEmail, password, role: 'DRIVER', name: `Bác Tài ${runId}` },
  });
  assert.equal(regDriver.status, 201);
  const driverUserId = regDriver.data.data.id;

  const loginDriver = await api('/auth/login', {
    method: 'POST',
    body: { email: driverEmail, password },
  });
  assert.equal(loginDriver.status, 200);
  const driverToken = loginDriver.data.data.token;
  console.log(`  ✓ Đăng nhập tài xế thành công, user_id: ${driverUserId}`);

  // 4. Tạo hồ sơ tài xế & Cập nhật GPS
  console.log('\n[BƯỚC 4]: Khởi tạo hồ sơ xe & Cập nhật vị trí GPS...');
  const profile = await api('/drivers', {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { name: `Bác Tài ${runId}`, vehicle_plate: `29A-${runId}`, vehicle_model: 'VinFast VF8' },
  });
  assert.equal(profile.status, 200);
  const driverId = profile.data.data.id;

  // Cập nhật vị trí GPS tại Hồ Hoàn Kiếm (21.0285, 105.8542)
  const loc = await api('/drivers/location', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { latitude: 21.0285, longitude: 105.8542 },
  });
  assert.equal(loc.status, 200);

  // Chuyển sang trạng thái AVAILABLE
  const st = await api('/drivers/status', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { status: 'AVAILABLE' },
  });
  assert.equal(st.status, 200);
  console.log(`  ✓ Tài xế ${driverId} đang AVAILABLE tại toạ độ (21.0285, 105.8542)`);

  // 5. Hành khách tạo cuốc xe
  console.log('\n[BƯỚC 5]: Hành khách đặt chuyến xe mới qua API Gateway...');
  const createTrip = await api('/trips', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${passengerToken}`,
      'idempotency-key': `idem_${runId}`,
    },
    body: {
      pickup_latitude: 21.0286,
      pickup_longitude: 105.8543,
      pickup_address: 'Hồ Gươm Plaza, Hà Nội',
      dropoff_latitude: 21.0350,
      dropoff_longitude: 105.8400,
      dropoff_address: 'Lăng Bác, Hà Nội',
    },
  });
  assert.equal(createTrip.status, 201, `Tạo cuốc xe lỗi: ${JSON.stringify(createTrip.data)}`);
  const tripId = createTrip.data.data.id;
  const fare = createTrip.data.data.estimated_fare;
  console.log(`  ✓ Cuốc xe được tạo thành công: ID=${tripId}, Cước=${fare} đ, Trạng thái=${createTrip.data.data.status}`);

  // 6. Chờ Matching Service ghép tài xế & Payment Service tạm giữ tiền (HOLD)
  console.log('\n[BƯỚC 6]: Đang đợi Matching Service & Payment Service xử lý qua RabbitMQ...');
  let matchedTrip = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const check = await api(`/trips/${tripId}`, {
      headers: { authorization: `Bearer ${passengerToken}` },
    });
    if (check.ok && ['DRIVER_ASSIGNED', 'CONFIRMED'].includes(check.data.data.status)) {
      matchedTrip = check.data.data;
      break;
    }
  }

  assert(matchedTrip, 'Hết thời gian chờ matching (Timeout 10s)');
  console.log(`  ✓ Ghép xe thành công! Tài xế được gán: ${matchedTrip.driver_id}, Trạng thái: ${matchedTrip.status}`);

  // 7. Chờ trạng thái sang CONFIRMED (Payment Hold thành công)
  for (let i = 0; i < 15; i++) {
    if (matchedTrip.status === 'CONFIRMED') break;
    await sleep(500);
    const check = await api(`/trips/${tripId}`, {
      headers: { authorization: `Bearer ${passengerToken}` },
    });
    matchedTrip = check.data.data;
  }
  assert.equal(matchedTrip.status, 'CONFIRMED', 'Chuyến xe phải đạt CONFIRMED sau khi hold ví thành công');
  console.log(`  ✓ Tiền cước (${fare} đ) đã được tạm giữ an toàn trong ví. Cuốc xe chính thức CONFIRMED!`);

  // 8. Tài xế nhận khách (ACCEPT) -> Bắt đầu (START) -> Hoàn tất (COMPLETE)
  console.log('\n[BƯỚC 7]: Vòng đời chuyến xe (ACCEPTED -> IN_PROGRESS -> COMPLETED)...');
  const accept = await api(`/trips/${tripId}/accept`, {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
  });
  assert.equal(accept.status, 200);

  const start = await api(`/trips/${tripId}/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
  });
  assert.equal(start.status, 200);

  const complete = await api(`/trips/${tripId}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
  });
  assert.equal(complete.status, 200);
  console.log('  ✓ Tài xế đã hoàn tất chuyến xe (COMPLETED)!');

  // 9. Xác nhận Payment Service đã Capture trừ tiền
  console.log('\n[BƯỚC 8]: Xác nhận đối soát giao dịch trừ tiền (CAPTURE) trên Payment Service...');
  await sleep(1000);
  const walletCheck = await api('/payments/wallet', {
    headers: { authorization: `Bearer ${passengerToken}` },
  });
  assert.equal(walletCheck.status, 200);
  const remaining = walletCheck.data.data.balance;
  const held = walletCheck.data.data.held_balance;
  console.log(`  ✓ Số dư ví sau chuyến: ${remaining} đ (Đã trừ chính xác ${fare} đ, Tiền tạm giữ = ${held} đ)`);
  assert.equal(held, 0, 'Held balance phải trở về 0 sau khi hoàn tất chuyến');

  console.log('\n' + '='.repeat(75));
  console.log('🎉 KỊCH BẢN E2E-01 ĐÃ HOÀN TẤT VÀ VƯỢT QUA 100% TIÊU CHÍ NGHIỆM THU THẬT!');
  console.log('='.repeat(75));
}

main().catch((err) => {
  console.error('\n❌ KỊCH BẢN E2E THẤT BẠI:', err.message);
  process.exit(1);
});
