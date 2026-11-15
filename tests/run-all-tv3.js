'use strict';

/**
 * TV3 Master Test Suite Runner
 * Executes FT-07 (Payment), Payment JWT/ownership security, FR-01 (Fault Tolerance),
 * FR-02 (Saga Compensation), DLQ & Bounded Retries, Notification dedup, and API Gateway tests.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const testFiles = [
  'ft-07-payment.test.js',
  'payment-state-machine.test.js',
  'outbox-reliability.test.js',
  'broker-lifecycle.test.js',
  'payment-auth.test.js',
  'payment-config.test.js',
  'fr-01-fr-02-fault-saga.test.js',
  'dlq-retry.test.js',
  'notification.test.js',
  'topology.test.js',
  'gateway.test.js',
];

async function runTestFile(file) {
  const filePath = path.join(__dirname, file);
  return new Promise((resolve) => {
    console.log(`\n▶ [CHẠY KIỂM THỬ]: ${file}...`);
    let output = '';
    const child = spawn(process.execPath, ['--test', filePath], {
      env: process.env,
    });

    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      output += d.toString();
    });

    child.on('close', (code) => {
      const passMatch = output.match(/ℹ pass (\d+)/);
      const totalMatch = output.match(/ℹ tests (\d+)/);
      const failMatch = output.match(/ℹ fail (\d+)/);
      const passed = passMatch ? parseInt(passMatch[1], 10) : (code === 0 ? 1 : 0);
      const total = totalMatch ? parseInt(totalMatch[1], 10) : passed;
      const failed = failMatch ? parseInt(failMatch[1], 10) : (code !== 0 ? 1 : 0);
      resolve({ file, passed: code === 0, code, testPassed: passed, testTotal: total, testFailed: failed });
    });
  });
}

async function main() {
  console.log('='.repeat(70));
  console.log(' BỘ KIỂM THỬ THÀNH VIÊN 3 (TV3 TEST SUITE) — DS03');
  console.log(' Phạm vi: FT-07 (Payment), FR-01 (Fault Tolerance), FR-02 (Saga), DLQ, Gateway');
  console.log('='.repeat(70));

  const results = [];
  for (const file of testFiles) {
    const res = await runTestFile(file);
    results.push(res);
  }

  console.log('\n' + '='.repeat(70));
  console.log(' TỔNG HỢP KẾT QUẢ KIỂM THỬ TOÀN BỘ MODULE THÀNH VIÊN 3:');
  console.log('='.repeat(70));

  let allPassed = true;
  let totalTestPassed = 0;
  let totalTestCount = 0;
  for (const r of results) {
    const icon = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(` ${icon} | ${r.file}: ${r.testPassed}/${r.testTotal} tests`);
    if (!r.passed) allPassed = false;
    totalTestPassed += r.testPassed;
    totalTestCount += r.testTotal;
  }

  console.log('='.repeat(70));
  if (allPassed) {
    console.log(`🎉 TẤT CẢ ${totalTestPassed}/${totalTestCount} BÀI TEST CỦA THÀNH VIÊN 3 ĐÃ ĐẠT 100% TIÊU CHÍ NGHIỆM THU!`);
    if (require.main === module) process.exit(0);
  } else {
    console.error('⚠️ Có bài test thất bại. Hãy kiểm tra chi tiết ở log phía trên.');
    if (require.main === module) process.exit(1);
  }

  return { passed: totalTestPassed, total: totalTestCount, allPassed, results };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  });
}

module.exports = { runTests: main, testFiles };
