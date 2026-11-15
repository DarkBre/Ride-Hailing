'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const config = require('./config');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool(config.POSTGRES);
    pool.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] [payment-service] [ERROR] PostgreSQL idle client error:`, err.message);
    });
  }
  return pool;
}

async function initDb() {
  const currentPool = getPool();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  const client = await currentPool.connect();
  try {
    await client.query(schemaSql);
  } finally {
    client.release();
  }
}

/**
 * Execute a callback within an isolated PostgreSQL transaction
 */
async function withTransaction(work) {
  const client = await getPool().connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      discard = true;
    }
    throw err;
  } finally {
    client.release(discard);
  }
}

async function healthCheck() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  initDb,
  withTransaction,
  healthCheck,
  closeDb,
};
