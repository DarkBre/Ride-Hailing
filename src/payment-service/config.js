'use strict';

module.exports = {
  SERVICE_NAME: 'payment-service',
  PORT: Number(process.env.PAYMENT_SERVICE_PORT || process.env.PORT || 8005),
  NODE_ENV: process.env.NODE_ENV || 'development',
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
  INTERNAL_KEY: process.env.INTERNAL_KEY || 'dev-internal-service-key-ds03',
  OUTBOX_POLL_INTERVAL_MS: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 250),
};
