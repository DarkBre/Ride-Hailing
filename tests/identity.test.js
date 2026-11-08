'use strict';

/**
 * TEST SUITE: IDENTITY / USER SERVICE (TV1)
 * Bao gồm: FT-01, FT-02, ST-01, ST-02 (Input Validation & RBAC)
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
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
  const service = createIdentityService({ port: TEST_PORT, dbPath: TEST_DB });
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

    // 14. API Nội bộ verify token
    await test('API nội bộ /internal/verify-token xác thực chính xác', async () => {
      const driverRes = await makeRequest({
        method: 'POST',
        path: '/auth/login',
        body: { email: 'driver1@test.com', password: 'DriverPassword123!' },
      });
      const driverToken = driverRes.body.data.token;

      const resVerify = await makeRequest({
        method: 'POST',
        path: '/internal/verify-token',
        body: { token: driverToken },
      });
      assert.strictEqual(resVerify.status, 200);
      assert.strictEqual(resVerify.body.data.valid, true);
      assert.strictEqual(resVerify.body.data.user.role, 'DRIVER');
    });

  } finally {
    await service.stop();
    cleanTestDb();
  }

  console.log(`\n🎉 KẾT QUẢ: ${passed}/${total} TESTS PASSED CHO IDENTITY/USER SERVICE!`);
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
