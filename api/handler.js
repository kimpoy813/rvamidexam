import pg from 'pg';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeBlueprint, previewOriginalImport } from '../server/neon/blueprint.js';
import { gradeOne, rng, hashString, shuffleWith } from '../server/lib/exam-engine.js';
import { examToText } from '../server/lib/importer.js';

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
        ALTER TABLE simple_exams ADD COLUMN IF NOT EXISTS results_released BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS result_key_hash TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS simple_attempts_result_key ON simple_attempts(result_key_hash) WHERE result_key_hash IS NOT NULL;
        ALTER TABLE simple_exams ADD COLUMN IF NOT EXISTS lock_sections BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE simple_exams ADD COLUMN IF NOT EXISTS shuffle_questions BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE simple_exams ADD COLUMN IF NOT EXISTS shuffle_choices BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS order_seed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS current_section INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS max_section INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS section_starts JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS pending DOUBLE PRECISION NOT NULL DEFAULT 0;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS manual_scores JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS completion_reason TEXT;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS integrity_cleared_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS teacher_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS student_class TEXT;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS student_section TEXT;
        ALTER TABLE simple_attempts ADD COLUMN IF NOT EXISTS integrity_events JSONB NOT NULL DEFAULT '[]'::jsonb;
        CREATE INDEX IF NOT EXISTS simple_attempts_exam ON simple_attempts(exam_id);
        CREATE TABLE IF NOT EXISTS simple_auth_limits (key TEXT PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL);
      `);
      // Upgrade existing integer score columns once; preserve all existing data.
      for (const col of ['score','total']) {
        const type = await client.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='simple_attempts' AND column_name=$1", [col]);
        if (type.rows[0]?.data_type !== 'double precision') await client.query(`ALTER TABLE simple_attempts ALTER COLUMN ${col} TYPE DOUBLE PRECISION`);
      }
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
async function limit(req, action, maximum = 30) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 100);
  const key = hash(`${action}:${ip}`);
  const { rows } = await query(`INSERT INTO simple_auth_limits(key, window_start, attempts) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET window_start = CASE WHEN simple_auth_limits.window_start < now() - interval '15 minutes' THEN now() ELSE simple_auth_limits.window_start END,
    attempts = CASE WHEN simple_auth_limits.window_start < now() - interval '15 minutes' THEN 1 ELSE simple_auth_limits.attempts + 1 END RETURNING attempts`, [key]);
  if (rows[0].attempts > maximum) throw fail(429, 'Too many attempts. Try again later.');
}
function parseQuestions(input, sections) {
  if (sections !== undefined) {
    const normalized = normalizeBlueprint(sections);
    if (!normalized.length || normalized.some(s => !s.questions.length)) throw fail(400, 'Each part needs at least one question.');
    const qs = normalized.flatMap((s, index) => s.questions.map(q => ({ ...q, id:id(), section:{ index, title:s.title, instructions:s.instructions, lock_after:s.lock_after, minutes:s.minutes } })));
    if (qs.length > 100) throw fail(400, 'Provide at most 100 questions.');
    return qs;
  }
  // Legacy MCQ payload and stored exams remain compatible.
  if (!Array.isArray(input) || !input.length || input.length > 100) throw fail(400, 'Provide 1 to 100 questions.');
  return input.map(q => {
    const prompt = String(q.prompt || '').trim();
    if (!prompt || prompt.length > 2000 || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6) throw fail(400, 'Every question needs a prompt and 2–6 choices.');
    const choices = q.choices.map(c => String(c).trim());
    if (choices.some(c => !c || c.length > 500)) throw fail(400, 'Choices must be non-empty and at most 500 characters.');
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= choices.length) throw fail(400, 'Choose a correct answer for every question.');
    return { id:id(), prompt, choices, answer:q.answer };
  });
}
function examOptions(body) {
  const options={}; for(const key of ['lock_sections','shuffle_questions','shuffle_choices']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw fail(400, 'Invalid exam setting.');
    options[key]=body[key] ?? false;
  } return options;
}
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
  catch (err) { try { await c.query('ROLLBACK'); } catch {} throw err; }
  finally { c.release(); }
}
const bankRevision = exam => hash(JSON.stringify({ title:exam.title, duration:exam.duration, questions:exam.questions, lock_sections:exam.lock_sections, shuffle_questions:exam.shuffle_questions, shuffle_choices:exam.shuffle_choices }));
const sectionOf = q => q.section?.index ?? 0;
function sectionInfo(a, index) { return a.questions.find(q => sectionOf(q) === index)?.section || { index:0, title:'Part 1', instructions:'', minutes:0, lock_after:false }; }
function sectionDeadline(a, index) {
  const start = a.section_starts?.[String(index)], minutes = Number(sectionInfo(a,index).minutes || 0);
  return start && minutes ? new Date(Number(start) + minutes * 60000).toISOString() : null;
}
function sectionExpired(a, index) { const deadline=sectionDeadline(a,index); return deadline && new Date(deadline).getTime() <= new Date(a.server_now).getTime(); }
function controlled(a) { return a.lock_sections || a.questions.some(q => Number(q.section?.minutes || 0) > 0); }
function publicQuestions(a) {
  const groups = new Map();
  for (const q of a.questions) { const i=sectionOf(q); if(!groups.has(i)) groups.set(i,[]); groups.get(i).push(q); }
  return [...groups.entries()].sort((x,y)=>x[0]-y[0]).flatMap(([i,qs]) => {
    const ordered=a.shuffle_questions ? shuffleWith(qs,rng((a.order_seed ^ hashString(`part:${i}`)) >>> 0)) : qs;
    return ordered.map(q => {
      let keys=q.choices.map((_,n)=>n);
      if(a.shuffle_choices && q.shuffle !== false && (q.kind === 'mcq' || q.kind === 'multiselect' || !q.kind)) keys=shuffleWith(keys,rng((a.order_seed ^ hashString(q.id)) >>> 0));
      return { id:q.id, prompt:q.prompt, choices:keys.map(n=>q.choices[n]), choiceKeys:keys, kind:q.kind || 'mcq', points:q.points ?? 1, section:q.section || null };
    });
  });
}
function attemptState(a) { return { title:a.title, deadline:a.deadline, submitted:!!a.submitted_at, completionReason:a.submitted_at ? a.completion_reason : null, answers:a.answers, questions:publicQuestions(a), currentSection:a.current_section, maxSection:a.max_section, sectionDeadline:sectionDeadline(a,a.current_section), serverTime:a.server_now, controlled:controlled(a), lockSections:a.lock_sections }; }
function mark(q, value, manual) {
  const points = q.points ?? 1;
  if (manual && typeof manual.points === 'number') return { points:manual.points, pending:false };
  if (!q.kind) return { points:value === q.answer ? 1 : 0, pending:false };
  return gradeOne({ ...q, hasAnswer:q.answer != null }, value);
}
function calculate(qs, answers, manual = {}) {
  let score = 0, total = 0, pending = 0;
  for (const q of qs) { const pts = q.points ?? 1, result = mark(q, answers[q.id], manual[q.id]); score += result.points; total += pts; if (result.pending) pending += pts; }
  return { score:Math.round(score * 1000)/1000, total:Math.round(total * 1000)/1000, pending:Math.round(pending * 1000)/1000 };
}
async function lockAttempt(client, token) {
  if (!/^[\w-]{24,64}$/.test(token)) throw fail(404, 'Attempt not found.');
  const r = await client.query('SELECT a.*, e.questions, e.title, e.lock_sections, e.shuffle_questions, e.shuffle_choices, clock_timestamp() AS server_now FROM simple_attempts a JOIN simple_exams e ON e.id = a.exam_id WHERE a.token_hash=$1 FOR UPDATE OF a', [hash(token)]);
  if (!r.rows[0]) throw fail(404, 'Attempt not found.');
  const clock = await client.query('SELECT clock_timestamp() AS server_now');
  return { ...r.rows[0], server_now:clock.rows[0].server_now };
}
async function finalize(client, a) {
  if (a.submitted_at) return a;
  const grade = calculate(a.questions, a.answers, a.manual_scores);
  const result = await client.query('UPDATE simple_attempts SET submitted_at=now(), score=$2, total=$3, pending=$4 WHERE token_hash=$1 RETURNING *', [a.token_hash, grade.score, grade.total, grade.pending]);
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
      const preview = previewOriginalImport(b.text);
      // Legacy clients may still consume the flat form for plain MCQs.
      const flat = preview.sections.flatMap(section => section.questions);
      const questions = flat.every(q => ['mcq','truefalse'].includes(q.kind) && q.points === 1 && q.answer !== null)
        ? flat.map(q => ({prompt:q.prompt,choices:q.choices,answer:q.choices.findIndex(c => c === q.answer)})) : [];
      return send(res,200,{ ...preview, questions });
    }
    if (path === 'simple/exams' && method === 'GET') { const t = await teacher(req); const r = await query('SELECT id,title,code,duration,open,created_at FROM simple_exams WHERE teacher_id=$1 ORDER BY created_at DESC', [t.id]); return send(res, 200, { exams: r.rows }); }
    if (path === 'simple/exams' && method === 'POST') {
      const t = await teacher(req); const b = await bodyOf(req); const title = String(b.title || '').trim(); const duration = Number(b.duration);
      if (!title || title.length > 150 || !Number.isInteger(duration) || duration < 1 || duration > 600) throw fail(400, 'Provide a title and duration between 1 and 600 minutes.');
      const qs = parseQuestions(b.questions, b.sections); const options=examOptions(b); let code; let exam;
      for (let n = 0; n < 5; n++) { code = crypto.randomBytes(6).toString('hex').toUpperCase(); try { exam = await query('INSERT INTO simple_exams(id,teacher_id,title,code,duration,questions,lock_sections,shuffle_questions,shuffle_choices) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,title,code,duration,open', [id(),t.id,title,code,duration,JSON.stringify(qs),options.lock_sections,options.shuffle_questions,options.shuffle_choices]); break; } catch(e) { if (e.code !== '23505') throw e; } }
      if (!exam) throw fail(503, 'Could not create an access code. Try again.');
      return send(res, 201, exam.rows[0]);
    }
    const bankMatch = path.match(/^simple\/exams\/([\w-]+)\/bank$/);
    if (bankMatch && (method === 'GET' || method === 'POST')) {
      const t = await teacher(req), examId = bankMatch[1];
      if (method === 'GET') {
        const r = await query('SELECT id,title,duration,questions,lock_sections,shuffle_questions,shuffle_choices FROM simple_exams WHERE id=$1 AND teacher_id=$2', [examId,t.id]);
        if (!r.rows[0]) throw fail(404, 'Exam not found.');
        const exam = r.rows[0];
        const count = await query('SELECT EXISTS(SELECT 1 FROM simple_attempts WHERE exam_id=$1) AS locked', [examId]);
        const sections = [];
        for (const q of exam.questions) {
          const index=q.section?.index ?? 0;
          if (!sections[index]) sections[index]={title:q.section?.title || 'Part 1',instructions:q.section?.instructions || '',questions:[]};
          sections[index].questions.push({...q,kind:q.kind || 'mcq',points:q.points ?? 1,answer:q.kind ? q.answer : q.choices[q.answer]});
        }
        const text = `${exam.title}\n\n${examToText(sections.filter(Boolean))}`;
        return send(res,200,{...exam, text, locked:count.rows[0].locked, revision:bankRevision(exam)});
      }
      const b = await bodyOf(req), title = String(b.title || '').trim(), duration = Number(b.duration);
      if (!title || title.length > 150 || !Number.isInteger(duration) || duration < 1 || duration > 600 || !/^[a-f0-9]{64}$/.test(String(b.revision || ''))) throw fail(400, 'Provide a valid title, duration and bank revision.');
      const questions = parseQuestions(b.questions, b.sections), options=examOptions(b);
      const exam = await tx(async c => {
        const r = await c.query('SELECT id,title,duration,questions,lock_sections,shuffle_questions,shuffle_choices FROM simple_exams WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [examId,t.id]);
        if (!r.rows[0]) throw fail(404, 'Exam not found.');
        if (bankRevision(r.rows[0]) !== b.revision) throw fail(409, 'This exam changed since it was loaded. Reload the saved bank before editing.');
        if (['lock_sections','shuffle_questions','shuffle_choices'].some(key => b[key] === undefined && r.rows[0][key])) throw fail(409, 'Reload the question editor to preserve this exam’s settings.');
        const attempts = await c.query('SELECT 1 FROM simple_attempts WHERE exam_id=$1 LIMIT 1', [examId]);
        if (attempts.rowCount) throw fail(409, 'This exam already has student attempts. Its question bank cannot be changed; create a new exam instead.');
        const updated = await c.query('UPDATE simple_exams SET title=$2,duration=$3,questions=$4,lock_sections=$5,shuffle_questions=$6,shuffle_choices=$7 WHERE id=$1 RETURNING id,title,duration,questions,lock_sections,shuffle_questions,shuffle_choices', [examId,title,duration,JSON.stringify(questions),options.lock_sections,options.shuffle_questions,options.shuffle_choices]);
        return updated.rows[0];
      });
      return send(res,200,{...exam, revision:bankRevision(exam)});
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
      const r = await query(`SELECT student_name, student_no, student_class, student_section, token_hash AS attempt_id, started_at, submitted_at, deadline, last_seen_at, score, total, pending, integrity_events, completion_reason, teacher_actions,
        (last_seen_at > clock_timestamp() - interval '35 seconds' AND submitted_at IS NULL AND deadline > clock_timestamp()) AS recently_seen, GREATEST(jsonb_array_length(integrity_events)-integrity_cleared_count,0) AS integrity_count,
        (SELECT count(*)::int FROM jsonb_each(answers) item WHERE item.value <> '""'::jsonb AND item.value <> '[]'::jsonb AND item.value <> 'null'::jsonb) AS answered
        FROM simple_attempts WHERE exam_id=$1 ORDER BY started_at DESC`, [progressMatch[1]]);
      return send(res, 200, { total: exam.rows[0].total, attempts: r.rows });
    }
    const resultMatch = path.match(/^simple\/exams\/([\w-]+)\/results$/);
    if (resultMatch && method === 'GET') {
      const t = await teacher(req); const exam = await query('SELECT * FROM simple_exams WHERE id=$1 AND teacher_id=$2', [resultMatch[1],t.id]); if (!exam.rows[0]) throw fail(404, 'Exam not found.');
      await tx(async c => {
        const expired = await c.query('SELECT * FROM simple_attempts WHERE exam_id=$1 AND submitted_at IS NULL AND deadline <= now() FOR UPDATE', [resultMatch[1]]);
        for (const row of expired.rows) await finalize(c, { ...row, questions:exam.rows[0].questions });
      });
      const r = await query('SELECT token_hash AS attempt_id,student_name,student_no,student_class,student_section,started_at,submitted_at,score,total,pending,answers,manual_scores,integrity_events,integrity_cleared_count,completion_reason,teacher_actions FROM simple_attempts WHERE exam_id=$1 ORDER BY started_at DESC', [resultMatch[1]]);
      const submitted=r.rows.filter(row=>row.submitted_at && row.completion_reason !== 'invalidated');
      const analysis=exam.rows[0].questions.map((q,index)=>{
        let answered=0, correct=0, assessed=0, awaiting=0;
        for(const row of submitted) {
          const answer=row.answers[q.id];
          if(answer===undefined || answer===null || answer==='' || (Array.isArray(answer) && !answer.length)) continue;
          answered++; const result=mark(q,answer,row.manual_scores?.[q.id]);
          if(result.pending) {awaiting++; continue;}
          assessed++; if(result.correct===true || (result.correct===undefined && (q.points ?? 1)>0 && result.points >= (q.points ?? 1))) correct++;
        }
        return {index, prompt:q.prompt, section:q.section?.title || '', kind:q.kind || 'mcq', points:q.points ?? 1, answered,correct,assessed,awaiting};
      });
      return send(res,200,{ title: exam.rows[0].title, resultsReleased:exam.rows[0].results_released, questions:exam.rows[0].questions, results:r.rows, analysis });
    }
    const releaseMatch=path.match(/^simple\/exams\/([\w-]+)\/release-results$/);
    if(releaseMatch && method==='POST') {
      const t=await teacher(req),b=await bodyOf(req); if(typeof b.released!=='boolean') throw fail(400,'Provide a release setting.');
      const r=await query('UPDATE simple_exams SET results_released=$3 WHERE id=$1 AND teacher_id=$2 RETURNING results_released',[releaseMatch[1],t.id,b.released]);
      if(!r.rows.length) throw fail(404,'Exam not found.'); return send(res,200,{released:r.rows[0].results_released});
    }
    if(path==='simple/result-lookup' && method==='POST') {
      await limit(req,'result-lookup',300); const b=await bodyOf(req);
      const code=String(b.code||'').trim().toUpperCase(), number=String(b.number||'').trim(), key=String(b.resultKey||'').trim();
      if(!code || code.length>30 || number.length<2 || number.length>40 || !/^[A-Za-z0-9_-]{22}$/.test(key)) throw fail(400,'Enter the exam code, student number and private result key.');
      const r=await query(`SELECT e.title,a.score,a.total,a.pending FROM simple_attempts a JOIN simple_exams e ON e.id=a.exam_id
        WHERE e.code=$1 AND lower(trim(a.student_no))=lower(trim($2)) AND a.result_key_hash=$3 AND e.results_released=true AND a.submitted_at IS NOT NULL AND a.completion_reason IS DISTINCT FROM 'invalidated'`,[code,number,hash(key)]);
      if(!r.rows.length) throw fail(404,'No released result found. Check your details or ask your teacher.');
      return send(res,200,r.rows[0]);
    }
    if(path==='simple/attempt/result-key' && method==='POST') {
      const token=String(req.headers['x-exam-token']||''), key=crypto.randomBytes(16).toString('base64url');
      await tx(async c=>{const a=await lockAttempt(c,token); await c.query('UPDATE simple_attempts SET result_key_hash=$2 WHERE token_hash=$1',[a.token_hash,hash(key)]);});
      return send(res,200,{resultKey:key});
    }
    const actionMatch = path.match(/^simple\/exams\/([\w-]+)\/action$/);
    if (actionMatch && method === 'POST') {
      const t=await teacher(req), b=await bodyOf(req);
      if (!/^[a-f0-9]{64}$/.test(String(b.attemptId || '')) || !['extend','force_submit','invalidate','reopen','dismiss_flag'].includes(b.action)) throw fail(400,'Invalid teacher action.');
      if (b.action==='extend' && (!Number.isInteger(b.minutes) || b.minutes<1 || b.minutes>600)) throw fail(400,'Extra time must be 1–600 minutes.');
      const result=await tx(async c=>{
        // Match join's exam-then-attempt locking order to prevent conflicting active attempts.
        const exam=await c.query('SELECT id,duration,questions FROM simple_exams WHERE id=$1 AND teacher_id=$2 FOR UPDATE',[actionMatch[1],t.id]);
        if(!exam.rows[0]) throw fail(404,'Exam not found.');
        const r=await c.query('SELECT *,clock_timestamp() AS server_now FROM simple_attempts WHERE exam_id=$1 AND token_hash=$2 FOR UPDATE',[actionMatch[1],b.attemptId]);
        if(!r.rows[0]) throw fail(404,'Attempt not found.');
        let a={...r.rows[0],questions:exam.rows[0].questions};
        if(a.teacher_actions.length>=500) throw fail(409,'Teacher action history is full for this attempt.');
        if(b.action==='extend') {
          if(a.submitted_at || new Date(a.deadline)<=new Date(a.server_now)) throw fail(409,'Only an active attempt can receive extra time. Reopen it first.');
          const q=await c.query("UPDATE simple_attempts SET deadline=deadline+($2 * interval '1 minute') WHERE token_hash=$1 RETURNING deadline",[a.token_hash,b.minutes]); a.deadline=q.rows[0].deadline;
        } else if(b.action==='force_submit') {
          if(a.submitted_at) throw fail(409,'This attempt is already submitted.');
          a=await finalize(c,a); await c.query("UPDATE simple_attempts SET completion_reason='force_submitted' WHERE token_hash=$1",[a.token_hash]);
        } else if(b.action==='invalidate') {
          if(a.completion_reason==='invalidated') throw fail(409,'This attempt is already invalidated.');
          if(!a.submitted_at) a=await finalize(c,a);
          await c.query("UPDATE simple_attempts SET completion_reason='invalidated' WHERE token_hash=$1",[a.token_hash]);
        } else if(b.action==='reopen') {
          if(!a.submitted_at) throw fail(409,'Only a submitted attempt can be reopened.');
          const clash=await c.query("SELECT 1 FROM simple_attempts WHERE exam_id=$1 AND token_hash<>$2 AND lower(trim(student_no))=lower(trim($3)) AND submitted_at IS NULL AND deadline>clock_timestamp() LIMIT 1",[actionMatch[1],a.token_hash,a.student_no]);
          if(clash.rows.length) throw fail(409,'Another attempt for this student is active.');
          const q=await c.query("UPDATE simple_attempts SET submitted_at=NULL,completion_reason=NULL,score=NULL,total=NULL,pending=0,manual_scores='{}'::jsonb,last_seen_at=NULL,deadline=GREATEST(clock_timestamp()+interval '1 minute',started_at+($2 * interval '1 minute')) WHERE token_hash=$1 RETURNING deadline",[a.token_hash,exam.rows[0].duration]); a.deadline=q.rows[0].deadline;
        } else {
          await c.query('UPDATE simple_attempts SET integrity_cleared_count=jsonb_array_length(integrity_events) WHERE token_hash=$1',[a.token_hash]);
        }
        await c.query(`UPDATE simple_attempts SET teacher_actions=(teacher_actions || jsonb_build_array(jsonb_build_object('action',$2::text,'minutes',$3::int,'at',clock_timestamp()))) WHERE token_hash=$1 AND jsonb_array_length(teacher_actions)<500`,[a.token_hash,b.action,b.action==='extend'?b.minutes:null]);
        return {ok:true,deadline:a.deadline};
      });
      return send(res,200,result);
    }
    const gradeMatch = path.match(/^simple\/exams\/([\w-]+)\/grade$/);
    if (gradeMatch && method === 'POST') {
      const t = await teacher(req), b = await bodyOf(req);
      if (!/^[a-f0-9]{64}$/.test(String(b.attemptId || '')) || typeof b.questionId !== 'string' || typeof b.points !== 'number' || !Number.isFinite(b.points)) throw fail(400, 'Invalid grade.');
      const result = await tx(async c => {
        const r = await c.query(`SELECT a.*,e.questions FROM simple_attempts a JOIN simple_exams e ON e.id=a.exam_id WHERE e.id=$1 AND e.teacher_id=$2 AND a.token_hash=$3 FOR UPDATE OF a`, [gradeMatch[1],t.id,b.attemptId]);
        if (!r.rows[0]) throw fail(404, 'Attempt not found.');
        const a = r.rows[0]; if (!a.submitted_at) throw fail(409, 'Submit the attempt before grading.');
        const q = a.questions.find(q => q.id === b.questionId);
        if (!q || b.points < 0 || b.points > (q.points ?? 1)) throw fail(400, 'Invalid grade.');
        const manual = { ...a.manual_scores, [q.id]:{ points:b.points } }, grade = calculate(a.questions,a.answers,manual);
        await c.query('UPDATE simple_attempts SET manual_scores=$2,score=$3,total=$4,pending=$5 WHERE token_hash=$1', [a.token_hash,JSON.stringify(manual),grade.score,grade.total,grade.pending]);
        return grade;
      });
      return send(res,200,result);
    }
    if (path === 'simple/join' && method === 'POST') {
      const b = await bodyOf(req); const code = String(b.code || '').trim().toUpperCase(); const name = String(b.name || '').trim(); const no = String(b.number || '').trim(); const studentClass = String(b.studentClass || '').trim(); const studentSection = String(b.studentSection || '').trim();
      if (!code || name.length < 2 || name.length > 80 || no.length < 2 || no.length > 40 || !studentClass || studentClass.length > 80 || !studentSection || studentSection.length > 80) throw fail(400, 'Enter your exam code, full name, student number, class and section.');
      const token = crypto.randomBytes(32).toString('base64url'), resultKey=crypto.randomBytes(16).toString('base64url');
      // Serialize joining against bank edits; no attempt can start with a bank
      // that is being replaced, and no edit can overwrite an existing attempt.
      const duplicate = await tx(async c => {
        const exam = await c.query('SELECT id,duration FROM simple_exams WHERE code=$1 AND open=true FOR UPDATE', [code]);
        if (!exam.rows[0]) throw fail(404, 'Exam not found or closed.');
        const existing=await c.query("SELECT token_hash FROM simple_attempts WHERE exam_id=$1 AND lower(trim(student_no))=lower(trim($2)) AND submitted_at IS NULL AND deadline > clock_timestamp() ORDER BY started_at DESC LIMIT 1 FOR UPDATE",[exam.rows[0].id,no]);
        if(existing.rows.length) {
          await c.query(`UPDATE simple_attempts SET integrity_events=integrity_events || jsonb_build_array(jsonb_build_object('type','duplicate_join','at',clock_timestamp())) WHERE token_hash=$1 AND jsonb_array_length(integrity_events)<500`,[existing.rows[0].token_hash]);
          return true;
        }
        await c.query("INSERT INTO simple_attempts(token_hash,exam_id,student_name,student_no,started_at,deadline,order_seed,section_starts,student_class,student_section,result_key_hash) VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+($5 * interval '1 minute'),$6,jsonb_build_object('0',extract(epoch from clock_timestamp()) * 1000),$7,$8,$9)", [hash(token),exam.rows[0].id,name,no,exam.rows[0].duration,crypto.randomInt(1,2**31),studentClass,studentSection,hash(resultKey)]);
        return false;
      });
      if (duplicate) throw fail(409,'An active exam already exists for this student number. Continue in your original tab or contact your teacher.');
      return send(res,201,{ token,resultKey });
    }
    const attemptMatch = path.match(/^simple\/attempt(?:\/(answer|submit|navigate|integrity|heartbeat))?$/);
    if (attemptMatch) {
      const token = String(req.headers['x-exam-token'] || ''), action = attemptMatch[1];
      if ((!action && method !== 'GET') || (action && method !== 'POST')) throw fail(405,'Method not allowed.');
      const b = ['answer','navigate','integrity'].includes(action) ? await bodyOf(req) : {};
      const data = await tx(async c => {
        let a = await lockAttempt(c, token);
        if (!a.submitted_at && new Date(a.deadline).getTime() <= new Date(a.server_now).getTime()) a = await finalize(c,a);
        if (action === 'heartbeat') {
          if (!a.submitted_at) await c.query('UPDATE simple_attempts SET last_seen_at=clock_timestamp() WHERE token_hash=$1',[a.token_hash]);
          return {submitted:!!a.submitted_at,deadline:a.deadline,serverTime:a.server_now};
        }
        if (action === 'integrity') {
          if (!['copy','cut','paste','second_tab','tab_hidden'].includes(b.type)) throw fail(400,'Invalid integrity event.');
          if (!a.submitted_at) await c.query(`UPDATE simple_attempts SET integrity_events=integrity_events || jsonb_build_array(jsonb_build_object('type',$2::text,'at',clock_timestamp())) WHERE token_hash=$1 AND jsonb_array_length(integrity_events)<500`,[a.token_hash,b.type]);
          return {ok:true};
        }
        if (action === 'answer') {
          if (a.submitted_at) return { answerClosed:true };
          const q = a.questions.find(q => q.id === b.questionId);
          if (!q) throw fail(400,'Invalid answer.');
          const section=sectionOf(q);
          if (controlled(a) && section !== a.current_section) throw fail(403,'Navigate to this part before answering.');
          if (sectionExpired(a,section)) throw fail(409,'Time for this part has expired. Move to another part or submit.');
          const kind = q.kind || 'mcq', value = b.answer;
          const validChoice = n => Number.isInteger(n) && n >= 0 && n < q.choices.length;
          if ((kind === 'mcq' || kind === 'truefalse') && !validChoice(value)) throw fail(400,'Invalid answer.');
          if (kind === 'multiselect' && (!Array.isArray(value) || value.length > q.choices.length || value.some(n => !validChoice(n)) || new Set(value).size !== value.length)) throw fail(400,'Invalid answer.');
          if ((kind === 'short' || kind === 'essay') && (typeof value !== 'string' || value.length > 8000)) throw fail(400,'Invalid answer.');
          const r = await c.query('UPDATE simple_attempts SET answers=jsonb_set(answers, ARRAY[$2]::text[], $3::jsonb, true) WHERE token_hash=$1 RETURNING answers', [a.token_hash,q.id,JSON.stringify(value)]); a.answers = r.rows[0].answers;
        } else if (action === 'navigate') {
          if (a.submitted_at) return attemptState(a);
          const target=b.section;
          if (!Number.isInteger(target) || !a.questions.some(q=>sectionOf(q)===target)) throw fail(400,'Unknown part.');
          if (a.lock_sections && target < a.max_section && sectionInfo(a,target).lock_after) throw fail(403,'That part is locked and cannot be revisited.');
          if (sectionExpired(a,target) && target !== a.current_section) throw fail(403,'Time for that part has expired.');
          const starts={...a.section_starts}; if (!starts[String(target)]) starts[String(target)] = new Date(a.server_now).getTime();
          const r=await c.query('UPDATE simple_attempts SET current_section=$2,max_section=GREATEST(max_section,$2),section_starts=$3 WHERE token_hash=$1 RETURNING current_section,max_section,section_starts', [a.token_hash,target,JSON.stringify(starts)]);
          a={...a,...r.rows[0]};
        } else if (action === 'submit') a = await finalize(c,a);
        return attemptState(a);
      });
      if (data.answerClosed) throw fail(409,'This attempt is already submitted.');
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
