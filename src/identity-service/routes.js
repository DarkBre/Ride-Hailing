'use strict';

// =========================================================================
// [TV1] Identity Service Routes
// - POST /auth/register: Đăng ký tài khoản (Scrypt + Salt 16B)
// - POST /auth/login: Đăng nhập & cấp phát JWT HS256 (24h)
// - GET /auth/me: Lấy thông tin tài khoản hiện tại qua Bearer token
// - POST /auth/logout: Đăng xuất & thu hồi token vào blacklist SQLite
// - POST /internal/verify-token: API nội bộ cho Gateway xác thực vé (X-Internal-Key)
// =========================================================================

const crypto = require('node:crypto');
const auth = require('./auth');
const config = require('./config');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createRoutes(db) {
  return [
    // 1. Health & Kubernetes/Docker Probes
    {
      method: 'GET',
      path: '/health',
      handler: async () => ({
        status: 'healthy',
        service: 'identity-service',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      method: 'GET',
      path: '/live',
      handler: async () => ({
        status: 'UP',
        service: 'identity-service',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      method: 'GET',
      path: '/ready',
      handler: async () => {
        try {
          db.get('SELECT 1 AS ok;');
          return {
            ready: true,
            service: 'identity-service',
            timestamp: new Date().toISOString(),
          };
        } catch (err) {
          const readinessErr = new Error(`SQLite chưa sẵn sàng: ${err.message}`);
          readinessErr.status = 503;
          readinessErr.code = 'NOT_READY';
          throw readinessErr;
        }
      },
    },

    // 2. [TV1] Đăng ký tài khoản: Validate, băm mật khẩu Scrypt + Salt 16B, lưu users SQLite
    ...['/auth/register', '/api/v1/auth/register'].map((path) => ({
      method: 'POST',
      path,
      status: 201,
      handler: async ({ body }) => {
        const { email, password, name, phone, role } = body || {};

        // 2.1. Kiểm tra định dạng email, độ dài mật khẩu >= 6, role hợp lệ
        if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
          const err = new Error('Email không đúng định dạng');
          err.status = 400;
          err.code = 'INVALID_EMAIL';
          throw err;
        }

        if (!password || typeof password !== 'string' || password.length < 6) {
          const err = new Error('Mật khẩu phải chứa ít nhất 6 ký tự');
          err.status = 400;
          err.code = 'INVALID_PASSWORD';
          throw err;
        }

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          const err = new Error('Họ và tên không được để trống');
          err.status = 400;
          err.code = 'INVALID_NAME';
          throw err;
        }

        const normalizedRole = (role || 'PASSENGER').toUpperCase();
        if (!['PASSENGER', 'DRIVER'].includes(normalizedRole)) {
          const err = new Error('Vai trò người dùng phải là PASSENGER hoặc DRIVER');
          err.status = 400;
          err.code = 'INVALID_ROLE';
          throw err;
        }

        // 2.2. Kiểm tra email đã đăng ký chưa (tránh trùng lặp tài khoản)
        const existing = db.get('SELECT id FROM users WHERE email = ?;', email.trim().toLowerCase());
        if (existing) {
          const err = new Error('Email đã được đăng ký trong hệ thống');
          err.status = 409;
          err.code = 'EMAIL_ALREADY_EXISTS';
          throw err;
        }

        // 2.3. Băm mật khẩu Scrypt + Salt 16B và ghi vào database SQLite
        const passwordHash = auth.hashPassword(password);
        const userId = crypto.randomUUID();
        const now = new Date().toISOString();

        try {
          db.run(
            `INSERT INTO users (id, email, password_hash, name, phone, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
            userId,
            email.trim().toLowerCase(),
            passwordHash,
            name.trim(),
            phone ? String(phone).trim() : null,
            normalizedRole,
            now,
            now
          );
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            const conflictErr = new Error('Email đã được đăng ký trong hệ thống');
            conflictErr.status = 409;
            conflictErr.code = 'EMAIL_ALREADY_EXISTS';
            throw conflictErr;
          }
          throw err;
        }

        return {
          id: userId,
          email: email.trim().toLowerCase(),
          name: name.trim(),
          phone: phone ? String(phone).trim() : null,
          role: normalizedRole,
          created_at: now,
        };
      },
    })),

    // 3. [TV1] Đăng nhập: So khớp mật khẩu timingSafeEqual và cấp phát JWT HS256 (24h)
    ...['/auth/login', '/api/v1/auth/login'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ body }) => {
        const { email, password } = body || {};

        if (!email || !password) {
          const err = new Error('Vui lòng cung cấp đầy đủ email và mật khẩu');
          err.status = 400;
          err.code = 'MISSING_CREDENTIALS';
          throw err;
        }

        // 3.1. Tìm kiếm tài khoản người dùng theo email trong SQLite
        const user = db.get('SELECT * FROM users WHERE email = ?;', String(email).trim().toLowerCase());
        if (!user) {
          const err = new Error('Email hoặc mật khẩu không chính xác');
          err.status = 401;
          err.code = 'INVALID_CREDENTIALS';
          throw err;
        }

        // 3.2. So khớp mật khẩu bằng timingSafeEqual (chống Timing Attack O(1))
        const isValid = auth.verifyPassword(String(password), user.password_hash);
        if (!isValid) {
          const err = new Error('Email hoặc mật khẩu không chính xác');
          err.status = 401;
          err.code = 'INVALID_CREDENTIALS';
          throw err;
        }

        // 3.3. Cấp phát JWT Access Token chứa payload (userId, email, role, exp 24h)
        const token = auth.signToken({
          sub: user.id,
          userId: user.id,
          user_id: user.id,
          email: user.email,
          role: user.role,
        });

        return {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            phone: user.phone,
            role: user.role,
          },
        };
      },
    })),

    // 4. Lấy thông tin tài khoản hiện tại (/auth/me và /api/v1/auth/me)
    ...['/auth/me', '/api/v1/auth/me'].map((path) => ({
      method: 'GET',
      path,
      status: 200,
      handler: async ({ headers }) => {
        const authHeader = headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const decoded = auth.verifyToken(token, db);

        if (!decoded) {
          const err = new Error('Token xác thực không hợp lệ hoặc đã hết hạn');
          err.status = 401;
          err.code = 'UNAUTHORIZED';
          throw err;
        }

        const userId = decoded.userId || decoded.user_id || decoded.sub;
        const user = db.get('SELECT id, email, name, phone, role, created_at FROM users WHERE id = ?;', userId);
        if (!user) {
          const err = new Error('Không tìm thấy thông tin người dùng');
          err.status = 404;
          err.code = 'USER_NOT_FOUND';
          throw err;
        }

        return user;
      },
    })),

    // 5. [TV1] Đăng xuất: Thu hồi token, lưu SHA-256 vào Persistent Blacklist SQLite
    ...['/auth/logout', '/api/v1/auth/logout'].map((path) => ({
      method: 'POST',
      path,
      status: 200,
      handler: async ({ headers }) => {
        const authHeader = headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token) {
          auth.revokeToken(token, db);
        }
        return { message: 'Đăng xuất thành công' };
      },
    })),

    // 6. [TV1] API Nội bộ: Xác thực nhanh JWT cho API Gateway (bảo vệ bằng X-Internal-Key)
    {
      method: 'POST',
      path: '/internal/verify-token',
      status: 200,
      handler: async ({ headers, body }) => {
        const internalKey = headers['x-internal-key'];
        if (!auth.safeCompare(internalKey, config.INTERNAL_KEY)) {
          const err = new Error('Yêu cầu x-internal-key hợp lệ để truy cập endpoint nội bộ');
          err.status = 401;
          err.code = 'UNAUTHORIZED_INTERNAL';
          throw err;
        }

        const { token } = body || {};
        const decoded = auth.verifyToken(token, db);
        if (!decoded) {
          return { valid: false, user: null };
        }
        const userId = decoded.userId || decoded.user_id || decoded.sub;
        const user = db.get('SELECT id, email, name, role FROM users WHERE id = ?;', userId);
        if (!user) {
          return { valid: false, user: null };
        }
        return { valid: true, user };
      },
    },
  ];
}

module.exports = {
  createRoutes,
};
