'use strict';

const crypto = require('node:crypto');
const auth = require('./auth');
const config = require('./config');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createRoutes(db) {
  return [
    // 1. Health check
    {
      method: 'GET',
      path: '/health',
      handler: async () => ({
        status: 'healthy',
        service: 'identity-service',
        timestamp: new Date().toISOString(),
      }),
    },

    // 2. Đăng ký tài khoản (Hỗ trợ cả /auth/register và /api/v1/auth/register)
    ...['/auth/register', '/api/v1/auth/register'].map((path) => ({
      method: 'POST',
      path,
      status: 201,
      handler: async ({ body }) => {
        const { email, password, name, phone, role } = body || {};

        // 2.1. Validate input data (ST-02)
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

        // 2.2. Kiểm tra trùng lặp email
        const existing = db.get('SELECT id FROM users WHERE email = ?;', email.trim().toLowerCase());
        if (existing) {
          const err = new Error('Email đã được đăng ký trong hệ thống');
          err.status = 409;
          err.code = 'EMAIL_ALREADY_EXISTS';
          throw err;
        }

        // 2.3. Băm mật khẩu scrypt + salt và ghi DB an toàn
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

    // 3. Đăng nhập (Hỗ trợ /auth/login và /api/v1/auth/login)
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

        const user = db.get('SELECT * FROM users WHERE email = ?;', String(email).trim().toLowerCase());
        if (!user) {
          const err = new Error('Email hoặc mật khẩu không chính xác');
          err.status = 401;
          err.code = 'INVALID_CREDENTIALS';
          throw err;
        }

        const isValid = auth.verifyPassword(String(password), user.password_hash);
        if (!isValid) {
          const err = new Error('Email hoặc mật khẩu không chính xác');
          err.status = 401;
          err.code = 'INVALID_CREDENTIALS';
          throw err;
        }

        // Ký JWT Token
        const token = auth.signToken({
          userId: user.id,
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

        const user = db.get('SELECT id, email, name, phone, role, created_at FROM users WHERE id = ?;', decoded.userId);
        if (!user) {
          const err = new Error('Không tìm thấy thông tin người dùng');
          err.status = 404;
          err.code = 'USER_NOT_FOUND';
          throw err;
        }

        return user;
      },
    })),

    // 5. Đăng xuất / Thu hồi token (/auth/logout và /api/v1/auth/logout)
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

    // 6. API Nội bộ: Xác thực nhanh token cho API Gateway hoặc Service khác
    // Được bảo vệ nghiêm ngặt bằng X-Internal-Key (ST-01, Section 5.5)
    {
      method: 'POST',
      path: '/internal/verify-token',
      status: 200,
      handler: async ({ headers, body }) => {
        const internalKey = headers['x-internal-key'];
        if (!internalKey || internalKey !== config.INTERNAL_KEY) {
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
        const user = db.get('SELECT id, email, name, role FROM users WHERE id = ?;', decoded.userId);
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
