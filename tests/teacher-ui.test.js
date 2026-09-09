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

async function openDashboard(pathname = '/teacher') {
  const html = readFileSync(new URL('../public/teacher.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}${pathname}`, pretendToBeVisual: true });
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
  assert.equal($(win, '#sFs').checked, false, 'full screen should not be required by default');
  assert.equal($(win, '#sOpen').checked, true, 'the exam should be open');

  assert.match($(win, '#bankCount').textContent, /4 parts · 21 items · 50 pts/);
  assert.match($(win, '#bankText').value, /# Part I\. Multiple Choice/,
    'the editor should be pre-filled with the current bank');
  assert.ok($$(win, '#bankPreview .bp-sec').length >= 4, 'the preview should list every part');
});

test('exam setup auto-saves and is still present after reopening the dashboard', async () => {
  const win = await openDashboard();
  await settle(900);

  $$(win, '.tab').find((t) => t.dataset.tab === 'setup')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(300);

  const value = `Saved school ${Date.now()}`;
  $(win, '#sSchool').value = value;
  $(win, '#sSchool').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.match($(win, '#setupSaveState').textContent, /Unsaved/);
  await settle(1100);
  assert.match($(win, '#setupSaveState').textContent, /Saved/);

  let stored = await api('/api/teacher/settings', {
    headers: { 'X-Teacher-Token': teacherToken }
  });
  assert.equal(stored.school, value, 'the auto-save must reach SQLite');

  // Also cover closing immediately, before the normal debounce can fire. The
  // pagehide keepalive request must flush the latest field value.
  const lastSecondValue = `Last-second subject ${Date.now()}`;
  $(win, '#sSubject').value = lastSecondValue;
  $(win, '#sSubject').dispatchEvent(new win.Event('input', { bubbles: true }));
  win.dispatchEvent(new win.Event('pagehide'));
  await settle(450);
  stored = await api('/api/teacher/settings', {
    headers: { 'X-Teacher-Token': teacherToken }
  });
  assert.equal(stored.subject, lastSecondValue, 'page close should flush pending setup changes');

  // A fresh dashboard represents closing and opening the teacher system again.
  const reopened = await openDashboard();
  await settle(900);
  assert.equal($(reopened, '#sSchool').value, value);
  assert.equal($(reopened, '#sSubject').value, lastSecondValue);
  assert.match($(reopened, '#storageTitle').textContent, /stored|storage connected/i);
});

test('/admin opens the authenticated question editor directly', async () => {
  const win = await openDashboard('/admin');
  await settle(800);

  assert.equal($(win, '#tab-questions').classList.contains('hidden'), false);
  assert.equal($(win, '#tab-setup').classList.contains('hidden'), true);
  assert.equal($$(win, '.tab').find((tab) => tab.dataset.tab === 'questions').getAttribute('aria-selected'), 'true');
  assert.ok($(win, '#bankPreview'));
});

test('a pasted paper with an answer key previews and imports', async () => {
  const win = await openDashboard();
  await settle(3200);

  $$(win, '.tab').find((t) => t.dataset.tab === 'setup')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(900);

  // Exactly the shape a teacher gets from copying a paper and its key sheet.
  $(win, '#bankText').value = `GE ELEC 103 - Midterm Examination

PART I. MULTIPLE CHOICE
Directions: Choose the letter of the correct answer.

1. Which of the following is a chemical change?
A. Melting of ice    B. Rusting of iron    C. Dissolving sugar

2. What is the smallest unit of an element?
A. Molecule    B. Atom    C. Compound

PART II. TRUE OR FALSE

3. Sound travels faster in water than in air.

PART III. IDENTIFICATION

4. The process by which plants make their own food.

ANSWER KEY
1. B    2. B
3. TRUE
4. Photosynthesis
`;

  $(win, '#previewBank').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(1200);

  const secs = $$(win, '#bankPreview .bp-sec');
  assert.equal(secs.length, 3, 'all three parts should appear in the preview');
  assert.match(secs[0].textContent, /Part I\. Multiple Choice/);
  assert.match(secs[1].textContent, /Part II\. True Or False/);
  assert.match(secs[2].textContent, /Part III\. Identification/);

  // The banner must confirm the key sheet was actually picked up, and nothing
  // should be flagged as unreadable.
  assert.match($(win, '#bankWarnings').textContent, /Answer key read/);
  assert.match($(win, '#bankWarnings').textContent, /applied to 4 item\(s\): 1, 2, 3, 4/);
  assert.doesNotMatch($(win, '#bankWarnings').textContent, /thing\(s\) to check/);
  assert.doesNotMatch($(win, '#bankPreview').textContent, /no key/,
    'every item should have a resolved answer');

  $(win, '#importBank').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(1500);

  assert.match($(win, '#bankCount').textContent, /3 parts · 4 items · 4 pts/);
  assert.match($(win, '#sTitle').value, /GE ELEC 103 - Midterm Examination/,
    'importing should adopt the paper title');

  // The bank that was stored is the one a student will actually be served.
  const stored = await api('/api/teacher/exam', {
    headers: { 'X-Teacher-Token': teacherToken }
  });
  assert.equal(stored.blueprint.length, 3);
  assert.equal(stored.blueprint[0].questions[0].answer, 'Rusting of iron');
  assert.equal(stored.blueprint[1].questions[0].kind, 'truefalse');
  assert.equal(stored.blueprint[2].questions[0].answer, 'Photosynthesis');
});

test('the teacher can preview, correct, and save pasted question types', async () => {
  const win = await openDashboard();
  await settle(3200);

  $$(win, '.tab').find((t) => t.dataset.tab === 'questions')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(500);
  assert.equal($(win, '#tab-questions').classList.contains('hidden'), false,
    'teachers should have a dedicated Questions tab');
  assert.equal($(win, '#tab-setup').classList.contains('hidden'), true);

  // The modified True/False directions require typed answers. Numbering with
  // no space is intentional: this is how many document pastes arrive.
  $(win, '#bankText').value = `# Part VI. True Or False
Write TRUE if the statement is correct. If it is false, write the word that makes the statement incorrect.

1.Reading a design means asking why an element is there and whether it actually works.
Ans: TRUE
2.Looking is the deliberate, structured practice of asking what a design is doing and whether it succeeds.
Ans: FALSE | READING
3.Whitespace is wasted space and should always be filled with more content.
Ans: FALSE | WASTED | ACTIVE
4.Visual literacy is the ability to interpret, evaluate, and construct meaning from visual material.
Ans: TRUE
5.A critique such as "it looks clean" is specific enough to earn credit in a screen teardown.
Ans: FALSE | VAGUE | not specific | general`;
  $(win, '#bankText').dispatchEvent(new win.Event('input', { bubbles: true }));
  $(win, '#previewBank').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(900);

  const typeMenus = $$(win, '#bankPreview [data-bank-kind]');
  assert.equal(typeMenus.length, 5, 'the full part should be shown, not a truncated summary');
  assert.deepEqual(typeMenus.map((menu) => menu.value), Array(5).fill('short'),
    'pure TRUE items 1 and 4 must also render as typed short answers');
  assert.equal($$(win, '#bankPreview .bp-student-input:not(.essay)').length, 5,
    'the teacher preview should show the student response control');

  // The per-item menu is live: a teacher can override any inferred type and
  // immediately see the corresponding student control.
  let firstType = $(win, '[data-bank-kind="0:0"]');
  firstType.value = 'truefalse';
  firstType.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.ok($(win, '[data-bank-question="0:0"] .bp-tf'), 'True/False should preview two buttons');
  firstType = $(win, '[data-bank-kind="0:0"]');
  firstType.value = 'short';
  firstType.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.ok($(win, '[data-bank-question="0:0"] .bp-student-input:not(.essay)'),
    'changing it back to Short answer should preview a text box');

  // Open the first item and change content in the structured editor. These
  // edits must be the data saved, rather than being lost by re-parsing the raw
  // textarea during import.
  $(win, '[data-bank-edit-question="0:0"]')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(50);
  const editor = $(win, '[data-bank-editor="0:0"]');
  assert.ok(editor, 'Edit should open prompt/key/points controls');
  editor.querySelector('[data-edit-prompt]').value = 'Reading a design means asking why each element is there. (edited)';
  editor.querySelector('[data-edit-answer]').value = 'TRUE\nCORRECT';
  editor.querySelector('[data-edit-points]').value = '2';
  editor.querySelector('[data-bank-save-question]')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(80);

  assert.match($(win, '#bankDraftStatus').textContent, /Unsaved/);
  assert.match($(win, '#bankPreview').textContent, /\(edited\)/);

  $(win, '#importBank').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(1300);

  const stored = await api('/api/teacher/exam', {
    headers: { 'X-Teacher-Token': teacherToken }
  });
  assert.match(stored.title, /GE ELEC 103/, 'a part-only paste should not rename the selected exam');
  const questions = stored.blueprint[0].questions;
  assert.equal(questions.length, 5);
  assert.deepEqual(questions.map((q) => q.kind), Array(5).fill('short'));
  assert.match(questions[0].prompt, /\(edited\)$/);
  assert.deepEqual(questions[0].answer, ['TRUE', 'CORRECT']);
  assert.equal(questions[0].points, 2);
  assert.match($(win, '#bankDraftStatus').textContent, /matches the saved/);
});
