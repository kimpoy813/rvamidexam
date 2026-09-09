/**
 * Persistence layer.
 *
 * Uses the SQLite engine that ships with Node 22 (`node:sqlite`) so the app has
 * zero external runtime dependencies. Everything a teacher needs later
 * (responses, scores, integrity events) lives in one file: data/exam.sqlite.
 *
 * Multiple exams are supported. Each exam owns its question bank, its own
 * settings (title, duration, access code, …) and its own roster of attempts.
 * The teacher switches the "current" exam from the dashboard; a student is
 * routed to whichever exam their access code belongs to.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = process.env.EXAM_DATA_DIR || path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.EXAM_DB || path.join(DATA_DIR, 'exam.sqlite');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS exams (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  access_code  TEXT NOT NULL,
  settings     TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id            TEXT PRIMARY KEY,
  exam_id       TEXT,
  ord           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  instructions  TEXT DEFAULT '',
  lock_after    INTEGER NOT NULL DEFAULT 1,
  minutes       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  section_id   TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL,            -- mcq | multiselect | truefalse | short | essay
  prompt       TEXT NOT NULL,
  choices      TEXT DEFAULT '[]',        -- JSON array of strings
  answer       TEXT,                     -- JSON: string | string[] | null (manual)
  points       REAL NOT NULL DEFAULT 1,
  shuffle      INTEGER NOT NULL DEFAULT 1,
  tags         TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_id, ord);

CREATE TABLE IF NOT EXISTS sessions (
  token          TEXT PRIMARY KEY,
  exam_id        TEXT,
  access_code    TEXT NOT NULL,
  student_name   TEXT NOT NULL,
  student_no     TEXT NOT NULL,
  class_section  TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active',
                 -- active | submitted | force_submitted | invalidated
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  deadline       INTEGER,
  last_seen      INTEGER NOT NULL,
  order_seed     INTEGER NOT NULL,
  answers        TEXT NOT NULL DEFAULT '{}',   -- JSON map questionId -> {value, at, ms, revealed}
  section_index  INTEGER NOT NULL DEFAULT 0,
  max_section    INTEGER NOT NULL DEFAULT 0,   -- furthest section reached (drives locking)
  cursor         INTEGER NOT NULL DEFAULT 0,   -- global question index across the paper
  reloads        INTEGER NOT NULL DEFAULT 0,
  ip             TEXT DEFAULT '',
  user_agent     TEXT DEFAULT '',
  submitted_at   INTEGER,
  score          REAL,
  max_score      REAL,
  pending_manual INTEGER NOT NULL DEFAULT 0,
  violations     INTEGER NOT NULL DEFAULT 0,
  flagged        INTEGER NOT NULL DEFAULT 0,
  manual_notes   TEXT DEFAULT '',
  manual_scores  TEXT NOT NULL DEFAULT '{}'    -- JSON questionId -> {points, note}
);
CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(access_code, status);
CREATE INDEX IF NOT EXISTS idx_sessions_ident ON sessions(student_no, class_section);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  token   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  detail  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_token ON events(token, at);

CREATE TABLE IF NOT EXISTS teachers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teacher_tokens (
  token      TEXT PRIMARY KEY,
  teacher_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

/* -------------------------------------------------------- schema migration */

// Databases created before multi-exam support lack these columns.
const hasColumn = (table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

if (!hasColumn('sections', 'exam_id')) {
  db.exec('ALTER TABLE sections ADD COLUMN exam_id TEXT');
}
if (!hasColumn('sessions', 'exam_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN exam_id TEXT');
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_sections_exam ON sections(exam_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id, status);
`);

/* ------------------------------------------------------------------ utils */

export const now = () => Date.now();

export const uid = (prefix = '') =>
  prefix + crypto.randomBytes(8).toString('hex');

/** Human friendly, hard-to-mistake access code: 3 letters + 3 digits. */
export function makeAccessCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let out = '';
  for (let i = 0; i < 3; i++) out += letters[crypto.randomInt(letters.length)];
  out += '-';
  for (let i = 0; i < 3; i++) out += digits[crypto.randomInt(digits.length)];
  return out;
}

/* --------------------------------------------------------------- settings */

const DEFAULT_SETTINGS = {
  exam_title: 'Midterm Examination',
  school: 'RVM',
  subject: '',
  term: '',
  instructions:
    'Read each item carefully. Choose the best answer. Your responses are saved automatically.',
  duration_minutes: '60',
  access_code: '',
  shuffle_questions: '1',
  shuffle_choices: '1',
  // Sections do not lock: students may revisit an earlier part within the hour.
  lock_sections: '0',
  // Full screen is optional. The browser is never forced into it.
  require_fullscreen: '0',
  max_violations: '8',
  auto_submit_on_violations: '0',
  // Scores stay with the teacher; students see only a confirmation.
  show_result_to_student: '0',
  allow_resume: '1',
  exam_open: '1',
  proctor_notes: ''
};

const stmtGetPointer = db.prepare("SELECT value FROM settings WHERE key = 'current_exam_id'");
const stmtSetPointer = db.prepare(
  "INSERT INTO settings(key, value) VALUES('current_exam_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

function settingsFor(examId) {
  const row = examId ? db.prepare('SELECT settings FROM exams WHERE id = ?').get(examId) : null;
  const raw = row ? JSON.parse(row.settings || '{}') : {};
  return { ...DEFAULT_SETTINGS, ...raw };
}

/* ------------------------------------------------------------ exam routing */

export function getCurrentExamId() {
  const pointer = stmtGetPointer.get();
  if (pointer?.value) {
    const exists = db.prepare('SELECT 1 AS ok FROM exams WHERE id = ?').get(pointer.value);
    if (exists) return pointer.value;
  }
  const first = db.prepare('SELECT id FROM exams ORDER BY created_at ASC, rowid ASC').get();
  if (first) {
    setCurrentExamId(first.id);
    return first.id;
  }
  return null;
}

export function setCurrentExamId(id) {
  if (!id) return;
  stmtSetPointer.run(id);
}

export function getExam(examId) {
  const row = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!row) return null;
  return { ...row, settings: settingsFor(row.id) };
}

export function findExamByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const row = db.prepare('SELECT * FROM exams WHERE access_code = ?').get(c);
  return row ? { ...row, settings: settingsFor(row.id) } : null;
}

export function listExams() {
  const currentId = getCurrentExamId();
  return db.prepare('SELECT * FROM exams ORDER BY created_at ASC, rowid ASC').all().map((e) => {
    const blueprint = getExamBlueprint(e.id);
    return {
      id: e.id,
      title: e.title,
      access_code: e.access_code,
      settings: settingsFor(e.id),
      current: e.id === currentId,
      created_at: e.created_at,
      counts: {
        sections: blueprint.length,
        questions: blueprint.reduce((n, s) => n + s.questions.length, 0),
        points: blueprint.reduce((n, s) => n + s.questions.reduce((m, q) => m + q.points, 0), 0)
      }
    };
  });
}

function codeTaken(code, exceptId) {
  const row = db.prepare('SELECT id FROM exams WHERE access_code = ?').get(code);
  return row && row.id !== exceptId ? row : null;
}

function uniqueAccessCode(preferred) {
  let code = String(preferred || '').trim().toUpperCase();
  if (code && !codeTaken(code, null)) return code;
  do {
    code = makeAccessCode();
  } while (codeTaken(code, null));
  return code;
}

export function createExam({ title = 'Untitled Exam', access_code, settings = {} } = {}) {
  const id = uid('ex_');
  const code = uniqueAccessCode(access_code);
  const merged = { ...DEFAULT_SETTINGS, ...settings, access_code: code };
  db.prepare('INSERT INTO exams(id, title, access_code, settings, created_at) VALUES(?,?,?,?,?)')
    .run(id, title, code, JSON.stringify(merged), now());
  setCurrentExamId(id);
  return getExam(id);
}

export function deleteExam(id) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM exams').get().c;
  if (count <= 1) throw new Error('You need at least one exam.');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM questions WHERE section_id IN (SELECT id FROM sections WHERE exam_id = ?)').run(id);
    db.prepare('DELETE FROM sections WHERE exam_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE token IN (SELECT token FROM sessions WHERE exam_id = ?)').run(id);
    db.prepare('DELETE FROM sessions WHERE exam_id = ?').run(id);
    db.prepare('DELETE FROM exams WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // If the deleted exam was the current one, re-resolve to the first exam.
  getCurrentExamId();
}

export function duplicateExam(id) {
  const src = getExam(id);
  if (!src) throw new Error('Exam not found.');
  const blueprint = getExamBlueprint(id);
  const copy = createExam({
    title: `${src.title} (copy)`,
    settings: { ...src.settings }
  });
  replaceExam({ title: `${src.title} (copy)`, sections: blueprint }, copy.id);
  return copy;
}

/** Migrates a single-exam database, then makes sure at least one exam exists. */
export function ensureExamExists() {
  migrateLegacy();
  const existing = getCurrentExamId();
  if (existing) return existing;
  return createExam({ title: 'Midterm Examination', access_code: makeAccessCode() }).id;
}

function migrateLegacy() {
  const examCount = db.prepare('SELECT COUNT(*) AS c FROM exams').get().c;
  if (examCount > 0) return;

  const sectionCount = db.prepare('SELECT COUNT(*) AS c FROM sections').get().c;
  const legacyRows = db.prepare("SELECT key, value FROM settings WHERE key != 'current_exam_id'").all();

  // Fresh database: nothing to migrate.
  if (sectionCount === 0 && legacyRows.length === 0) return;

  const legacy = {};
  for (const r of legacyRows) legacy[r.key] = r.value;
  const title = legacy.exam_title || 'Midterm Examination';
  const code = legacy.access_code || makeAccessCode();

  const id = uid('ex_');
  const merged = { ...DEFAULT_SETTINGS, ...legacy, access_code: code };
  db.prepare('INSERT INTO exams(id, title, access_code, settings, created_at) VALUES(?,?,?,?,?)')
    .run(id, title, code, JSON.stringify(merged), now());
  db.prepare("UPDATE sections SET exam_id = ? WHERE exam_id IS NULL OR exam_id = ''").run(id);
  db.prepare("DELETE FROM settings WHERE key != 'current_exam_id'").run();
  setCurrentExamId(id);
}

export function getExamSettings(examId) {
  return settingsFor(examId || getCurrentExamId());
}

export function getSettings() {
  return getExamSettings(getCurrentExamId());
}

export function setExamSettings(examId, patch) {
  const id = examId || getCurrentExamId();
  if (!id) return { ...DEFAULT_SETTINGS };
  const next = { ...settingsFor(id) };
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) next[k] = String(v);
  }
  db.prepare('UPDATE exams SET settings = ? WHERE id = ?').run(JSON.stringify(next), id);
  if (next.access_code) db.prepare('UPDATE exams SET access_code = ? WHERE id = ?').run(next.access_code, id);
  if (next.exam_title) db.prepare('UPDATE exams SET title = ? WHERE id = ?').run(next.exam_title, id);
  return next;
}

export function setSettings(patch) {
  return setExamSettings(getCurrentExamId(), patch);
}

/* --------------------------------------------------------------- teachers */

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}

export function ensureTeacher(username, password) {
  const row = db.prepare('SELECT * FROM teachers WHERE username = ?').get(username);
  if (row) return row;
  const { hash, salt } = hashPassword(password);
  db.prepare(
    'INSERT INTO teachers(username, pass_hash, salt, created_at) VALUES(?,?,?,?)'
  ).run(username, hash, salt, now());
  return db.prepare('SELECT * FROM teachers WHERE username = ?').get(username);
}

export function verifyTeacher(username, password) {
  const row = db.prepare('SELECT * FROM teachers WHERE username = ?').get(username);
  if (!row) return null;
  const { hash } = hashPassword(password, row.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(row.pass_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

export function issueTeacherToken(teacherId) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO teacher_tokens(token, teacher_id, created_at) VALUES(?,?,?)').run(
    token,
    teacherId,
    now()
  );
  return token;
}

export function teacherFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT t.* FROM teacher_tokens tt JOIN teachers t ON t.id = tt.teacher_id
       WHERE tt.token = ?`
    )
    .get(token);
  return row || null;
}

export function revokeTeacherToken(token) {
  db.prepare('DELETE FROM teacher_tokens WHERE token = ?').run(token);
}

/* ------------------------------------------------------------- exam shape */

export function getSections(examId = getCurrentExamId()) {
  const rows = examId
    ? db.prepare('SELECT * FROM sections WHERE exam_id = ? ORDER BY ord ASC, rowid ASC').all(examId)
    : db.prepare('SELECT * FROM sections ORDER BY ord ASC, rowid ASC').all();
  return rows.map((s) => ({
    ...s,
    lock_after: !!s.lock_after,
    minutes: Number(s.minutes) || 0
  }));
}

export function getQuestions(examId = getCurrentExamId()) {
  const rows = examId
    ? db
        .prepare(
          `SELECT q.* FROM questions q JOIN sections s ON s.id = q.section_id
           WHERE s.exam_id = ? ORDER BY q.ord ASC, q.rowid ASC`
        )
        .all(examId)
    : db.prepare('SELECT * FROM questions ORDER BY ord ASC, rowid ASC').all();
  return rows.map((q) => ({
    ...q,
    choices: JSON.parse(q.choices || '[]'),
    answer: q.answer == null ? null : JSON.parse(q.answer),
    shuffle: !!q.shuffle,
    points: Number(q.points) || 0
  }));
}

/** Sections with their questions nested, in bank order. */
export function getExamBlueprint(examId = getCurrentExamId()) {
  const questions = getQuestions(examId);
  return getSections(examId).map((s) => ({
    ...s,
    questions: questions.filter((q) => q.section_id === s.id)
  }));
}

export function replaceExam({ title, sections }, examId = getCurrentExamId()) {
  const id = examId;
  const tx = () => {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM questions WHERE section_id IN (SELECT id FROM sections WHERE exam_id = ?)').run(id);
      db.prepare('DELETE FROM sections WHERE exam_id = ?').run(id);
      sections.forEach((sec, si) => {
        const sectionId = uid('sec_');
        db.prepare(
          `INSERT INTO sections(id, exam_id, ord, title, instructions, lock_after, minutes)
           VALUES(?,?,?,?,?,?,?)`
        ).run(
          sectionId,
          id,
          si,
          sec.title || `Part ${si + 1}`,
          sec.instructions || '',
          sec.lock_after === false ? 0 : 1,
          Number(sec.minutes) || 0
        );
        (sec.questions || []).forEach((q, qi) => {
          db.prepare(
            `INSERT INTO questions(id, section_id, ord, kind, prompt, choices, answer, points, shuffle, tags)
             VALUES(?,?,?,?,?,?,?,?,?,?)`
          ).run(
            uid('q_'),
            sectionId,
            qi,
            q.kind || 'mcq',
            q.prompt || '',
            JSON.stringify(q.choices || []),
            q.answer === undefined || q.answer === null ? null : JSON.stringify(q.answer),
            Number(q.points ?? 1),
            q.shuffle === false ? 0 : 1,
            q.tags || ''
          );
        });
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  tx();
  if (title) setExamSettings(id, { exam_title: title });
  return getExamBlueprint(id);
}

/* --------------------------------------------------------------- sessions */

const SESSION_COLUMNS = `token, exam_id, access_code, student_name, student_no, class_section,
  status, created_at, started_at, deadline, last_seen, order_seed, answers,
  section_index, max_section, cursor, reloads, ip, user_agent, submitted_at, score,
  max_score, pending_manual, violations, flagged, manual_notes, manual_scores`;

export function createSession(data) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO sessions(token, exam_id, access_code, student_name, student_no, class_section,
       status, created_at, last_seen, order_seed, ip, user_agent)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    token,
    data.exam_id || null,
    data.access_code,
    data.student_name,
    data.student_no,
    data.class_section || '',
    'active',
    now(),
    now(),
    crypto.randomInt(1, 2 ** 31),
    data.ip || '',
    data.user_agent || ''
  );
  return getSession(token);
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token = ?`).get(token);
  return row ? hydrateSession(row) : null;
}

export function hydrateSession(row) {
  return {
    ...row,
    answers: JSON.parse(row.answers || '{}'),
    manual_scores: JSON.parse(row.manual_scores || '{}'),
    flagged: !!row.flagged
  };
}

export function listSessions(filter) {
  let rows;
  if (filter && filter.exam_id) {
    rows = db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE exam_id = ? ORDER BY created_at ASC`)
      .all(filter.exam_id);
  } else if (typeof filter === 'string' && filter) {
    rows = db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE access_code = ? ORDER BY created_at ASC`)
      .all(filter);
  } else {
    rows = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at ASC`).all();
  }
  return rows.map(hydrateSession);
}

export function updateSession(token, patch) {
  const allowed = [
    'status', 'started_at', 'deadline', 'last_seen', 'answers', 'section_index',
    'max_section', 'cursor', 'reloads', 'submitted_at', 'score', 'max_score',
    'pending_manual', 'violations', 'flagged', 'manual_notes', 'manual_scores',
    'class_section', 'student_name', 'student_no'
  ];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return getSession(token);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const v = patch[k];
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  db.prepare(`UPDATE sessions SET ${sets} WHERE token = ?`).run(...values, token);
  return getSession(token);
}

export function logEvent(token, type, detail = '') {
  db.prepare('INSERT INTO events(token, at, type, detail) VALUES(?,?,?,?)').run(
    token,
    now(),
    type,
    String(detail).slice(0, 500)
  );
}

export function eventsFor(token) {
  return db.prepare('SELECT at, type, detail FROM events WHERE token = ? ORDER BY at ASC').all(token);
}

export function eventsSince(after = 0) {
  return db
    .prepare('SELECT token, at, type, detail FROM events WHERE at > ? ORDER BY at ASC LIMIT 500')
    .all(after);
}

export function deleteSessionsExceptKeep(examId = null) {
  if (examId) {
    db.prepare('DELETE FROM events WHERE token IN (SELECT token FROM sessions WHERE exam_id = ?)').run(examId);
    db.prepare('DELETE FROM sessions WHERE exam_id = ?').run(examId);
    return;
  }
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM sessions').run();
}
