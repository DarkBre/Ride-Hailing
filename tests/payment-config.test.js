'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const STRONG = 'x'.repeat(32);

function loadConfig(envOverrides) {
  return spawnSync(
    process.execPath,
    ['-e', "require('./src/payment-service/config')"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        JWT_SECRET: '',
        INTERNAL_KEY: '',
        ...envOverrides,
      },
      encoding: 'utf8',
    }
  );
}

test('Payment config fails closed in production when secrets are missing', () => {
  const result = loadConfig({ NODE_ENV: 'production' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /FATAL: JWT_SECRET|FATAL: INTERNAL_KEY/);
});

test('Payment config rejects known development secrets in production', () => {
  const result = loadConfig({
    NODE_ENV: 'production',
    JWT_SECRET: 'dev-jwt-secret-key-ds03-2026',
    INTERNAL_KEY: 'ds03-internal-secret-dev',
  });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /FATAL:/);
});

test('Payment config accepts strong secrets in production', () => {
  const result = loadConfig({
    NODE_ENV: 'production',
    JWT_SECRET: STRONG,
    INTERNAL_KEY: STRONG,
  });
  assert.strictEqual(result.status, 0, result.stderr);
});

test('Payment config keeps explicit development fallback usable', () => {
  const result = loadConfig({ NODE_ENV: 'development' });
  assert.strictEqual(result.status, 0, result.stderr);
});
