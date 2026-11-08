'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

function openDatabase(serviceName, schemaSql = '') {
  const dbPath = config.getDbPath(serviceName);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Bật chế độ WAL để tăng tốc ghi và an toàn cho đa luồng
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  if (schemaSql && schemaSql.trim().length > 0) {
    db.exec(schemaSql);
  }

  return {
    raw: db,

    exec(sql) {
      return db.exec(sql);
    },

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
  openDatabase,
};
