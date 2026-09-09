/**
 * RVM Midterm Exam — secure online examination server.
 * Zero external dependencies (Node 22 built-ins only).
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, getSettings, setSettings, ensureTeacher, verifyTeacher, makeAccessCode,
  getExamBlueprint, replaceExam, now, ensureExamExists, getCurrentExamId, listExams
} from './lib/db.js';
import { createRouter, sendJson, serveStatic, HttpError } from './lib/http.js';
import { registerStudentRoutes } from './routes/student.js';
import { registerTeacherRoutes, requireAuthMiddleware } from './routes/teacher.js';
import { hub, broadcastRoster, enforceDeadlines } from './lib/live.js';
import { SAMPLE_EXAM } from './seed/sample-exam.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------- bootstrap */

function bootstrap() {
  const username = process.env.EXAM_TEACHER_USER || 'teacher';
  const generated = !process.env.EXAM_TEACHER_PASSWORD;
  const password = process.env.EXAM_TEACHER_PASSWORD || 'rvm-exam-2026';
  ensureTeacher(username, password);
  // True only while the teacher is still signing in with the well-known
  // default password — once they change it in the dashboard this flips off,
  // so the startup banner stops advertising a password that no longer works.
  const defaultPasswordActive = verifyTeacher(username, password);

  const examId = ensureExamExists();
  if (!getExamBlueprint(examId).length) {
    replaceExam(SAMPLE_EXAM, examId);
    console.log('[exam] No question bank found — loaded the sample exam.');
  }

  return { username, password, generated, defaultPasswordActive };
}

const creds = bootstrap();

/* ---------------------------------------------------------------- router */

const router = createRouter();
registerStudentRoutes(router);
registerTeacherRoutes(router, { requireAuth: requireAuthMiddleware });

const PAGES = {
  '/': 'index.html',
  '/exam': 'exam.html',
  '/teacher': 'teacher.html',
  '/admin': 'teacher.html'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req.url_ = url;
  req.query = Object.fromEntries(url.searchParams.entries());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await router.handle(req, res, url);
      if (handled === false) throw new HttpError(404, 'Unknown endpoint');
      return;
    }

    if (PAGES[url.pathname]) {
      serveStatic(res, PUBLIC_DIR, '/' + PAGES[url.pathname]);
      return;
    }

    if (serveStatic(res, PUBLIC_DIR, url.pathname)) return;

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p><a href="/">Back to the exam</a></p>');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[exam] error:', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error' });
    else res.end();
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/* ------------------------------------------------------- deadline sweeper */

const sweeper = setInterval(() => {
  if (enforceDeadlines()) broadcastRoster(true);
}, 5000);
sweeper.unref?.();

server.listen(PORT, HOST, () => {
  const s = getSettings();
  const bank = getExamBlueprint(getCurrentExamId());
  const exams = listExams();
  const counts = {
    sections: bank.length,
    questions: bank.reduce((n, x) => n + x.questions.length, 0),
    points: bank.reduce((n, x) => n + x.questions.reduce((m, q) => m + q.points, 0), 0)
  };
  console.log('');
  console.log('  RVM Midterm Exam is running');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Local      http://localhost:${PORT}`);
  console.log(`  Students   http://localhost:${PORT}/`);
  console.log(`  Teacher    http://localhost:${PORT}/teacher`);
  console.log(`  Questions  http://localhost:${PORT}/admin`);
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Exams        ${exams.length} (create more in the dashboard)`);
  console.log(`  Exam title   ${s.exam_title}`);
  console.log(`  Access code  ${s.access_code}`);
  console.log(`  Duration     ${s.duration_minutes} minutes`);
  console.log(`  Question bank ${counts.sections} sections · ${counts.questions} items · ${counts.points} pts`);
  if (creds.defaultPasswordActive) {
    console.log(`  Teacher      ${creds.username} / ${creds.password}${creds.generated ? '  (default — change it in the dashboard)' : ''}`);
  } else {
    console.log(`  Teacher      ${creds.username} (a custom password is in use)`);
  }
  console.log('');
});

export const httpServer = server;

process.on('SIGINT', () => {
  console.log('\n[exam] shutting down');
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
});
