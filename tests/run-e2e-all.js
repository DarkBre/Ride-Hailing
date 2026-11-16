'use strict';

/**
 * DS03 - Bộ Điều Phối Kiểm Thử Đầu Cuối Toàn Hệ Thống (Master Live E2E Runner)
 * Chạy toàn bộ các kịch bản kiểm thử tích hợp thực tế trên Docker Compose:
 * - E2E-01: Happy Path Toàn Trình (Đăng ký -> Nạp tiền -> Khớp xe -> Giữ tiền -> Hoàn thành -> Trừ tiền)
 * - E2E-02: Bù trừ Phân tán (Khách huỷ -> Hoàn tiền ví -> Giải phóng tài xế -> Saga COMPENSATED)
 * - E2E-03: Tranh chấp Đồng thời & Chống Double-Booking (2 Khách cùng đặt cạnh 1 Tài xế)
 * - E2E-04: Thất bại Giữ tiền & Tự Động Rollback (Ví không đủ tiền -> Hold Failed -> Huỷ & Nhả tài xế)
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  { name: 'E2E-01: Luồng Chuẩn Toàn Trình (Happy Path)', file: 'e2e-live.js' },
  { name: 'E2E-02: Bù Trừ Phân Tán (Saga Compensation)', file: 'e2e-compensation.js' },
  { name: 'E2E-03: Tranh Chấp & Chống Double-Booking (Concurrency)', file: 'e2e-concurrency.js' },
  { name: 'E2E-04: Thất Bại Giữ Tiền & Rollback (Hold Failed)', file: 'e2e-insufficient-funds.js' },
];

async function main() {
  console.log('='.repeat(80));
  console.log('       TỔNG HỢP KIỂM THỬ ĐẦU CUỐI THỰC TẾ (MASTER E2E LIVE TEST SUITE)');
  console.log('       Môi trường: Docker Compose 10 Container Live | RabbitMQ 4 | Postgres 17');
  console.log('='.repeat(80));

  const results = [];
  const startTime = Date.now();

  for (const suite of SUITES) {
    console.log(`\n▶ ĐANG CHẠY: ${suite.name}...`);
    const filePath = path.join(__dirname, suite.file);
    const startSuite = Date.now();
    const child = spawnSync(process.execPath, [filePath], {
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
    });
    const duration = ((Date.now() - startSuite) / 1000).toFixed(2);
    const passed = child.status === 0;
    results.push({ ...suite, passed, duration });
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n' + '='.repeat(80));
  console.log('                     BẢNG KẾT QUẢ NGHIỆM THU E2E LIVE');
  console.log('='.repeat(80));

  let allPassed = true;
  for (const r of results) {
    const mark = r.passed ? '✅ ĐẠT (PASS)' : '❌ HỎNG (FAIL)';
    console.log(`${mark} | ${r.duration.padStart(6)}s | ${r.name}`);
    if (!r.passed) allPassed = false;
  }

  console.log('-'.repeat(80));
  console.log(`Tổng thời gian thực thi: ${totalDuration}s`);
  console.log(`Kết luận: ${allPassed ? '🎉 TOÀN BỘ 4/4 KỊCH BẢN E2E ĐÃ VƯỢT QUA 100%!' : '⚠️ CÓ KỊCH BẢN THẤT BẠI'}`);
  console.log('='.repeat(80));

  if (!allPassed) {
    process.exit(1);
  }
}

main();
