/** Create a consistent SQLite backup before moving exam data to another database. */
import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) {
  console.error('Usage: node --disable-warning=ExperimentalWarning tools/backup-sqlite.js SOURCE.sqlite DESTINATION.sqlite');
  process.exit(1);
}
const source = path.resolve(sourceArg);
const destination = path.resolve(destinationArg);
if (!existsSync(source)) {
  console.error('Source database does not exist. No backup was created.');
  process.exit(1);
}
let reserved = false;
let database;
try {
  // Exclusive creation prevents overwriting an earlier backup. Restrict access:
  // the database contains student records, password hashes and login tokens.
  closeSync(openSync(destination, 'wx', 0o600));
  reserved = true;
  database = new DatabaseSync(source, { readOnly: true });
  await backup(database, destination);
  console.log('SQLite backup created. Store it securely; it contains private records.');
} catch (err) {
  if (reserved) { try { unlinkSync(destination); } catch {} }
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  database?.close();
}
