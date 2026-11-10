import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeonPool, initializeNeon } from '../server/neon/database.js';

test('Neon schema initialization commits atomically and releases its connection', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); }, release: () => calls.push('RELEASE') };
  await initializeNeon({ connect: async () => client });
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.match(calls[2], /CREATE TABLE IF NOT EXISTS sessions/);
  assert.deepEqual(calls.slice(-2), ['COMMIT', 'RELEASE']);
});

test('Neon schema initialization rolls back on failure', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); if (sql.includes('CREATE TABLE')) throw new Error('schema failed'); }, release: () => calls.push('RELEASE') };
  await assert.rejects(initializeNeon({ connect: async () => client }), /schema failed/);
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'RELEASE']);
});

test('Neon pool requires a connection string', () => {
  assert.throws(() => createNeonPool(''), /DATABASE_URL/);
});
