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

const JWT_SECRET = selectSecret('JWT_SECRET', DEV_JWT_SECRET, KNOWN_DEV_JWT_SECRETS);
const INTERNAL_KEY = selectSecret('INTERNAL_KEY', DEV_INTERNAL_KEY, KNOWN_DEV_INTERNAL_KEYS);

module.exports = {
  SERVICE_NAME: 'payment-service',
  PORT: Number(process.env.PAYMENT_SERVICE_PORT || process.env.PORT || 8005),
  NODE_ENV,
  IS_PRODUCTION,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  POSTGRES: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.PAYMENT_DB_NAME || 'payment_db',
    user: process.env.POSTGRES_USER || 'payment_service',
    password: process.env.PAYMENT_DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'payment_secret_password',
    max: Number(process.env.PG_MAX_POOL || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  },

  RABBITMQ: {
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    exchange: process.env.RABBITMQ_EXCHANGE || 'trip.exchange',
    dlx: process.env.RABBITMQ_DLX || 'trip.dlx',
    dlq: process.env.RABBITMQ_DLQ || 'trip.dlq',
    queue: 'payment.queue',
    prefetch: Number(process.env.RABBITMQ_PREFETCH || 10),
    maxRetries: 3,
    retryDelays: [1000, 2000, 4000],
  },

  IDENTITY_URL: process.env.IDENTITY_URL || process.env.URL_IDENTITY || 'http://localhost:8001',
  INTERNAL_KEY,
  JWT_SECRET,
  JWT_ISSUER: process.env.JWT_ISSUER || '',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || '',
  IDENTITY_TIMEOUT_MS: Number(process.env.IDENTITY_TIMEOUT_MS || 2000),
  OUTBOX_POLL_INTERVAL_MS: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 250),
};
