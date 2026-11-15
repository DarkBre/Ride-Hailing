'use strict';

/**
 * TỔNG HỢP KIỂM THỬ THÀNH VIÊN 2 (TV2 ALL TESTS RUNNER)
 * Chạy các bài kiểm thử của TV2: Driver Service & Matching Service
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function runTest(name, file, cwd) {
  console.log(`\n▶ [CHẠY KIỂM THỬ TV2]: ${name} (${file})...`);
  const res = spawnSync(process.execPath, ['--test', file], {
    cwd: path.resolve(__dirname, '..', cwd),
    encoding: 'utf8',
    env: process.env,
  });

  if (res.stdout) console.log(res.stdout.trim());
  if (res.stderr) console.error(res.stderr.trim());

  const stdout = res.stdout || '';
  const passMatch = stdout.match(/ℹ pass (\d+)/);
  const skipMatch = stdout.match(/ℹ skipped (\d+)/);
  const failMatch = stdout.match(/ℹ fail (\d+)/);
  const totalMatch = stdout.match(/ℹ tests (\d+)/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : (res.status !== 0 ? 1 : 0);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : (passed + skipped + failed);

  return { name, file, passed, skipped, failed, total, ok: res.status === 0 };
}

async function main() {
  console.log('='.repeat(70));
  console.log(' CHƯƠNG TRÌNH KIỂM THỬ THÀNH VIÊN 2 (TV2 SUITE RUNNER) — DS03');
  console.log(' Scope: Driver Service, Matching Service, Geo Algorithm & Reservations');
  console.log('='.repeat(70));

  const startTime = Date.now();
  const results = [];

  // 1. Matching Service Geo Unit Tests
  const geoResult = runTest(
    'Matching Geo & Ranking Unit Tests',
    'geo.test.cjs',
    'src/matching-service'
  );
  results.push(geoResult);

  // 2. Driver Service Integration Tests (skipped if DRIVER_TEST_DATABASE_URL is absent)
  const driverResult = runTest(
    'Driver HTTP + PostgreSQL Tests',
    'integration.test.cjs',
    'src/driver-service'
  );
  results.push(driverResult);

  const totalPassed = results.reduce((acc, r) => acc + r.passed, 0);
  const totalSkipped = results.reduce((acc, r) => acc + r.skipped, 0);
  const totalFailed = results.reduce((acc, r) => acc + r.failed, 0);
  const totalTests = results.reduce((acc, r) => acc + r.total, 0);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n' + '='.repeat(70));
  console.log(` TỔNG HỢP KẾT QUẢ KIỂM THỬ THÀNH VIÊN 2: ${totalPassed} PASS, ${totalSkipped} SKIP, ${totalFailed} FAIL (${elapsed}s)`);
  console.log('='.repeat(70));
  for (const r of results) {
    const status = r.failed > 0 ? '❌ FAIL' : (r.skipped > 0 && r.passed === 0 ? '⚠️ SKIP' : '✅ PASS');
    console.log(` ${status} | ${r.name}: ${r.passed} passed, ${r.skipped} skipped, ${r.failed} failed`);
  }
  console.log(' Lưu ý:');
  console.log(' - geo.test.cjs: kiểm thử thuần túy thuật toán Haversine và bộ lọc xếp hạng tài xế (in-memory).');
  console.log(' - integration.test.cjs: yêu cầu DRIVER_TEST_DATABASE_URL (tự động SKIP an toàn khi chạy offline/local không có PostgreSQL).');
  console.log(' - broker.integration.cjs: kịch bản kiểm thử tích hợp AMQP/HTTP toàn diện trên Docker stack.');
  console.log('='.repeat(70));

  if (totalFailed > 0) {
    process.exit(1);
  }
  return { passed: totalPassed, skipped: totalSkipped, failed: totalFailed, total: totalTests };
}

if (require.main === module) {
  main();
}

module.exports = { runTests: main };
