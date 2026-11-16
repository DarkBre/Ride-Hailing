'use strict';

/**
 * DS03 - Bộ Kiểm Thử Tích Hợp Dịch Vụ (Service Integration Test Runner)
 * Scope: HTTP Server + Database (SQLite WAL / Postgres Mocks), Transactional Outbox, DLQ, Gateway
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const serviceTestSuites = [
  { name: 'TV1 Identity Service (HTTP + SQLite WAL)', file: 'identity.test.js', cwd: 'tests' },
  { name: 'TV1 Trip Service & Pricing (HTTP + SQLite)', file: 'trip.test.js', cwd: 'tests' },
  { name: 'TV1 Saga Coordinator & Compensation (SQLite)', file: 'saga.test.js', cwd: 'tests' },
  { name: 'TV1 ADR-007 Readiness & Mocks', file: 'tv1-integration-readiness.test.js', cwd: 'tests' },
  { name: 'TV3 FT-07 Payment Consistency', file: 'ft-07-payment.test.js', cwd: 'tests' },
  { name: 'TV3 Outbox Reliability & Recovery', file: 'outbox-reliability.test.js', cwd: 'tests' },
  { name: 'TV3 Fault Saga & Compensation', file: 'fr-01-fr-02-fault-saga.test.js', cwd: 'tests' },
  { name: 'TV3 DLQ & Bounded Retries', file: 'dlq-retry.test.js', cwd: 'tests' },
  { name: 'TV3 Notification Dedup & SSE', file: 'notification.test.js', cwd: 'tests' },
  { name: 'TV3 API Gateway Proxy & Tracing', file: 'gateway.test.js', cwd: 'tests' },
  { name: 'TV3 Broker Lifecycle', file: 'broker-lifecycle.test.js', cwd: 'tests' },
];

function runSuite({ name, file, cwd }) {
  console.log(`▶ [SERVICE INTEGRATION]: ${name}...`);
  const res = spawnSync(process.execPath, [file.endsWith('.cjs') ? '--test' : file], {
    cwd: path.resolve(__dirname, '..', cwd),
    encoding: 'utf8',
    env: process.env,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (res.status !== 0 && stderr) console.error(stderr.trim());

  // Check for node:test output or custom runner output
  const passMatch = stdout.match(/ℹ pass (\d+)/) || stdout.match(/KẾT QUẢ: (\d+)\/(\d+) TESTS PASSED/);
  const totalMatch = stdout.match(/ℹ tests (\d+)/) || (passMatch ? [null, passMatch[2]] : null);
  const passed = passMatch ? parseInt(passMatch[1], 10) : (res.status === 0 ? 1 : 0);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : passed;

  const icon = res.status === 0 ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${icon} (${passed}/${total} tests)`);
  return { name, passed, total, ok: res.status === 0 };
}

async function main() {
  console.log('='.repeat(70));
  console.log(' BỘ KIỂM THỬ TÍCH HỢP DỊCH VỤ (SERVICE INTEGRATION) — DS03');
  console.log('='.repeat(70));

  const start = Date.now();
  let totalPass = 0;
  let grandTotal = 0;
  let allOk = true;

  for (const s of serviceTestSuites) {
    const res = runSuite(s);
    totalPass += res.passed;
    grandTotal += res.total;
    if (!res.ok) allOk = false;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log('='.repeat(70));
  console.log(`🎉 TỔNG KẾT SERVICE INTEGRATION: ${totalPass}/${grandTotal} PASSED (${elapsed}s)`);
  console.log('='.repeat(70));

  if (!allOk) process.exit(1);
}

if (require.main === module) main();
module.exports = { runTests: main };
