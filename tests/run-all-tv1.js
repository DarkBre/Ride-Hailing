'use strict';

/**
 * TỔNG HỢP KIỂM THỬ THÀNH VIÊN 1 (TV1 ALL TESTS RUNNER)
 * Chạy toàn bộ test suites của TV1: Identity Service, Trip Service & Saga Coordinator
 */

const { runTests: runIdentityTests } = require('./identity.test');
const { runTests: runTripTests } = require('./trip.test');
const { runTests: runSagaTests } = require('./saga.test');
const { runTests: runIntegrationReadinessTests } = require('./tv1-integration-readiness.test');

async function main() {
  console.log('='.repeat(70));
  console.log(' CHƯƠNG TRÌNH KIỂM THỬ TOÀN DIỆN THÀNH VIÊN 1 (TV1 SUITE RUNNER)');
  console.log(' Scope: Identity/User Service, Trip/Booking Service, Saga & ADR-007 Readiness');
  console.log('='.repeat(70));

  const startTime = Date.now();

  try {
    const rId = await runIdentityTests();
    console.log('');
    const rTrip = await runTripTests();
    console.log('');
    const rSaga = await runSagaTests();
    console.log('');
    const rReady = await runIntegrationReadinessTests();

    const totalPassed = rId.passed + rTrip.passed + rSaga.passed + rReady.passed;
    const totalCount = rId.total + rTrip.total + rSaga.total + rReady.total;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(70));
    console.log(`✅ KẾT QUẢ PHẠM VI TV1: ${totalPassed}/${totalCount} BÀI TEST ĐÃ VƯỢT QUA (${elapsed}s)!`);
    console.log(`   - Identity Service Suite:     ${rId.passed}/${rId.total} (HTTP+SQLite + SHA-256 Persistent Blacklist + now>=exp + Fail-Fast)`);
    console.log(`   - Trip & Pricing Suite:       ${rTrip.passed}/${rTrip.total} (HTTP+SQLite + RBAC/Ownership + Scoped Idempotency + Real TCP Outbox HTTP Adapter + State Machine)`);
    console.log(`   - Saga & Atomicity Suite:     ${rSaga.passed}/${rSaga.total} (Compensation + Stale Hold/Driver Release + Rollback Atomicity + Crash Recovery)`);
    console.log(`   - ADR-007 Readiness Suite:    ${rReady.passed}/${rReady.total} (Probes, iss/aud, Mock AMQP Topology/Retry/DLQ, Mock Driver /nearby + /confirm + /release)`);
    console.log('   - Lưu ý phạm vi: Dùng mock amqplib & local HTTP Driver mock; tích hợp Compose RabbitMQ thật với TV2/TV3 chạy ở bước ghép nhóm.');
    console.log('='.repeat(70));
    process.exitCode = 0;
  } catch (err) {
    console.error('\n❌ CÓ BÀI TEST THẤT BẠI:', err);
    process.exit(1);
  }
}

main();
