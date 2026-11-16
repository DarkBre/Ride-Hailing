'use strict';

/**
 * DS03 - Kịch Bản Kiểm Thử Tranh Chấp Đồng Thời (E2E-03 Concurrency & Double-Booking Prevention)
 * Mục tiêu: Chứng minh tính nhất quán của thuật toán Matching & Khóa phân tán
 * 1. Khởi tạo DUY NHẤT 1 Tài xế AVAILABLE tại toạ độ (21.0285, 105.8542)
 * 2. Khởi tạo 2 Hành khách riêng biệt, cả hai đều có đủ tiền trong ví
 * 3. Cả 2 Hành khách gửi yêu cầu đặt xe ĐỒNG THỜI (Promise.all)
 * 4. Xác nhận:
 *    - CHỈ CÓ DUY NHẤT 1 cuốc xe được ghép thành công với tài xế đó
 *    - Cuốc xe còn lại chuyển sang MATCHING_FAILED (hoặc không bị gán trùng)
 *    - Tài xế không bao giờ bị double-booking
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
  console.log(' KHỞI CHẠY KIỂM THỬ TRANH CHẤP ĐỒNG THỜI (E2E-03 CONCURRENCY & ISOLATION)');
  console.log('='.repeat(75));

  const runId = crypto.randomBytes(4).toString('hex');
  const driverEmail = `driver_iso_${runId}@ds03.vn`;
  const pass1Email = `pass1_iso_${runId}@ds03.vn`;
  const pass2Email = `pass2_iso_${runId}@ds03.vn`;
  const password = 'Password@123';

  // 1. Tạo 1 Tài xế duy nhất
  console.log('\n[BƯỚC 1]: Tạo 1 Tài xế duy nhất ở trạng thái AVAILABLE...');
  await api('/auth/register', {
    method: 'POST',
    body: { email: driverEmail, password, role: 'DRIVER', name: `Tài Xế Độc Nhất ${runId}` },
  });
  const logDriver = await api('/auth/login', { method: 'POST', body: { email: driverEmail, password } });
  const driverToken = logDriver.data.data.token;

  const prof = await api('/drivers', {
    method: 'POST',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { name: `Tài Xế Độc Nhất ${runId}`, vehicle_plate: `29C-${runId}`, vehicle_model: 'Mazda CX-5' },
  });
  const driverId = prof.data.data.id;

  await api('/drivers/location', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { latitude: 21.0200, longitude: 105.8500 },
  });
  await api('/drivers/status', {
    method: 'PUT',
    headers: { authorization: `Bearer ${driverToken}` },
    body: { status: 'AVAILABLE' },
  });
  console.log(`  ✓ Tài xế ID: ${driverId} đang AVAILABLE tại (21.0200, 105.8500)`);

  // 2. Tạo 2 Hành khách và nạp tiền ví
  console.log('\n[BƯỚC 2]: Khởi tạo 2 Hành khách riêng biệt có sẵn số dư...');
  async function createPassenger(email, name) {
    await api('/auth/register', { method: 'POST', body: { email, password, role: 'PASSENGER', name } });
    const log = await api('/auth/login', { method: 'POST', body: { email, password } });
    const token = log.data.data.token;
    await api('/payments/topup', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { amount: 100000 },
    });
    return token;
  }

  const [token1, token2] = await Promise.all([
    createPassenger(pass1Email, `Khách 1 ${runId}`),
    createPassenger(pass2Email, `Khách 2 ${runId}`),
  ]);
  console.log('  ✓ Cả 2 hành khách đã đăng ký và nạp 100,000 đ thành công');

  // 3. Đặt xe ĐỒNG THỜI
  console.log('\n[BƯỚC 3]: Gửi đồng thời 2 yêu cầu đặt chuyến xe cạnh vị trí tài xế...');
  const [res1, res2] = await Promise.all([
    api('/trips', {
      method: 'POST',
      headers: { authorization: `Bearer ${token1}`, 'idempotency-key': `idem_c1_${runId}` },
      body: {
        pickup_latitude: 21.0201,
        pickup_longitude: 105.8501,
        pickup_address: 'Ngã tư Tràng Tiền',
        dropoff_latitude: 21.0300,
        dropoff_longitude: 105.8600,
        dropoff_address: 'Nhà Hát Lớn',
      },
    }),
    api('/trips', {
      method: 'POST',
      headers: { authorization: `Bearer ${token2}`, 'idempotency-key': `idem_c2_${runId}` },
      body: {
        pickup_latitude: 21.0202,
        pickup_longitude: 105.8502,
        pickup_address: 'Vườn hoa Lý Thái Tổ',
        dropoff_latitude: 21.0350,
        dropoff_longitude: 105.8650,
        dropoff_address: 'Cầu Chương Dương',
      },
    }),
  ]);

  assert.equal(res1.status, 201);
  assert.equal(res2.status, 201);
  const trip1Id = res1.data.data.id;
  const trip2Id = res2.data.data.id;
  console.log(`  ✓ Yêu cầu đặt xe 1: ID=${trip1Id}`);
  console.log(`  ✓ Yêu cầu đặt xe 2: ID=${trip2Id}`);

  // 4. Chờ hệ thống Matching xử lý cả 2 cuốc
  console.log('\n[BƯỚC 4]: Chờ kết quả phân phối từ Matching Service & RabbitMQ...');
  let t1Status = null;
  let t2Status = null;

  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const [c1, c2] = await Promise.all([
      api(`/trips/${trip1Id}`, { headers: { authorization: `Bearer ${token1}` } }),
      api(`/trips/${trip2Id}`, { headers: { authorization: `Bearer ${token2}` } }),
    ]);
    t1Status = c1.data.data;
    t2Status = c2.data.data;

    // Khi 1 cuốc đã CONFIRMED và cuốc kia hoặc MATCHING_FAILED hoặc REQUESTED/CANCELLED
    const oneConfirmed = ['DRIVER_ASSIGNED', 'CONFIRMED'].includes(t1Status?.status) || ['DRIVER_ASSIGNED', 'CONFIRMED'].includes(t2Status?.status);
    if (oneConfirmed && i >= 4) break;
  }

  console.log(`  ✓ Trạng thái Cuốc 1: ${t1Status.status} (Tài xế: ${t1Status.driver_id || 'Chưa gán'})`);
  console.log(`  ✓ Trạng thái Cuốc 2: ${t2Status.status} (Tài xế: ${t2Status.driver_id || 'Chưa gán'})`);

  // 5. Kiểm tra phòng chống Double-Booking
  console.log('\n[BƯỚC 5]: Kiểm chứng tính toàn vẹn (Double-Booking Prevention)...');
  const trip1GotDriver = t1Status.driver_id === driverId;
  const trip2GotDriver = t2Status.driver_id === driverId;

  assert(
    (trip1GotDriver && !trip2GotDriver) || (!trip1GotDriver && trip2GotDriver),
    'LỖI NGHIÊM TRỌNG: Tài xế bị gán trùng cho cả 2 cuốc xe cùng lúc!'
  );
  console.log('  ✓ XÁC NHẬN: Duy nhất 1 cuốc xe giành được tài xế, không có hiện tượng double-booking!');

  console.log('\n' + '='.repeat(75));
  console.log('🎉 KỊCH BẢN E2E-03 CONCURRENCY TEST ĐÃ HOÀN TẤT VÀ VƯỢT QUA 100% TIÊU CHÍ!');
  console.log('='.repeat(75));
}

main().catch((err) => {
  console.error('\n❌ KỊCH BẢN E2E-03 THẤT BẠI:', err.message);
  process.exit(1);
});
