'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');

function limitConfig(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

function clientIp(req, key) {
  const ip = req.headers['x-ds03-client-ip'];
  const signature = req.headers['x-ds03-client-signature'];
  if (key && typeof ip === 'string' && isIP(ip) && typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature)) {
    const expected = createHmac('sha256', key).update(ip).digest();
    if (timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return ip;
  }
  return req.socket.remoteAddress || 'unknown';
}

function authLimiter(db, config = {}) {
  const windowMs = config.windowMs ?? limitConfig('AUTH_RATE_WINDOW_MS', 60_000);
  const ipLimit = config.ipLimit ?? limitConfig('AUTH_RATE_IP_LIMIT', 60);
  const accountLimit = config.accountLimit ?? limitConfig('AUTH_RATE_ACCOUNT_LIMIT', 10);
  const registerLimit = config.registerLimit ?? limitConfig('AUTH_RATE_REGISTER_LIMIT', 20);
  const now = config.now ?? Date.now;
  const key = config.key ?? process.env.RATE_PROXY_KEY;
  return (action, req, email) => {
    const timestamp = now();
    const ip = clientIp(req, key).replace(/^::ffff:(?=\d)/, '');
    const buckets = [[`${action}:ip:${ip}`, action === 'login' ? ipLimit : registerLimit]];
    if (action === 'login' && typeof email === 'string') {
      const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
      buckets.push([`login:account:${digest}`, accountLimit]);
    }
    return db.tx(() => {
      db.run('DELETE FROM auth_rate_buckets WHERE expires_at <= ?', timestamp);
      // Consume the IP budget before creating any account bucket for this request.
      for (const [bucket, limit] of buckets) {
        const count = db.get('SELECT attempts, expires_at FROM auth_rate_buckets WHERE bucket = ?', bucket);
        if (count?.attempts >= limit) return Math.ceil((count.expires_at - timestamp) / 1000);
        db.run(`INSERT INTO auth_rate_buckets VALUES (?, 1, ?)
          ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1`, bucket, timestamp + windowMs);
      }
      return 0;
    });
  };
}

module.exports = { authLimiter };
