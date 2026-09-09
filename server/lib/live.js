/**
 * Live roster: turns raw session rows into the snapshot the teacher dashboard
 * renders, and pushes it over SSE whenever something changes.
 */
import {
  listSessions, getSettings, getExamSettings, getCurrentExamId, now,
  updateSession, logEvent, getSession, eventsSince, listExams
} from './db.js';
import { buildPaper, gradePaper } from './exam.js';
import { SseHub } from './http.js';

export const hub = new SseHub();
hub.startHeartbeat(15000);

const ONLINE_WINDOW_MS = 12_000;

export function secondsLeft(session, settings = getSettings()) {
  if (!session.started_at) return Number(settings.duration_minutes) * 60;
  if (!session.deadline) return Number(settings.duration_minutes) * 60;
  return Math.max(0, Math.round((session.deadline - now()) / 1000));
}

/** Auto-submit anyone whose server-side deadline has passed. */
export function enforceDeadlines() {
  const due = listSessions()
    .filter((s) => s.status === 'active' && s.deadline && s.deadline <= now());
  for (const s of due) {
    finishSession(s, 'auto_timeout', getExamSettings(s.exam_id));
  }
  return due.length;
}

/**
 * Ends a session: freezes answers, grades everything auto-gradable and records
 * the reason (student, timeout, or teacher action).
 */
export function finishSession(session, reason = 'student', settings = getSettings(), patch = {}) {
  const status = reason === 'invalidated' ? 'invalidated'
    : reason === 'teacher' ? 'force_submitted'
    : 'submitted';

  const paper = buildPaper(session, undefined, settings);
  const grade = gradePaper(paper, session.answers, session.manual_scores, session.exam_id);

  const updated = updateSession(session.token, {
    status,
    submitted_at: now(),
    score: grade.score,
    max_score: grade.max,
    pending_manual: grade.pending,
    ...patch
  });

  logEvent(session.token, 'submit', `${reason} | score ${grade.score}/${grade.max}`);
  broadcastRoster(true);
  return { session: updated, grade };
}

export function studentSnapshot(session, paper, settings) {
  const submitted = session.status !== 'active';
  const answeredCount = Object.values(session.answers).filter(
    (a) => a && a.value !== '' && a.value !== null && !(Array.isArray(a.value) && a.value.length === 0)
  ).length;
  const total = paper.reduce((n, s) => n + s.questions.length, 0);
  const section = paper[Math.min(session.section_index, paper.length - 1)] || paper[0];
  const ago = now() - session.last_seen;

  let grade = null;
  if (submitted) {
    grade = gradePaper(paper, session.answers, session.manual_scores, session.exam_id);
  }

  return {
    token: session.token,
    examId: session.exam_id,
    shortId: session.token.slice(0, 6).toUpperCase(),
    name: session.student_name,
    studentNo: session.student_no,
    classSection: session.class_section,
    status: session.status,
    submitted,
    online: !submitted && ago < ONLINE_WINDOW_MS,
    lastSeenAgo: Math.max(0, Math.round(ago / 1000)),
    started: !!session.started_at,
    startedAt: session.started_at,
    secondsLeft: secondsLeft(session, settings),
    progress: total ? answeredCount / total : 0,
    answered: answeredCount,
    total,
    sectionIndex: session.section_index,
    sectionTitle: section ? section.title : '',
    maxSection: session.max_section,
    questionNumber: Math.min(session.cursor + 1, total),
    violations: session.violations,
    flagged: !!session.flagged,
    reloads: session.reloads,
    ip: session.ip,
    createdAt: session.created_at,
    submittedAt: session.submitted_at,
    score: grade ? grade.score : null,
    max: grade ? grade.max : null,
    percent: grade ? grade.percent : null,
    pending: grade ? grade.pending : null,
    needsManual: grade ? grade.pending > 0 : false
  };
}

/** Full roster + class summary used by both SSE and the polling fallback. */
export function rosterSnapshot() {
  const examId = getCurrentExamId();
  const settings = getExamSettings(examId);
  const paper = buildPaper({ order_seed: 0, exam_id: examId }, undefined, settings); // shape only
  const sessions = listSessions({ exam_id: examId });

  const students = sessions.map((s) => studentSnapshot(s, buildPaper(s, undefined, settings), settings));

  const active = students.filter((s) => !s.submitted);
  const done = students.filter((s) => s.submitted);
  const scored = done.filter((s) => s.score !== null && !s.needsManual);

  const byToken = new Map(students.map((s) => [s.token, s]));
  const tokens = new Set(byToken.keys());
  const feed = eventsSince(now() - 45 * 60 * 1000)
    .filter((e) => tokens.has(e.token))
    .slice(-60)
    .reverse()
    .map((e) => ({
      at: e.at,
      type: e.type,
      detail: e.detail,
      token: e.token,
      name: byToken.get(e.token)?.name || 'Unknown student'
    }));

  const summary = {
    total: students.length,
    online: active.filter((s) => s.online).length,
    inProgress: active.length,
    submitted: done.length,
    needsManual: done.filter((s) => s.needsManual).length,
    flagged: students.filter((s) => s.flagged).length,
    violations: students.reduce((n, s) => n + s.violations, 0),
    averageProgress:
      active.length ? active.reduce((n, s) => n + s.progress, 0) / active.length : 0,
    averagePercent:
      scored.length ? scored.reduce((n, s) => n + s.percent, 0) / scored.length : null,
    highest: scored.length ? Math.max(...scored.map((s) => s.percent)) : null,
    lowest: scored.length ? Math.min(...scored.map((s) => s.percent)) : null,
    paperTotal: paper.reduce((n, s) => n + s.questions.length, 0),
    examOpen: settings.exam_open === '1'
  };

  return { at: now(), summary, students, feed };
}

/**
 * A combined roster across every exam, so the teacher can monitor several
 * exams running at once. Each student is tagged with the exam they belong to,
 * and the summary carries a per-exam breakdown.
 */
export function rosterSnapshotAll() {
  const exams = listExams();
  const examById = new Map(exams.map((e) => [e.id, e]));
  const sessions = listSessions();

  const students = sessions.map((s) => {
    const settings = examById.get(s.exam_id)?.settings || getExamSettings(s.exam_id);
    const snap = studentSnapshot(s, buildPaper(s, undefined, settings), settings);
    snap.examTitle = examById.get(s.exam_id)?.title || 'Unknown exam';
    return snap;
  });

  const active = students.filter((s) => !s.submitted);
  const done = students.filter((s) => s.submitted);
  const scored = done.filter((s) => s.score !== null && !s.needsManual);

  const byToken = new Map(students.map((s) => [s.token, s]));
  const tokens = new Set(byToken.keys());
  const feed = eventsSince(now() - 45 * 60 * 1000)
    .filter((e) => tokens.has(e.token))
    .slice(-60)
    .reverse()
    .map((e) => ({
      at: e.at,
      type: e.type,
      detail: e.detail,
      token: e.token,
      name: byToken.get(e.token)?.name || 'Unknown student'
    }));

  const perExam = exams.map((e) => {
    const members = students.filter((s) => s.examId === e.id);
    const memberActive = members.filter((s) => !s.submitted);
    return {
      id: e.id,
      title: e.title,
      accessCode: e.access_code,
      examOpen: e.settings.exam_open === '1',
      total: members.length,
      online: memberActive.filter((s) => s.online).length,
      inProgress: memberActive.length,
      submitted: members.length - memberActive.length,
      flagged: members.filter((s) => s.flagged).length
    };
  });

  const summary = {
    total: students.length,
    online: active.filter((s) => s.online).length,
    inProgress: active.length,
    submitted: done.length,
    needsManual: done.filter((s) => s.needsManual).length,
    flagged: students.filter((s) => s.flagged).length,
    violations: students.reduce((n, s) => n + s.violations, 0),
    averageProgress:
      active.length ? active.reduce((n, s) => n + s.progress, 0) / active.length : 0,
    averagePercent:
      scored.length ? scored.reduce((n, s) => n + s.percent, 0) / scored.length : null,
    highest: scored.length ? Math.max(...scored.map((s) => s.percent)) : null,
    lowest: scored.length ? Math.min(...scored.map((s) => s.percent)) : null,
    examCount: exams.length,
    paperTotal: null,
    examOpen: exams.some((e) => e.settings.exam_open === '1')
  };

  return { at: now(), summary, students, exams: perExam, feed };
}

/* ------------------------------------------------------- integrity events */

const VIOLATION_LABELS = {
  tab_hidden: 'Switched away from the exam tab',
  fullscreen_exit: 'Left full-screen mode',
  window_blur: 'Exam window lost focus',
  copy: 'Attempted to copy content',
  paste: 'Attempted to paste content',
  cut: 'Attempted to cut content',
  contextmenu: 'Opened the right-click menu',
  devtools_key: 'Pressed a developer-tools shortcut',
  second_tab: 'Opened the exam in a second tab',
  reload: 'Reloaded the exam page',
  resize: 'Resized the window (possible dev tools)',
  print: 'Attempted to print the exam',
  select: 'Selected exam text',
  navigation: 'Attempted to leave the page'
};

export function violationLabel(type) {
  return VIOLATION_LABELS[type] || type;
}

/**
 * Records an integrity event against a session and enforces the thresholds the
 * teacher configured (flag, and optionally auto-submit).
 */
export function registerViolation(token, type, detail = '', settings = getSettings()) {
  const session = getSession(token);
  if (!session) return null;
  settings = getExamSettings(session.exam_id);

  const count = session.violations + 1;
  const limit = Number(settings.max_violations) || 0;
  const flagged = limit > 0 && count >= limit;

  logEvent(token, `violation:${type}`, detail || violationLabel(type));
  const updated = updateSession(token, { violations: count, flagged });

  if (flagged && !session.flagged) {
    logEvent(token, 'flagged', `Violation limit (${limit}) reached`);
  }

  if (flagged && settings.auto_submit_on_violations === '1' && session.status === 'active') {
    finishSession(session, 'teacher', settings);
  }

  broadcastRoster(true);
  return { count, flagged, limit };
}

/* -------------------------------------------------------------- broadcast */

/** Debounced broadcast so a burst of heartbeats does not flood the dashboard. */
let scheduled = null;
let lastPayload = '';
export function broadcastRoster(force = false) {
  if (scheduled && !force) return;
  if (scheduled) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  scheduled = setTimeout(() => {
    scheduled = null;
    const payload = rosterSnapshot();
    const encoded = JSON.stringify(payload);
    if (!force && encoded === lastPayload) return;
    lastPayload = encoded;
    hub.send('roster', payload);
  }, 250);
  scheduled.unref?.();
}
