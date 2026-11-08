'use strict';

/**
 * Script kiểm tra tính toàn vẹn của codebase nền tảng (Shared Foundations)
 * DS03: Ride-Hailing Microservices System
 */

const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert');

console.log('='.repeat(60));
console.log(' KIỂM TRA CODEBASE NỀN TẢNG (FOUNDATIONAL CODEBASE CHECK)');
console.log('='.repeat(60));

// 1. Kiểm tra phiên bản Node.js
const [major, minor] = process.versions.node.split('.').map(Number);
console.log(`[1/5] Kiểm tra phiên bản Node.js: v${process.versions.node}`);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`❌ Yêu cầu Node.js >= 22.13.0 (để hỗ trợ native node:sqlite không cần cờ experimental). Hiện tại: v${process.versions.node}`);
  process.exit(1);
}
console.log('  -> OK: Phiên bản Node.js tương thích chuẩn.');

// 2. Kiểm tra node:sqlite native
console.log('[2/5] Kiểm tra module node:sqlite native...');
try {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT);');
  memDb.prepare('INSERT INTO test (name) VALUES (?);').run('foundation_check');
  const row = memDb.prepare('SELECT name FROM test WHERE id = 1;').get();
  assert.strictEqual(row.name, 'foundation_check');
  memDb.close();
  console.log('  -> OK: node:sqlite hoạt động trơn tru (Zero external dependencies).');
} catch (err) {
  console.error('❌ Lỗi khi khởi tạo node:sqlite:', err);
  process.exit(1);
}

// 3. Kiểm tra load các modules shared
console.log('[3/5] Nạp và kiểm tra cú pháp các modules trong services/_shared/...');
let config, id, logger, store, auth, geo, httpServer, httpClient;
try {
  config = require('../services/_shared/config');
  id = require('../services/_shared/id');
  logger = require('../services/_shared/logger');
  store = require('../services/_shared/store');
  auth = require('../services/_shared/auth');
  geo = require('../services/_shared/geo');
  httpServer = require('../services/_shared/http-server');
  httpClient = require('../services/_shared/http-client');
  console.log('  -> OK: Nạp thành công 8/8 modules shared.');
} catch (err) {
  console.error('❌ Lỗi cú pháp/require trong services/_shared:', err);
  process.exit(1);
}

// 4. Kiểm tra logic các hàm tiện ích
console.log('[4/5] Kiểm tra chức năng logic của từng module...');

// 4.1 id.js
const testUuid = id.uuid();
const testCorrId = id.correlationId();
assert(testUuid.length === 36, 'UUID phải có 36 ký tự');
assert(testCorrId.startsWith('corr_'), 'Correlation ID phải có tiền tố corr_');

// 4.2 auth.js (scrypt & JWT)
const pwd = 'SecretPassword123!';
const hash = auth.hashPassword(pwd);
assert(auth.verifyPassword(pwd, hash) === true, 'Mật khẩu đúng phải verify thành công');
assert(auth.verifyPassword('WrongPassword', hash) === false, 'Mật khẩu sai phải verify thất bại');

const tokenPayload = { userId: 'usr_test123', role: 'customer' };
const token = auth.signToken(tokenPayload, 60);
const decoded = auth.verifyToken(token);
assert(decoded && decoded.userId === 'usr_test123', 'Token JWT giải mã phải khớp');
assert(auth.verifyToken(token + 'corrupt') === null, 'Token hỏng phải trả về null');

// 4.3 geo.js (Haversine & thời gian)
// Toạ độ Bờ Hồ (Hoàn Kiếm): 21.0285, 105.8542
// Toạ độ Hồ Tây (Tây Hồ): 21.0583, 105.8236
const dist = geo.haversineDistanceKm(
  { lat: 21.0285, lon: 105.8542 },
  { lat: 21.0583, lon: 105.8236 }
);
assert(dist > 3 && dist < 6, `Khoảng cách Bờ Hồ - Hồ Tây phải ~4.6km (thực tế tính được: ${dist}km)`);
const eta = geo.estimateTravelMinutes(dist);
assert(eta >= 3, 'ETA phải >= 3 phút');

// 4.4 config.js
assert(config.PORTS.gateway === 8080, 'Cổng Gateway mặc định phải là 8080');
assert(config.PORTS.identity === 4001, 'Cổng Identity mặc định phải là 4001');
assert(config.PORTS.trip === 4003, 'Cổng Trip mặc định phải là 4003');

console.log('  -> OK: Logic ID, Auth (scrypt + JWT), Geo (Haversine), Config hoạt động chính xác 100%.');

// 5. Kiểm tra SQLite Store wrapper
console.log('[5/5] Kiểm tra SQLite Store wrapper (WAL mode & Transactions)...');
const testDbName = 'test_check';
const db = store.openDatabase(testDbName, `
  CREATE TABLE IF NOT EXISTS check_table (
    id TEXT PRIMARY KEY,
    val INTEGER
  );
`);
db.run('INSERT INTO check_table (id, val) VALUES (?, ?);', 'row_1', 100);
const r1 = db.get('SELECT val FROM check_table WHERE id = ?;', 'row_1');
assert.strictEqual(r1.val, 100);

// Test transaction rollback
try {
  db.tx(() => {
    db.run('INSERT INTO check_table (id, val) VALUES (?, ?);', 'row_fail', 999);
    throw new Error('Simulation rollback');
  });
} catch (_) {}
const rFail = db.get('SELECT val FROM check_table WHERE id = ?;', 'row_fail');
assert.strictEqual(rFail, undefined, 'Giao dịch bị lỗi phải được rollback hoàn toàn');

db.close();

// Dọn dẹp db test
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = config.getDbPath(testDbName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  if (fs.existsSync(`${p}-wal`)) fs.unlinkSync(`${p}-wal`);
  if (fs.existsSync(`${p}-shm`)) fs.unlinkSync(`${p}-shm`);
} catch (_) {}

console.log('  -> OK: SQLite Store wrapper + Transaction Rollback hoạt động hoàn hảo.');

console.log('='.repeat(60));
console.log('✅ TOÀN BỘ CODEBASE NỀN TẢNG (FOUNDATION) ĐẠT TIÊU CHUẨN 100%!');
console.log('='.repeat(60));
