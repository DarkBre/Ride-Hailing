'use strict';

const crypto = require('node:crypto');
const config = require('./config');

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * So sánh chuỗi bí mật an toàn chống timing attack
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
 * Xác thực JWT token trên Trip Service (HS256, kiểm tra claims & mốc now >= exp)
 */
function verifyToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;

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

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return null;
    }
    if (nowSeconds >= payload.exp) {
      return null;
    }
    const resolvedUserId = payload.userId || payload.user_id || payload.sub;
    if (!resolvedUserId || typeof resolvedUserId !== 'string' || !payload.role || typeof payload.role !== 'string') {
      return null;
    }
    return {
      ...payload,
      userId: resolvedUserId,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Trích xuất người gọi (Caller identity) từ headers
 */
function extractCaller(headers) {
  if (!headers) return null;

  const internalKey = headers['x-internal-key'];
  if (internalKey) {
    if (safeCompare(internalKey, config.INTERNAL_KEY)) {
      return { isInternal: true, role: 'INTERNAL' };
    }
    return { isInvalidInternalKey: true };
  }

  const authHeader = headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (decoded) {
      return {
        isInternal: false,
        userId: decoded.userId,
        email: decoded.email,
        role: String(decoded.role).toUpperCase(),
      };
    }
    return { isInvalidToken: true };
  }

  return null;
}

module.exports = {
  safeCompare,
  verifyToken,
  extractCaller,
};
