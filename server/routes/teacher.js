/**
 * Teacher API: login, live roster, per-student review, grading, settings,
 * question-bank import and result export.
 */
import crypto from 'node:crypto';
import {
  getSettings, setSettings, getExamSettings, getCurrentExamId, setCurrentExamId,
  verifyTeacher, issueTeacherToken, teacherFromToken, revokeTeacherToken, getSession,
  listSessions, updateSession, logEvent, now, eventsFor, getExamBlueprint, replaceExam,
  deleteSessionsExceptKeep, getQuestions, getSections, ensureTeacher,
  listExams, createExam, deleteExam, duplicateExam, findExamByCode, getExam
} from '../lib/db.js';
import { buildPaper, gradePaper, itemAnalysis, toCsv, normalizeAnswer } from '../lib/exam.js';
import { HttpError, sendJson, sendText, readJsonBody, readTextBody } from '../lib/http.js';
import { hub, rosterSnapshot, rosterSnapshotAll, broadcastRoster, finishSession, enforceDeadlines, secondsLeft } from '../lib/live.js';
import { parseAny, parseExamJson, examToText } from '../lib/importer.js';

export function registerTeacherRoutes(router, { requireAuth }) {
  /* ------------------------------------------------------------------ auth */

  router.post('/api/teacher/login', async (req, res) => {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const teacher = verifyTeacher(username, password);
    if (!teacher) {
      throw new HttpError(401, 'Incorrect username or password.');
    }
    const token = issueTeacherToken(teacher.id);
    sendJson(res, 200, {
      token,
      teacher: { username: teacher.username }
    });
  });

  router.post('/api/teacher/logout', (req, res) => {
    revokeTeacherToken(req.headers['x-teacher-token'] || '');
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/teacher/me', (req, res) => {
    const teacher = requireAuth(req);
    const settings = getSettings();
    sendJson(res, 200, {
      username: teacher.username,
      examTitle: settings.exam_title,
      accessCode: settings.access_code,
      examOpen: settings.exam_open === '1'
    });
  });

  router.post('/api/teacher/password', async (req, res) => {
    const teacher = requireAuth(req);
    const body = await readJsonBody(req);
    const current = String(body.current || '');
    const next = String(body.next || '');
    if (!verifyTeacher(teacher.username, current)) throw new HttpError(401, 'Current password is wrong.');
    if (next.length < 6) throw new HttpError(400, 'New password must be at least 6 characters.');
    const { hashPassword } = await import('../lib/db.js');
    const { hash, salt } = hashPassword(next);
    const { db } = await import('../lib/db.js');
    db.prepare('UPDATE teachers SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, teacher.id);
    sendJson(res, 200, { ok: true });
  });

  /* ---------------------------------------------------------------- exams */

  router.get('/api/teacher/exams', (req, res) => {
    requireAuth(req);
    sendJson(res, 200, { exams: listExams(), currentId: getCurrentExamId() });
  });

  router.post('/api/teacher/exams', async (req, res) => {
    requireAuth(req);
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim() || 'Untitled Exam';
    const access_code = body.access_code
      ? String(body.access_code).trim().toUpperCase()
      : null;
    if (access_code && findExamByCode(access_code)) {
      throw new HttpError(409, 'That access code is already used by another exam.');
    }
    const exam = createExam({ title, access_code: access_code || undefined });
    broadcastRoster(true);
    sendJson(res, 201, { exams: listExams(), currentId: getCurrentExamId(), exam });
  });

  router.post('/api/teacher/exams/:id/select', (req, res) => {
    requireAuth(req);
    const exam = getExam(req.params.id);
    if (!exam) throw new HttpError(404, 'Exam not found.');
    setCurrentExamId(exam.id);
    broadcastRoster(true);
    sendJson(res, 200, { exams: listExams(), currentId: exam.id });
  });

  router.post('/api/teacher/exams/:id/duplicate', (req, res) => {
    requireAuth(req);
    const copy = duplicateExam(req.params.id);
    broadcastRoster(true);
    sendJson(res, 200, { exams: listExams(), currentId: getCurrentExamId(), exam: copy });
  });

  router.delete('/api/teacher/exams/:id', (req, res) => {
    requireAuth(req);
    deleteExam(req.params.id);
    broadcastRoster(true);
    sendJson(res, 200, { exams: listExams(), currentId: getCurrentExamId() });
  });

  /* ------------------------------------------------------------ live roster */

  router.get('/api/teacher/live', (req, res) => {
    requireAuth(req);
    enforceDeadlines();
    const stream = hub.add(req, res);
    stream.write(`event: roster\ndata: ${JSON.stringify(rosterSnapshot())}\n\n`);
  });

  router.get('/api/teacher/roster', (req, res) => {
    requireAuth(req);
    enforceDeadlines();
    // ?all=1 returns a combined roster of every exam, so the teacher can
    // monitor several exams at once.
    const all = req.query?.all === '1' || req.query?.scope === 'all';
    sendJson(res, 200, all ? rosterSnapshotAll() : rosterSnapshot());
  });

  /* -------------------------------------------------------- student detail */

  router.get('/api/teacher/session/:token', (req, res) => {
    requireAuth(req);
    const session = getSession(req.params.token);
    if (!session) throw new HttpError(404, 'Session not found.');

    const settings = getExamSettings(session.exam_id);
    const paper = buildPaper(session, undefined, settings);
    const grade = gradePaper(paper, session.answers, session.manual_scores, session.exam_id);

    sendJson(res, 200, {
      session: {
        token: session.token,
        name: session.student_name,
        studentNo: session.student_no,
        classSection: session.class_section,
        status: session.status,
        createdAt: session.created_at,
        startedAt: session.started_at,
        deadline: session.deadline,
        secondsLeft: secondsLeft(session, settings),
        submittedAt: session.submitted_at,
        violations: session.violations,
        flagged: session.flagged,
        reloads: session.reloads,
        ip: session.ip,
        userAgent: session.user_agent,
        cursor: session.cursor,
        sectionIndex: session.section_index,
        manualNotes: session.manual_notes
      },
      grade,
      events: eventsFor(session.token),
      paper: paper.map((sec) => ({
        title: sec.title,
        questions: sec.questions.map((q) => ({
          id: q.id,
          kind: q.kind,
          prompt: q.prompt,
          points: q.points,
          choices: q.choices,
          expected: grade.items[q.id]?.expected ?? null,
          given: session.answers[q.id]?.value ?? null,
          // Already resolved server-side: the client must not have to map a
          // stored key back through the shuffled choice list itself.
          givenText: grade.items[q.id]?.givenText ?? '',
          awarded: grade.items[q.id]?.awarded ?? 0,
          status: grade.items[q.id]?.status ?? 'manual',
          manualNote: grade.items[q.id]?.manualNote ?? '',
          answeredAt: session.answers[q.id]?.at ?? null,
          timeOnClockMs: session.answers[q.id]?.ms ?? null
        }))
      }))
    });
  });

  router.post('/api/teacher/session/:token/grade', async (req, res) => {
    requireAuth(req);
    const session = getSession(req.params.token);
    if (!session) throw new HttpError(404, 'Session not found.');
    const body = await readJsonBody(req);
    const questionId = String(body.questionId || '');

    const settings = getExamSettings(session.exam_id);
    const paper = buildPaper(session, undefined, settings);
    const flat = paper.flatMap((sec) => sec.questions);
    const question = flat.find((q) => q.id === questionId);
    if (!question) throw new HttpError(404, 'Question not found in this paper.');

    const points = Math.max(0, Math.min(question.points, Number(body.points) || 0));
    const manual = { ...session.manual_scores, [questionId]: { points, note: String(body.note || '') } };
    const grade = gradePaper(paper, session.answers, manual, session.exam_id);

    updateSession(session.token, {
      manual_scores: manual,
      score: grade.score,
      max_score: grade.max,
      pending_manual: grade.pending,
      manual_notes: String(body.sessionNote ?? session.manual_notes)
    });
    logEvent(session.token, 'graded', `Item ${questionId} → ${points}/${question.points}`);
    broadcastRoster(true);

    sendJson(res, 200, { grade, saved: true });
  });

  /* ------------------------------------------------------- teacher actions */

  router.post('/api/teacher/session/:token/action', async (req, res) => {
    requireAuth(req);
    const session = getSession(req.params.token);
    if (!session) throw new HttpError(404, 'Session not found.');
    const body = await readJsonBody(req);
    const action = String(body.action || '');
    const settings = getExamSettings(session.exam_id);

    if (action === 'extend') {
      const minutes = Math.max(-600, Math.min(600, Number(body.minutes) || 5));
      const base = session.deadline || now() + minutes * 60000;
      const updated = updateSession(session.token, {
        deadline: base + minutes * 60000,
        status: session.status === 'submitted' ? 'active' : session.status
      });
      logEvent(session.token, 'teacher_action', `Time ${minutes > 0 ? 'added' : 'removed'}: ${minutes} min`);
      broadcastRoster(true);
      return sendJson(res, 200, { ok: true, deadline: updated.deadline });
    }

    if (action === 'force_submit') {
      const { grade } = finishSession(session, 'teacher', settings);
      return sendJson(res, 200, { ok: true, grade });
    }

    if (action === 'invalidate') {
      const { session: ended } = finishSession(session, 'invalidated', settings);
      return sendJson(res, 200, { ok: true, status: ended.status });
    }

    if (action === 'reopen') {
      const settings2 = getExamSettings(session.exam_id);
      const durationSec = (Number(settings2.duration_minutes) || 60) * 60;
      const startedAt = session.started_at || now();
      updateSession(session.token, {
        status: 'active',
        submitted_at: null,
        started_at: startedAt,
        deadline: Math.max(now() + 60000, startedAt + durationSec * 1000)
      });
      logEvent(session.token, 'teacher_action', 'Attempt reopened');
      broadcastRoster(true);
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'dismiss_flag') {
      updateSession(session.token, { flagged: false, violations: 0 });
      logEvent(session.token, 'teacher_action', 'Flags cleared by teacher');
      broadcastRoster(true);
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(400, `Unknown action: ${action}`);
  });

  /* --------------------------------------------------------------- results */

  router.get('/api/teacher/results', (req, res) => {
    requireAuth(req);
    enforceDeadlines();
    const examId = getCurrentExamId();
    const settings = getExamSettings(examId);
    const sessions = listSessions({ exam_id: examId });
    const submitted = sessions.filter((s) => s.status !== 'active');
    const graded = submitted.map((s) => ({
      session: s,
      ...gradePaper(buildPaper(s, undefined, settings), s.answers, s.manual_scores, s.exam_id)
    }));

    const scores = graded.map((g) => g.percent);
    const distribution = [0, 0, 0, 0, 0];
    for (const p of scores) {
      distribution[Math.min(4, Math.floor(p / 20))]++;
    }

    sendJson(res, 200, {
      total: sessions.length,
      submitted: submitted.length,
      inProgress: sessions.length - submitted.length,
      average: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null,
      highest: scores.length ? Math.max(...scores) : null,
      lowest: scores.length ? Math.min(...scores) : null,
      median: scores.length ? median(scores) : null,
      passing: scores.filter((p) => p >= 75).length,
      distribution,
      needsManual: graded.filter((g) => g.pending > 0).length,
      rows: graded.map((g) => ({
        token: g.session.token,
        name: g.session.student_name,
        studentNo: g.session.student_no,
        classSection: g.session.class_section,
        status: g.session.status,
        score: g.score,
        max: g.max,
        percent: g.percent,
        pending: g.pending,
        violations: g.session.violations,
        flagged: g.session.flagged,
        submittedAt: g.session.submitted_at,
        durationMin: g.session.submitted_at && g.session.started_at
          ? Math.round((g.session.submitted_at - g.session.started_at) / 60000)
          : null
      })),
      items: itemAnalysis(buildPaper({ order_seed: 0, exam_id: examId }, undefined, settings), graded)
    });
  });

  /* ---------------------------------------------------------------- export */

  router.get('/api/teacher/export.csv', (req, res) => {
    requireAuth(req);
    const examId = getCurrentExamId();
    const settings = getExamSettings(examId);
    const paper = getExamBlueprint(examId);
    const sessions = listSessions({ exam_id: examId });

    const header = [
      'Student Name', 'Student No', 'Class/Section', 'Status', 'Started', 'Submitted',
      'Minutes Used', 'Score', 'Max', 'Percent', 'Pending Points', 'Violations',
      'Flagged', 'IP Address'
    ];
    const allQuestions = paper.flatMap((s) => s.questions);
    for (const q of allQuestions) {
      header.push(`Q: ${truncate(q.prompt, 80)}`, 'Answer');
    }

    const rows = [header];
    for (const s of sessions) {
      const grade = gradePaper(buildPaper(s, undefined, settings), s.answers, s.manual_scores, s.exam_id);
      const row = [
        s.student_name, s.student_no, s.class_section, s.status,
        s.started_at ? new Date(s.started_at).toISOString() : '',
        s.submitted_at ? new Date(s.submitted_at).toISOString() : '',
        s.submitted_at && s.started_at ? Math.round((s.submitted_at - s.started_at) / 60000) : '',
        s.submitted_at != null ? grade.score : '',
        s.submitted_at != null ? grade.max : '',
        s.submitted_at != null ? grade.percent : '',
        grade.pending, s.violations, s.flagged ? 'YES' : '', s.ip
      ];
      for (const q of allQuestions) {
        const item = grade.items[q.id];
        row.push(q.prompt, item ? item.givenText : '');
      }
      rows.push(row);
    }

    sendText(res, 200, '\uFEFF' + toCsv(rows), 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="exam-results-${Date.now()}.csv"`
    });
  });

  /* -------------------------------------------------------------- settings */

  router.get('/api/teacher/settings', (req, res) => {
    requireAuth(req);
    sendJson(res, 200, getSettings());
  });

  router.post('/api/teacher/settings', async (req, res) => {
    requireAuth(req);
    const body = await readJsonBody(req);
    const patch = {};
    const allowed = {
      exam_title: String, school: String, subject: String, term: String,
      instructions: String, proctor_notes: String,
      duration_minutes: (v) => String(Math.max(1, Math.min(600, Number(v) || 60))),
      access_code: (v) => String(v || '').trim().toUpperCase(),
      shuffle_questions: toFlag, shuffle_choices: toFlag, lock_sections: toFlag,
      require_fullscreen: toFlag, auto_submit_on_violations: toFlag,
      show_result_to_student: toFlag, allow_resume: toFlag, exam_open: toFlag,
      max_violations: (v) => String(Math.max(0, Math.min(999, Number(v) || 0)))
    };
    for (const [key, coerce] of Object.entries(allowed)) {
      if (body[key] !== undefined) patch[key] = coerce(body[key]);
    }
    // An access code belongs to exactly one exam.
    if (patch.access_code !== undefined && patch.access_code) {
      const clash = findExamByCode(patch.access_code);
      if (clash && clash.id !== getCurrentExamId()) {
        throw new HttpError(409, 'That access code is already used by another exam.');
      }
    }
    if (body.new_access_code) {
      const { makeAccessCode } = await import('../lib/db.js');
      let code = makeAccessCode();
      while (findExamByCode(code)) code = makeAccessCode();
      patch.access_code = code;
    }
    const settings = setSettings(patch);
    broadcastRoster(true);
    sendJson(res, 200, settings);
  });

  /* ----------------------------------------------------------- question bank */

  router.get('/api/teacher/exam', (req, res) => {
    requireAuth(req);
    const blueprint = getExamBlueprint();
    sendJson(res, 200, {
      blueprint,
      text: examToText(blueprint),
      counts: {
        sections: blueprint.length,
        questions: blueprint.reduce((n, s) => n + s.questions.length, 0),
        points: blueprint.reduce((n, s) => n + s.questions.reduce((m, q) => m + q.points, 0), 0)
      }
    });
  });

  router.post('/api/teacher/parse', async (req, res) => {
    requireAuth(req);
    const text = await readTextBody(req);
    const parsed = parseAny(text);
    sendJson(res, 200, {
      ...parsed,
      counts: {
        sections: parsed.sections.length,
        questions: parsed.sections.reduce((n, s) => n + s.questions.length, 0),
        points: parsed.sections.reduce(
          (n, s) => n + s.questions.reduce((m, q) => m + Number(q.points || 0), 0), 0)
      }
    });
  });

  router.post('/api/teacher/exam', async (req, res) => {
    requireAuth(req);
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
      const body = await readJsonBody(req);
      // Normalise through the same importer as the paste path, so a JSON body
      // that is a bare array of questions (or uses "parts"/"items") works too.
      const parsed = parseExamJson(JSON.stringify(body));
      if (!parsed.sections.length) throw new HttpError(400, 'No questions could be read from that JSON.');
      const blueprint = replaceExam({ title: parsed.title, sections: parsed.sections });
      broadcastRoster(true);
      return sendJson(res, 200, { ok: true, counts: countBlueprint(blueprint) });
    }
    const text = await readTextBody(req);
    const parsed = parseAny(text);
    if (!parsed.sections.length) throw new HttpError(400, 'No questions could be read from that text.');
    const blueprint = replaceExam(parsed);
    broadcastRoster(true);
    sendJson(res, 200, {
      ok: true,
      warnings: parsed.warnings,
      keyApplied: parsed.keyApplied,
      counts: countBlueprint(blueprint)
    });
  });

  router.post('/api/teacher/reset-attempts', async (req, res) => {
    requireAuth(req);
    await readJsonBody(req).catch(() => ({}));
    deleteSessionsExceptKeep(getCurrentExamId());
    broadcastRoster(true);
    sendJson(res, 200, { ok: true });
  });
}

/* ------------------------------------------------------------------ helpers */

function requireAuthMiddleware(req) {
  // EventSource cannot set request headers, so the live stream may pass the
  // token as a query parameter instead.
  const token = req.headers['x-teacher-token'] || req.query?.t || '';
  const teacher = teacherFromToken(String(token));
  if (!teacher) throw new HttpError(401, 'Please sign in as a teacher.');
  return teacher;
}

function toFlag(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? '1' : '0';
}

function countBlueprint(blueprint) {
  return {
    sections: blueprint.length,
    questions: blueprint.reduce((n, s) => n + s.questions.length, 0),
    points: blueprint.reduce((n, s) => n + s.questions.reduce((m, q) => m + q.points, 0), 0)
  };
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function median(list) {
  const sorted = list.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1);
}

export { requireAuthMiddleware };
