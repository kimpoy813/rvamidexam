/** PostgreSQL teacher-account primitives for the Render port.
 * Not wired into the Render HTTP server yet. Callers enforce authorization. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const cleanUser = value => String(value || '').trim();
const validToken = value => /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));

async function passwordHash(password, salt) {
  return (await scrypt(String(password), salt, 32)).toString('hex');
}

/** Register with case-insensitive unique usernames and a securely salted password. */
export async function registerTeacher(pool, username, password) {
  username = cleanUser(username);
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw fail(400, 'Invalid username.');
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw fail(400, 'Password must be 10–200 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await passwordHash(password, salt);
  try {
    const { rows } = await pool.query('INSERT INTO teachers(username,pass_hash,salt,created_at) VALUES($1,$2,$3,$4) RETURNING id,username', [username, hash, salt, Date.now()]);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw fail(409, 'That username is already in use.');
    throw err;
  }
}

/** SQLite's scrypt hashes remain compatible if accounts are migrated later. */
export async function verifyTeacher(pool, username, password) {
  if (typeof password !== 'string' || password.length > 200) return null;
  const { rows } = await pool.query('SELECT id,username,pass_hash,salt FROM teachers WHERE lower(username)=lower($1)', [cleanUser(username)]);
  const row = rows[0];
  if (!row || !/^[0-9a-f]{64}$/i.test(row.pass_hash)) return null;
  const actual = Buffer.from(await passwordHash(password, row.salt), 'hex');
  const expected = Buffer.from(row.pass_hash, 'hex');
  return crypto.timingSafeEqual(actual, expected) ? { id: row.id, username: row.username } : null;
}

/** Store only a digest, never the bearer token. */
export async function issueTeacherToken(pool, teacherId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO teacher_tokens(token,teacher_id,created_at) VALUES($1,$2,$3)', [digest(token), teacherId, Date.now()]);
  return token;
}
export async function teacherFromToken(pool, token) {
  if (!validToken(token)) return null;
  const {rows} = await pool.query('SELECT t.id,t.username FROM teachers t JOIN teacher_tokens tt ON tt.teacher_id=t.id WHERE tt.token=$1', [digest(token)]);
  return rows[0] || null;
}
export async function revokeTeacherToken(pool, token) {
  if (validToken(token)) await pool.query('DELETE FROM teacher_tokens WHERE token=$1', [digest(token)]);
}
