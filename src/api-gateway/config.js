'use strict';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const DEV_JWT_SECRET = 'dev-jwt-secret-key-ds03-2026';
const DEV_INTERNAL_KEY = 'dev-internal-service-key-ds03';
const KNOWN_DEV_JWT_SECRETS = new Set([DEV_JWT_SECRET, 'super-secret-jwt-key-distributed-systems-2026']);
const KNOWN_DEV_INTERNAL_KEYS = new Set([DEV_INTERNAL_KEY, 'ds03-internal-secret-dev']);
const DEV_DRIVER_INTERNAL_KEY = 'ds03-driver-internal-secret-dev';
const KNOWN_DEV_DRIVER_INTERNAL_KEYS = new Set([DEV_DRIVER_INTERNAL_KEY, DEV_INTERNAL_KEY]);

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
  SERVICE_NAME: 'api-gateway',
  PORT: Number(process.env.GATEWAY_PORT || process.env.PORT || 8080),
  NODE_ENV,
  IS_PRODUCTION,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  SERVICES: {
    identity: process.env.IDENTITY_URL || process.env.URL_IDENTITY || 'http://localhost:8001',
    driver: process.env.DRIVER_URL || process.env.URL_DRIVER || 'http://localhost:8002',
    trip: process.env.TRIP_URL || process.env.URL_TRIP || 'http://localhost:8003',
    matching: process.env.MATCHING_URL || process.env.URL_MATCHING || 'http://localhost:8004',
    payment: process.env.PAYMENT_URL || process.env.URL_PAYMENT || 'http://localhost:8005',
    notification: process.env.NOTIFICATION_URL || process.env.URL_NOTIFICATION || 'http://localhost:8006',
    dashboard: process.env.DASHBOARD_URL || 'http://localhost:3000',
  },

  INTERNAL_KEY: selectSecret('INTERNAL_KEY', DEV_INTERNAL_KEY, KNOWN_DEV_INTERNAL_KEYS),
  DRIVER_INTERNAL_KEY: selectSecret('DRIVER_INTERNAL_KEY', DEV_DRIVER_INTERNAL_KEY, KNOWN_DEV_DRIVER_INTERNAL_KEYS),
  JWT_SECRET: selectSecret('JWT_SECRET', DEV_JWT_SECRET, KNOWN_DEV_JWT_SECRETS),
  JWT_ISSUER: process.env.JWT_ISSUER || '',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || '',
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 8000),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
};
