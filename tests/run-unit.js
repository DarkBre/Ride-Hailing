'use strict';

/**
 * DS03 - Bộ Kiểm Thử Đơn Vị (Unit Test Runner)
 * Scope: Logic nghiệp vụ độc lập, Pure In-Memory algorithms, State Machine, Token & Auth
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const unitTestSuites = [
  { name: 'TV2 Matching Geo & Ranking', file: 'geo.test.cjs', cwd: 'src/matching-service' },
  { name: 'TV3 Payment State Machine', file: 'payment-state-machine.test.js', cwd: 'tests' },
  { name: 'TV3 Payment Auth & Ownership', file: 'payment-auth.test.js', cwd: 'tests' },
  { name: 'TV3 Payment Config & Secrets', file: 'payment-config.test.js', cwd: 'tests' },
  { name: 'TV3 AMQP Topology & Bindings', file: 'topology.test.js', cwd: 'tests' },
];

function runSuite({ name, file, cwd }) {
  console.log(`▶ [UNIT TEST]: ${name}...`);
  const res = spawnSync(process.execPath, ['--test', file], {
    cwd: path.resolve(__dirname, '..', cwd),
    encoding: 'utf8',
    env: process.env,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (res.status !== 0 && stderr) console.error(stderr.trim());

  const passMatch = stdout.match(/ℹ pass (\d+)/);
  const totalMatch = stdout.match(/ℹ tests (\d+)/);
  const passed = passMatch ? parseInt(passMatch[1], 10) : (res.status === 0 ? 1 : 0);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : passed;

  const icon = res.status === 0 ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${icon} (${passed}/${total} tests)`);
  return { name, passed, total, ok: res.status === 0 };
}

async function main() {
  console.log('='.repeat(70));
  console.log(' BỘ KIỂM THỬ ĐƠN VỊ (UNIT TESTS RUNNER) — DS03');
  console.log('='.repeat(70));

  const start = Date.now();
  let totalPass = 0;
  let grandTotal = 0;
  let allOk = true;

  for (const s of unitTestSuites) {
    const res = runSuite(s);
    totalPass += res.passed;
    grandTotal += res.total;
    if (!res.ok) allOk = false;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log('='.repeat(70));
  console.log(`🎉 TỔNG KẾT UNIT TESTS: ${totalPass}/${grandTotal} PASSED (${elapsed}s)`);
  console.log('='.repeat(70));

  if (!allOk) process.exit(1);
}

if (require.main === module) main();
module.exports = { runTests: main };
