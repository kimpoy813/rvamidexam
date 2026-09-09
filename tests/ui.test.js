/**
 * UI tests: load the real exam.html in jsdom, execute the real exam.js module
 * against a real server, and drive it by clicking.
 *
 * This exists because a syntax check cannot catch the class of bug where a
 * handler assigns to a `const` — the page loads fine and only throws the moment
 * a student clicks an answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const dir = mkdtempSync(path.join(tmpdir(), 'rvm-ui-'));
const work = path.join(dir, 'js');
mkdirSync(work, { recursive: true });

process.env.EXAM_DATA_DIR = dir;
process.env.EXAM_DB = path.join(dir, 'ui.sqlite');
process.env.EXAM_TEACHER_PASSWORD = 'ui-pass';
process.env.PORT = '4124';
process.env.HOST = '127.0.0.1';

const BASE = 'http://127.0.0.1:4124';
const serverModule = await import('../server/index.js');
await new Promise((r) => setTimeout(r, 400));

const { getSettings } = await import('../server/lib/db.js');
const accessCode = getSettings().access_code;

const realFetch = globalThis.fetch;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeSetTimeout = globalThis.setTimeout;

const GLOBAL_KEYS = ['window', 'document', 'location', 'sessionStorage', 'localStorage',
  'navigator', 'fetch', 'confirm', 'setInterval', 'setTimeout', 'clearInterval',
  'scrollTo', 'requestAnimationFrame', 'cancelAnimationFrame', 'BroadcastChannel'];

const savedGlobals = Object.fromEntries(
  GLOBAL_KEYS.map((k) => [k, { value: globalThis[k], existed: k in globalThis }])
);

const openPages = new Set();

test.after(async () => {
  for (const page of openPages) page.close();
  openPages.clear();
  for (const [k, { value, existed }] of Object.entries(savedGlobals)) {
    if (existed) define(k, value);
    else delete globalThis[k];
  }
  // close() alone waits on keep-alive sockets left open by fetch, so drop them.
  serverModule.httpServer.closeAllConnections?.();
  await new Promise((r) => serverModule.httpServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function define(k, v) {
  Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
}

/* ------------------------------------------------------------------ helpers */

const api = async (url, opts) => {
  const res = await realFetch(BASE + url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};

async function newStudent(name, no) {
  const res = await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_code: accessCode, student_name: name, student_no: no, class_section: '10-StMary'
    })
  });
  await api(`/api/s/${res.token}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  return res.token;
}

async function moveTo(token, index) {
  await api(`/api/s/${token}/goto`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index })
  });
}

/**
 * Mounts the real exam page and runs the real exam.js in it.
 * The browser globals stay pointed at this page until close() is called,
 * because the page's handlers and heartbeat keep running after boot.
 */
async function openExam(token) {
  const html = readFileSync(new URL('../public/exam.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/exam?t=${token}`, pretendToBeVisual: true });
  const win = dom.window;

  // exam.js and util.js are ESM with a relative import between them, so they are
  // copied side by side into a temp dir and imported by Node.
  writeFileSync(path.join(work, 'util.js'),
    readFileSync(new URL('../public/js/util.js', import.meta.url), 'utf8'));
  writeFileSync(path.join(work, 'exam.js'),
    readFileSync(new URL('../public/js/exam.js', import.meta.url), 'utf8'));

  const pageTimers = new Set();

  define('window', win);
  define('document', win.document);
  define('location', win.location);
  define('sessionStorage', win.sessionStorage);
  define('localStorage', win.localStorage);
  define('navigator', win.navigator);
  define('confirm', () => true);
  define('scrollTo', () => {});
  define('requestAnimationFrame', (fn) => nativeSetTimeout(fn, 0));
  define('cancelAnimationFrame', (id) => clearTimeout(id));
  define('fetch', (url, opts) =>
    realFetch(String(url).startsWith('http') ? url : BASE + url, opts));

  // Track this page's timers so close() can stop them and the suite can exit.
  define('setInterval', (fn, ms) => {
    const id = nativeSetInterval(fn, ms);
    pageTimers.add(id);
    return id;
  });
  define('clearInterval', (id) => { pageTimers.delete(id); nativeClearInterval(id); });
  define('setTimeout', (fn, ms) => {
    const id = nativeSetTimeout(fn, ms);
    pageTimers.add(id);
    return id;
  });

  win.scrollTo = () => {};

  // The query string gives each mount its own module instance, so module-level
  // state is not shared between tests.
  await import(`${path.join(work, 'exam.js')}?t=${token}&r=${Math.random()}`);

  const page = {
    win,
    close() {
      for (const id of pageTimers) nativeClearInterval(id);
      pageTimers.clear();
      openPages.delete(page);
      dom.window.close();
    }
  };
  openPages.add(page);
  return page;
}

const $ = (win, sel) => win.document.querySelector(sel);
const $$ = (win, sel) => [...win.document.querySelectorAll(sel)];
const settle = (ms = 300) => new Promise((r) => nativeSetTimeout(r, ms));
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

/* -------------------------------------------------------------------- tests */

test('the exam page boots and renders the first question', async (t) => {
  const page = await openExam(await newStudent('UI Alice', 'UI-001'));
  t.after(() => page.close());
  const win = page.win;

  const prompt = $(win, '.qprompt');
  assert.ok(prompt, 'a question prompt should be rendered');
  assert.ok(prompt.textContent.length > 10, `prompt should have text, got "${prompt.textContent}"`);

  const choices = $$(win, '.choice');
  assert.equal(choices.length, 4, 'a multiple-choice item should render four options');
  assert.ok(choices[0].textContent.includes('A'), 'options should be lettered');

  assert.equal($$(win, '.pal').length, 21, 'the question map should list all 21 items');
  assert.equal($(win, '#totalCount').textContent, '21');
  // 3600s renders with an hours field, so both "1:00:00" and "59:5x" are valid.
  assert.match($(win, '#timerText').textContent, /^(1:00:00|59:\d\d)$/,
    `the clock should read about an hour, got "${$(win, '#timerText').textContent}"`);
  assert.equal($(win, '#qChip').textContent.trim(), 'Question 1 of 21');
});

test('clicking an answer saves it to the server', async (t) => {
  const token = await newStudent('UI Bruno', 'UI-002');
  const page = await openExam(token);
  t.after(() => page.close());
  const win = page.win;

  const second = $$(win, '.choice')[1];
  click(win, second);
  await settle();

  const paper = await api(`/api/s/${token}/paper`, {});
  const saved = Object.entries(paper.answers).filter(([, v]) => v !== '' && v !== null);
  assert.equal(saved.length, 1, 'exactly one answer should have been saved');
  assert.equal(String(saved[0][1]), second.dataset.key, 'the clicked option should be the one stored');
  assert.ok(second.classList.contains('selected'), 'the clicked option should look selected');
  assert.match($(win, '#saveText').textContent, /Saved/, 'the save indicator should confirm');
});

test('true/false items render both options and can be answered', async (t) => {
  const token = await newStudent('UI Carla', 'UI-003');
  const paper = await api(`/api/s/${token}/paper`, {});
  const tf = paper.sections[1].questions[0];
  await moveTo(token, tf.index);

  const page = await openExam(token);
  t.after(() => page.close());
  const win = page.win;
  await settle(150);

  const options = $$(win, '.choice');
  assert.equal(options.length, 2, 'a true/false item must offer exactly two options');
  const labels = options.map((o) => o.textContent.trim());
  assert.ok(labels.some((l) => /True/.test(l)), `expected a True option, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => /False/.test(l)), `expected a False option, got ${JSON.stringify(labels)}`);

  click(win, options[0]);
  await settle();

  const after = await api(`/api/s/${token}/paper`, {});
  assert.equal(String(after.answers[tf.id]), options[0].dataset.key,
    'the true/false selection should be stored');
});

test('typing in an essay saves the response', async (t) => {
  const token = await newStudent('UI Dino', 'UI-004');
  const paper = await api(`/api/s/${token}/paper`, {});
  const essay = paper.sections[3].questions[0];
  for (const idx of [paper.sections[1].start, paper.sections[2].start, essay.index]) {
    await moveTo(token, idx);
  }

  const page = await openExam(token);
  t.after(() => page.close());
  const win = page.win;
  await settle(150);

  const box = $(win, '#ansText');
  assert.ok(box, 'the essay should render a text area');
  assert.equal(box.tagName, 'TEXTAREA');

  box.value = 'Integrity matters because learning depends on honest work.';
  box.dispatchEvent(new win.Event('input', { bubbles: true }));
  box.dispatchEvent(new win.Event('blur', { bubbles: true }));
  await settle(900);

  const after = await api(`/api/s/${token}/paper`, {});
  assert.match(String(after.answers[essay.id]), /Integrity matters/,
    'the typed essay should reach the server');
  assert.match($(win, '#wc').textContent, /\d+ words/, 'the word counter should update');
});

test('the progress ring and question map track answered items', async (t) => {
  const page = await openExam(await newStudent('UI Elsa', 'UI-005'));
  t.after(() => page.close());
  const win = page.win;

  assert.equal($(win, '#answeredCount').textContent, '0');
  assert.equal($(win, '#ringNum').textContent, '0%');

  click(win, $$(win, '.choice')[0]);
  await settle();

  assert.equal($(win, '#answeredCount').textContent, '1');
  assert.equal($(win, '#ringNum').textContent, `${Math.round((1 / 21) * 100)}%`);
  assert.ok($$(win, '.pal.answered').length >= 1, 'the map should mark the answered item');
});

test('the student entry form validates the access code', async (t) => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/`, pretendToBeVisual: true });
  const win = dom.window;
  t.after(() => { win.close(); });

  writeFileSync(path.join(work, 'entry.js'),
    readFileSync(new URL('../public/js/student-entry.js', import.meta.url), 'utf8'));

  define('window', win);
  define('document', win.document);
  define('location', win.location);
  define('sessionStorage', win.sessionStorage);
  define('localStorage', win.localStorage);
  define('navigator', win.navigator);
  define('fetch', (url, opts) =>
    realFetch(String(url).startsWith('http') ? url : BASE + url, opts));

  await import(`${path.join(work, 'entry.js')}?r=${Math.random()}`);
  await settle(200);

  assert.equal($(win, '#heroTitle').textContent, 'Midterm Examination (SAMPLE)');
  assert.ok($(win, '#startBtn').disabled, 'the start button needs the honesty checkbox first');
  assert.match($(win, '.hero-stats').textContent, /60 min/);

  $(win, '#fAgree').checked = true;
  $(win, '#fAgree').dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal($(win, '#startBtn').disabled, false, 'agreeing should enable the button');
});
