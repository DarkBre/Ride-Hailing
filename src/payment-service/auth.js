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

function unauthorized(message = 'Missing or invalid authentication token') {
  const err = new Error(message);
  err.status = 401;
  err.code = 'UNAUTHORIZED';
  return err;
}

function forbidden(message = 'You are not allowed to access another user wallet') {
  const err = new Error(message);
  err.status = 403;
  err.code = 'FORBIDDEN';
  return err;
}

/**
 * Xác thực JWT HS256 cục bộ. Bắt buộc kiểm tra chữ ký, alg và exp.
 */
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
    if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) {
      return null;
    }
    if (config.JWT_ISSUER && payload.iss !== config.JWT_ISSUER) return null;
    if (config.JWT_AUDIENCE && payload.aud !== config.JWT_AUDIENCE) return null;

    const id = payload.userId || payload.user_id || payload.sub;
    if (typeof id !== 'string' || id.length === 0) return null;

    return {
      id,
      email: payload.email || null,
      role: payload.role || null,
      claims: payload,
    };
  } catch (_) {
    return null;
  }
}

function extractBearer(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Gọi Identity Service để tôn trọng token blacklist (logout).
 * Trả về { status: 'valid'|'invalid'|'unavailable', user }.
 */
async function lookupIdentity(token, correlationId = '') {
  try {
    const url = new URL('/internal/verify-token', config.IDENTITY_URL);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': config.INTERNAL_KEY,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(config.IDENTITY_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return { status: 'unavailable', user: null };
    }
    if (!response.ok) {
      return { status: 'unavailable', user: null };
    }

    const body = await response.json();
    const data = body?.data || body;
    if (!data || data.valid !== true || !data.user || typeof data.user.id !== 'string') {
      return { status: 'invalid', user: null };
    }
    return {
      status: 'valid',
      user: {
        id: data.user.id,
        email: data.user.email || null,
        role: data.user.role || null,
      },
    };
  } catch (_) {
    return { status: 'unavailable', user: null };
  }
}

/**
 * Xác thực request người dùng. Ưu tiên Identity Service để kiểm tra blacklist;
 * nếu Identity không sẵn sàng thì fallback xác thực chữ ký HS256 + exp cục bộ.
 */
async function resolveRequestUser(req, deps = {}) {
  const token = extractBearer(req);
  if (!token) return null;

  const local = verifyJwt(token);
  if (!local) return null;

  const identityLookup = deps.identityLookup || lookupIdentity;
  const identity = await identityLookup(token, req.headers?.['x-correlation-id'] || '');
  if (identity.status === 'valid') return identity.user;
  if (identity.status === 'invalid') return null;

  return local;
}

function isInternalRequest(req) {
  return safeCompare(req.headers?.['x-internal-key'], config.INTERNAL_KEY);
}

/**
 * Trả về user_id mục tiêu cho thao tác ví.
 * - Request nội bộ có X-Internal-Key hợp lệ được phép chỉ định user_id (seed/script).
 * - Request người dùng chỉ được thao tác trên ví của chính mình.
 */
async function resolveWalletTarget(req, requestedUserId = null, deps = {}) {
  if (isInternalRequest(req)) {
    if (!requestedUserId || typeof requestedUserId !== 'string') {
      throw unauthorized('Internal wallet request requires user_id');
    }
    return { userId: requestedUserId, internal: true };
  }

  const user = await resolveRequestUser(req, deps);
  if (!user) throw unauthorized();

  if (requestedUserId && requestedUserId !== user.id) {
    throw forbidden();
  }

  return { userId: user.id, internal: false, user };
}

module.exports = {
  verifyJwt,
  resolveRequestUser,
  resolveWalletTarget,
  isInternalRequest,
  lookupIdentity,
  safeCompare,
  unauthorized,
  forbidden,
};
