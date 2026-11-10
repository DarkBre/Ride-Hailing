'use strict';

module.exports = {
  SERVICE_NAME: 'api-gateway',
  PORT: Number(process.env.GATEWAY_PORT || process.env.PORT || 8080),
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  SERVICES: {
    identity: process.env.IDENTITY_URL || process.env.URL_IDENTITY || 'http://localhost:8001',
    driver: process.env.DRIVER_URL || process.env.URL_DRIVER || 'http://localhost:8002',
    trip: process.env.TRIP_URL || process.env.URL_TRIP || 'http://localhost:8003',
    matching: process.env.MATCHING_URL || process.env.URL_MATCHING || 'http://localhost:8004',
    payment: process.env.PAYMENT_URL || process.env.URL_PAYMENT || 'http://localhost:8005',
    dashboard: process.env.DASHBOARD_URL || 'http://localhost:3000',
  },

  INTERNAL_KEY: process.env.INTERNAL_KEY || 'dev-internal-service-key-ds03',
  DRIVER_INTERNAL_KEY: process.env.DRIVER_INTERNAL_KEY || process.env.INTERNAL_KEY || 'dev-internal-service-key-ds03',
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 8000),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
};
