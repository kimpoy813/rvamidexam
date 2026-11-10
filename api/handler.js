import pg from 'pg';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { parseAny } from '../server/lib/importer.js';

const scrypt = promisify(crypto.scrypt);
let pool;
let ready;
const id = () => crypto.randomBytes(18).toString('base64url');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const query = async (sql, params = []) => (await pool.query(sql, params));

async function initialize() {
  if (!process.env.DATABASE_URL) throw fail(503, 'DATABASE_URL is not configured on the server.');
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
    pool.on('error', err => console.error('[simple-exam] idle database connection failed:', err.code || err.name));
  }
  if (!ready) ready = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [78293461]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS simple_teachers (id TEXT PRIMARY KEY, username TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE UNIQUE INDEX IF NOT EXISTS simple_teachers_username ON simple_teachers(lower(username));
        CREATE TABLE IF NOT EXISTS simple_teacher_tokens (token_hash TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES simple_teachers(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
        CREATE TABLE IF NOT EXISTS simple_exams (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES simple_teachers(id), title TEXT NOT NULL, code TEXT UNIQUE NOT NULL, duration INTEGER NOT NULL, questions JSONB NOT NULL, open BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS simple_attempts (token_hash TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES simple_exams(id), student_name TEXT NOT NULL, student_no TEXT NOT NULL, answers JSONB NOT NULL DEFAULT '{}'::jsonb, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), deadline TIMESTAMPTZ NOT NULL, submitted_at TIMESTAMPTZ, score INTEGER, total INTEGER);
        CREATE INDEX IF NOT EXISTS simple_attempts_exam ON simple_attempts(exam_id);
        CREATE TABLE IF NOT EXISTS simple_auth_limits (key TEXT PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL);
      `);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally { client.release(); }
  })().catch(err => { ready = null; throw err; });
  await ready;
}

function send(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); }
async function bodyOf(req) {
  // Vercel may pre-parse JSON, while the test server passes a stream.
  if (req.body !== undefined) {
    const data = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(data) > 300000) throw fail(413, 'Request is too large.');
    try { const obj = JSON.parse(data); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw 0; return obj; } catch { throw fail(400, 'Invalid JSON body.'); }
  }
  let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 300000) throw fail(413, 'Request is too large.'); }
  try { const obj = JSON.parse(data || '{}'); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw 0; return obj; } catch { throw fail(400, 'Invalid JSON body.'); }
}
async function teacher(req) {
  const token = String(req.headers['x-teacher-token'] || '');
  if (!/^[\w-]{24,64}$/.test(token)) throw fail(401, 'Please sign in.');
  const { rows } = await query('SELECT t.id, t.username FROM simple_teacher_tokens k JOIN simple_teachers t ON t.id = k.teacher_id WHERE k.token_hash = $1 AND k.expires_at > now()', [hash(token)]);
  if (!rows[0]) throw fail(401, 'Please sign in.');
  return rows[0];
}
async function limit(req, action) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 100);
  const key = hash(`${action}:${ip}`);
  const { rows } = await query(`INSERT INTO simple_auth_limits(key, window_start, attempts) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET window_start = CASE WHEN simple_auth_limits.window_start < now() - interval '15 minutes' THEN now() ELSE simple_auth_limits.window_start END,
    attempts = CASE WHEN simple_auth_limits.window_start < now() - interval '15 minutes' THEN 1 ELSE simple_auth_limits.attempts + 1 END RETURNING attempts`, [key]);
  if (rows[0].attempts > 30) throw fail(429, 'Too many attempts. Try again later.');
}
function parseQuestions(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw fail(400, 'Provide 1 to 100 questions.');
  return input.map((q) => {
    const prompt = String(q.prompt || '').trim();
    if (!prompt || prompt.length > 2000 || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6) throw fail(400, 'Every question needs a prompt and 2–6 choices.');
    const choices = q.choices.map(c => String(c).trim());
    if (choices.some(c => !c || c.length > 500)) throw fail(400, 'Choices must be non-empty and at most 500 characters.');
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= choices.length) throw fail(400, 'Choose a correct answer for every question.');
    return { id: id(), prompt, choices, answer: q.answer };
  });
}
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
  catch (err) { try { await c.query('ROLLBACK'); } catch {} throw err; }
  finally { c.release(); }
}
const publicQuestions = (qs) => qs.map(({ id, prompt, choices }) => ({ id, prompt, choices }));
const score = (qs, answers) => qs.reduce((sum, q) => sum + (answers[q.id] === q.answer ? 1 : 0), 0);
async function lockAttempt(client, token) {
  if (!/^[\w-]{24,64}$/.test(token)) throw fail(404, 'Attempt not found.');
  const r = await client.query('SELECT a.*, e.questions, e.title FROM simple_attempts a JOIN simple_exams e ON e.id = a.exam_id WHERE a.token_hash=$1 FOR UPDATE OF a', [hash(token)]);
  if (!r.rows[0]) throw fail(404, 'Attempt not found.');
  return r.rows[0];
}
async function finalize(client, a) {
  if (a.submitted_at) return a;
  const result = await client.query('UPDATE simple_attempts SET submitted_at=now(), score=$2, total=$3 WHERE token_hash=$1 RETURNING *', [a.token_hash, score(a.questions, a.answers), a.questions.length]);
  return { ...a, ...result.rows[0] };
}

export default async function handler(req, res) {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    await initialize();
    const url = new URL(req.url, 'http://local');
    // The rewrite passes the original route in path; direct function calls can
    // also use /api/simple/... (useful in tests).
    const path = String(req.query?.path || url.searchParams.get('path') || url.pathname.replace(/^\/api\//, '')).replace(/^\/+|\/+$/g, '');
    const method = req.method;
    if (path === 'simple/register' && method === 'POST') {
      await limit(req, 'register'); const b = await bodyOf(req); const username = String(b.username || '').trim(); const password = String(b.password || '');
      if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 10 || password.length > 200) throw fail(400, 'Username must be 3–40 letters, numbers, dots, dashes or underscores; password must be 10–200 characters.');
      const salt = crypto.randomBytes(16).toString('hex'); const pw = (await scrypt(password, salt, 32)).toString('hex');
      try { await query('INSERT INTO simple_teachers(id,username,salt,password_hash) VALUES($1,$2,$3,$4)', [id(), username, salt, pw]); }
      catch (e) { if (e.code === '23505') throw fail(409, 'Username already in use.'); throw e; }
      return send(res, 201, { ok: true });
    }
    if (path === 'simple/login' && method === 'POST') {
      await limit(req, 'login'); const b = await bodyOf(req); const username = String(b.username || '').trim(); const password = String(b.password || '');
      if (username.length > 40 || password.length > 200) throw fail(401, 'Incorrect username or password.');
      const { rows } = await query('SELECT * FROM simple_teachers WHERE lower(username)=lower($1)', [username]);
      const salt = rows[0]?.salt || '00000000000000000000000000000000'; const computed = await scrypt(password, salt, 32); const stored = rows[0] ? Buffer.from(rows[0].password_hash, 'hex') : Buffer.alloc(32);
      if (!rows[0] || stored.length !== computed.length || !crypto.timingSafeEqual(stored, computed)) throw fail(401, 'Incorrect username or password.');
      const token = crypto.randomBytes(32).toString('base64url'); await query("INSERT INTO simple_teacher_tokens(token_hash, teacher_id, expires_at) VALUES($1,$2,now()+interval '12 hours')", [hash(token), rows[0].id]);
      return send(res, 200, { token, username: rows[0].username });
    }
    if (path === 'simple/logout' && method === 'POST') { const t = await teacher(req); await query('DELETE FROM simple_teacher_tokens WHERE token_hash=$1 AND teacher_id=$2', [hash(String(req.headers['x-teacher-token'])), t.id]); return send(res, 200, { ok: true }); }
    if (path === 'simple/me' && method === 'GET') return send(res, 200, await teacher(req));
    if (path === 'simple/import-preview' && method === 'POST') {
      await teacher(req);
      const b = await bodyOf(req);
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 200000) throw fail(400, 'Provide up to 200,000 characters of exam text.');
      let parsed;
      try { parsed = parseAny(b.text); } catch (e) { throw fail(400, `Could not parse import: ${e.message}`); }
      const raw = parsed.sections.flatMap(section => section.questions);
      const unsupported = [];
      const converted = raw.map((q, i) => {
        const choices = Array.isArray(q.choices) ? q.choices.map(c => String(c).trim()) : [];
        const matching = choices.reduce((a, c, j) => c === String(q.answer ?? '').trim() ? [...a, j] : a, []);
        if (!['mcq', 'truefalse'].includes(q.kind) || Number(q.points) !== 1 || matching.length !== 1) unsupported.push(i + 1);
        return { prompt: q.prompt, choices, answer: matching[0] };
      });
      if (unsupported.length) throw fail(400, `Cannot import questions ${unsupported.join(', ')}: only single-answer multiple choice and true/false with one point and an unambiguous answer key are supported. No questions were imported.`);
      // Apply the same limits as exam creation before displaying a preview.
      const questions = parseQuestions(converted).map(({ id, ...q }) => q);
      return send(res, 200, { title: parsed.title, questions, warnings: [...(parsed.warnings || []), 'Sections and section instructions are not retained in this version.'] });
    }
    if (path === 'simple/exams' && method === 'GET') { const t = await teacher(req); const r = await query('SELECT id,title,code,duration,open,created_at FROM simple_exams WHERE teacher_id=$1 ORDER BY created_at DESC', [t.id]); return send(res, 200, { exams: r.rows }); }
    if (path === 'simple/exams' && method === 'POST') {
      const t = await teacher(req); const b = await bodyOf(req); const title = String(b.title || '').trim(); const duration = Number(b.duration);
      if (!title || title.length > 150 || !Number.isInteger(duration) || duration < 1 || duration > 600) throw fail(400, 'Provide a title and duration between 1 and 600 minutes.');
      const qs = parseQuestions(b.questions); let code; let exam;
      for (let n = 0; n < 5; n++) { code = crypto.randomBytes(6).toString('hex').toUpperCase(); try { exam = await query('INSERT INTO simple_exams(id,teacher_id,title,code,duration,questions) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,code,duration,open', [id(),t.id,title,code,duration,JSON.stringify(qs)]); break; } catch(e) { if (e.code !== '23505') throw e; } }
      if (!exam) throw fail(503, 'Could not create an access code. Try again.');
      return send(res, 201, exam.rows[0]);
    }
    const toggleMatch = path.match(/^simple\/exams\/([\w-]+)\/open$/);
    if (toggleMatch && method === 'POST') {
      const t = await teacher(req); const b = await bodyOf(req);
      if (typeof b.open !== 'boolean') throw fail(400, 'Provide an open or closed status.');
      const r = await query('UPDATE simple_exams SET open=$3 WHERE id=$1 AND teacher_id=$2 RETURNING id,open', [toggleMatch[1],t.id,b.open]);
      if (!r.rows[0]) throw fail(404, 'Exam not found.');
      return send(res,200,r.rows[0]);
    }
    // Progress is a snapshot of saved answers, not evidence that a student is online.
    const progressMatch = path.match(/^simple\/exams\/([\w-]+)\/progress$/);
    if (progressMatch && method === 'GET') {
      const t = await teacher(req);
      const exam = await query('SELECT id, jsonb_array_length(questions) AS total FROM simple_exams WHERE id=$1 AND teacher_id=$2', [progressMatch[1], t.id]);
      if (!exam.rows[0]) throw fail(404, 'Exam not found.');
      const r = await query(`SELECT student_name, student_no, submitted_at, deadline,
        (SELECT count(*)::int FROM jsonb_object_keys(answers)) AS answered
        FROM simple_attempts WHERE exam_id=$1 ORDER BY started_at DESC`, [progressMatch[1]]);
      return send(res, 200, { total: exam.rows[0].total, attempts: r.rows });
    }
    const resultMatch = path.match(/^simple\/exams\/([\w-]+)\/results$/);
    if (resultMatch && method === 'GET') {
      const t = await teacher(req); const exam = await query('SELECT * FROM simple_exams WHERE id=$1 AND teacher_id=$2', [resultMatch[1],t.id]); if (!exam.rows[0]) throw fail(404, 'Exam not found.');
      await query('UPDATE simple_attempts SET submitted_at=now(), score=(SELECT count(*) FROM jsonb_array_elements($2::jsonb) q WHERE answers->>(q->>\'id\') = q->>\'answer\'), total=jsonb_array_length($2::jsonb) WHERE exam_id=$1 AND submitted_at IS NULL AND deadline <= now()', [resultMatch[1],JSON.stringify(exam.rows[0].questions)]);
      const r = await query('SELECT student_name,student_no,started_at,submitted_at,score,total,answers FROM simple_attempts WHERE exam_id=$1 ORDER BY started_at DESC', [resultMatch[1]]); return send(res,200,{ title: exam.rows[0].title, questions:exam.rows[0].questions, results: r.rows });
    }
    if (path === 'simple/join' && method === 'POST') {
      const b = await bodyOf(req); const code = String(b.code || '').trim().toUpperCase(); const name = String(b.name || '').trim(); const no = String(b.number || '').trim();
      if (!code || name.length < 2 || name.length > 80 || no.length < 2 || no.length > 40) throw fail(400, 'Enter your exam code, full name and student number.');
      const token = crypto.randomBytes(32).toString('base64url');
      const inserted = await query("INSERT INTO simple_attempts(token_hash,exam_id,student_name,student_no,deadline) SELECT $1,id,$3,$4,now()+(duration * interval '1 minute') FROM simple_exams WHERE code=$2 AND open=true RETURNING token_hash", [hash(token),code,name,no]);
      if (!inserted.rowCount) throw fail(404, 'Exam not found or closed.');
      return send(res,201,{ token });
    }
    const attemptMatch = path.match(/^simple\/attempt(?:\/(answer|submit))?$/);
    if (attemptMatch) {
      const token = String(req.headers['x-exam-token'] || ''), action = attemptMatch[1];
      if ((!action && method !== 'GET') || (action && method !== 'POST')) throw fail(405,'Method not allowed.');
      const b = action === 'answer' ? await bodyOf(req) : {};
      const data = await tx(async c => {
        let a = await lockAttempt(c, token);
        if (!a.submitted_at && new Date(a.deadline).getTime() <= Date.now()) a = await finalize(c,a);
        if (action === 'answer') {
          if (a.submitted_at) throw fail(409,'This attempt is already submitted.');
          const q = a.questions.find(q => q.id === b.questionId);
          if (!q || !Number.isInteger(b.answer) || b.answer < 0 || b.answer >= q.choices.length) throw fail(400,'Invalid answer.');
          const r = await c.query('UPDATE simple_attempts SET answers=jsonb_set(answers, ARRAY[$2]::text[], to_jsonb($3::integer), true) WHERE token_hash=$1 RETURNING answers', [a.token_hash,q.id,b.answer]); a.answers = r.rows[0].answers;
        } else if (action === 'submit') a = await finalize(c,a);
        return { title:a.title, deadline:a.deadline, submitted:!!a.submitted_at, answers:a.answers, questions:publicQuestions(a.questions), score:a.submitted_at ? a.score : null, total:a.submitted_at ? a.total : null };
      });
      return send(res,200,data);
    }
    throw fail(404, 'Unknown endpoint.');
  } catch (e) {
    if (!e.status) console.error('[simple-exam] request failed:', e.code || e.name);
    return send(res, e.status || 500, { error: e.status ? e.message : 'The server could not complete the request. Please try again.' });
  }
}

// For the isolated PostgreSQL integration test; not exposed as an HTTP route.
export async function closeTestPool() { if (pool) await pool.end(); pool = undefined; ready = undefined; }
