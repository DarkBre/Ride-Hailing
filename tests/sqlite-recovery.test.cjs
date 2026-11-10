const assert = require('node:assert/strict');
const { DatabaseSync, backup } = require('node:sqlite');
const { mkdtemp, open, stat, copyFile, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { test } = require('node:test');

test('online SQLite backup includes committed WAL data and a corrupted copy is rejected', async t => {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'ds03-sqlite-recovery-'));
  const sourcePath = join(directory, 'source.sqlite');
  const archivePath = join(directory, 'archive.sqlite');
  const source = new DatabaseSync(sourcePath);
  t.after(async () => {
    source.close();
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), tempRoot);
    await rm(resolved, { recursive: true });
  });
  source.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO bookings VALUES (1, 'ACCEPTED'), (2, 'CANCELLED');
  `);
  assert.ok((await stat(sourcePath + '-wal')).size > 32);
  await backup(source, archivePath);

  const restored = new DatabaseSync(archivePath, { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restored.prepare('SELECT status FROM bookings ORDER BY id').all().map(row => row.status),
      ['ACCEPTED', 'CANCELLED']);
  } finally {
    restored.close();
  }

  const corruptPath = join(directory, 'corrupt.sqlite');
  await copyFile(archivePath, corruptPath);
  const corruptFile = await open(corruptPath, 'r+');
  try {
    await corruptFile.write(Buffer.alloc(32), 0, 32, 0);
  } finally {
    await corruptFile.close();
  }
  const corrupt = new DatabaseSync(corruptPath, { readOnly: true });
  try {
    assert.throws(() => corrupt.prepare('PRAGMA integrity_check').get(), /not a database/i);
  } finally {
    corrupt.close();
  }
});
