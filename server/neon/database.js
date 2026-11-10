/** Foundation for Neon support. Not used by the app until the SQLite data
 * layer and request handlers have been converted to asynchronous operations. */
import fs from 'node:fs';
import pg from 'pg';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Initialize an empty Postgres database in a single transaction.
 * A caller must await this before accepting application requests. */
export async function initializeNeon(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize schema setup if two instances happen to start simultaneously.
    await client.query('SELECT pg_advisory_xact_lock($1)', [72361948]);
    await client.query(schema);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Create a bounded pool. Connection strings are intentionally never logged. */
export function createNeonPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for Neon storage.');
  return new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
}
