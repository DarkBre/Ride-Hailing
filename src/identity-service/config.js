'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');

const PORT = Number(process.env.PORT || process.env.PORT_IDENTITY || 8001);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'user_db.sqlite');

const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.INTERNAL_KEY)) {
  throw new Error('JWT_SECRET and INTERNAL_KEY are required in production');
}

module.exports = {
  SERVICE_NAME: 'identity-service',
  PORT,
  DB_PATH,
  JWT_SECRET,
  JWT_EXPIRES_IN: Number(process.env.JWT_EXPIRES_IN || 86400), // 24 giờ
  INTERNAL_KEY: process.env.INTERNAL_KEY || randomBytes(32).toString('hex'),
  NODE_ENV: process.env.NODE_ENV || 'development',
};
