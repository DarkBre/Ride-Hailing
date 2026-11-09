'use strict';

/**
 * TỔNG HỢP KIỂM THỬ THÀNH VIÊN 1 (TV1 ALL TESTS RUNNER)
 * Chạy toàn bộ test suites của TV1: Identity Service, Trip Service & Saga Coordinator
 */

process.env.JWT_SECRET ||= require('node:crypto').randomBytes(32).toString('hex');
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
    console.log(`✅ TOÀN BỘ SUITE CỦA THÀNH VIÊN 1 ĐÃ VƯỢT QUA (${elapsed}s)!`);
    console.log('   - Identity Tests (18/18): FT-01, FT-02, Persistent Token Blacklist, Fail-fast Secret, Race Condition');
    console.log('   - Trip Tests: FT-05, FT-08, ST-01 Ownership/RBAC, ST-02 Validation, Idempotency, Outbox Network Retry & Recovery, State Machine Transitions');
    console.log('   - Saga Tests (14/14): Happy Path, Payment Compensation, Stale Driver & Stale Hold Refund, Deduplication, Restart Recovery, Internal Key Security');
    console.log('   - Dynamic Pricing: Haversine distance, surge multiplier capping [1.0, 2.5]');
    console.log('   - Transactional Outbox: Đảm bảo At-least-once delivery & Publisher Acknowledgement');
    console.log('='.repeat(70));
    process.exit(0);
  } catch (err) {
    console.error('\n❌ CÓ BÀI TEST THẤT BẠI:', err);
    process.exit(1);
  }
}

main();
