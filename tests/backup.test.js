import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const run = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/backup-sqlite.js', ...args], { encoding: 'utf8' });

test('backup includes committed WAL data and refuses to overwrite', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exam-backup-'));
  const source = path.join(dir, 'source.sqlite');
  const copy = path.join(dir, 'copy.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES (\'saved\');');
    assert.equal(run(source, copy).status, 0);
    const result = new DatabaseSync(copy, { readOnly: true });
    assert.equal(result.prepare('SELECT value FROM records').get().value, 'saved');
    result.close();
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.notEqual(run(source, copy).status, 0);
    assert.notEqual(run(path.join(dir, 'missing.sqlite'), path.join(dir, 'missing-copy.sqlite')).status, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
