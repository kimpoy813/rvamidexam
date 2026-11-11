import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const dir = mkdtempSync(path.join(tmpdir(), 'rvm-score-signup-'));
const work = path.join(dir, 'js');
mkdirSync(work, { recursive: true });

process.env.EXAM_DATA_DIR = dir;
process.env.EXAM_DB = path.join(dir, 'score-signup.sqlite');
process.env.EXAM_TEACHER_PASSWORD = 'teacher-pass-123';
process.env.PORT = '4129';
process.env.HOST = '127.0.0.1';

const BASE = 'http://127.0.0.1:4129';
const serverModule = await import('../server/index.js');
await new Promise((r) => setTimeout(r, 350));

const { getSettings } = await import('../server/lib/db.js');
const accessCode = getSettings().access_code;

const realFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

const GLOBAL_KEYS = ['window', 'document', 'location', 'sessionStorage', 'localStorage',
  'navigator', 'fetch', 'confirm', 'setInterval', 'clearInterval', 'scrollTo',
  'requestAnimationFrame', 'cancelAnimationFrame'];
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
  serverModule.httpServer.closeAllConnections?.();
  await new Promise((r) => serverModule.httpServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function define(k, v) {
  Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
}

const settle = (ms = 120) => new Promise((r) => nativeSetTimeout(r, ms));

writeFileSync(path.join(work, 'util.js'),
  readFileSync(new URL('../public/js/util.js', import.meta.url), 'utf8'));
writeFileSync(path.join(work, 'student-entry.js'),
  readFileSync(new URL('../public/js/student-entry.js', import.meta.url), 'utf8'));
writeFileSync(path.join(work, 'teacher.js'),
  readFileSync(new URL('../public/js/teacher.js', import.meta.url), 'utf8'));

function bindGlobals(win, { onReload } = {}) {
  define('window', win);
  define('document', win.document);
  define('location', onReload
    ? {
        href: win.location.href,
        origin: win.location.origin,
        pathname: win.location.pathname,
        search: win.location.search,
        hash: win.location.hash,
        reload: onReload
      }
    : win.location);
  define('sessionStorage', win.sessionStorage);
  define('localStorage', win.localStorage);
  define('navigator', win.navigator);
  define('confirm', () => true);
  define('scrollTo', () => {});
  define('requestAnimationFrame', (fn) => nativeSetTimeout(fn, 0));
  define('cancelAnimationFrame', (id) => clearTimeout(id));
  define('setInterval', (fn, ms) => nativeSetInterval(fn, ms));
  define('clearInterval', (id) => nativeClearInterval(id));
  define('fetch', (url, opts) =>
    realFetch(String(url).startsWith('http') ? url : BASE + url, opts));
}

test('every HTML input across student and teacher portals declares an explicit type', () => {
  for (const rel of ['public/index.html', 'public/teacher.html', 'public/neon.html', 'public/neon-teacher.html']) {
    const html = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    const dom = new JSDOM(html);
    const inputs = [...dom.window.document.querySelectorAll('input')];
    assert.ok(inputs.length > 0, `${rel} should have inputs`);
    for (const input of inputs) {
      const attr = input.getAttribute('type');
      assert.ok(attr && attr.trim().length > 0, `${rel} input#${input.id || '?'} is missing an explicit type attribute`);
    }
    dom.window.close();
  }
});

test('student score lookup formats codes, auto-opens from hash, and renders structured score cards', async () => {
  // Submit a student attempt and release results via teacher API.
  const loginRes = await realFetch(`${BASE}/api/teacher/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: 'teacher-pass-123' })
  }).then((r) => r.json());

  const joinRes = await realFetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_code: accessCode,
      student_name: 'Maria Santos',
      student_no: '2024-0193',
      class_section: 'Grade 10 - A'
    })
  }).then((r) => r.json());

  await realFetch(`${BASE}/api/s/${joinRes.token}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  const itemRes = await realFetch(`${BASE}/api/s/${joinRes.token}/item?index=0`).then((r) => r.json());
  await realFetch(`${BASE}/api/s/${joinRes.token}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: itemRes.question.id, value: itemRes.question.choices?.[0] ?? 'True' })
  });
  await realFetch(`${BASE}/api/s/${joinRes.token}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true })
  });

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/#scoreLookupPanel`, pretendToBeVisual: true });
  openPages.add(dom.window);
  bindGlobals(dom.window);

  await import(`${path.join(work, 'student-entry.js')}?r=${Math.random()}`);
  await settle(150);

  const doc = dom.window.document;
  assert.equal(doc.querySelector('#scoreLookupPanel').open, true, 'hash #scoreLookupPanel should auto-open');

  // Verify ABC -> ABC- formatting on #lookupCode.
  const codeInput = doc.querySelector('#lookupCode');
  codeInput.value = accessCode.slice(0, 3).toLowerCase();
  codeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(codeInput.value, `${accessCode.slice(0, 3)}-`);

  // Before release, lookup renders an error card.
  codeInput.value = accessCode;
  doc.querySelector('#lookupNumber').value = '2024-0193';
  doc.querySelector('#scoreLookup').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(150);
  assert.ok(doc.querySelector('#lookupResult .score-card.is-error'), 'unreleased score should render error card');
  assert.match(doc.querySelector('#lookupResult').textContent, /No released score/);

  // Release results and verify structured score card.
  await realFetch(`${BASE}/api/teacher/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': loginRes.token },
    body: JSON.stringify({ show_result_to_student: true })
  });

  doc.querySelector('#scoreLookup').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(150);

  const card = doc.querySelector('#lookupResult .score-card');
  assert.ok(card, 'released score should render structured .score-card');
  assert.ok(card.classList.contains('is-provisional') || card.classList.contains('is-ok'), `got card: ${card.className} -> ${card.textContent}`);
  assert.match(card.querySelector('.score-card-title').textContent, /Final Examination/);
  assert.match(card.querySelector('.score-card-points').textContent, /\/\s*50\s*pts/);
  assert.match(card.querySelector('.score-card-pct').textContent, /%/);
});

test('teacher sign-up UI switches modes, validates live password checks, toggles visibility, and registers an account', async () => {
  const html = readFileSync(new URL('../public/teacher.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/teacher`, pretendToBeVisual: true });
  openPages.add(dom.window);
  let reloaded = false;
  bindGlobals(dom.window, { onReload: () => { reloaded = true; } });

  await import(`${path.join(work, 'teacher.js')}?r=${Math.random()}`);
  await settle(100);

  const doc = dom.window.document;
  assert.equal(doc.querySelector('#loginView').classList.contains('hidden'), false);
  assert.equal(doc.querySelector('#authTabLogin').getAttribute('aria-pressed'), 'true');

  // Switch to registration via top mode switcher.
  doc.querySelector('#authTabRegister').click();
  assert.equal(doc.querySelector('#registerForm').classList.contains('hidden'), false);
  assert.equal(doc.querySelector('#loginForm').classList.contains('hidden'), true);
  assert.equal(doc.querySelector('#authTabRegister').getAttribute('aria-pressed'), 'true');
  assert.match(doc.querySelector('#authTitle').textContent, /Create teacher account/);

  // Test password visibility toggle.
  const rPass = doc.querySelector('#rPass');
  const pwToggle = doc.querySelector('[data-pw-target="rPass"]');
  assert.equal(rPass.type, 'password');
  pwToggle.click();
  assert.equal(rPass.type, 'text');
  assert.equal(pwToggle.getAttribute('aria-label'), 'Hide password');
  pwToggle.click();
  assert.equal(rPass.type, 'password');

  // Invalid username characters highlight hint and block submit with inline alert.
  const rUser = doc.querySelector('#rUser');
  const rConfirm = doc.querySelector('#rConfirm');
  rUser.value = 'bad space';
  rPass.value = 'valid-pass-1234';
  rConfirm.value = 'valid-pass-1234';
  doc.querySelector('#registerForm').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('#rUserHint').classList.contains('is-bad'), true);
  assert.equal(doc.querySelector('#rLenCheck').classList.contains('met'), true);
  assert.equal(doc.querySelector('#rMatchCheck').classList.contains('met'), true);

  doc.querySelector('#registerForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(50);
  assert.equal(doc.querySelector('#authAlert').classList.contains('hidden'), false);
  assert.match(doc.querySelector('#authAlert').textContent, /3–40 letters/);

  // Fix username, test mismatch check & alert.
  rUser.value = 'ms.santos';
  rConfirm.value = 'mismatch-pass';
  doc.querySelector('#registerForm').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('#rMatchCheck').classList.contains('bad'), true);
  doc.querySelector('#registerForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(50);
  assert.match(doc.querySelector('#authAlert').textContent, /Passwords do not match/);

  // Matching valid credentials register the teacher and store token.
  rConfirm.value = 'valid-pass-1234';
  doc.querySelector('#registerForm').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  doc.querySelector('#registerForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(200);

  assert.ok(dom.window.localStorage.getItem('rvm_teacher_token'), 'registration should store teacher token');
  assert.equal(reloaded, true, 'registration should reload into dashboard');
});
