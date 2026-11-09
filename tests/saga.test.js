'use strict';

/**
 * TEST SUITE: SAGA TRANSACTION COORDINATOR & COMPENSATION (TV1)
 * Bao gồm: Saga Happy Path, Payment Hold Failed & Compensating Action,
 * Matching Failed, Idempotent Event Deduplication, và Service Restart Recovery
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createTripService } = require('../src/trip-service');
const { SAGA_STATUS } = require('../src/trip-service/saga-coordinator');

const TEST_PORT = 8904;
const TEST_DB = path.join(__dirname, '..', 'data', 'test_saga_db.sqlite');
const { INTERNAL_KEY } = require('../src/trip-service/config');
const INTERNAL_HEADERS = { 'x-internal-key': INTERNAL_KEY };

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
  console.log(' [TEST SUITE 3] SAGA TRANSACTION COORDINATOR & COMPENSATION (TV1)');
  console.log('='.repeat(65));

  cleanTestDb();

  let service = createTripService({ port: TEST_PORT, dbPath: TEST_DB });
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
    // -------------------------------------------------------------
    // KỊCH BẢN 1: SAGA HAPPY PATH
    // -------------------------------------------------------------
    let happyTripId = null;
    await test('Saga 1.1: Tạo chuyến xe -> Saga khởi động với trạng thái STARTED', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        body: {
          pickup_latitude: 21.0285,
          pickup_longitude: 105.8544,
          pickup_address: 'Bo Ho Hoan Kiem',
          dropoff_latitude: 21.0358,
          dropoff_longitude: 105.8412,
          dropoff_address: 'Cau Giay Ha Noi',
        },
      });
      assert.strictEqual(res.status, 201);
      happyTripId = res.body.data.id;

      const saga = service.sagaCoordinator.getSagaStatus(happyTripId);
      assert(saga, 'Saga instance phải tồn tại');
      assert.strictEqual(saga.status, SAGA_STATUS.STARTED);
      assert.strictEqual(saga.current_step, 'MATCHING');
    });

    await test('Saga 1.2: Nhận event trip.event.driver_matched -> Trip chuyển DRIVER_ASSIGNED, Saga chuyển HOLDING_PAYMENT', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_matched_001',
          event_type: 'trip.event.driver_matched',
          correlation_id: 'corr_test_001',
          payload: {
            trip_id: happyTripId,
            driver_id: 'driver_vip_01',
            estimated_fare: 45000,
          },
        },
      });
      assert.strictEqual(res.status, 200);

      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', happyTripId);
      assert.strictEqual(trip.status, 'DRIVER_ASSIGNED');
      assert.strictEqual(trip.driver_id, 'driver_vip_01');

      const saga = service.sagaCoordinator.getSagaStatus(happyTripId);
      assert.strictEqual(saga.status, SAGA_STATUS.HOLDING_PAYMENT);

      // Kiểm tra Outbox event payment.event.hold_requested đã được sinh ra
      const holdEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'payment.event.hold_requested';",
        happyTripId
      );
      assert(holdEvt, 'Outbox phải chứa payment.event.hold_requested');
    });

    await test('Saga 1.3: Nhận event payment.event.hold_success -> Trip chuyển CONFIRMED, Saga chuyển CONFIRMED (Happy path hoàn tất)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_hold_success_001',
          event_type: 'payment.event.hold_success',
          correlation_id: 'corr_test_001',
          payload: {
            trip_id: happyTripId,
          },
        },
      });
      assert.strictEqual(res.status, 200);

      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', happyTripId);
      assert.strictEqual(trip.status, 'CONFIRMED');

      const saga = service.sagaCoordinator.getSagaStatus(happyTripId);
      assert.strictEqual(saga.status, SAGA_STATUS.CONFIRMED);
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 2: SAGA BÙ TRỪ KHI LỖI THANH TOÁN (COMPENSATION PATH)
    // -------------------------------------------------------------
    let failedTripId = null;
    await test('Saga 2.1: Tạo chuyến xe thứ 2 chuẩn bị cho kịch bản bù trừ', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/trips',
        body: {
          pickup_latitude: 21.01,
          pickup_longitude: 105.80,
          pickup_address: 'Thanh Xuan',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.78,
          dropoff_address: 'Nam Tu Liem',
        },
      });
      assert.strictEqual(res.status, 201);
      failedTripId = res.body.data.id;

      // Ghép tài xế driver_d02
      await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_matched_002',
          event_type: 'trip.event.driver_matched',
          payload: {
            trip_id: failedTripId,
            driver_id: 'driver_d02',
            estimated_fare: 50000,
          },
        },
      });
    });

    await test('Saga 2.2: Payment hold thất bại -> Kích hoạt Bù trừ (Huỷ chuyến & Phát trip.event.release_driver)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_hold_failed_002',
          event_type: 'payment.event.hold_failed',
          correlation_id: 'corr_compensation_002',
          payload: {
            trip_id: failedTripId,
            driver_id: 'driver_d02',
            reason: 'INSUFFICIENT_FUNDS',
          },
        },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.action, 'COMPENSATED');
      assert.strictEqual(res.body.data.releasedDriverId, 'driver_d02');

      // 1. Kiểm tra trạng thái chuyến đi: CANCELLED
      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', failedTripId);
      assert.strictEqual(trip.status, 'CANCELLED');
      assert(trip.cancellation_reason.includes('PAYMENT_HOLD_FAILED'));

      // 2. Kiểm tra trạng thái Saga: COMPENSATED
      const saga = service.sagaCoordinator.getSagaStatus(failedTripId);
      assert.strictEqual(saga.status, SAGA_STATUS.COMPENSATED);

      // 3. Kiểm tra PHÁT LỆNH BÙ TRỪ: Outbox event trip.event.release_driver
      const releaseEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.release_driver';",
        failedTripId
      );
      assert(releaseEvt, 'Phải có sự kiện bù trừ trip.event.release_driver trong Outbox');
      const payload = JSON.parse(releaseEvt.payload);
      assert.strictEqual(payload.driver_id, 'driver_d02', 'Lệnh bù trừ phải giải phóng đúng tài xế d02');
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 3: SAGA MATCHING FAILED (KHÔNG TÌM THẤY TÀI XẾ)
    // -------------------------------------------------------------
    await test('Saga 3: Matching failed -> Chuyến đi huỷ với NO_DRIVER_AVAILABLE và Saga chuyển FAILED', async () => {
      const resCreate = await makeRequest({
        method: 'POST',
        path: '/trips',
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'No Driver Zone',
          dropoff_latitude: 21.04,
          dropoff_longitude: 105.81,
          dropoff_address: 'Destination',
        },
      });
      const noDriverTripId = resCreate.body.data.id;

      const resFail = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_no_driver_003',
          event_type: 'trip.event.matching_failed',
          payload: {
            trip_id: noDriverTripId,
            reason: 'Hết tài xế khả dụng trong bán kính 5km',
          },
        },
      });
      assert.strictEqual(resFail.status, 200);

      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', noDriverTripId);
      assert.strictEqual(trip.status, 'CANCELLED');
      assert(trip.cancellation_reason.includes('NO_DRIVER_AVAILABLE'));

      const saga = service.sagaCoordinator.getSagaStatus(noDriverTripId);
      assert.strictEqual(saga.status, SAGA_STATUS.FAILED);
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 4: DEDUPLICATION & IDEMPOTENCY
    // -------------------------------------------------------------
    await test('Saga 4: Sự kiện lặp lại (Duplicate event) được phát hiện và bỏ qua an toàn', async () => {
      // Gửi lại event hold_failed cũ với cùng event_id
      const resDup = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_hold_failed_002', // Đã xử lý ở test 2.2
          event_type: 'payment.event.hold_failed',
          payload: { trip_id: failedTripId, driver_id: 'driver_d02' },
        },
      });
      assert.strictEqual(resDup.status, 200);
      assert.strictEqual(resDup.body.data.duplicate, true);
      assert.strictEqual(resDup.body.data.action, 'IGNORED');

      // Đảm bảo không bị nhân bản sự kiện bù trừ trong Outbox
      const releaseEvents = service.db.all(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.release_driver';",
        failedTripId
      );
      assert.strictEqual(releaseEvents.length, 1, 'Chỉ có duy nhất 1 sự kiện bù trừ được phát sinh');
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 5: SERVICE RESTART & RESILIENCE (PHỤC HỒI KHI KHỞI ĐỘNG LẠI)
    // -------------------------------------------------------------
    await test('Saga 5: Tắt service và khởi động lại -> Dữ liệu Saga và Outbox được phục hồi hoàn chỉnh', async () => {
      // Dừng service hiện tại
      await service.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Khởi động lại service trỏ vào cùng cơ sở dữ liệu
      service = createTripService({ port: TEST_PORT, dbPath: TEST_DB });
      await service.start();
      await new Promise((r) => setTimeout(r, 50));

      // Kiểm tra Saga của chuyến xe thành công
      const sagaHappy = service.sagaCoordinator.getSagaStatus(happyTripId);
      assert(sagaHappy, 'Saga happy path phải được khôi phục nguyên vẹn');
      assert.strictEqual(sagaHappy.status, SAGA_STATUS.CONFIRMED);

      // Kiểm tra Saga của chuyến xe bù trừ
      const sagaCompensated = service.sagaCoordinator.getSagaStatus(failedTripId);
      assert(sagaCompensated, 'Saga bù trừ phải được khôi phục nguyên vẹn');
      assert.strictEqual(sagaCompensated.status, SAGA_STATUS.COMPENSATED);

      // Kiểm tra bảng processed_events vẫn ghi nhớ các event ID đã xử lý
      assert.strictEqual(service.sagaCoordinator.isEventProcessed('evt_hold_failed_002'), true);
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 6: OUT-OF-ORDER & STALE EVENT PROTECTION
    // -------------------------------------------------------------
    await test('Saga 6: Stale driver_matched đến sau khi chuyến xe đã CANCELLED -> Chuyến giữ nguyên CANCELLED và lập tức phát release_driver', async () => {
      // Tạo chuyến xe mới
      const resCreate = await makeRequest({
        method: 'POST',
        path: '/trips',
        body: {
          pickup_latitude: 21.02,
          pickup_longitude: 105.85,
          pickup_address: 'Point A',
          dropoff_latitude: 21.04,
          dropoff_longitude: 105.81,
          dropoff_address: 'Point B',
        },
      });
      const staleTripId = resCreate.body.data.id;

      // Khách huỷ chuyến khi đang ở trạng thái PENDING
      const resCancel = await makeRequest({
        method: 'POST',
        path: `/trips/${staleTripId}/cancel`,
        body: { reason: 'Khách đổi ý muốn đi bộ' },
      });
      assert.strictEqual(resCancel.status, 200);

      // Matching service muộn màng gửi event driver_matched
      const resLateMatch = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_late_match_006',
          event_type: 'trip.event.driver_matched',
          payload: {
            trip_id: staleTripId,
            driver_id: 'driver_late_999',
            estimated_fare: 42000,
          },
        },
      });
      assert.strictEqual(resLateMatch.status, 200);
      assert.strictEqual(resLateMatch.body.data.action, 'STALE_EVENT_DRIVER_RELEASED');

      // Chuyến xe vẫn giữ nguyên CANCELLED, không bị chuyển thành DRIVER_ASSIGNED
      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', staleTripId);
      assert.strictEqual(trip.status, 'CANCELLED');

      // Outbox bắt buộc phải có lệnh bù trừ giải phóng tài xế muộn
      const releaseEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.release_driver';",
        staleTripId
      );
      assert(releaseEvt, 'Phải có event trip.event.release_driver trong Outbox để giải phóng tài xế');
      const payload = JSON.parse(releaseEvt.payload);
      assert.strictEqual(payload.driver_id, 'driver_late_999');
    });

    await test('Saga 7: Stale payment.event.hold_success đến sau khi chuyến đã CANCELLED -> Kích hoạt bù trừ giải phóng tiền (payment.event.refund_requested)', async () => {
      // failedTripId đã bị CANCELLED ở Kịch bản 2
      const resLateHold = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_late_hold_success_007',
          event_type: 'payment.event.hold_success',
          payload: {
            trip_id: failedTripId,
          },
        },
      });
      assert.strictEqual(resLateHold.status, 200);
      assert.strictEqual(resLateHold.body.data.action, 'STALE_EVENT_COMPENSATED_PAYMENT_RELEASED');

      // 1. Chuyến xe vẫn giữ nguyên trạng thái CANCELLED, tuyệt đối không bị ghi đè CONFIRMED
      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', failedTripId);
      assert.strictEqual(trip.status, 'CANCELLED');

      // 2. Saga instance chuyển sang COMPENSATED với bước giải phóng tiền
      const saga = service.sagaCoordinator.getSagaStatus(failedTripId);
      assert.strictEqual(saga.status, SAGA_STATUS.COMPENSATED);
      assert.strictEqual(saga.current_step, 'COMPENSATION_RELEASE_PAYMENT');

      // 3. Outbox bắt buộc phải sinh ra sự kiện payment.event.refund_requested để giải phóng tiền đã giữ
      const refundEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'payment.event.refund_requested';",
        failedTripId
      );
      assert(refundEvt, 'Outbox phải chứa sự kiện bù trừ payment.event.refund_requested');
      const refundPayload = JSON.parse(refundEvt.payload);
      assert.strictEqual(refundPayload.trip_id, failedTripId);
      assert(refundPayload.amount > 0, 'Số tiền hoàn lại phải > 0');
    });

    await test('Saga 7.1: Duplicate stale hold_success -> Phát hiện trùng lặp và không nhân bản lệnh giải phóng tiền', async () => {
      const resDupHold = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_late_hold_success_007', // Gửi lại đúng event_id đã xử lý ở test 7
          event_type: 'payment.event.hold_success',
          payload: {
            trip_id: failedTripId,
          },
        },
      });
      assert.strictEqual(resDupHold.status, 200);
      assert.strictEqual(resDupHold.body.data.duplicate, true);
      assert.strictEqual(resDupHold.body.data.action, 'IGNORED');

      // Đảm bảo không nhân bản thêm sự kiện refund trong Outbox
      const refundEvents = service.db.all(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'payment.event.refund_requested';",
        failedTripId
      );
      assert.strictEqual(refundEvents.length, 1, 'Chỉ được phép có đúng 1 sự kiện bù trừ refund trong Outbox');
    });

    await test('Saga 7.2: Race condition cả driver_matched lẫn hold_success đều đến muộn -> Giải phóng cả tài xế lẫn tiền cước', async () => {
      // Tạo chuyến xe mới rồi khách lập tức huỷ khi đang REQUESTED
      const resCreate = await makeRequest({
        method: 'POST',
        path: '/trips',
        body: {
          pickup_latitude: 21.03,
          pickup_longitude: 105.84,
          pickup_address: 'Doi Can',
          dropoff_latitude: 21.05,
          dropoff_longitude: 105.80,
          dropoff_address: 'Xuan Thuy',
        },
      });
      const raceTripId = resCreate.body.data.id;

      // Khách huỷ chuyến
      await makeRequest({
        method: 'POST',
        path: `/trips/${raceTripId}/cancel`,
        body: { reason: 'Khách không muốn đi nữa' },
      });

      // 1. driver_matched đến muộn
      await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_race_match_001',
          event_type: 'trip.event.driver_matched',
          payload: { trip_id: raceTripId, driver_id: 'driver_race_01', estimated_fare: 45000 },
        },
      });

      // 2. hold_success cũng đến muộn
      await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: INTERNAL_HEADERS,
        body: {
          event_id: 'evt_race_hold_001',
          event_type: 'payment.event.hold_success',
          payload: { trip_id: raceTripId },
        },
      });

      // Kiểm tra: chuyến xe vẫn là CANCELLED
      const trip = service.db.get('SELECT * FROM trips WHERE id = ?;', raceTripId);
      assert.strictEqual(trip.status, 'CANCELLED');

      // Kiểm tra Outbox: CẢ 2 sự kiện bù trừ đều được phát sinh
      const releaseDriver = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'trip.event.release_driver';",
        raceTripId
      );
      const releasePayment = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'payment.event.refund_requested';",
        raceTripId
      );

      assert(releaseDriver, 'Phải có sự kiện bù trừ giải phóng tài xế');
      assert(releasePayment, 'Phải có sự kiện bù trừ hoàn tiền');
      assert.strictEqual(JSON.parse(releaseDriver.payload).driver_id, 'driver_race_01');
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 8: BẢO MẬT INTERNAL ENDPOINT VỚI X-INTERNAL-KEY
    // -------------------------------------------------------------
    await test('Saga 8: Endpoint /internal/events từ chối truy cập nếu thiếu hoặc sai x-internal-key (HTTP 401)', async () => {
      // 8.1. Không có x-internal-key
      const resNoKey = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        body: {
          event_id: 'evt_unauth_001',
          event_type: 'trip.event.driver_matched',
          payload: { trip_id: happyTripId, driver_id: 'driver_hacker' },
        },
      });
      assert.strictEqual(resNoKey.status, 401);
      assert.strictEqual(resNoKey.body.error.code, 'UNAUTHORIZED_INTERNAL');

      // 8.2. Có key nhưng sai
      const resWrongKey = await makeRequest({
        method: 'POST',
        path: '/internal/events',
        headers: { 'x-internal-key': 'attacker-fake-key' },
        body: {
          event_id: 'evt_unauth_002',
          event_type: 'trip.event.driver_matched',
          payload: { trip_id: happyTripId, driver_id: 'driver_hacker' },
        },
      });
      assert.strictEqual(resWrongKey.status, 401);
      assert.strictEqual(resWrongKey.body.error.code, 'UNAUTHORIZED_INTERNAL');
    });

    // -------------------------------------------------------------
    // KỊCH BẢN 9: PHỤC HỒI COMPENSATION KHI CRASH / RESTART
    // -------------------------------------------------------------
    await test('Saga 9: Khởi động lại service sau khi ghi bù trừ refund vào Outbox -> Dữ liệu bù trừ được phục hồi nguyên vẹn từ SQLite', async () => {
      // Dừng tiến trình hiện tại
      await service.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Khởi động lại service trỏ vào cùng cơ sở dữ liệu
      service = createTripService({ port: TEST_PORT, dbPath: TEST_DB });
      await service.start();
      await new Promise((r) => setTimeout(r, 50));

      // Kiểm tra sự kiện refund trong Outbox vẫn tồn tại nguyên vẹn
      const refundEvt = service.db.get(
        "SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'payment.event.refund_requested';",
        failedTripId
      );
      assert(refundEvt, 'Sự kiện bù trừ payment.event.refund_requested phải còn nguyên trên đĩa SQLite');
      assert.strictEqual(refundEvt.status, 'PENDING');

      // Saga instance vẫn là COMPENSATED
      const saga = service.sagaCoordinator.getSagaStatus(failedTripId);
      assert.strictEqual(saga.status, SAGA_STATUS.COMPENSATED);
    });

  } finally {
    await service.stop();
    cleanTestDb();
  }

  console.log(`\n🎉 KẾT QUẢ: ${passed}/${total} TESTS PASSED CHO SAGA TRANSACTION COORDINATOR!`);
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
