/** Transactional attempt primitives for the original exam engine.
 * Internal module only: routes must separately authenticate and shape output. */
import crypto from 'node:crypto';
import { buildPaper, gradePaper } from '../lib/exam-engine.js';
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
async function tx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (err) { try { await c.query('ROLLBACK'); } catch {} throw err; }
  finally { c.release(); }
}
async function lock(c, tokenHash) {
  const {rows} = await c.query('SELECT * FROM sessions WHERE token=$1 FOR UPDATE', [tokenHash]);
  if (!rows[0] || !rows[0].paper_snapshot) throw fail(404, 'Attempt not found.');
  return rows[0];
}
function tokenHash(token) {
  if (!/^[\w-]{43}$/.test(String(token || ''))) throw fail(404, 'Attempt not found.');
  return hash(token);
}
function paperFor(row) {
  const snapshot = JSON.parse(row.paper_snapshot);
  return { ...snapshot, paper:buildPaper(row, snapshot.blueprint, snapshot.settings) };
}
function grade(row) {
  const { blueprint, paper } = paperFor(row);
  return gradePaper(paper, JSON.parse(row.answers || '{}'), JSON.parse(row.manual_scores || '{}'), blueprint.flatMap(s => s.questions));
}
async function finalize(c, row, status = 'submitted') {
  if (row.status !== 'active') return row;
  const graded = grade(row), at = Date.now();
  const {rows} = await c.query(`UPDATE sessions SET status=$2,submitted_at=$3,score=$4,max_score=$5,pending_manual=$6 WHERE token=$1 RETURNING *`,
    [row.token,status,at,graded.score,graded.max,graded.pending]);
  return rows[0];
}
async function expire(c, row) {
  return row.status === 'active' && row.deadline && Number(row.deadline) <= Date.now() ? finalize(c,row,'auto_timeout') : row;
}
function publicState(row) {
  const {paper, settings} = paperFor(row);
  return { status:row.status, startedAt:row.started_at && Number(row.started_at), deadline:row.deadline && Number(row.deadline),
    paper, answers:JSON.parse(row.answers || '{}'),
    result: row.status !== 'active' && settings.show_result_to_student === '1' ? {score:row.score, max:row.max_score, pending:row.pending_manual} : null };
}
export async function startAttempt(pool, token) {
  return tx(pool, async c => {
    let row = await expire(c, await lock(c,tokenHash(token)));
    if (row.status !== 'active') return publicState(row);
    if (!row.started_at) {
      const settings = JSON.parse(row.paper_snapshot).settings;
      const minutes = Number(settings.duration_minutes || 60);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) throw fail(400, 'Invalid exam duration.');
      const at = Date.now(); row = (await c.query('UPDATE sessions SET started_at=$2,deadline=$3,last_seen=$2 WHERE token=$1 RETURNING *', [row.token, at, at + minutes * 60000])).rows[0];
    }
    return publicState(row);
  });
}
export async function saveAnswer(pool, token, questionId, value) {
  const result = await tx(pool, async c => {
    let row = await expire(c, await lock(c,tokenHash(token)));
    if (row.status !== 'active') return { expired:true };
    if (!row.started_at) throw fail(409, 'Start the exam first.');
    const {paper} = paperFor(row);
    const sectionIndex = paper.findIndex(s => s.questions.some(q => q.id === questionId));
    if (sectionIndex < 0) throw fail(404, 'Unknown question.');
    const section = paper[sectionIndex], q = section.questions.find(q => q.id === questionId);
    if (section.lock_after && sectionIndex < row.max_section) throw fail(403, 'This section is locked.');
    const validKey = v => /^\d+$/.test(String(v)) && q.choices.some(choice => choice.key === Number(v));
    if (q.kind === 'multiselect') {
      if (!Array.isArray(value) || value.length > q.choices.length || value.some(v => !validKey(v)) || new Set(value.map(Number)).size !== value.length) throw fail(400,'Invalid answer.');
      value = value.map(Number);
    } else if (q.kind === 'mcq' || q.kind === 'truefalse') {
      if (value !== '' && !validKey(value)) throw fail(400,'Invalid answer.');
      value = String(value);
    } else if (typeof value !== 'string' || value.length > 8000) throw fail(400,'Invalid answer.');
    const answers = JSON.parse(row.answers || '{}'), at = Date.now();
    answers[q.id] = { ...(answers[q.id] || {}), value, at, ms:at - Number(row.started_at) };
    await c.query('UPDATE sessions SET answers=$2,last_seen=$3 WHERE token=$1', [row.token, JSON.stringify(answers), at]);
    return { saved:true };
  });
  if (result.expired) throw fail(409, 'Exam already submitted or time expired.');
  return result;
}
export async function submitAttempt(pool, token) {
  return tx(pool, async c => {
    let row = await expire(c, await lock(c,tokenHash(token)));
    if (!row.started_at) throw fail(409, 'Start the exam first.');
    row = await finalize(c,row);
    return publicState(row);
  });
}
/** Attempt ID here is the stored token hash, never the student's bearer token. */
export async function gradeAttempt(pool, teacherId, attemptId, questionId, points, note = '') {
  if (!teacherId || !/^[a-f0-9]{64}$/.test(String(attemptId || ''))) throw fail(404, 'Attempt not found.');
  return tx(pool, async c => {
    const found = await c.query('SELECT s.token FROM sessions s JOIN exams e ON e.id=s.exam_id WHERE s.token=$1 AND e.teacher_id=$2', [attemptId,teacherId]);
    if (!found.rowCount) throw fail(404, 'Attempt not found.');
    let row = await expire(c, await lock(c,attemptId));
    if (row.status === 'active') throw fail(409, 'Submit the attempt before grading.');
    const {blueprint} = paperFor(row), q = blueprint.flatMap(s => s.questions).find(q => q.id === questionId);
    if (!q) throw fail(404, 'Unknown question.');
    if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > q.points || typeof note !== 'string' || note.length > 2000) throw fail(400, 'Invalid grade.');
    const manual = JSON.parse(row.manual_scores || '{}'); manual[q.id] = {points,note}; row.manual_scores = JSON.stringify(manual);
    const graded = grade(row);
    await c.query('UPDATE sessions SET manual_scores=$2,score=$3,max_score=$4,pending_manual=$5 WHERE token=$1', [row.token,row.manual_scores,graded.score,graded.max,graded.pending]);
    return graded;
  });
}
