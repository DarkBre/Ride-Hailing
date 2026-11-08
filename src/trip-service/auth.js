'use strict';

const crypto = require('node:crypto');
const config = require('./config');

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Xác thực JWT token trên Trip Service
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

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

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }
    return payload;
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
  if (internalKey && internalKey === config.INTERNAL_KEY) {
    return { isInternal: true, role: 'INTERNAL' };
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
        role: decoded.role,
      };
    }
    return { isInvalidToken: true };
  }

  return null;
}

module.exports = {
  verifyToken,
  extractCaller,
};
