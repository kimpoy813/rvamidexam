/**
 * Student-facing API.
 *
 * Anti-cheating model:
 *  - the answer key never leaves the server (clients get `hasAnswer` only)
 *  - the clock is server-side; refreshing the page cannot buy time
 *  - questions are served one at a time, so the whole paper cannot be scraped
 *    with a single request, and every student sees a different order
 *  - every integrity event is recorded against the session
 */
import {
  getSession, createSession, updateSession, getSettings, getExamSettings,
  getExamBlueprint, findExamByCode, listSessions, logEvent, now, eventsFor,
  verifyTeacher
} from '../lib/db.js';
import { buildPaper, gradePaper } from '../lib/exam.js';
import { HttpError, sendJson, readJsonBody, clientIp } from '../lib/http.js';
import {
  secondsLeft, finishSession, broadcastRoster, registerViolation, violationLabel, enforceDeadlines
} from '../lib/live.js';

export function registerStudentRoutes(router) {
  /* ------------------------------------------------------------- exam info */

  router.get('/api/public/auth-hint', (req, res) => {
    // Tells the teacher sign-in page whether the well-known default password is
    // still active, so the "Default: teacher / rvm-exam-2026" hint can hide
    // itself once the password has been changed in the dashboard.
    const username = process.env.EXAM_TEACHER_USER || 'teacher';
    const stillDefault =
      !process.env.EXAM_TEACHER_PASSWORD && !!verifyTeacher(username, 'rvm-exam-2026');
    sendJson(res, 200, { showDefaultHint: stillDefault });
  });

  router.get('/api/public/exam-info', (req, res) => {
    enforceDeadlines();
    const s = getSettings();
    const paper = getExamBlueprint();
    sendJson(res, 200, {
      title: s.exam_title,
      school: s.school,
      subject: s.subject,
      term: s.term,
      instructions: s.instructions,
      proctorNotes: s.proctor_notes,
      durationMinutes: Number(s.duration_minutes) || 60,
      examOpen: s.exam_open === '1',
      requireFullscreen: s.require_fullscreen === '1',
      lockSections: s.lock_sections === '1',
      showResult: s.show_result_to_student === '1',
      maxViolations: Number(s.max_violations) || 0,
      totalQuestions: paper.reduce((n, sec) => n + sec.questions.length, 0),
      totalPoints: paper.reduce(
        (n, sec) => n + sec.questions.reduce((m, q) => m + q.points, 0), 0),
      sections: paper.map((sec, i) => ({
        index: i,
        title: sec.title,
        instructions: sec.instructions,
        count: sec.questions.length,
        lockAfter: !!sec.lock_after
      }))
    });
  });

  /* ---------------------------------------------------------- start / join */

  router.post('/api/sessions', async (req, res) => {
    enforceDeadlines();

    const body = await readJsonBody(req);
    const code = String(body.access_code || '').trim().toUpperCase();
    const name = String(body.student_name || '').trim().replace(/\s+/g, ' ');
    const studentNo = String(body.student_no || '').trim();
    const classSection = String(body.class_section || '').trim();

    if (!code) throw new HttpError(400, 'Please enter the exam access code.');
    if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
    if (studentNo.length < 2) throw new HttpError(400, 'Please enter your student number.');

    // The access code decides which exam this student joins.
    const exam = findExamByCode(code);
    if (!exam) throw new HttpError(403, 'That access code is not valid.');
    const s = exam.settings;
    if (s.exam_open !== '1') throw new HttpError(403, 'This exam is currently closed.');

    const existing = listSessions({ exam_id: exam.id }).filter(
      (x) => x.status === 'active' &&
             x.student_no.toLowerCase() === studentNo.toLowerCase() &&
             x.class_section.toLowerCase() === classSection.toLowerCase()
    );

    // Someone is already mid-exam on another device: refuse, do not fork.
    const elsewhere = existing.find((x) => now() - x.last_seen < 10_000);
    if (elsewhere) {
      throw new HttpError(409,
        'You already have this exam open on another device or tab. ' +
        'Close it and try again, or ask your teacher for help.');
    }

    if (existing.length && s.allow_resume === '1') {
      const session = existing[0];
      updateSession(session.token, { last_seen: now(), reloads: session.reloads + 1 });
      logEvent(session.token, 'resume', `Resumed from ${clientIp(req)}`);
      broadcastRoster(true);
      return sendJson(res, 200, {
        token: session.token,
        resumed: true,
        secondsLeft: secondsLeft(session, s)
      });
    }

    const session = createSession({
      exam_id: exam.id,
      access_code: exam.access_code,
      student_name: name,
      student_no: studentNo,
      class_section: classSection,
      ip: clientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
    });
    logEvent(session.token, 'join', `${name} (${studentNo}) from ${clientIp(req)}`);
    broadcastRoster(true);
    sendJson(res, 201, { token: session.token, resumed: false, secondsLeft: secondsLeft(session, s) });
  });

  /* --------------------------------------------------------- session guard */

  const load = (token, { allowSubmitted = false } = {}) => {
    const session = getSession(token);
    if (!session) throw new HttpError(404, 'This exam session no longer exists.');
    if (!allowSubmitted && session.status !== 'active') {
      throw new HttpError(409, 'This exam has already been submitted.');
    }
    return session;
  };

  /** Auto-submits if the server-side clock ran out, then returns fresh state. */
  const fresh = (session) => {
    if (session.status === 'active' && session.deadline && session.deadline <= now()) {
      const { session: ended } = finishSession(session, 'auto_timeout');
      return ended;
    }
    return session;
  };

  const paperFor = (session) => {
    const s = getExamSettings(session.exam_id);
    return { session: fresh(session), settings: s, paper: buildPaper(session, undefined, s) };
  };

  const sectionIndexFor = (paper, globalIndex) => {
    let seen = 0;
    for (let i = 0; i < paper.length; i++) {
      seen += paper[i].questions.length;
      if (globalIndex < seen) return i;
    }
    return Math.max(0, paper.length - 1);
  };

  /* ----------------------------------------------------------------- start */

  router.post('/api/s/:token/start', (req, res) => {
    const session = load(req.params.token);
    const s = getExamSettings(session.exam_id);
    const durationSec = (Number(s.duration_minutes) || 60) * 60;

    if (!session.started_at) {
      const startedAt = now();
      updateSession(session.token, {
        started_at: startedAt,
        deadline: startedAt + durationSec * 1000
      });
      logEvent(session.token, 'start', `Timer started (${durationSec}s)`);
    }
    const current = getSession(session.token);
    updateSession(current.token, { last_seen: now() });
    broadcastRoster(true);
    sendJson(res, 200, { secondsLeft: secondsLeft(current, s), startedAt: current.started_at });
  });

  /* --------------------------------------------------------- paper + items */

  router.get('/api/s/:token/paper', (req, res) => {
    const { session, settings, paper } = paperFor(load(req.params.token, { allowSubmitted: true }));
    const total = paper.reduce((n, sec) => n + sec.questions.length, 0);

    sendJson(res, 200, {
      status: session.status,
      secondsLeft: secondsLeft(session, settings),
      deadline: session.deadline,
      cursor: session.cursor,
      maxSection: session.max_section,
      total,
      violations: session.violations,
      maxViolations: Number(settings.max_violations) || 0,
      flagged: session.flagged,
      sections: paper.map((sec, i) => {
        let start = 0;
        for (let k = 0; k < i; k++) start += paper[k].questions.length;
        const locking = settings.lock_sections === '1';
        return {
          index: i,
          title: sec.title,
          instructions: sec.instructions,
          start,
          count: sec.questions.length,
          locked: i < session.max_section && !!sec.lock_after,
          // With free navigation (locking off) every section is reachable.
          reachable: locking ? i <= session.max_section : true,
          questions: sec.questions.map((q, qi) => ({
            index: start + qi,
            id: q.id,
            kind: q.kind,
            points: q.points
          }))
        };
      }),
      answers: Object.fromEntries(
        Object.entries(session.answers).map(([k, v]) => [k, v.value ?? ''])
      ),
      grade: session.status === 'active'
        ? null
        : gradePaper(paper, session.answers, session.manual_scores, session.exam_id)
    });
  });

  /** One question at a time. Correct answers are never included. */
  router.get('/api/s/:token/item', (req, res, url) => {
    const { session, settings, paper } = paperFor(load(req.params.token, { allowSubmitted: true }));
    if (session.status === 'invalidated') {
      throw new HttpError(409, 'This attempt was invalidated by your teacher.');
    }
    const total = paper.reduce((n, sec) => n + sec.questions.length, 0);
    const index = Math.max(0, Math.min(total - 1, Number(url.searchParams.get('i') ?? session.cursor) || 0));
    const sectionIndex = sectionIndexFor(paper, index);
    const section = paper[sectionIndex];

    let offset = 0;
    for (let k = 0; k < sectionIndex; k++) offset += paper[k].questions.length;
    const question = section.questions[index - offset];

    if (!question) throw new HttpError(404, 'Question not found.');

    const locked = sectionIndex < session.max_section && !!section.lock_after;

    if (session.status === 'active' && !locked) {
      // Remember that the student saw this item (used for time-per-item stats).
      const answers = { ...session.answers };
      if (!answers[question.id]) {
        answers[question.id] = { value: '', revealedAt: now() };
        updateSession(session.token, { answers });
      }
      updateSession(session.token, {
        cursor: index,
        section_index: sectionIndex,
        last_seen: now()
      });
      broadcastRoster();
    }

    const saved = session.answers[question.id]?.value ?? '';

    sendJson(res, 200, {
      index,
      total,
      sectionIndex,
      sectionTitle: section.title,
      sectionLocked: locked,
      status: session.status,
      secondsLeft: secondsLeft(session, settings),
      question: {
        id: question.id,
        kind: question.kind,
        prompt: question.prompt,
        points: question.points,
        // Free-text items (short answer, essay) have no options to send.
        choices: ['mcq', 'multiselect', 'truefalse'].includes(question.kind)
          ? question.choices
          : [],
        locked
      },
      saved
    });
  });

  /* -------------------------------------------------------------- answering */

  router.post('/api/s/:token/answer', async (req, res) => {
    const session = load(req.params.token);
    const { settings, paper } = paperFor(session);
    if (fresh(session).status !== 'active') throw new HttpError(409, 'Exam already submitted.');

    const body = await readJsonBody(req);
    const questionId = String(body.questionId || '');
    let value = body.value;

    const found = paper.flatMap((sec) => sec.questions).find((q) => q.id === questionId);
    if (!found) throw new HttpError(404, 'Unknown question.');

    const sectionIndex = paper.findIndex((sec) => sec.questions.some((q) => q.id === questionId));
    if (sectionIndex < session.max_section && paper[sectionIndex].lock_after) {
      throw new HttpError(403, 'That section is locked and can no longer be changed.');
    }

    if (found.kind === 'multiselect') {
      value = Array.isArray(value) ? value.map(Number).filter(Number.isFinite).slice(0, 20) : [];
    } else if (found.kind === 'mcq' || found.kind === 'truefalse') {
      value = value === '' || value === null || value === undefined ? '' : String(value);
    } else {
      value = String(value ?? '').slice(0, 8000);
    }

    const answers = { ...session.answers };
    const prev = answers[questionId] || {};
    answers[questionId] = {
      ...prev,
      value,
      at: now(),
      ms: session.started_at ? now() - session.started_at : 0
    };

    const updated = updateSession(session.token, { answers, last_seen: now() });
    broadcastRoster();

    const answeredCount = Object.values(answers).filter(
      (a) => a.value !== '' && a.value !== null && !(Array.isArray(a.value) && !a.value.length)
    ).length;
    const total = paper.reduce((n, sec) => n + sec.questions.length, 0);

    sendJson(res, 200, {
      saved: true,
      answered: answeredCount,
      total,
      secondsLeft: secondsLeft(updated, settings)
    });
  });

  /* ------------------------------------------------------------- navigation */

  router.post('/api/s/:token/goto', async (req, res) => {
    const session = load(req.params.token);
    const { settings, paper } = paperFor(session);
    const body = await readJsonBody(req);
    const total = paper.reduce((n, sec) => n + sec.questions.length, 0);
    const target = Math.max(0, Math.min(total - 1, Number(body.index) || 0));
    const targetSection = sectionIndexFor(paper, target);

    // With free navigation (section locking off) the student may jump to any
    // question. When locking is on, keep the linear one-section-at-a-time flow.
    const locking = settings.lock_sections === '1';
    if (locking && targetSection > session.max_section + 1) {
      throw new HttpError(403, 'Finish the current section before moving on.');
    }
    if (locking && targetSection < session.max_section && paper[targetSection].lock_after) {
      throw new HttpError(403, `"${paper[targetSection].title}" is locked and cannot be revisited.`);
    }

    const patch = {
      cursor: target,
      section_index: targetSection,
      max_section: Math.max(session.max_section, targetSection),
      last_seen: now()
    };
    const updated = updateSession(session.token, patch);
    logEvent(session.token, 'navigate', `→ item ${target + 1} (${paper[targetSection].title})`);
    broadcastRoster();

    sendJson(res, 200, {
      cursor: updated.cursor,
      sectionIndex: updated.section_index,
      maxSection: updated.max_section,
      secondsLeft: secondsLeft(updated, settings)
    });
  });

  /* -------------------------------------------------------------- integrity */

  router.post('/api/s/:token/flag', async (req, res) => {
    const session = load(req.params.token);
    const body = await readJsonBody(req);
    const type = String(body.type || 'unknown').slice(0, 40);
    const detail = String(body.detail || '').slice(0, 200);
    const result = registerViolation(session.token, type, detail);
    sendJson(res, 200, { ...result, label: violationLabel(type) });
  });

  /**
   * Presence ping. Browser-side monitoring is intentionally limited to tab
   * visibility, so the server only detects a visible tab becoming hidden.
   */
  router.post('/api/s/:token/heartbeat', async (req, res) => {
    let session = load(req.params.token);
    const body = await readJsonBody(req);
    const s = getExamSettings(session.exam_id);
    const prev = heartbeatState.get(session.token) || {};

    const next = {
      visible: body.visible !== false
    };

    if (prev.visible && !next.visible) registerViolation(session.token, 'tab_hidden');

    heartbeatState.set(session.token, next);
    updateSession(session.token, { last_seen: now() });

    session = fresh(getSession(session.token));
    broadcastRoster();

    sendJson(res, 200, {
      status: session.status,
      secondsLeft: secondsLeft(session, s),
      violations: session.violations,
      flagged: session.flagged
    });
  });

  /* ----------------------------------------------------------------- submit */

  router.post('/api/s/:token/submit', async (req, res) => {
    const session = load(req.params.token);
    const { settings, paper } = paperFor(session);
    const body = await readJsonBody(req).catch(() => ({}));

    const total = paper.reduce((n, sec) => n + sec.questions.length, 0);
    const answered = Object.values(session.answers).filter(
      (a) => a.value !== '' && a.value !== null && !(Array.isArray(a.value) && !a.value.length)
    ).length;

    if (!body.confirm && answered < total) {
      return sendJson(res, 200, {
        requiresConfirm: true,
        answered,
        total,
        unanswered: total - answered
      });
    }

    const { session: ended, grade } = finishSession(session, 'student', settings);
    heartbeatState.delete(session.token);

    sendJson(res, 200, {
      submitted: true,
      showResult: settings.show_result_to_student === '1',
      grade: settings.show_result_to_student === '1' ? summaryOf(grade) : null
    });
  });

  router.get('/api/s/:token/result', (req, res) => {
    const session = load(req.params.token, { allowSubmitted: true });
    if (session.status === 'active') throw new HttpError(409, 'Exam is still in progress.');
    const s = getExamSettings(session.exam_id);
    const revealed = s.show_result_to_student === '1';
    const paper = buildPaper(session, undefined, s);
    const grade = gradePaper(paper, session.answers, session.manual_scores, session.exam_id);

    sendJson(res, 200, {
      studentName: session.student_name,
      studentNo: session.student_no,
      classSection: session.class_section,
      status: session.status,
      submittedAt: session.submitted_at,
      violations: session.violations,
      showResult: revealed,
      events: eventsFor(session.token).filter((e) => e.type.startsWith('violation')),
      // Withheld marks must not reach the browser at all — hiding them in the
      // UI still leaves the number readable in the network response.
      summary: revealed ? summaryOf(grade) : null,
      items: revealed
        ? Object.values(grade.items).map((it) => ({
            prompt: it.prompt,
            kind: it.kind,
            given: it.given,
            givenText: it.givenText,
            expected: it.expected,
            status: it.status,
            awarded: it.awarded,
            points: it.points,
            note: it.manualNote
          }))
        : []
    });
  });
}

function summaryOf(grade) {
  return {
    score: grade.score,
    max: grade.max,
    percent: grade.percent,
    pending: grade.pending,
    correct: Object.values(grade.items).filter((i) => i.status === 'correct').length,
    wrong: Object.values(grade.items).filter((i) => i.status === 'wrong').length,
    manual: Object.values(grade.items).filter((i) => i.status === 'manual').length
  };
}

/** Last-known browser state per session, used for transition detection. */
export const heartbeatState = new Map();
