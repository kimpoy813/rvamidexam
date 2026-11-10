/**
 * Persistence layer.
 *
 * Uses Node 22's built-in SQLite (`node:sqlite`) for fast synchronous in-process
 * reads/writes, and — when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (or
 * `DATABASE_URL` / `SUPABASE_DB_URL`) is configured — hydrates from Supabase /
 * PostgreSQL on boot and durably syncs relational changes back to Supabase.
 *
 * Multiple exams are supported. Each exam owns its question bank, its own
 * settings (title, duration, access code, …) and its own roster of attempts.
 * The teacher switches the "current" exam from the dashboard; a student is
 * routed to whichever exam their access code belongs to.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { resolveRemoteConfig, createConfiguredRemoteStore } from './remote-store.js';

export const teacherContext = new AsyncLocalStorage();
export const currentTeacherId = () => teacherContext.getStore()?.teacherId || null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

const initialRemoteConfig = resolveRemoteConfig(process.env);
const defaultCacheDir = initialRemoteConfig
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'rvam-supabase-cache-'))
  : path.join(ROOT, 'data');

export const DATA_DIR = process.env.EXAM_DATA_DIR || defaultCacheDir;
export const DB_PATH = process.env.EXAM_DB || path.join(DATA_DIR, 'exam.sqlite');

// On Render, never silently initialize a new database on an ephemeral root
// filesystem when durable storage was expected. Configuring Supabase / Postgres
// satisfies durability without requiring a paid Render persistent disk.
if ((process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID) && !initialRemoteConfig) {
  if (process.env.EXAM_STORAGE_MODE !== 'persistent') {
    if (process.env.EXAM_ALLOW_EPHEMERAL !== 'true') {
      throw new Error(
        'Render requires durable storage: configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or DATABASE_URL), attach a persistent disk with EXAM_DATA_DIR and EXAM_STORAGE_MODE=persistent, or set EXAM_ALLOW_EPHEMERAL=true for a disposable demo.'
      );
    }
  } else {
    const dataPath = path.resolve(DATA_DIR);
    const dbPath = path.resolve(DB_PATH);
    const relative = path.relative(dataPath, dbPath);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('EXAM_DB must be inside the persistent EXAM_DATA_DIR.');
    }
    let mounts;
    try {
      mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
        .map(line => line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
    } catch {
      throw new Error('Cannot verify the Render persistent disk mount.');
    }
    if (!mounts.includes(dataPath)) {
      throw new Error(`Persistent disk is not mounted at EXAM_DATA_DIR (${dataPath}); refusing to create a temporary database.`);
    }
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
-- Exam configuration and answers are more important than a small write-speed
-- gain. FULL makes SQLite wait until a committed change is on disk before the
-- API reports it as saved, including when the host is stopped immediately.
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
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

if (!hasColumn('exams', 'teacher_id')) db.exec('ALTER TABLE exams ADD COLUMN teacher_id INTEGER REFERENCES teachers(id)');

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

// A stable ID lets the dashboard distinguish a normal browser reopen from a
// hosting provider replacing the database with a fresh ephemeral filesystem.
const storageIdRow = db.prepare("SELECT value FROM settings WHERE key = 'storage_id'").get();
if (!storageIdRow) {
  db.prepare("INSERT INTO settings(key, value) VALUES('storage_id', ?)")
    .run(crypto.randomBytes(16).toString('hex'));
}

/* ------------------------------------------------- remote sync coordinator */

const SESSION_COLUMNS = `token, exam_id, access_code, student_name, student_no, class_section,
  status, created_at, started_at, deadline, last_seen, order_seed, answers,
  section_index, max_section, cursor, reloads, ip, user_agent, submitted_at, score,
  max_score, pending_manual, violations, flagged, manual_notes, manual_scores`;

let remoteStore = null;
let remoteEnabled = false;
let lastSyncedEventId = 0;
let activeFlush = null;
let heartbeatTimer = null;

const dirtyTeachers = new Set();
const dirtyTokens = new Set();
const deletedTokens = new Set();
const dirtyExams = new Set();
const deletedExams = new Set();
const dirtySettings = new Set();
const deletedSettings = new Set();
const replacedExamBanks = new Set();
const dirtySessions = new Set();
const heartbeatSessions = new Set();
const deletedSessionExams = new Set();
const deletedEventTokens = new Set();
let sessionsClearedAll = false;
let pendingEventSync = false;

function scheduleHeartbeatFlush() {
  if (!remoteEnabled || heartbeatTimer) return;
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null;
    flushRemoteStorage({ includeHeartbeats: true }).catch((err) => {
      console.error('[exam] background heartbeat sync failed:', err.message);
    });
  }, 5000);
  heartbeatTimer.unref?.();
}

function markTeacherDirty(id) {
  if (remoteEnabled && id != null) dirtyTeachers.add(Number(id));
}

function markTokenDirty(token) {
  if (!remoteEnabled || !token) return;
  deletedTokens.delete(token);
  dirtyTokens.add(token);
}

function markTokenDeleted(token) {
  if (!remoteEnabled || !token) return;
  dirtyTokens.delete(token);
  deletedTokens.add(token);
}

function markExamDirty(id) {
  if (!remoteEnabled || !id) return;
  deletedExams.delete(id);
  dirtyExams.add(id);
}

function markExamBankReplaced(id) {
  if (!remoteEnabled || !id) return;
  replacedExamBanks.add(id);
}

function markExamDeleted(id, sessionTokens = []) {
  if (!remoteEnabled || !id) return;
  dirtyExams.delete(id);
  replacedExamBanks.delete(id);
  deletedExams.add(id);
  deletedSessionExams.add(id);
  for (const tok of sessionTokens) {
    dirtySessions.delete(tok);
    heartbeatSessions.delete(tok);
    deletedEventTokens.add(tok);
  }
}

function markSettingDirty(key) {
  if (!remoteEnabled || !key) return;
  deletedSettings.delete(key);
  dirtySettings.add(key);
}

function markSettingDeleted(key) {
  if (!remoteEnabled || !key) return;
  dirtySettings.delete(key);
  deletedSettings.add(key);
}

function markSessionDirty(token, { urgent = true } = {}) {
  if (!remoteEnabled || !token) return;
  if (urgent) {
    heartbeatSessions.delete(token);
    dirtySessions.add(token);
  } else if (!dirtySessions.has(token)) {
    heartbeatSessions.add(token);
    scheduleHeartbeatFlush();
  }
}

function markExamSessionsCleared(examId, sessionTokens = []) {
  if (!remoteEnabled || !examId) return;
  deletedSessionExams.add(examId);
  for (const tok of sessionTokens) {
    dirtySessions.delete(tok);
    heartbeatSessions.delete(tok);
    deletedEventTokens.add(tok);
  }
}

function markAllSessionsCleared() {
  if (!remoteEnabled) return;
  sessionsClearedAll = true;
  deletedSessionExams.clear();
  deletedEventTokens.clear();
  dirtySessions.clear();
  heartbeatSessions.clear();
}

export function isRemoteStorageEnabled() {
  return remoteEnabled;
}

export function hasUrgentRemoteSync() {
  if (!remoteEnabled) return false;
  return Boolean(
    dirtyTeachers.size ||
    dirtyTokens.size ||
    deletedTokens.size ||
    dirtyExams.size ||
    deletedExams.size ||
    dirtySettings.size ||
    deletedSettings.size ||
    replacedExamBanks.size ||
    dirtySessions.size ||
    deletedSessionExams.size ||
    deletedEventTokens.size ||
    sessionsClearedAll ||
    pendingEventSync
  );
}

function hydrateLocalSqlite(dataset) {
  const localStorageId =
    db.prepare("SELECT value FROM settings WHERE key = 'storage_id'").get()?.value ||
    crypto.randomBytes(16).toString('hex');
  const remoteHasStorageId = (dataset.settings || []).some((s) => s.key === 'storage_id');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      DELETE FROM questions;
      DELETE FROM sections;
      DELETE FROM events;
      DELETE FROM sessions;
      DELETE FROM exams;
      DELETE FROM teacher_tokens;
      DELETE FROM teachers;
      DELETE FROM settings;
    `);

    const insTeacher = db.prepare(
      'INSERT INTO teachers(id, username, pass_hash, salt, created_at) VALUES(?,?,?,?,?)'
    );
    for (const t of dataset.teachers || []) {
      insTeacher.run(t.id, t.username, t.pass_hash, t.salt, t.created_at);
    }

    const insToken = db.prepare(
      'INSERT INTO teacher_tokens(token, teacher_id, created_at) VALUES(?,?,?)'
    );
    for (const tk of dataset.teacher_tokens || []) {
      insToken.run(tk.token, tk.teacher_id, tk.created_at);
    }

    const insExam = db.prepare(
      'INSERT INTO exams(id, title, access_code, settings, created_at, teacher_id) VALUES(?,?,?,?,?,?)'
    );
    for (const ex of dataset.exams || []) {
      insExam.run(ex.id, ex.title, ex.access_code, ex.settings, ex.created_at, ex.teacher_id);
    }

    const insSetting = db.prepare('INSERT INTO settings(key, value) VALUES(?,?)');
    for (const st of dataset.settings || []) {
      insSetting.run(st.key, st.value);
    }
    if (!remoteHasStorageId) {
      insSetting.run('storage_id', localStorageId);
    }

    const insSection = db.prepare(
      'INSERT INTO sections(id, exam_id, ord, title, instructions, lock_after, minutes) VALUES(?,?,?,?,?,?,?)'
    );
    for (const sec of dataset.sections || []) {
      insSection.run(sec.id, sec.exam_id, sec.ord, sec.title, sec.instructions, sec.lock_after, sec.minutes);
    }

    const insQuestion = db.prepare(
      'INSERT INTO questions(id, section_id, ord, kind, prompt, choices, answer, points, shuffle, tags) VALUES(?,?,?,?,?,?,?,?,?,?)'
    );
    for (const q of dataset.questions || []) {
      insQuestion.run(q.id, q.section_id, q.ord, q.kind, q.prompt, q.choices, q.answer, q.points, q.shuffle, q.tags);
    }

    const insSession = db.prepare(
      `INSERT INTO sessions(${SESSION_COLUMNS})
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const s of dataset.sessions || []) {
      insSession.run(
        s.token, s.exam_id, s.access_code, s.student_name, s.student_no, s.class_section,
        s.status, s.created_at, s.started_at, s.deadline, s.last_seen, s.order_seed, s.answers,
        s.section_index, s.max_section, s.cursor, s.reloads, s.ip, s.user_agent, s.submitted_at,
        s.score, s.max_score, s.pending_manual, s.violations, s.flagged, s.manual_notes, s.manual_scores
      );
    }

    const insEvent = db.prepare('INSERT INTO events(id, token, at, type, detail) VALUES(?,?,?,?,?)');
    for (const ev of dataset.events || []) {
      insEvent.run(ev.id, ev.token, ev.at, ev.type, ev.detail);
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  dirtyTeachers.clear();
  dirtyTokens.clear();
  deletedTokens.clear();
  dirtyExams.clear();
  deletedExams.clear();
  dirtySettings.clear();
  deletedSettings.clear();
  replacedExamBanks.clear();
  dirtySessions.clear();
  heartbeatSessions.clear();
  deletedSessionExams.clear();
  deletedEventTokens.clear();
  sessionsClearedAll = false;
  pendingEventSync = false;
  lastSyncedEventId = (dataset.events || []).reduce((max, ev) => Math.max(max, Number(ev.id) || 0), 0);

  if (!remoteHasStorageId) {
    dirtySettings.add('storage_id');
  }
}

export async function initRemoteStorage(customStore = null) {
  const store = customStore || createConfiguredRemoteStore(process.env);
  if (!store) return false;
  const dataset = await store.init();
  remoteStore = store;
  hydrateLocalSqlite(dataset);
  remoteEnabled = true;
  return true;
}

function drainBatchSnapshot({ includeHeartbeats = false } = {}) {
  const teacherIds = [...dirtyTeachers];
  dirtyTeachers.clear();

  const delTokens = [...deletedTokens];
  deletedTokens.clear();
  const upTokenIds = [...dirtyTokens];
  dirtyTokens.clear();

  const delExams = [...deletedExams];
  deletedExams.clear();
  const upExamIds = [...dirtyExams].filter((id) => !delExams.includes(id));
  dirtyExams.clear();

  const delSettings = [...deletedSettings];
  deletedSettings.clear();
  const upSettingKeys = [...dirtySettings].filter((k) => !delSettings.includes(k));
  dirtySettings.clear();

  const bankExamIds = [...replacedExamBanks].filter((id) => !delExams.includes(id));
  replacedExamBanks.clear();

  const clearAll = sessionsClearedAll;
  sessionsClearedAll = false;
  const clearExamIds = [...deletedSessionExams];
  deletedSessionExams.clear();
  const delEvTokens = [...deletedEventTokens];
  deletedEventTokens.clear();

  const urgentTokens = [...dirtySessions];
  dirtySessions.clear();
  for (const t of urgentTokens) heartbeatSessions.delete(t);

  const hbTokens = includeHeartbeats ? [...heartbeatSessions] : [];
  if (includeHeartbeats) heartbeatSessions.clear();

  const wasEventPending = pendingEventSync;
  pendingEventSync = false;

  const upsertTeachers = teacherIds
    .map((id) => db.prepare('SELECT id, username, pass_hash, salt, created_at FROM teachers WHERE id = ?').get(id))
    .filter(Boolean);

  const upsertTokens = upTokenIds
    .map((tok) => db.prepare('SELECT token, teacher_id, created_at FROM teacher_tokens WHERE token = ?').get(tok))
    .filter(Boolean);

  const upsertExams = upExamIds
    .map((id) => db.prepare('SELECT id, title, access_code, settings, created_at, teacher_id FROM exams WHERE id = ?').get(id))
    .filter(Boolean);

  const upsertSettings = upSettingKeys
    .map((k) => db.prepare('SELECT key, value FROM settings WHERE key = ?').get(k))
    .filter(Boolean);

  const upsertSections = [];
  const upsertQuestions = [];
  for (const examId of bankExamIds) {
    const secs = db
      .prepare('SELECT id, exam_id, ord, title, instructions, lock_after, minutes FROM sections WHERE exam_id = ? ORDER BY ord ASC, rowid ASC')
      .all(examId);
    const qs = db
      .prepare(
        `SELECT q.id, q.section_id, q.ord, q.kind, q.prompt, q.choices, q.answer, q.points, q.shuffle, q.tags
         FROM questions q JOIN sections s ON s.id = q.section_id
         WHERE s.exam_id = ? ORDER BY q.ord ASC, q.rowid ASC`
      )
      .all(examId);
    upsertSections.push(...secs);
    upsertQuestions.push(...qs);
  }

  const allSessionTokens = [...new Set([...urgentTokens, ...hbTokens])];
  const upsertSessions = allSessionTokens
    .map((tok) => db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token = ?`).get(tok))
    .filter(Boolean);

  const upsertEvents = db
    .prepare('SELECT id, token, at, type, detail FROM events WHERE id > ? ORDER BY id ASC')
    .all(lastSyncedEventId);

  const isEmpty =
    !upsertTeachers.length &&
    !delTokens.length &&
    !upsertTokens.length &&
    !delExams.length &&
    !upsertExams.length &&
    !delSettings.length &&
    !upsertSettings.length &&
    !bankExamIds.length &&
    !clearAll &&
    !clearExamIds.length &&
    !delEvTokens.length &&
    !upsertSessions.length &&
    !upsertEvents.length;

  return {
    isEmpty,
    raw: {
      teacherIds,
      delTokens,
      upTokenIds,
      delExams,
      upExamIds,
      delSettings,
      upSettingKeys,
      bankExamIds,
      clearAll,
      clearExamIds,
      delEvTokens,
      urgentTokens,
      hbTokens,
      wasEventPending
    },
    batch: {
      upsertTeachers,
      deleteTokens: delTokens,
      upsertTokens,
      deleteExams: delExams,
      upsertExams,
      deleteSettings: delSettings,
      upsertSettings,
      replaceBankExamIds: bankExamIds,
      upsertSections,
      upsertQuestions,
      clearAllSessions: clearAll,
      clearSessionExamIds: clearExamIds,
      deleteEventTokens: delEvTokens,
      upsertSessions,
      upsertEvents
    }
  };
}

function requeueSnapshot(raw) {
  for (const id of raw.teacherIds) dirtyTeachers.add(id);
  for (const t of raw.delTokens) if (!dirtyTokens.has(t)) deletedTokens.add(t);
  for (const t of raw.upTokenIds) if (!deletedTokens.has(t)) dirtyTokens.add(t);
  for (const id of raw.delExams) if (!dirtyExams.has(id)) deletedExams.add(id);
  for (const id of raw.upExamIds) if (!deletedExams.has(id)) dirtyExams.add(id);
  for (const k of raw.delSettings) if (!dirtySettings.has(k)) deletedSettings.add(k);
  for (const k of raw.upSettingKeys) if (!deletedSettings.has(k)) dirtySettings.add(k);
  for (const id of raw.bankExamIds) if (!deletedExams.has(id)) replacedExamBanks.add(id);
  if (raw.clearAll) sessionsClearedAll = true;
  for (const id of raw.clearExamIds) deletedSessionExams.add(id);
  for (const t of raw.delEvTokens) deletedEventTokens.add(t);
  for (const t of raw.urgentTokens) dirtySessions.add(t);
  for (const t of raw.hbTokens) if (!dirtySessions.has(t)) heartbeatSessions.add(t);
  if (raw.wasEventPending) pendingEventSync = true;
}

export async function flushRemoteStorage({ includeHeartbeats = false } = {}) {
  if (!remoteEnabled || !remoteStore) return;
  if (activeFlush) {
    await activeFlush;
    if (!hasUrgentRemoteSync() && !(includeHeartbeats && heartbeatSessions.size)) return;
  }

  activeFlush = (async () => {
    while (true) {
      const snap = drainBatchSnapshot({ includeHeartbeats });
      if (snap.isEmpty) break;
      try {
        await remoteStore.pushBatch(snap.batch);
        if (snap.batch.upsertEvents.length) {
          const maxId = snap.batch.upsertEvents[snap.batch.upsertEvents.length - 1].id;
          lastSyncedEventId = Math.max(lastSyncedEventId, maxId);
        }
      } catch (err) {
        requeueSnapshot(snap.raw);
        throw err;
      }
      if (!hasUrgentRemoteSync() && !(includeHeartbeats && heartbeatSessions.size)) break;
    }
  })();

  try {
    await activeFlush;
  } finally {
    activeFlush = null;
  }
}

export async function closeRemoteStorage() {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!remoteStore) return;
  const store = remoteStore;
  remoteStore = null;
  remoteEnabled = false;
  await store.close();
}

/* ------------------------------------------------------------------ utils */

export const now = () => Date.now();

export const uid = (prefix = '') =>
  prefix + crypto.randomBytes(8).toString('hex');

/** Force committed WAL pages into the main database before shutdown/backup. */
export function checkpointDatabase() {
  try {
    return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } catch {
    return null;
  }
}

/** Non-sensitive storage diagnostics for the authenticated teacher dashboard. */
export function getStorageInfo() {
  if (remoteEnabled && remoteStore) {
    return {
      storageId: db.prepare("SELECT value FROM settings WHERE key = 'storage_id'").get()?.value || '',
      durable: true,
      mode: remoteStore.mode || 'supabase',
      warning: ''
    };
  }
  const onRender = process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);
  const declaredPersistent = process.env.EXAM_STORAGE_MODE === 'persistent';
  const durable = !onRender || declaredPersistent;
  return {
    storageId: db.prepare("SELECT value FROM settings WHERE key = 'storage_id'").get()?.value || '',
    durable,
    mode: declaredPersistent ? 'persistent-disk' : onRender ? 'host-filesystem' : 'local-disk',
    warning: durable
      ? ''
      : 'This Render service is using an ephemeral filesystem. Configure Supabase or attach a persistent disk so setup does not reset on restart.'
  };
}

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
  exam_title: 'Final Examination',
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
  const teacherId = currentTeacherId();
  if (teacherId) {
    const key = `teacher_current_exam_${teacherId}`;
    const pointer = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (pointer && db.prepare('SELECT 1 FROM exams WHERE id = ? AND teacher_id = ?').get(pointer.value, teacherId)) return pointer.value;
    const first = db.prepare('SELECT id FROM exams WHERE teacher_id = ? ORDER BY created_at, rowid').get(teacherId);
    if (first) setCurrentExamId(first.id);
    return first?.id || null;
  }
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
  const teacherId = currentTeacherId();
  if (teacherId) {
    if (!db.prepare('SELECT 1 FROM exams WHERE id = ? AND teacher_id = ?').get(id, teacherId)) return;
    const key = `teacher_current_exam_${teacherId}`;
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, id);
    markSettingDirty(key);
    return;
  }
  stmtSetPointer.run(id);
  markSettingDirty('current_exam_id');
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
  const rows = currentTeacherId() ? db.prepare('SELECT * FROM exams WHERE teacher_id = ? ORDER BY created_at ASC, rowid ASC').all(currentTeacherId()) : db.prepare('SELECT * FROM exams ORDER BY created_at ASC, rowid ASC').all();
  return rows.map((e) => {
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
  db.prepare('INSERT INTO exams(id, title, access_code, settings, created_at, teacher_id) VALUES(?,?,?,?,?,?)')
    .run(id, title, code, JSON.stringify(merged), now(), currentTeacherId());
  markExamDirty(id);
  setCurrentExamId(id);
  return getExam(id);
}

export function assignUnownedExams(teacherId) {
  if (!teacherId) return;
  const rows = db.prepare('SELECT id FROM exams WHERE teacher_id IS NULL').all();
  if (!rows.length) return;
  db.prepare('UPDATE exams SET teacher_id = ? WHERE teacher_id IS NULL').run(teacherId);
  for (const r of rows) markExamDirty(r.id);
}

export function deleteExam(id) {
  const count = currentTeacherId() ? db.prepare('SELECT COUNT(*) AS c FROM exams WHERE teacher_id = ?').get(currentTeacherId()).c : db.prepare('SELECT COUNT(*) AS c FROM exams').get().c;
  if (count <= 1) throw new Error('You need at least one exam.');
  const sessionTokens = db.prepare('SELECT token FROM sessions WHERE exam_id = ?').all(id).map((r) => r.token);
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
  markExamDeleted(id, sessionTokens);
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
  return createExam({ title: 'Final Examination', access_code: makeAccessCode() }).id;
}

function migrateLegacy() {
  const examCount = db.prepare('SELECT COUNT(*) AS c FROM exams').get().c;
  if (examCount > 0) return;

  const sectionCount = db.prepare('SELECT COUNT(*) AS c FROM sections').get().c;
  const legacyRows = db.prepare(
    "SELECT key, value FROM settings WHERE key NOT IN ('current_exam_id', 'storage_id')"
  ).all();

  // Fresh database: nothing to migrate.
  if (sectionCount === 0 && legacyRows.length === 0) return;

  const legacy = {};
  for (const r of legacyRows) legacy[r.key] = r.value;
  const title = legacy.exam_title || 'Final Examination';
  const code = legacy.access_code || makeAccessCode();

  const id = uid('ex_');
  const merged = { ...DEFAULT_SETTINGS, ...legacy, access_code: code };
  db.prepare('INSERT INTO exams(id, title, access_code, settings, created_at) VALUES(?,?,?,?,?)')
    .run(id, title, code, JSON.stringify(merged), now());
  db.prepare("UPDATE sections SET exam_id = ? WHERE exam_id IS NULL OR exam_id = ''").run(id);
  db.prepare("DELETE FROM settings WHERE key NOT IN ('current_exam_id', 'storage_id')").run();
  markExamDirty(id);
  markExamBankReplaced(id);
  for (const r of legacyRows) markSettingDeleted(r.key);
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

  // Keep the JSON settings, display title, and access-code index in one durable
  // transaction. A shutdown can no longer leave only part of the setup saved.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE exams SET settings = ?, access_code = ?, title = ? WHERE id = ?').run(
      JSON.stringify(next),
      next.access_code,
      next.exam_title,
      id
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  markExamDirty(id);
  return settingsFor(id);
}

export function setSettings(patch) {
  return setExamSettings(getCurrentExamId(), patch);
}

/* --------------------------------------------------------------- teachers */

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}

export function teacherUsernameExists(username) {
  return Boolean(db.prepare('SELECT 1 FROM teachers WHERE username = ? COLLATE NOCASE').get(username));
}

export function ensureTeacher(username, password) {
  const row = db.prepare('SELECT * FROM teachers WHERE username = ? COLLATE NOCASE').get(username);
  if (row) return row;
  const { hash, salt } = hashPassword(password);
  db.prepare(
    'INSERT INTO teachers(username, pass_hash, salt, created_at) VALUES(?,?,?,?)'
  ).run(username, hash, salt, now());
  const created = db.prepare('SELECT * FROM teachers WHERE username = ? COLLATE NOCASE').get(username);
  markTeacherDirty(created?.id);
  return created;
}

export function updateTeacherPassword(teacherId, newPassword) {
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE teachers SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, teacherId);
  markTeacherDirty(teacherId);
}

export function verifyTeacher(username, password) {
  const row = db.prepare('SELECT * FROM teachers WHERE username = ? COLLATE NOCASE').get(username);
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
  markTokenDirty(token);
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
  if (!token) return;
  db.prepare('DELETE FROM teacher_tokens WHERE token = ?').run(token);
  markTokenDeleted(token);
}

export function discardUnpersistedRegistration({ teacherId, examId, token }) {
  db.exec('BEGIN');
  try {
    if (token) db.prepare('DELETE FROM teacher_tokens WHERE token = ?').run(token);
    if (examId) {
      db.prepare('DELETE FROM questions WHERE section_id IN (SELECT id FROM sections WHERE exam_id = ?)').run(examId);
      db.prepare('DELETE FROM sections WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    }
    if (teacherId != null) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(`teacher_current_exam_${teacherId}`);
      db.prepare('DELETE FROM teachers WHERE id = ?').run(teacherId);
    }
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  }
  if (teacherId != null) {
    dirtyTeachers.delete(Number(teacherId));
    dirtySettings.delete(`teacher_current_exam_${teacherId}`);
    deletedSettings.delete(`teacher_current_exam_${teacherId}`);
  }
  if (examId) {
    dirtyExams.delete(examId);
    deletedExams.delete(examId);
    replacedExamBanks.delete(examId);
  }
  if (token) {
    dirtyTokens.delete(token);
    deletedTokens.delete(token);
  }
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
  markExamBankReplaced(id);
  if (title) setExamSettings(id, { exam_title: title });
  return getExamBlueprint(id);
}

/* --------------------------------------------------------------- sessions */

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
  markSessionDirty(token, { urgent: true });
  return getSession(token);
}

export function discardUnpersistedSession(token) {
  if (!token) return;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM events WHERE token = ?').run(token);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  }
  dirtySessions.delete(token);
  heartbeatSessions.delete(token);
  deletedEventTokens.delete(token);
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
    rows = currentTeacherId() ? db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE exam_id IN (SELECT id FROM exams WHERE teacher_id = ?) ORDER BY created_at ASC`).all(currentTeacherId()) : db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at ASC`).all();
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
  const heartbeatOnly = keys.length === 1 && keys[0] === 'last_seen';
  markSessionDirty(token, { urgent: !heartbeatOnly });
  return getSession(token);
}

export function logEvent(token, type, detail = '') {
  db.prepare('INSERT INTO events(token, at, type, detail) VALUES(?,?,?,?)').run(
    token,
    now(),
    type,
    String(detail).slice(0, 500)
  );
  if (remoteEnabled) pendingEventSync = true;
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
    const tokens = db.prepare('SELECT token FROM sessions WHERE exam_id = ?').all(examId).map((r) => r.token);
    db.prepare('DELETE FROM events WHERE token IN (SELECT token FROM sessions WHERE exam_id = ?)').run(examId);
    db.prepare('DELETE FROM sessions WHERE exam_id = ?').run(examId);
    markExamSessionsCleared(examId, tokens);
    return;
  }
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM sessions').run();
  markAllSessionsCleared();
}
