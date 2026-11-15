'use strict';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const DEV_JWT_SECRET = 'dev-jwt-secret-key-ds03-2026';
const DEV_INTERNAL_KEY = 'dev-internal-service-key-ds03';
const KNOWN_DEV_JWT_SECRETS = new Set([DEV_JWT_SECRET, 'super-secret-jwt-key-distributed-systems-2026']);
const KNOWN_DEV_INTERNAL_KEYS = new Set([DEV_INTERNAL_KEY, 'ds03-internal-secret-dev']);

function selectSecret(name, fallback, knownDevValues) {
  const value = process.env[name];
  if (IS_PRODUCTION) {
    if (!value || value.length < 16 || knownDevValues.has(value)) {
      throw new Error(`FATAL: ${name} must be a non-default secret of at least 16 characters in production`);
    }
    return value;
  }
  return value || fallback;
}

module.exports = {
  SERVICE_NAME: 'notification-service',
  NODE_ENV,
  IS_PRODUCTION,
  PORT: Number(process.env.NOTIFICATION_SERVICE_PORT || process.env.PORT || 8006),
  JWT_SECRET: selectSecret('JWT_SECRET', DEV_JWT_SECRET, KNOWN_DEV_JWT_SECRETS),
  JWT_ISSUER: process.env.JWT_ISSUER || '',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || '',
  INTERNAL_KEY: selectSecret('INTERNAL_KEY', DEV_INTERNAL_KEY, KNOWN_DEV_INTERNAL_KEYS),
  RABBITMQ: {
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    exchange: process.env.RABBITMQ_EXCHANGE || 'trip.exchange',
    dlx: process.env.RABBITMQ_DLX || 'trip.dlx',
    dlq: process.env.RABBITMQ_DLQ || 'trip.dlq',
    queue: process.env.NOTIFICATION_QUEUE || 'notification.queue',
    prefetch: Number(process.env.RABBITMQ_PREFETCH || 10),
  },
  GATEWAY_URL: process.env.GATEWAY_URL || 'http://localhost:8080',
  RECONNECT_BASE_MS: Number(process.env.RABBITMQ_RECONNECT_BASE_MS || 1000),
  RECONNECT_MAX_MS: Number(process.env.RABBITMQ_RECONNECT_MAX_MS || 30000),
};
