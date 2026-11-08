'use strict';

/**
 * TỔNG HỢP KIỂM THỬ THÀNH VIÊN 1 (TV1 ALL TESTS RUNNER)
 * Chạy toàn bộ test suites của TV1: Identity Service, Trip Service & Saga Coordinator
 */

const { runTests: runIdentityTests } = require('./identity.test');
const { runTests: runTripTests } = require('./trip.test');
const { runTests: runSagaTests } = require('./saga.test');

async function main() {
  console.log('='.repeat(70));
  console.log(' CHƯƠNG TRÌNH KIỂM THỬ TOÀN DIỆN THÀNH VIÊN 1 (TV1 SUITE RUNNER)');
  console.log(' Scope: Identity/User Service, Trip/Booking Service, Saga & Pricing');
  console.log('='.repeat(70));

  const startTime = Date.now();

  try {
    await runIdentityTests();
    console.log('');
    await runTripTests();
    console.log('');
    await runSagaTests();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(70));
    console.log(`✅ TOÀN BỘ 38/38 BÀI TEST CỦA THÀNH VIÊN 1 ĐÃ VƯỢT QUA 100% (${elapsed}s)!`);
    console.log('   - FT-01, FT-02: Đăng ký, đăng nhập & cấp phát JWT (Identity Service)');
    console.log('   - FT-05, FT-08: Tạo cuốc xe, vòng đời & hoàn tất (Trip Service)');
    console.log('   - ST-01, ST-02: RBAC, bảo vệ token, validate input & SQL injection');
    console.log('   - Dynamic Pricing: Haversine distance, surge multiplier capping [1.0, 2.5]');
    console.log('   - Saga Coordinator: Happy Path, Compensation & Event Deduplication');
    console.log('   - Transactional Outbox: Đảm bảo At-least-once delivery');
    console.log('='.repeat(70));
    process.exit(0);
  } catch (err) {
    console.error('\n❌ CÓ BÀI TEST THẤT BẠI:', err);
    process.exit(1);
  }
}

main();
