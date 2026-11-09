'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  LOGS_DIR,
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Khóa bảo mật
  JWT_SECRET: process.env.JWT_SECRET || randomBytes(32).toString('hex'),
  INTERNAL_KEY: process.env.INTERNAL_KEY || randomBytes(32).toString('hex'),

  // Cổng các Microservices (theo kiến trúc 9 tiến trình)
  PORTS: {
    broker: Number(process.env.PORT_BROKER || 4000),
    identity: Number(process.env.PORT_IDENTITY || 4001),
    driver: Number(process.env.PORT_DRIVER || 4002),
    trip: Number(process.env.PORT_TRIP || 4003),
    matching: Number(process.env.PORT_MATCHING || 4004),
    pricing: Number(process.env.PORT_PRICING || 4005),
    payment: Number(process.env.PORT_PAYMENT || 4006),
    notification: Number(process.env.PORT_NOTIFICATION || 4007),
    gateway: Number(process.env.PORT_GATEWAY || 8080),
  },

  // Địa chỉ gọi nội bộ giữa các service
  URLS: {
    broker: process.env.URL_BROKER || 'http://127.0.0.1:4000',
    identity: process.env.URL_IDENTITY || 'http://127.0.0.1:4001',
    driver: process.env.URL_DRIVER || 'http://127.0.0.1:4002',
    trip: process.env.URL_TRIP || 'http://127.0.0.1:4003',
    matching: process.env.URL_MATCHING || 'http://127.0.0.1:4004',
    pricing: process.env.URL_PRICING || 'http://127.0.0.1:4005',
    payment: process.env.URL_PAYMENT || 'http://127.0.0.1:4006',
    notification: process.env.URL_NOTIFICATION || 'http://127.0.0.1:4007',
    gateway: process.env.URL_GATEWAY || 'http://127.0.0.1:8080',
  },

  // Đường dẫn database cho từng service
  getDbPath(serviceName) {
    return path.join(DATA_DIR, `${serviceName}.db`);
  },

  // Đường dẫn file log cho từng service
  getLogPath(serviceName) {
    return path.join(LOGS_DIR, `${serviceName}.log`);
  },
};
