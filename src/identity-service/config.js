'use strict';

const path = require('node:path');

const PORT = Number(process.env.PORT || process.env.PORT_IDENTITY || 8001);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'user_db.sqlite');

module.exports = {
  SERVICE_NAME: 'identity-service',
  PORT,
  DB_PATH,
  JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret-key-ds03-2026',
  JWT_EXPIRES_IN: Number(process.env.JWT_EXPIRES_IN || 86400), // 24 giờ
  INTERNAL_KEY: process.env.INTERNAL_KEY || 'dev-internal-service-key-ds03',
  NODE_ENV: process.env.NODE_ENV || 'development',
};
