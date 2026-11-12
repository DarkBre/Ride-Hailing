'use strict';

const crypto = require('node:crypto');
const config = require('./config');

function base64UrlDecode(value) {
  let str = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function safeCompare(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = crypto.createHash('sha256').update(left).digest();
  const b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;

  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (!header || header.alg !== 'HS256') return null;

    const expected = crypto
      .createHmac('sha256', config.JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    const providedBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (config.JWT_ISSUER && payload.iss !== config.JWT_ISSUER) return null;
    if (config.JWT_AUDIENCE && payload.aud !== config.JWT_AUDIENCE) return null;

    const userId = payload.userId || payload.user_id || payload.sub;
    if (typeof userId !== 'string' || userId.length === 0) return null;
    return { userId, role: payload.role || null, email: payload.email || null };
  } catch (_) {
    return null;
  }
}

function isInternalRequest(req) {
  return safeCompare(req.headers?.['x-internal-key'], config.INTERNAL_KEY);
}

function extractToken(req, url) {
  const header = req.headers?.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return url?.searchParams?.get('token') || null;
}

/**
 * Returns { internal: true } for service-to-service calls, or
 * { internal: false, userId } for an authenticated user. Null means unauthenticated.
 */
function authenticateRequest(req, url) {
  if (isInternalRequest(req)) return { internal: true, userId: null };
  const user = verifyJwt(extractToken(req, url));
  if (!user) return null;
  return { internal: false, userId: user.userId, user };
}

module.exports = {
  verifyJwt,
  isInternalRequest,
  authenticateRequest,
  safeCompare,
};
