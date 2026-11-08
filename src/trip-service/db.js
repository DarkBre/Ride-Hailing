'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

function initDatabase(customDbPath = null) {
  const dbPath = customDbPath || config.DB_PATH;
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Cấu hình tối ưu và bảo đảm tính toàn vẹn
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  // 1. Bảng trips (theo CONTRACTS.md Section 4.3)
  db.exec(`
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      passenger_id TEXT NOT NULL,
      driver_id TEXT,
      pickup_latitude REAL NOT NULL,
      pickup_longitude REAL NOT NULL,
      pickup_address TEXT,
      dropoff_latitude REAL NOT NULL,
      dropoff_longitude REAL NOT NULL,
      dropoff_address TEXT,
      distance_km REAL NOT NULL,
      fare REAL NOT NULL,
      surge_multiplier REAL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'REQUESTED' 
        CHECK (status IN ('REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'CONFIRMED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
      cancellation_reason TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trips_passenger ON trips(passenger_id);
    CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
    CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
    CREATE INDEX IF NOT EXISTS idx_trips_idempotency ON trips(idempotency_key);
  `);

  // 2. Bảng outbox_events (Transactional Outbox Pattern)
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      published_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status);
  `);

  // 3. Bảng processed_events (Chống xử lý trùng lặp / Idempotent Consumers)
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 4. Bảng saga_instances (Lưu trạng thái giao dịch phân tán Saga bền vững)
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga_instances (
      saga_id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL UNIQUE,
      current_step TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('STARTED', 'MATCHED', 'HOLDING_PAYMENT', 'CONFIRMED', 'COMPENSATING', 'COMPENSATED', 'FAILED')),
      correlation_id TEXT NOT NULL,
      payload TEXT,
      error_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_saga_trip ON saga_instances(trip_id);
    CREATE INDEX IF NOT EXISTS idx_saga_status ON saga_instances(status);
  `);

  return {
    raw: db,

    get(sql, ...params) {
      const stmt = db.prepare(sql);
      return stmt.get(...params);
    },

    all(sql, ...params) {
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },

    run(sql, ...params) {
      const stmt = db.prepare(sql);
      return stmt.run(...params);
    },

    tx(fn) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const result = fn();
        db.exec('COMMIT;');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch (_) {}
        throw err;
      }
    },

    close() {
      try {
        db.close();
      } catch (_) {}
    },
  };
}

module.exports = {
  initDatabase,
};
