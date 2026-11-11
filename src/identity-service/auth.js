'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const tokenBlacklist = new Set(); // Chỉ lưu token hash (SHA-256)

/**
 * Băm token bằng SHA-256 trước khi lưu vào blacklist (tránh lưu raw JWT)
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * So sánh chuỗi bí mật an toàn chống timing attack (băm cố định 32 bytes trước khi timingSafeEqual)
 */
function safeCompare(provided, expected) {
  if (!provided || !expected || typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const h1 = crypto.createHash('sha256').update(provided).digest();
  const h2 = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(h1, h2);
}

/**
 * Dọn dẹp các bản ghi blacklist đã hết hạn theo trường expires_at
 */
function cleanupExpiredBlacklist(db, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!db) return 0;
  try {
    const res = db.run(
      'DELETE FROM token_blacklist WHERE expires_at IS NOT NULL AND expires_at <= ?;',
      nowSeconds
    );
    return res ? res.changes || 0 : 0;
  } catch (_) {
    return 0;
  }
}

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

  const fullPayload = { ...payload, iat, exp, jti };

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
function verifyToken(token, db = null, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') return null;

  const tokenHash = hashToken(token);

  // 1. Kiểm tra blacklist trong bộ nhớ (bằng hash)
  if (tokenBlacklist.has(tokenHash)) return null;

  // 2. Kiểm tra blacklist bền vững trong SQLite (bằng hash, nếu có DB)
  if (db) {
    try {
      const row = db.get('SELECT token_hash FROM token_blacklist WHERE token_hash = ?;', tokenHash);
      if (row) {
        tokenBlacklist.add(tokenHash);
        return null;
      }
    } catch (_) {}
  }

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;

  // Kiểm tra header thuật toán HS256 (chặn alg=none hoặc sai thuật toán)
  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (!header || header.alg !== 'HS256') {
      return null;
    }
  } catch (_) {
    return null;
  }

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
    if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return null; // Thiếu claim exp hợp lệ
    }
    if (nowSeconds >= payload.exp) {
      return null; // Hết hạn tại đúng mốc now >= exp (RFC 7519 Section 4.1.4)
    }
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Đưa hash của token vào danh sách đen (khi đăng xuất), lưu bền vững vào SQLite và dọn bản ghi hết hạn
 */
function revokeToken(token, db = null) {
  if (token && typeof token === 'string') {
    const tokenHash = hashToken(token);
    tokenBlacklist.add(tokenHash);
    if (db) {
      try {
        let exp = null;
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const p = JSON.parse(base64UrlDecode(parts[1]));
            exp = typeof p.exp === 'number' ? p.exp : null;
          }
        } catch (_) {}

        cleanupExpiredBlacklist(db);
        db.run(
          'INSERT OR IGNORE INTO token_blacklist (token_hash, expires_at) VALUES (?, ?);',
          tokenHash,
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
  hashToken,
  safeCompare,
  cleanupExpiredBlacklist,
  signToken,
  verifyToken,
  revokeToken,
};
