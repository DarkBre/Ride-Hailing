'use strict';

const path = require('node:path');

const PORT = Number(process.env.IDENTITY_SERVICE_PORT || process.env.PORT || process.env.PORT_IDENTITY || 8001);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'user_db.sqlite');

const DEFAULT_JWT_SECRET = 'dev-jwt-secret-key-ds03-2026';
const DEFAULT_INTERNAL_KEY = 'dev-internal-service-key-ds03';

const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const INTERNAL_KEY = process.env.INTERNAL_KEY || DEFAULT_INTERNAL_KEY;

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    throw new Error('FATAL: JWT_SECRET bảo mật (>= 16 ký tự, khác mặc định) bắt buộc phải thiết lập trong production!');
  }
  if (!process.env.INTERNAL_KEY || process.env.INTERNAL_KEY === DEFAULT_INTERNAL_KEY || process.env.INTERNAL_KEY.length < 16) {
    throw new Error('FATAL: INTERNAL_KEY bảo mật (>= 16 ký tự, khác mặc định) bắt buộc phải thiết lập trong production!');
  }
}

module.exports = {
  SERVICE_NAME: 'identity-service',
  PORT,
  DB_PATH,
  JWT_SECRET,
  JWT_EXPIRES_IN: Number(process.env.JWT_EXPIRES_IN || 86400), // 24 giờ
  JWT_ISSUER: process.env.JWT_ISSUER || '',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || '',
  INTERNAL_KEY,
  NODE_ENV: process.env.NODE_ENV || 'development',
};
