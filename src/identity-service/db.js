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

  // Cấu hình tối ưu và toàn vẹn
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  // Khởi tạo bảng users theo chuẩn CONTRACTS.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL CHECK (role IN ('PASSENGER', 'DRIVER')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- Bảng lưu trữ token đã thu hồi (Persistent Blacklist)
    CREATE TABLE IF NOT EXISTS token_blacklist (
      token TEXT PRIMARY KEY,
      revoked_at TEXT DEFAULT (datetime('now')),
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at);
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
      if (this._txDepth === undefined) this._txDepth = 0;
      const isTopLevel = this._txDepth === 0;

      if (isTopLevel) {
        db.exec('BEGIN IMMEDIATE;');
      }
      this._txDepth++;

      try {
        const result = fn();
        this._txDepth--;
        if (isTopLevel) {
          db.exec('COMMIT;');
        }
        return result;
      } catch (err) {
        this._txDepth--;
        if (isTopLevel) {
          try {
            db.exec('ROLLBACK;');
          } catch (_) {}
        }
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
