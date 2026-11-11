'use strict';

/**
 * TEST SUITE: TRIP / BOOKING SERVICE & DYNAMIC PRICING (TV1)
 * Bao gồm: FT-05, FT-08, ST-02, Dynamic Pricing, Outbox Pattern & State Machine
 */

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createTripService } = require('../src/trip-service');
const { PricingEngine } = require('../src/trip-service/pricing-engine');
const { haversineDistanceKm } = require('../src/trip-service/geo');
const { createHttpPublisher } = require('../src/trip-service/outbox');
const { verifyToken: verifyTripToken } = require('../src/trip-service/auth');
const { signToken } = require('../src/identity-service/auth');

const TEST_PORT = 8903;
const TEST_DB = path.join(__dirname, '..', 'data', 'test_trip_db.sqlite');

function cleanTestDb() {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(TEST_DB + ext)) fs.unlinkSync(TEST_DB + ext);
    } catch (_) {}
  }
}

function makeRequest({ method = 'GET', path = '/', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payloadStr = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (payloadStr) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payloadStr);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {
            parsed = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payloadStr) req.write(payloadStr);
    req.end();
  });
}

async function runTests() {
  console.log('='.repeat(65));
  console.log(' [TEST SUITE 2] TRIP / BOOKING SERVICE & PRICING (TV1)');
  console.log('='.repeat(65));

  cleanTestDb();

  const publishedEvents = [];
  const service = createTripService({
    port: TEST_PORT,
    dbPath: TEST_DB,
    onPublish: (envelope) => {
      publishedEvents.push(envelope);
    },
  });
  await service.start();

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  ✓ [PASS] ${name}`);
    } catch (err) {
      console.error(`  ✗ [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  try {
    // 1. Kiểm thử Dynamic Pricing Engine & Haversine Distance
    await test('Dynamic Pricing: Tính đúng khoảng cách Haversine GPS', () => {
      // Bờ Hồ (21.0285, 105.8542) đến Cầu Giấy (21.0358, 105.7925) ~ 6.4km
      const d = haversineDistanceKm(
        { lat: 21.0285, lon: 105.8542 },
        { lat: 21.0358, lon: 105.7925 }
      );
      assert(d > 6.0 && d < 7.0, `Khoảng cách phải ~6.4km, thực tế: ${d}km`);
    });

    await test('Dynamic Pricing: Surge Multiplier = 1.0 khi demand = 0', () => {
      const pe = new PricingEngine();
      const surge = pe.calculateSurgeMultiplier(0, 5);
      assert.strictEqual(surge, 1.0);
    });

    await test('Dynamic Pricing: Surge Multiplier tăng khi demand cao và supply thấp', () => {
      const pe = new PricingEngine();
      // demand = 4, supply = 2 => ratio = 2.0 => surge = 1.0 + 2.0 * 0.2 = 1.4
      const surge = pe.calculateSurgeMultiplier(4, 2);
      assert.strictEqual(surge, 1.4);
    });

    await test('Dynamic Pricing: Surge Multiplier chặn trần tối đa ở 2.5 (Capping)', () => {
      const pe = new PricingEngine();
      // demand = 100, supply = 1 => ratio = 100 => vượt ngưỡng => cap = 2.5
      const surge = pe.calculateSurgeMultiplier(100, 1);
      assert.strictEqual(surge, 2.5);
    });

    await test('Dynamic Pricing: Xử lý an toàn khi supply = 0 (tránh chia cho 0)', () => {
      const pe = new PricingEngine();
      const surge = pe.calculateSurgeMultiplier(5, 0);
      assert(surge >= 1.0 && surge <= 2.5, 'Surge phải trong khoảng [1.0, 2.5]');
    });

    await test('Dynamic Pricing: Xử lý an toàn khi demand/supply là NaN hoặc số âm', () => {
      const pe = new PricingEngine();
      const surge1 = pe.calculateSurgeMultiplier('invalid', -5);
      assert.strictEqual(surge1, 1.0);
    });

    const passengerToken1 = signToken({ userId: 'passenger_test_01', role: 'PASSENGER', email: 'p1@test.com' });
    const driverTokenD01 = signToken({ userId: 'driver_d01', role: 'DRIVER', email: 'd01@test.com' });

    // 2. FT-05: Tạo cuốc xe hợp lệ & lưu Outbox (bắt buộc JWT PASSENGER, chặn giả mạo passenger_id/fare)
    let createdTripId = null;
    await test('FT-05: Tạo cuốc xe thành công (HTTP 201), sinh Outbox event và không cho giả mạo passenger_id/fare', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: 21.028511,
          pickup_longitude: 105.854444,
          pickup_address: '12 Kim Ma, Ba Dinh, Ha Noi',
          dropoff_latitude: 21.035789,
          dropoff_longitude: 105.841234,
          dropoff_address: '88 Cau Giay, Ha Noi',
          passenger_id: 'attacker_spoofed_id',
          driver_id: 'attacker_spoofed_driver',
          fare: 1,
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.status, 'REQUESTED');
      assert(res.body.data.estimated_fare >= 15000, 'Giá cước phải được tính ở server, không dùng fare giả mạo');
      assert(res.body.data.distance_km > 0);
      assert(res.body.data.surge_multiplier >= 1.0);
      createdTripId = res.body.data.id;

      // Kiểm tra trong database: bảng trips (passenger_id lấy từ JWT chứ không phải body)
      const tripInDb = service.db.get('SELECT * FROM trips WHERE id = ?;', createdTripId);
      assert(tripInDb, 'Bản ghi trip phải tồn tại trong trip_db');
      assert.strictEqual(tripInDb.passenger_id, 'passenger_test_01', 'Phải lấy passenger_id từ JWT token, bỏ qua body spoofing');
      assert.strictEqual(tripInDb.driver_id, null, 'driver_id khởi tạo phải là null');
      assert.strictEqual(tripInDb.status, 'REQUESTED');

      // Kiểm tra trong database: bảng outbox_events
      const outboxEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.created';",
        createdTripId
      );
      assert(outboxEvt, 'Outbox event trip.event.created phải được tạo');
    });

    // 3. ST-02: Input Validation cho Trip Service
    await test('ST-02: Toạ độ ngoài phạm vi Trái Đất và chuỗi rỗng/null bị chặn (HTTP 400)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: 999.0, // Sai
          pickup_longitude: 105.85,
          pickup_address: 'A',
          dropoff_latitude: 21.0,
          dropoff_longitude: 105.8,
          dropoff_address: 'B',
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_COORDINATES');

      const resEmpty = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: '',
          pickup_longitude: null,
          pickup_address: 'A',
          dropoff_latitude: 21.0,
          dropoff_longitude: 105.8,
          dropoff_address: 'B',
        },
      });
      assert.strictEqual(resEmpty.status, 400);
      assert.strictEqual(resEmpty.body.error.code, 'INVALID_COORDINATES');
    });

    await test('ST-02: Điểm đón và điểm đến trùng nhau bị chặn (HTTP 400)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: 21.0285,
          pickup_longitude: 105.8544,
          pickup_address: 'Cùng 1 chỗ',
          dropoff_latitude: 21.0285,
          dropoff_longitude: 105.8544,
          dropoff_address: 'Cùng 1 chỗ',
        },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'ZERO_DISTANCE');
    });

    await test('ST-02: Thao tác payload chứa ký tự SQL Injection an toàn tuyệt đối', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: 21.0285,
          pickup_longitude: 105.8544,
          pickup_address: "'; DROP TABLE trips; --",
          dropoff_latitude: 21.0358,
          dropoff_longitude: 105.8412,
          dropoff_address: '88 Cau Giay',
        },
      });
      assert.strictEqual(res.status, 201);
      // Bảng trips vẫn nguyên vẹn
      const count = service.db.get('SELECT COUNT(*) as c FROM trips;');
      assert(count.c >= 2, 'Bảng trips không bị tổn hại bởi SQL Injection');
    });

    // 4. Idempotency Key Handling
    await test('Idempotency Key: Gửi 2 request cùng key trả về cuốc xe hiện có (không nhân bản)', async () => {
      const idempKey = 'idemp_key_unique_12345';
      const payload = {
        pickup_latitude: 21.02,
        pickup_longitude: 105.85,
        pickup_address: 'Diem Don',
        dropoff_latitude: 21.05,
        dropoff_longitude: 105.82,
        dropoff_address: 'Diem Den',
      };

      const res1 = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { 'idempotency-key': idempKey, Authorization: `Bearer ${passengerToken1}` },
        body: payload,
      });
      assert.strictEqual(res1.status, 201);
      const tripId1 = res1.body.data.id;

      // Gửi lại lần 2 với cùng key
      const res2 = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { 'idempotency-key': idempKey, Authorization: `Bearer ${passengerToken1}` },
        body: payload,
      });
      assert.strictEqual(res2.status, 201);
      assert.strictEqual(res2.body.data.id, tripId1, 'Phải trả về cùng tripId');
      assert.strictEqual(res2.body.data.duplicate, true);

      const records = service.db.all('SELECT * FROM trips WHERE idempotency_key = ?;', idempKey);
      assert.strictEqual(records.length, 1, 'Chỉ được có đúng 1 bản ghi trong database');
    });

    // 5. FT-08 & State Machine: Vòng đời chuyển trạng thái
    await test('FT-08: Vòng đời chuyến xe (DRIVER_ASSIGNED -> ACCEPTED -> IN_PROGRESS -> COMPLETED)', async () => {
      // 5.1. Giả lập Matching Service gán tài xế driver_d01
      service.db.run(
        "UPDATE trips SET status = 'DRIVER_ASSIGNED', driver_id = 'driver_d01' WHERE id = ?;",
        createdTripId
      );

      // 5.2. Tài xế nhận cuốc (POST /trips/:id/accept)
      const resAccept = await makeRequest({
        method: 'POST',
        path: `/trips/${createdTripId}/accept`,
        headers: { Authorization: `Bearer ${driverTokenD01}` },
      });
      assert.strictEqual(resAccept.status, 200);
      assert.strictEqual(resAccept.body.data.status, 'ACCEPTED');

      // 5.3. Bắt đầu chuyến đi (POST /trips/:id/start)
      const resStart = await makeRequest({
        method: 'POST',
        path: `/trips/${createdTripId}/start`,
        headers: { Authorization: `Bearer ${driverTokenD01}` },
      });
      assert.strictEqual(resStart.status, 200);
      assert.strictEqual(resStart.body.data.status, 'IN_PROGRESS');

      // 5.4. Hoàn thành chuyến đi (POST /trips/:id/complete)
      const resComplete = await makeRequest({
        method: 'POST',
        path: `/trips/${createdTripId}/complete`,
        headers: { Authorization: `Bearer ${driverTokenD01}` },
      });
      assert.strictEqual(resComplete.status, 200);
      assert.strictEqual(resComplete.body.data.status, 'COMPLETED');

      // Kiểm tra Outbox event trip.event.completed
      const completeEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.completed';",
        createdTripId
      );
      assert(completeEvt, 'Sự kiện trip.event.completed phải nằm trong Outbox');
    });

    // 6. Chặn chuyển đổi trạng thái không hợp lệ
    await test('Không thể huỷ chuyến xe khi đã COMPLETED (HTTP 400)', async () => {
      const resCancel = await makeRequest({
        method: 'POST',
        path: `/trips/${createdTripId}/cancel`,
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: { reason: 'Muốn huỷ sau khi đã xong' },
      });
      assert.strictEqual(resCancel.status, 400);
      assert.strictEqual(resCancel.body.error.code, 'CANNOT_CANCEL');
    });

    // 7. Flush Outbox Events
    await test('Outbox Worker quét và phát tán thành công các sự kiện PENDING', async () => {
      const flushedCount = await service.outboxManager.flushPending();
      assert(flushedCount >= 2, `Phải flush được ít nhất 2 sự kiện (thực tế: ${flushedCount})`);

      // Kiểm tra trạng thái đã chuyển thành PUBLISHED
      const pendingEvents = service.db.all("SELECT * FROM outbox_events WHERE status = 'PENDING';");
      assert.strictEqual(pendingEvents.length, 0, 'Toàn bộ sự kiện phải chuyển sang PUBLISHED');
    });

    // 8. Section 6.1: Xác thực chủ sở hữu và RBAC (Identity & Authorization)
    await test('Section 6.1: Tài xế (DRIVER) không được phép tạo cuốc xe (HTTP 403)', async () => {
      const driverToken = signToken({ userId: 'driver_test_99', role: 'DRIVER' });
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${driverToken}` },
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'Diem Don',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.82,
          dropoff_address: 'Diem Den',
        },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    });

    await test('Section 6.1: Passenger B không thể xem cuốc xe của Passenger A (HTTP 403)', async () => {
      const tokenA = signToken({ userId: 'passenger_A', role: 'PASSENGER' });
      const tokenB = signToken({ userId: 'passenger_B', role: 'PASSENGER' });

      // Passenger A tạo chuyến
      const resA = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'Nha A',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.82,
          dropoff_address: 'Cong Ty A',
        },
      });
      assert.strictEqual(resA.status, 201);
      const tripIdA = resA.body.data.id;

      // Passenger B cố tình đọc chuyến của A
      const resB = await makeRequest({
        method: 'GET',
        path: `/trips/${tripIdA}`,
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.strictEqual(resB.status, 403);
      assert.strictEqual(resB.body.error.code, 'FORBIDDEN');

      // Passenger A đọc chuyến của mình -> thành công 200
      const resA_Read = await makeRequest({
        method: 'GET',
        path: `/trips/${tripIdA}`,
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(resA_Read.status, 200);
      assert.strictEqual(resA_Read.body.data.passenger_id, 'passenger_A');
    });

    await test('Section 6.1: Driver Y không được phép nhận chuyến xe đã gán cho Driver X (HTTP 403)', async () => {
      // Giả lập chuyến đã gán driver_X
      const tripAssigned = service.db.get("SELECT id FROM trips WHERE status = 'REQUESTED' LIMIT 1;");
      service.db.run(
        "UPDATE trips SET status = 'DRIVER_ASSIGNED', driver_id = 'driver_X' WHERE id = ?;",
        tripAssigned.id
      );

      const tokenDriverY = signToken({ userId: 'driver_Y', role: 'DRIVER' });
      const resY = await makeRequest({
        method: 'POST',
        path: `/trips/${tripAssigned.id}/accept`,
        headers: { Authorization: `Bearer ${tokenDriverY}` },
      });
      assert.strictEqual(resY.status, 403);
      assert.strictEqual(resY.body.error.code, 'FORBIDDEN');
    });

    // 9. Section 6.3: Cùng Idempotency-Key nhưng khác payload bị chặn (HTTP 409) & Cách ly theo từng Passenger
    await test('Section 6.3: Cùng Idempotency-Key khác payload -> HTTP 409, và khác Passenger được cách ly độc lập', async () => {
      const conflictKey = 'idemp_key_conflict_999';
      const tokenPA = signToken({ userId: 'passenger_scope_A', role: 'PASSENGER' });
      const tokenPB = signToken({ userId: 'passenger_scope_B', role: 'PASSENGER' });
      const payloadA = {
        pickup_latitude: 21.02,
        pickup_longitude: 105.85,
        pickup_address: 'Dia Chi A',
        dropoff_latitude: 21.05,
        dropoff_longitude: 105.82,
        dropoff_address: 'Dia Chi Den',
      };
      const payloadB = {
        pickup_latitude: 21.02,
        pickup_longitude: 105.85,
        pickup_address: 'Dia Chi B KHAC HOAN TOAN',
        dropoff_latitude: 21.08,
        dropoff_longitude: 105.89,
        dropoff_address: 'Dia Chi Den Khac',
      };

      const res1 = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { 'idempotency-key': conflictKey, Authorization: `Bearer ${tokenPA}` },
        body: payloadA,
      });
      assert.strictEqual(res1.status, 201);

      // Cùng Passenger A dùng lại key nhưng đổi payload -> 409 Conflict
      const res2 = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { 'idempotency-key': conflictKey, Authorization: `Bearer ${tokenPA}` },
        body: payloadB,
      });
      assert.strictEqual(res2.status, 409);
      assert.strictEqual(res2.body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

      // Passenger B dùng cùng chuỗi key -> Được tạo cuốc độc lập (không rò rỉ dữ liệu của Passenger A)
      const resOtherUser = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { 'idempotency-key': conflictKey, Authorization: `Bearer ${tokenPB}` },
        body: payloadA,
      });
      assert.strictEqual(resOtherUser.status, 201);
      assert.notStrictEqual(resOtherUser.body.data.id, res1.body.data.id, 'Hai hành khách khác nhau phải tạo 2 cuốc tách biệt');
    });

    // 10. ST-01 & Bảo mật: Bắt buộc xác thực JWT (chặn anonymous 401), chống vượt quyền chéo role/ownership
    await test('ST-01 Security: Truy cập /trips không có JWT bị chặn HTTP 401, chặn Passenger/Driver lạ vượt quyền 403', async () => {
      // 10.1. Gọi không token -> 401 UNAUTHORIZED
      const resNoAuthCreate = await makeRequest({
        method: 'POST',
        path: '/trips',
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'A',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.82,
          dropoff_address: 'B',
          passenger_id: 'spoofed',
        },
      });
      assert.strictEqual(resNoAuthCreate.status, 401);
      assert.strictEqual(resNoAuthCreate.body.error.code, 'UNAUTHORIZED');

      const tripTarget = service.db.get("SELECT id, passenger_id FROM trips WHERE status = 'REQUESTED' LIMIT 1;");
      const resNoAuthGet = await makeRequest({ method: 'GET', path: `/trips/${tripTarget.id}` });
      assert.strictEqual(resNoAuthGet.status, 401);

      // 10.2. Tài xế chưa được gán không thể xem hoặc huỷ chuyến của người khác -> 403 FORBIDDEN
      const tokenRandomDriver = signToken({ userId: 'driver_stranger', role: 'DRIVER' });
      const resDriverGet = await makeRequest({
        method: 'GET',
        path: `/trips/${tripTarget.id}`,
        headers: { Authorization: `Bearer ${tokenRandomDriver}` },
      });
      assert.strictEqual(resDriverGet.status, 403);

      const resDriverCancel = await makeRequest({
        method: 'POST',
        path: `/trips/${tripTarget.id}/cancel`,
        headers: { Authorization: `Bearer ${tokenRandomDriver}` },
      });
      assert.strictEqual(resDriverCancel.status, 403);

      // 10.3. Hành khách không được phép gọi /start hoặc /complete -> 403 FORBIDDEN
      const ownerToken = signToken({ userId: tripTarget.passenger_id, role: 'PASSENGER' });
      const resPassengerStart = await makeRequest({
        method: 'POST',
        path: `/trips/${tripTarget.id}/start`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(resPassengerStart.status, 403);
      assert.strictEqual(resPassengerStart.body.error.code, 'FORBIDDEN');
    });

    // 11. Webhook /internal/events yêu cầu X-Internal-Key và event_id
    await test('Section 5.5: Webhook /internal/events chặn thiếu/sai X-Internal-Key (401) và thiếu event_id (400)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        body: { event_type: 'trip.event.created', payload: {} },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'UNAUTHORIZED_INTERNAL');

      const resNoEvtId = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: { 'x-internal-key': 'dev-internal-service-key-ds03' },
        body: { event_type: 'trip.event.driver_matched', payload: { trip_id: 'x', driver_id: 'y' } },
      });
      assert.strictEqual(resNoEvtId.status, 400);
      assert.strictEqual(resNoEvtId.body.error.code, 'INVALID_EVENT');
    });

    // 12. Hạng mục P0: Kiểm tra Outbox HTTP Publisher qua TCP Socket thật & Mock HTTP Test Server
    await test('Outbox HTTP Adapter: Mất kết nối TCP thật (ECONNREFUSED) -> Giữ PENDING, tăng retry_count', async () => {
      // Lấy một cổng TCP rảnh rồi đóng ngay lập tức để bảo đảm ECONNREFUSED qua socket thật
      const closedPort = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
        probe.on('error', reject);
      });

      const evt = service.outboxManager.insertEvent({
        aggregateType: 'TRIP',
        aggregateId: 'test_trip_outbox_real_tcp',
        eventType: 'trip.event.created',
        payload: { trip_id: 'test_trip_outbox_real_tcp', fare: 30000 },
        correlationId: 'corr_real_tcp_001',
      });

      const realUnreachablePublisher = createHttpPublisher(`http://127.0.0.1:${closedPort}`);
      const flushed = await service.outboxManager.flushPending(realUnreachablePublisher);
      assert.strictEqual(flushed, 0, 'Không được đếm là đã publish khi kết nối TCP bị từ chối');

      const savedEvt = service.db.get('SELECT * FROM outbox_events WHERE id = ?;', evt.eventId);
      assert.strictEqual(savedEvt.status, 'PENDING', 'Sự kiện phải giữ nguyên PENDING khi broker TCP không kết nối được');
      assert.strictEqual(savedEvt.retry_count, 1, 'retry_count phải tăng lên 1');
      assert.strictEqual(savedEvt.published_at, null, 'published_at phải là null');
    });

    await test('Outbox HTTP Adapter: HTTP 503 từ chối ACK -> Retry giữ PENDING; HTTP 200 ACK -> Chuyển PUBLISHED (Real Local HTTP Server)', async () => {
      let respondStatus = 503;
      const capturedRequests = [];

      const mockHttpBroker = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        capturedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        res.writeHead(respondStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: respondStatus < 300 }));
      });

      await new Promise((resolve) => mockHttpBroker.listen(0, '127.0.0.1', resolve));
      const { port: mockPort } = mockHttpBroker.address();

      try {
        const realHttpPublisher = createHttpPublisher(`http://127.0.0.1:${mockPort}`);

        // Pha 1: Local HTTP Broker Test Server trả về 503 -> KHÔNG được đánh dấu PUBLISHED
        await service.outboxManager.flushPending(realHttpPublisher);
        const evtAfter503 = service.db.get("SELECT * FROM outbox_events WHERE aggregate_id = 'test_trip_outbox_real_tcp';");
        assert.strictEqual(evtAfter503.status, 'PENDING', 'Broker trả 503 thì sự kiện vẫn phải ở trạng thái PENDING');
        assert.strictEqual(evtAfter503.retry_count, 2, 'retry_count phải tăng lên 2');

        // Pha 2: Broker phục hồi trả 200 OK -> Phải chuyển sang PUBLISHED và xác minh đúng Contract Envelope
        respondStatus = 200;
        const count = await service.outboxManager.flushPending(realHttpPublisher);
        assert(count >= 1, 'Phải publish thành công qua HTTP POST thật');

        const publishedEvt = service.db.get("SELECT * FROM outbox_events WHERE aggregate_id = 'test_trip_outbox_real_tcp';");
        assert.strictEqual(publishedEvt.status, 'PUBLISHED');
        assert(publishedEvt.published_at !== null);

        const ackedReq = capturedRequests.find(
          (r) => r.body && r.body.payload && r.body.payload.trip_id === 'test_trip_outbox_real_tcp' && capturedRequests.indexOf(r) > 0
        );
        assert(ackedReq, 'Test HTTP Broker Server phải nhận được HTTP POST thật');
        assert.strictEqual(ackedReq.method, 'POST');
        assert.strictEqual(ackedReq.url, '/events');
        assert.strictEqual(ackedReq.headers['x-internal-key'], 'dev-internal-service-key-ds03');
        assert.strictEqual(ackedReq.headers['x-correlation-id'], 'corr_real_tcp_001');
        assert.strictEqual(ackedReq.body.event_type, 'trip.event.created');
        assert.strictEqual(ackedReq.body.source_service, 'trip-service');
      } finally {
        await new Promise((resolve) => mockHttpBroker.close(resolve));
      }
    });

    // 13. Hạng mục P1: Kiểm tra State Machine - Chặn chuyển trạng thái bất hợp lệ
    await test('State Machine: Chặn nhảy trạng thái trái phép từ REQUESTED sang IN_PROGRESS (HTTP 400)', async () => {
      const resCreate = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'Diem Don',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.82,
          dropoff_address: 'Diem Den',
        },
      });
      assert.strictEqual(resCreate.body.data.status, 'REQUESTED', 'Trạng thái khởi tạo bắt buộc phải là REQUESTED');
      const tripId = resCreate.body.data.id;

      // Gán tài xế driver_d01 nhưng giữ nguyên status = REQUESTED (chưa ACCEPTED)
      service.db.run("UPDATE trips SET driver_id = 'driver_d01' WHERE id = ?;", tripId);

      // Tài xế cố tình gọi /start khi chưa chuyển qua DRIVER_ASSIGNED -> ACCEPTED
      const resStart = await makeRequest({
        method: 'POST',
        path: `/trips/${tripId}/start`,
        headers: { Authorization: `Bearer ${driverTokenD01}` },
      });
      assert.strictEqual(resStart.status, 400);
      assert.strictEqual(resStart.body.error.code, 'INVALID_STATE_TRANSITION');
    });

    await test('Saga Bù trừ: Huỷ chuyến khi đã CONFIRMED -> Sinh cả release_driver lẫn payment.event.refund_requested', async () => {
      const resCreate = await makeRequest({
        method: 'POST',
        path: '/trips',
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'Diem A',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.82,
          dropoff_address: 'Diem B',
        },
      });
      const confirmedTripId = resCreate.body.data.id;

      // Cập nhật trạng thái thành CONFIRMED đã gán tài xế
      service.db.run(
        "UPDATE trips SET status = 'CONFIRMED', driver_id = 'driver_d88' WHERE id = ?;",
        confirmedTripId
      );

      // Khách huỷ chuyến khi đã CONFIRMED
      const resCancel = await makeRequest({
        method: 'POST',
        path: `/trips/${confirmedTripId}/cancel`,
        headers: { Authorization: `Bearer ${passengerToken1}` },
        body: { reason: 'Khách đổi kế hoạch' },
      });
      assert.strictEqual(resCancel.status, 200);

      // Kiểm tra Outbox phải có CẢ 2 sự kiện: giải phóng tài xế VÀ hoàn tiền tạm giữ
      const releaseDriver = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.release_driver';",
        confirmedTripId
      );
      const refundPayment = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'payment.event.refund_requested';",
        confirmedTripId
      );
      const sagaAfterCancel = service.sagaCoordinator.getSagaStatus(confirmedTripId);

      assert(releaseDriver, 'Phải có sự kiện bù trừ release_driver');
      assert(refundPayment, 'Phải có sự kiện bù trừ payment.event.refund_requested');
      assert.strictEqual(JSON.parse(releaseDriver.payload).driver_id, 'driver_d88');
      assert(JSON.parse(refundPayment.payload).amount > 0);
      assert.strictEqual(sagaAfterCancel.status, 'COMPENSATED', 'Saga phải đồng bộ sang COMPENSATED khi huỷ chuyến đã giữ tài xế/tiền');
    });

    // 14. Boundary Tests: Toạ độ đường xích đạo lat=0, JWT now>=exp tại Trip Service và Fail-Fast Production
    await test('Boundary & Fail-Fast: Tính đúng Haversine tại lat=0, chặn JWT tại now===exp và Production Fail-Fast', () => {
      // 14.1. Toạ độ xích đạo lat = 0 không bị lỗi coercion falsy `0 || ...`
      const eqDist = haversineDistanceKm({ lat: 0, lon: 105.0 }, { lat: 0, lon: 105.1 });
      assert(eqDist > 10 && eqDist < 12, `Khoảng cách dọc xích đạo 0.1 độ kinh tuyến phải ~11.12km (thực tế: ${eqDist})`);

      // 14.2. Trip Service JWT boundary now === exp
      const tokenExp0 = signToken({ userId: 'u_bound', role: 'PASSENGER' }, 0);
      const expClaim = JSON.parse(Buffer.from(tokenExp0.split('.')[1], 'base64url').toString('utf8')).exp;
      assert(verifyTripToken(tokenExp0, expClaim - 1) !== null);
      assert.strictEqual(verifyTripToken(tokenExp0, expClaim), null, 'Trip auth phải từ chối tại đúng mốc now === exp');

      // 14.3. Production Fail-Fast trong trip-service/config.js
      const configPath = path.resolve(__dirname, '../src/trip-service/config.js').replace(/\\/g, '/');
      const runFail = spawnSync(process.execPath, ['-e', `require('${configPath}')`], {
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'dev-jwt-secret-key-ds03-2026', INTERNAL_KEY: 'custom-strong-internal-key-999' },
        encoding: 'utf8',
      });
      assert.notStrictEqual(runFail.status, 0, 'Trip Service phải fail-fast khi NODE_ENV=production mà dùng JWT_SECRET mặc định');
    });

  } finally {
    await service.stop();
    cleanTestDb();
  }

  console.log(`\n🎉 KẾT QUẢ: ${passed}/${total} TESTS PASSED CHO TRIP / BOOKING SERVICE!`);
  return { passed, total };
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
