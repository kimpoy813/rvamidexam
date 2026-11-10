/**
 * Async PostgreSQL primitives for the original exam model. Not yet connected
 * to the production routes. Keep each operation on one transaction/client:
 * bank edits and joins serialize on the exam row so a session can never get a
 * half-written paper. Existing SQLite and simple_* data are not modified.
 */
import crypto from 'node:crypto';
import { normalizeBlueprint } from './blueprint.js';

const uid = prefix => prefix + crypto.randomBytes(16).toString('hex');
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw err;
  } finally { client.release(); }
}

async function bank(client, examId) {
  const sections = (await client.query('SELECT * FROM sections WHERE exam_id=$1 ORDER BY ord,id', [examId])).rows;
  const questions = (await client.query(`SELECT q.* FROM questions q JOIN sections s ON s.id=q.section_id
    WHERE s.exam_id=$1 ORDER BY q.ord,q.id`, [examId])).rows;
  return sections.map(s => ({ ...s, lock_after: Boolean(s.lock_after), minutes: Number(s.minutes) || 0,
    questions: questions.filter(q => q.section_id === s.id).map(q => ({ ...q,
      choices: JSON.parse(q.choices || '[]'), answer: q.answer === null ? null : JSON.parse(q.answer),
      points: Number(q.points), shuffle: Boolean(q.shuffle) })) }));
}

async function owned(client, teacherId, examId, lock = false) {
  if (!teacherId || !examId) throw error(404, 'Exam not found.');
  const { rows } = await client.query(`SELECT * FROM exams WHERE id=$1 AND teacher_id=$2${lock ? ' FOR UPDATE' : ''}`, [examId, teacherId]);
  if (!rows[0]) throw error(404, 'Exam not found.');
  return rows[0];
}

/** Owner-scoped read; no caller can use an exam id to read another bank. */
export async function getOwnedBlueprint(pool, teacherId, examId) {
  return transaction(pool, async client => {
    await owned(client, teacherId, examId, true);
    return bank(client, examId);
  });
}

/** Replace all sections atomically. Existing sessions keep their snapshots. */
export async function replaceOwnedBlueprint(pool, teacherId, examId, sections) {
  const parsed = normalizeBlueprint(sections);
  return transaction(pool, async client => {
    await owned(client, teacherId, examId, true);
    await client.query('DELETE FROM sections WHERE exam_id=$1', [examId]);
    for (const [si, section] of parsed.entries()) {
      const sid = uid('sec_');
      await client.query('INSERT INTO sections(id,exam_id,ord,title,instructions,lock_after,minutes) VALUES($1,$2,$3,$4,$5,$6,$7)', [sid, examId, si, section.title, section.instructions, Number(section.lock_after), section.minutes]);
      for (const [qi, q] of section.questions.entries()) {
        await client.query('INSERT INTO questions(id,section_id,ord,kind,prompt,choices,answer,points,shuffle,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [uid('q_'), sid, qi, q.kind, q.prompt, JSON.stringify(q.choices), q.answer === null ? null : JSON.stringify(q.answer), q.points, Number(q.shuffle), q.tags]);
      }
    }
    return bank(client, examId);
  });
}

/** Create a session with an immutable paper and hashed bearer token.
 * Callers must not return paper_snapshot to students: it contains answer keys. */
export async function joinExam(pool, { code, name, number, classSection = '' }) {
  code = String(code || '').trim().toUpperCase(); name = String(name || '').trim();
  number = String(number || '').trim(); classSection = String(classSection || '').trim();
  if (!code || name.length < 2 || name.length > 80 || number.length < 2 || number.length > 40 || classSection.length > 80) throw error(400, 'Enter a valid exam code, name and student number.');
  return transaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM exams WHERE access_code=$1 FOR UPDATE', [code]);
    const exam = rows[0];
    if (!exam) throw error(404, 'Exam not found or closed.');
    const settings = JSON.parse(exam.settings || '{}');
    if (settings.exam_open === '0') throw error(404, 'Exam not found or closed.');
    const existing = await client.query("SELECT 1 FROM sessions WHERE exam_id=$1 AND lower(student_no)=lower($2) AND lower(class_section)=lower($3) AND status='active' LIMIT 1", [exam.id, number, classSection]);
    if (existing.rowCount) throw error(409, 'An active attempt already exists for this student.');
    const blueprint = await bank(client, exam.id);
    if (!blueprint.some(s => s.questions.length)) throw error(409, 'This exam has no questions.');
    const token = crypto.randomBytes(32).toString('base64url'), at = Date.now();
    await client.query(`INSERT INTO sessions(token,exam_id,access_code,student_name,student_no,class_section,status,created_at,last_seen,order_seed,paper_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,'active',$7,$7,$8,$9)`, [digest(token),exam.id,code,name,number,classSection,at,crypto.randomInt(1,2**31),JSON.stringify({ blueprint, settings })]);
    return { token };
  });
}

/** Internal-only snapshot lookup; never expose the result directly to a client. */
export async function getAttemptSnapshot(pool, token) {
  if (!/^[\w-]{43}$/.test(String(token || ''))) return null;
  const { rows } = await pool.query('SELECT paper_snapshot FROM sessions WHERE token=$1', [digest(token)]);
  return rows[0]?.paper_snapshot ? JSON.parse(rows[0].paper_snapshot) : null;
}
