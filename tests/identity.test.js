'use strict';

/**
 * TEST SUITE: IDENTITY / USER SERVICE (TV1)
 * Bao gồm: FT-01, FT-02, ST-01, ST-02 (Input Validation & RBAC)
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createIdentityService } = require('../src/identity-service');
const auth = require('../src/identity-service/auth');

const TEST_PORT = 8901;
const TEST_DB = path.join(__dirname, '..', 'data', 'test_user_db.sqlite');

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
  console.log(' [TEST SUITE 1] IDENTITY / USER SERVICE (TV1)');
  console.log('='.repeat(65));

  cleanTestDb();
  let service = createIdentityService({ port: TEST_PORT, dbPath: TEST_DB });
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
    // 1. Health check
    await test('Health check endpoint hoạt động', async () => {
      const res = await makeRequest({ method: 'GET', path: '/health' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.status, 'healthy');
    });

    // 2. FT-01: Đăng ký tài khoản PASSENGER hợp lệ
    let passengerId = null;
    await test('FT-01: Đăng ký thành công tài khoản PASSENGER (HTTP 201)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/register',
        body: {
          email: 'passenger1@test.com',
          password: 'Password123!',
          name: 'Nguyen Van Khach',
          phone: '0901234567',
          role: 'PASSENGER',
        },
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.email, 'passenger1@test.com');
      assert.strictEqual(res.body.data.role, 'PASSENGER');
      assert.strictEqual(res.body.data.password_hash, undefined, 'Không được trả về password_hash');
      assert(res.body.data.id, 'Phải có id');
      passengerId = res.body.data.id;
    });

    // 3. FT-01: Đăng ký tài khoản DRIVER hợp lệ
    await test('FT-01: Đăng ký thành công tài khoản DRIVER (HTTP 201)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/api/v1/auth/register',
        body: {
          email: 'driver1@test.com',
          password: 'DriverPassword123!',
          name: 'Tran Van TaiXe',
          phone: '0987654321',
          role: 'DRIVER',
        },
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.role, 'DRIVER');
    });

    // 4. Kiểm tra chống trùng email
    await test('Đăng ký trùng email bị từ chối với HTTP 409 Conflict', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/register',
        body: {
          email: 'passenger1@test.com',
          password: 'AnotherPassword',
          name: 'Người Trùng Email',
          role: 'PASSENGER',
        },
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'EMAIL_ALREADY_EXISTS');
    });

    // 5. ST-02: Input Validation khi đăng ký
    await test('ST-02: Validate email sai định dạng bị chặn (HTTP 400)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/register',
        body: { email: 'bad-email-format', password: 'ValidPassword123', name: 'Test' },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_EMAIL');
    });

    await test('ST-02: Validate password quá ngắn (<6 ký tự) bị chặn (HTTP 400)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/register',
        body: { email: 'test_short@test.com', password: '123', name: 'Test' },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_PASSWORD');
    });

    await test('ST-02: Validate role không hợp lệ bị chặn (HTTP 400)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/register',
        body: { email: 'test_role@test.com', password: 'Password123', name: 'Test', role: 'ADMIN' },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_ROLE');
    });

    // 6. FT-02: Đăng nhập thành công và cấp JWT Token
    let passengerToken = null;
    await test('FT-02: Đăng nhập thành công trả về JWT Token và thông tin user (HTTP 200)', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'passenger1@test.com', password: 'Password123!' },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert(res.body.data.token, 'Phải có token JWT');
      assert.strictEqual(res.body.data.user.email, 'passenger1@test.com');
      assert.strictEqual(res.body.data.user.role, 'PASSENGER');
      passengerToken = res.body.data.token;
    });

    // 7. FT-02: Đăng nhập sai mật khẩu
    await test('FT-02: Đăng nhập sai mật khẩu trả về HTTP 401 INVALID_CREDENTIALS', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'passenger1@test.com', password: 'WrongPassword' },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    });

    // 8. FT-02: Đăng nhập email không tồn tại
    await test('FT-02: Đăng nhập email không tồn tại trả về HTTP 401 INVALID_CREDENTIALS', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'nonexistent@test.com', password: 'AnyPassword' },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    });

    // 9. Lấy hồ sơ người dùng qua /auth/me (ST-01: Authentication test)
    await test('ST-01: Truy cập /auth/me với token hợp lệ thành công (HTTP 200)', async () => {
      const res = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${passengerToken}` },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.email, 'passenger1@test.com');
      assert.strictEqual(res.body.data.id, passengerId);
    });

    // 10. ST-01: Truy cập không có token bị từ chối
    await test('ST-01: Truy cập /auth/me không có token trả về HTTP 401 UNAUTHORIZED', async () => {
      const res = await makeRequest({ method: 'GET', path: '/auth/me' });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
    });

    // 11. ST-01: Truy cập với token bị làm giả (tampered signature)
    await test('ST-01: Token bị giả mạo chữ ký bị từ chối (HTTP 401)', async () => {
      const parts = passengerToken.split('.');
      const forgedToken = `${parts[0]}.${parts[1]}.ForgedInvalidSignatureValue`;
      const res = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${forgedToken}` },
      });
      assert.strictEqual(res.status, 401);
    });

    // 12. ST-01: Token hết hạn (Expired token)
    await test('ST-01: Token hết hạn bị từ chối (HTTP 401)', async () => {
      const expiredToken = auth.signToken({ userId: passengerId, role: 'PASSENGER' }, -10); // Hết hạn 10s trước
      const res = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.strictEqual(res.status, 401);
    });

    // 13. Đăng xuất và vô hiệu hoá token
    await test('Đăng xuất thành công và token bị đưa vào blacklist', async () => {
      const resLogout = await makeRequest({
        method: 'POST',
        path: '/auth/logout',
        headers: { Authorization: `Bearer ${passengerToken}` },
      });
      assert.strictEqual(resLogout.status, 200);

      // Thử dùng lại token sau khi logout -> phải bị 401
      const resAfter = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${passengerToken}` },
      });
      assert.strictEqual(resAfter.status, 401);
    });

    // 14. API Nội bộ verify token (Bảo vệ bằng X-Internal-Key)
    await test('ST-01: API nội bộ /internal/verify-token yêu cầu X-Internal-Key (chặn truy cập không khoá)', async () => {
      const resWithoutKey = await makeRequest({
        method: 'POST',
        path: '/internal/verify-token',
        body: { token: 'some_token' },
      });
      assert.strictEqual(resWithoutKey.status, 401);
      assert.strictEqual(resWithoutKey.body.error.code, 'UNAUTHORIZED_INTERNAL');
    });

    await test('API nội bộ /internal/verify-token xác thực chính xác khi có X-Internal-Key hợp lệ', async () => {
      const driverRes = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'driver1@test.com', password: 'DriverPassword123!' },
      });
      const driverToken = driverRes.body.data.token;

      const resVerify = await makeRequest({
        method: 'POST',
        path: '/internal/verify-token',
        headers: { 'x-internal-key': 'dev-internal-service-key-ds03' },
        body: { token: driverToken },
      });
      assert.strictEqual(resVerify.status, 200);
      assert.strictEqual(resVerify.body.data.valid, true);
      assert.strictEqual(resVerify.body.data.user.role, 'DRIVER');
    });

    // 15. Kiểm tra Blacklist bền vững trong SQLite sau khi khởi động lại Service (Section 5.3)
    await test('Section 5.3: Token đã logout vẫn bị từ chối sau khi Identity Service restart (Persistent Blacklist)', async () => {
      // 1. Đăng nhập lấy token mới
      const loginRes = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'driver1@test.com', password: 'DriverPassword123!' },
      });
      const persistentToken = loginRes.body.data.token;

      // 2. Sử dụng token thành công
      const meBefore = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${persistentToken}` },
      });
      assert.strictEqual(meBefore.status, 200);

      // 3. Logout
      const logoutRes = await makeRequest({
        method: 'POST',
        path: '/auth/logout',
        headers: { Authorization: `Bearer ${persistentToken}` },
      });
      assert.strictEqual(logoutRes.status, 200);

      // 4. Token cũ bị từ chối ngay lập tức
      const meAfterLogout = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${persistentToken}` },
      });
      assert.strictEqual(meAfterLogout.status, 401);

      // 5. Tắt service và khởi động lại
      await service.stop();
      await new Promise((r) => setTimeout(r, 50));
      service = createIdentityService({ port: TEST_PORT, dbPath: TEST_DB });
      await service.start();

      // 6. Token cũ VẪN BỊ TỪ CHỐI sau restart nhờ SQLite persistence
      const meAfterRestart = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${persistentToken}` },
      });
      assert.strictEqual(meAfterRestart.status, 401, 'Token đã logout phải bị từ chối cả sau khi restart');

      // 7. Token mới đăng nhập sau restart vẫn hoạt động bình thường
      const newLogin = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'driver1@test.com', password: 'DriverPassword123!' },
      });
      assert.strictEqual(newLogin.status, 200);
      const freshToken = newLogin.body.data.token;
      const meFresh = await makeRequest({
        method: 'GET',
        path: '/auth/me',
        headers: { Authorization: `Bearer ${freshToken}` },
      });
      assert.strictEqual(meFresh.status, 200);

      // 8. Kiểm tra SQLite chỉ lưu token_hash (SHA-256), tuyệt đối không lưu raw JWT token
      const blRows = service.db.all('SELECT token_hash, expires_at FROM token_blacklist;');
      assert(blRows.length >= 1, 'Phải có bản ghi trong token_blacklist');
      for (const r of blRows) {
        assert.notStrictEqual(r.token_hash, persistentToken, 'Không được lưu raw JWT trong blacklist');
        assert(/^[a-f0-9]{64}$/.test(r.token_hash), 'token_blacklist phải lưu SHA-256 hex digest (64 ký tự)');
      }
      const expectedHash = auth.hashToken(persistentToken);
      assert(blRows.some((r) => r.token_hash === expectedHash), 'Phải tìm thấy đúng SHA-256 hash của token đã logout');
    });

    // 16. Security Boundary: Kiểm tra JWT tại đúng mốc now >= exp và alg != HS256
    await test('Security Boundary: JWT bị từ chối tại đúng thời điểm now === exp và khi sai alg header', () => {
      const tokenZeroExp = auth.signToken({ userId: passengerId, role: 'PASSENGER' }, 0);
      const decodedPayload = JSON.parse(Buffer.from(tokenZeroExp.split('.')[1], 'base64url').toString('utf8'));
      const exactExp = decodedPayload.exp;

      // Trước thời điểm hết hạn 1s -> hợp lệ
      assert(auth.verifyToken(tokenZeroExp, null, exactExp - 1) !== null, 'Trước exp 1s token vẫn phải hợp lệ');
      // Tại đúng thời điểm now === exp -> phải hết hạn (null)
      assert.strictEqual(auth.verifyToken(tokenZeroExp, null, exactExp), null, 'Tại now === exp token phải bị từ chối');

      // Thử token giả mạo alg=none dù chữ ký khớp secret dev
      const badHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify({ userId: passengerId, role: 'PASSENGER', exp: exactExp + 3600 })).toString('base64url');
      const sig = crypto.createHmac('sha256', require('../src/identity-service/config').JWT_SECRET)
        .update(`${badHeader}.${payloadB64}`).digest('base64url');
      assert.strictEqual(auth.verifyToken(`${badHeader}.${payloadB64}.${sig}`), null, 'Phải từ chối header alg != HS256');
    });

    // 17. Security Cleanup: Dọn dẹp các bản ghi blacklist đã hết hạn
    await test('Blacklist Cleanup: Xoá các bản ghi blacklist hết hạn nhưng giữ nguyên token còn hạn', () => {
      const expiredRevoked = auth.signToken({ userId: 'u_exp', role: 'PASSENGER' }, -60);
      const activeRevoked = auth.signToken({ userId: 'u_act', role: 'PASSENGER' }, 3600);

      const expHash = auth.hashToken(expiredRevoked);
      const actHash = auth.hashToken(activeRevoked);

      auth.revokeToken(activeRevoked, service.db);
      service.db.run(
        'INSERT OR REPLACE INTO token_blacklist (token_hash, expires_at) VALUES (?, ?);',
        expHash,
        Math.floor(Date.now() / 1000) - 5
      );

      assert(service.db.get('SELECT token_hash FROM token_blacklist WHERE token_hash = ?;', expHash));
      const deleted = auth.cleanupExpiredBlacklist(service.db);
      assert(deleted >= 1, 'Phải xoá ít nhất 1 bản ghi blacklist hết hạn');
      assert.strictEqual(service.db.get('SELECT token_hash FROM token_blacklist WHERE token_hash = ?;', expHash), undefined);
      assert(service.db.get('SELECT token_hash FROM token_blacklist WHERE token_hash = ?;', actHash), 'Token chưa hết hạn phải được giữ lại');
    });

    // 18. Security Config: Production fail-fast khi thiếu JWT_SECRET hoặc INTERNAL_KEY
    await test('Production Fail-Fast: Từ chối khởi động khi NODE_ENV=production với secret mặc định/thiếu', () => {
      const configPath = path.resolve(__dirname, '../src/identity-service/config.js').replace(/\\/g, '/');
      const runMissingJwt = spawnSync(process.execPath, ['-e', `require('${configPath}')`], {
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', INTERNAL_KEY: 'custom-strong-internal-key-123' },
        encoding: 'utf8',
      });
      assert.notStrictEqual(runMissingJwt.status, 0, 'Phải crash fail-fast khi thiếu JWT_SECRET ở production');

      const runDefaultInternal = spawnSync(process.execPath, ['-e', `require('${configPath}')`], {
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'custom-strong-jwt-secret-1234', INTERNAL_KEY: 'dev-internal-service-key-ds03' },
        encoding: 'utf8',
      });
      assert.notStrictEqual(runDefaultInternal.status, 0, 'Phải crash fail-fast khi dùng INTERNAL_KEY mặc định ở production');
    });

  } finally {
    await service.stop();
    cleanTestDb();
  }

  console.log(`\n🎉 KẾT QUẢ: ${passed}/${total} TESTS PASSED CHO IDENTITY/USER SERVICE!`);
  return { passed, total };
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
