'use strict';

const path = require('node:path');

const PORT = Number(process.env.PORT || process.env.PORT_TRIP || 8003);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'trip_db.sqlite');

module.exports = {
  SERVICE_NAME: 'trip-service',
  PORT,
  DB_PATH,
  JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret-key-ds03-2026',
  INTERNAL_KEY: process.env.INTERNAL_KEY || 'dev-internal-service-key-ds03',
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Cấu hình định giá cơ sở
  PRICING: {
    BASE_FARE: Number(process.env.BASE_FARE || 15000),      // 15,000 VND
    PER_KM_RATE: Number(process.env.PER_KM_RATE || 10000),  // 10,000 VND / km
    MIN_SURGE: 1.0,
    MAX_SURGE: 2.5,
  },

  // Địa chỉ gọi các microservices khác
  SERVICES: {
    broker: process.env.URL_BROKER || 'http://127.0.0.1:4000',
    identity: process.env.URL_IDENTITY || 'http://127.0.0.1:8001',
    driver: process.env.URL_DRIVER || 'http://127.0.0.1:8002',
    matching: process.env.URL_MATCHING || 'http://127.0.0.1:8004',
    payment: process.env.URL_PAYMENT || 'http://127.0.0.1:8005',
  },
};
