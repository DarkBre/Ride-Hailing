'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const tokenBlacklist = new Set();

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Băm mật khẩu bằng scrypt với salt ngẫu nhiên 16 bytes
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Mật khẩu không hợp lệ');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Kiểm tra mật khẩu đối chiếu với hash lưu trữ
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof password !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  if (!storedHash.includes(':')) return false;

  const [salt, key] = storedHash.split(':');
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const keyBuffer = Buffer.from(key, 'hex');
    if (derivedKey.length !== keyBuffer.length) return false;
    return crypto.timingSafeEqual(derivedKey, keyBuffer);
  } catch (_) {
    return false;
  }
}

/**
 * Ký JWT token (HS256)
 */
function signToken(payload, expiresInSeconds = config.JWT_EXPIRES_IN) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const iat = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();

  const fullPayload = { ...payload, iat, exp, jti,
    iss: process.env.JWT_ISSUER || undefined, aud: process.env.JWT_AUDIENCE || undefined };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Xác thực JWT token
 */
function verifyToken(token, db = null) {
  if (!token || typeof token !== 'string') return null;

  // 1. Kiểm tra blacklist trong bộ nhớ
  if (tokenBlacklist.has(token)) return null;

  // 2. Kiểm tra blacklist bền vững trong SQLite (nếu có DB)
  if (db) {
    try {
      const row = db.get('SELECT token FROM token_blacklist WHERE token = ?;', token);
      if (row) {
        tokenBlacklist.add(token);
        return null;
      }
    } catch (_) {
      return null;
    }
  }

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;

  let expectedSignature;
  try {
    expectedSignature = crypto
      .createHmac('sha256', config.JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  } catch (_) {
    return null;
  }

  // Chống timing attack khi so khớp signature
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Date.now() / 1000;
    if (JSON.parse(base64UrlDecode(encodedHeader)).alg !== 'HS256' ||
        !Number.isFinite(payload.exp) || payload.exp <= now ||
        typeof payload.userId !== 'string' || !payload.userId ||
        !['DRIVER', 'PASSENGER'].includes(payload.role) ||
        (process.env.JWT_ISSUER && payload.iss !== process.env.JWT_ISSUER) ||
        (process.env.JWT_AUDIENCE && payload.aud !== process.env.JWT_AUDIENCE)) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Đưa token vào danh sách đen (khi đăng xuất), lưu bền vững vào SQLite
 */
function revokeToken(token, db = null) {
  if (token && typeof token === 'string') {
    tokenBlacklist.add(token);
    if (db) {
      try {
        let exp = null;
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const p = JSON.parse(base64UrlDecode(parts[1]));
            exp = p.exp || null;
          }
        } catch (_) {}

        db.run(
          'INSERT OR IGNORE INTO token_blacklist (token, expires_at) VALUES (?, ?);',
          token,
          exp
        );
      } catch (_) {}
    }
    return true;
  }
  return false;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  revokeToken,
};
