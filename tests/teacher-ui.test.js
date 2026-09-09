/**
 * Teacher dashboard tests: load the real teacher.html, run the real teacher.js
 * against a real server, and check that a live class actually renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const dir = mkdtempSync(path.join(tmpdir(), 'rvm-tui-'));
const work = path.join(dir, 'js');
mkdirSync(work, { recursive: true });

process.env.EXAM_DATA_DIR = dir;
process.env.EXAM_DB = path.join(dir, 'tui.sqlite');
process.env.EXAM_TEACHER_PASSWORD = 'tui-pass';
process.env.PORT = '4127';
process.env.HOST = '127.0.0.1';

const BASE = 'http://127.0.0.1:4127';
const serverModule = await import('../server/index.js');
await new Promise((r) => setTimeout(r, 400));

const { getSettings } = await import('../server/lib/db.js');
const accessCode = getSettings().access_code;

const realFetch = globalThis.fetch;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeSetTimeout = globalThis.setTimeout;

const GLOBAL_KEYS = ['window', 'document', 'location', 'sessionStorage', 'localStorage',
  'navigator', 'fetch', 'confirm', 'prompt', 'alert', 'setInterval', 'setTimeout',
  'clearInterval', 'scrollTo', 'requestAnimationFrame', 'cancelAnimationFrame'];

const saved = Object.fromEntries(
  GLOBAL_KEYS.map((k) => [k, { value: globalThis[k], existed: k in globalThis }])
);
const define = (k, v) =>
  Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });

const openWindows = [];

test.after(async () => {
  for (const w of openWindows) { try { w.close(); } catch { /* already closed */ } }
  for (const [k, { value, existed }] of Object.entries(saved)) {
    if (existed) define(k, value);
    else delete globalThis[k];
  }
  serverModule.httpServer.closeAllConnections?.();
  await new Promise((r) => serverModule.httpServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const api = async (url, opts) => {
  const res = await realFetch(BASE + url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};
const post = (url, body, token) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Teacher-Token': token } : {}) },
  body: JSON.stringify(body)
});

const teacherToken = (await post('/api/teacher/login', {
  username: 'teacher', password: 'tui-pass'
})).token;

/** Two submitted papers (one clean, one flagged) plus one still writing. */
async function seedClass() {
  const make = async (name, no, flagCount) => {
    const s = await post('/api/sessions', {
      access_code: accessCode, student_name: name, student_no: no, class_section: '10-StMary'
    });
    await post(`/api/s/${s.token}/start`, {});
    for (let i = 0; i < flagCount; i++) await post(`/api/s/${s.token}/flag`, { type: 'tab_hidden' });
    return s.token;
  };

  const a = await make('Ana Reyes', 'T-001', 0);
  const b = await make('Ben Cruz', 'T-002', 3);
  const paper = await api(`/api/s/${a}/paper`, {});

  for (const sec of paper.sections) {
    for (const q of sec.questions) {
      const item = await api(`/api/s/${a}/item?i=${q.index}`, {});
      const value = ['mcq', 'truefalse'].includes(item.question.kind) ? 0
        : item.question.kind === 'essay' ? 'A considered response.' : 'answer';
      await post(`/api/s/${a}/answer`, { questionId: item.question.id, value });
    }
  }
  await post(`/api/s/${a}/submit`, { confirm: true });
  await post(`/api/s/${b}/submit`, { confirm: true });

  const c = await make('Carla Diaz', 'T-003', 0);
  return { submitted: [a, b], writing: c };
}

async function openDashboard() {
  const html = readFileSync(new URL('../public/teacher.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/teacher`, pretendToBeVisual: true });
  const win = dom.window;
  openWindows.push(win);

  writeFileSync(path.join(work, 'util.js'),
    readFileSync(new URL('../public/js/util.js', import.meta.url), 'utf8'));
  writeFileSync(path.join(work, 'teacher.js'),
    readFileSync(new URL('../public/js/teacher.js', import.meta.url), 'utf8'));

  win.localStorage.setItem('rvm_teacher_token', teacherToken);

  define('window', win);
  define('document', win.document);
  define('location', win.location);
  define('sessionStorage', win.sessionStorage);
  define('localStorage', win.localStorage);
  define('navigator', win.navigator);
  define('confirm', () => true);
  define('prompt', () => 'x');
  define('alert', () => {});
  define('scrollTo', () => {});
  define('requestAnimationFrame', (fn) => nativeSetTimeout(fn, 0));
  define('cancelAnimationFrame', (id) => clearTimeout(id));
  define('fetch', (url, opts) =>
    realFetch(String(url).startsWith('http') ? url : BASE + url, opts));
  define('setInterval', (fn, ms) => nativeSetInterval(fn, ms));
  define('clearInterval', (id) => nativeClearInterval(id));

  // jsdom has no EventSource, so teacher.js falls back to polling — the same
  // path a browser takes when the stream drops.
  await import(`${path.join(work, 'teacher.js')}?r=${Math.random()}`);
  return win;
}

const $ = (win, s) => win.document.querySelector(s);
const $$ = (win, s) => [...win.document.querySelectorAll(s)];
const settle = (ms) => new Promise((r) => nativeSetTimeout(r, ms));

/* -------------------------------------------------------------------- tests */

test('the dashboard signs in and renders the live roster', async () => {
  await seedClass();
  const win = await openDashboard();

  // init() verifies the session over the network before revealing the app.
  await settle(700);

  assert.ok($(win, '#appView').classList.contains('hidden') === false, 'the dashboard should be visible');
  assert.ok($(win, '#loginView').classList.contains('hidden'), 'the login form should be hidden');

  // Polling runs every 2.5s; wait for the first roster to land.
  await settle(3200);

  const rows = $$(win, '.srow');
  assert.equal(rows.length, 3, `expected 3 students, found ${rows.length}`);

  const text = rows.map((r) => r.textContent.replace(/\s+/g, ' ')).join(' | ');
  assert.match(text, /Ana Reyes/);
  assert.match(text, /Ben Cruz/);
  assert.match(text, /Carla Diaz/);

  const kpis = $(win, '#kpis').textContent.replace(/\s+/g, ' ');
  assert.match(kpis, /Online now/);
  assert.match(kpis, /Submitted/);
  assert.match($(win, '#rosterCount').textContent, /3 joined/);
  assert.match($(win, '#codeText').textContent, new RegExp(accessCode),
    'the access code should be shown for sharing');
});

test('a flagged student is called out in the roster', async () => {
  const win = await openDashboard();
  await settle(3200);

  const flaggedRow = $$(win, '.srow').find((r) => /Ben Cruz/.test(r.textContent));
  assert.ok(flaggedRow, 'Ben should be listed');
  assert.match(flaggedRow.textContent, /⚑ 3/, 'his three violations should be visible');
});

test('opening a student shows their responses and grading controls', async () => {
  const win = await openDashboard();
  await settle(3200);

  const row = $$(win, '.srow').find((r) => /Ana Reyes/.test(r.textContent));
  row.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(600);

  const drawer = $(win, '.drawer');
  assert.ok(drawer, 'clicking a student should open the detail drawer');

  const body = drawer.textContent.replace(/\s+/g, ' ');
  assert.match(body, /Ana Reyes/);
  assert.match(body, /Activity timeline/);
  assert.match(body, /Responses/);
  assert.match(body, /Part I\. Multiple Choice/);

  const reviews = $$(win, '#dReview .qreview');
  assert.ok(reviews.length >= 21, `expected every item reviewed, got ${reviews.length}`);

  // The essay is ungraded, so it must offer a mark box.
  const gradeBoxes = $$(win, '#dReview [data-grade]');
  assert.ok(gradeBoxes.length >= 1, 'the essay should expose inline grading');

  assert.ok($$(win, '.drawer-foot [data-action="force_submit"], .drawer-foot [data-action="reopen"]').length,
    'teacher actions should be available');
});

test('the results tab shows the scoreboard and item analysis', async () => {
  const win = await openDashboard();
  await settle(3200);

  $$(win, '.tab').find((t) => t.dataset.tab === 'results')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(900);

  assert.ok($(win, '#tab-results').classList.contains('hidden') === false, 'results should be visible');

  const scoreRows = $$(win, '#scoreBody tr');
  assert.ok(scoreRows.length >= 2, `expected submitted students, got ${scoreRows.length}`);
  assert.match($(win, '#scoreBody').textContent, /Ana Reyes/);

  const itemRows = $$(win, '#itemBody tr');
  assert.equal(itemRows.length, 21, 'every question should appear in the item analysis');

  assert.equal($$(win, '#dist .dist-col').length, 5, 'the distribution chart needs five bands');
});

test('the exam setup tab loads the current settings and question bank', async () => {
  const win = await openDashboard();
  await settle(3200);

  $$(win, '.tab').find((t) => t.dataset.tab === 'setup')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(900);

  assert.equal($(win, '#sTitle').value, 'Midterm Examination (SAMPLE)');
  assert.equal($(win, '#sDuration').value, '60', 'the one-hour limit should be configured');
  assert.equal($(win, '#sShuffleQ').checked, true, 'question shuffling should be on');
  assert.equal($(win, '#sFs').checked, true, 'full screen should be required');
  assert.equal($(win, '#sOpen').checked, true, 'the exam should be open');

  assert.match($(win, '#bankCount').textContent, /4 parts · 21 items · 50 pts/);
  assert.match($(win, '#bankText').value, /# Part I\. Multiple Choice/,
    'the editor should be pre-filled with the current bank');
  assert.ok($$(win, '#bankPreview .bp-sec').length >= 4, 'the preview should list every part');
});
