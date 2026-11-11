import { api, toast, fmtClock } from './util.js';

const $ = (s) => document.querySelector(s);

let info = null;
let infoRequest = 0;
let clockStarted = false;

async function loadInfo(code = '') {
  const requestId = ++infoRequest;
  try {
    const loaded = await api('/api/public/exam-info' + (code ? `?code=${encodeURIComponent(code)}` : ''));
    if (requestId !== infoRequest) return;
    info = loaded;
  } catch (err) {
    if (requestId !== infoRequest) return;
    info = null;
    $('#startBtn').disabled = true;
    $('#heroTitle').textContent = code ? 'Exam not found' : 'Cannot reach the exam server';
    $('#heroMeta').textContent = err.message;
    return;
  }

  document.title = `${info.title} — Student Entry`;
  $('#heroSchool').textContent = info.school || 'RVM';
  $('#heroTitle').textContent = info.title;

  const bits = [info.subject, info.term].filter(Boolean);
  $('#heroMeta').textContent =
    bits.length ? bits.join(' · ') : 'Answer honestly. Leaving the exam tab and clipboard attempts are recorded.';

  $('#heroStats').innerHTML = [
    { k: 'Time limit', v: `${info.durationMinutes} min` },
    { k: 'Questions', v: info.totalQuestions },
    { k: 'Total points', v: info.totalPoints },
    { k: 'Sections', v: info.sections.length }
  ].map((s) => `<div class="hero-stat"><div class="v">${s.v}</div><div class="k">${s.k}</div></div>`).join('');

  $('#teacherNote')?.remove();
  if (info.proctorNotes) {
    const li = document.createElement('li');
    li.id = 'teacherNote';
    li.innerHTML = `<b>From your teacher:</b> ${info.proctorNotes.replace(/[<>]/g, '')}`;
    $('#rulesList').prepend(li);
  }

  // These two rules depend on how the teacher has configured the exam.
  $('#ruleNavigate').innerHTML = '<b>You can go back.</b> Move between parts freely and change an answer any time before you submit.';
  $('#ruleScores').innerHTML = '<b>Scores are not shown on screen.</b> Your teacher will release the results.';
  if (info.lockSections) {
    $('#ruleNavigate').innerHTML =
      '<b>Sections lock.</b> Once you move past a section you cannot return to it.';
  }
  if (info.showResult) {
    $('#ruleScores').innerHTML =
      '<b>Your score is shown when you submit.</b> You can review each item afterwards.';
  }

  $('.banner-closed')?.remove();
  if (!info.examOpen) {
    const banner = document.createElement('div');
    banner.className = 'banner-closed';
    banner.textContent = 'This exam is currently closed by your teacher. Please wait for it to open.';
    $('.entry-panel .card-pad').prepend(banner);
    $('#startBtn').disabled = true;
  }

  // The rules may have been accepted while the exam information was loading.
  $('#startBtn').disabled = !$('#fAgree').checked || !info.examOpen;
  tickClock();
  if (!clockStarted) { setInterval(tickClock, 1000); clockStarted = true; }
}

function tickClock() {
  $('#clockLine').textContent = `Server time ${new Date().toLocaleTimeString()}`;
}

/* ------------------------------------------------------------------ form */

const agree = $('#fAgree');
const startBtn = $('#startBtn');
agree.addEventListener('change', () => { startBtn.disabled = !agree.checked || !info?.examOpen; });

function formatAccessCodeInput(input, e) {
  const v = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const deleting = e?.inputType && e.inputType.startsWith('delete');
  input.value = v.length === 3 && !v.includes('-') && !deleting ? v + '-' : v;
}

let codeTimer;
$('#fCode').addEventListener('input', (e) => {
  formatAccessCodeInput(e.target, e);
  clearTimeout(codeTimer);
  infoRequest++; // Invalidate any request for a previous code.
  info = null;
  startBtn.disabled = true;
  const code = e.target.value.trim();
  codeTimer = setTimeout(() => loadInfo(code), code ? 350 : 0);
});

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!agree.checked) return toast('Please confirm you will answer honestly.', 'warn');

  startBtn.disabled = true;
  startBtn.textContent = 'Verifying…';

  try {
    const res = await api('/api/sessions', {
      method: 'POST',
      body: {
        access_code: $('#fCode').value.trim(),
        student_name: $('#fName').value.trim(),
        student_no: $('#fNo').value.trim(),
        class_section: $('#fSection').value.trim()
      }
    });

    sessionStorage.setItem('rvm_token', res.token);
    sessionStorage.setItem('rvm_name', $('#fName').value.trim());
    sessionStorage.setItem('rvm_no', $('#fNo').value.trim());
    if (res.resumed) toast('Welcome back — resuming your saved attempt.', 'ok');

    const url = new URL('/exam', location.origin);
    url.searchParams.set('t', res.token);
    location.href = url.toString();
  } catch (err) {
    toast(err.message, 'bad', 5000);
    startBtn.disabled = !agree.checked;
    startBtn.textContent = 'Start examination';
  }
});

let lookupGeneration = 0;
const lookupPanel = $('#scoreLookupPanel');
const lookupForm = $('#scoreLookup');
const lookupCodeInput = $('#lookupCode');
const lookupNumberInput = $('#lookupNumber');
const lookupResult = $('#lookupResult');

function prefillScoreLookup() {
  if (!lookupCodeInput.value && $('#fCode')?.value.trim()) {
    lookupCodeInput.value = $('#fCode').value.trim().toUpperCase();
  }
  if (!lookupNumberInput.value) {
    const savedNo = $('#fNo')?.value.trim() || sessionStorage.getItem('rvm_no') || '';
    if (savedNo) lookupNumberInput.value = savedNo;
  }
}

function openScoreLookupFromHash() {
  if (location.hash === '#scoreLookupPanel') {
    lookupPanel.open = true;
    prefillScoreLookup();
    lookupPanel.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    (lookupCodeInput.value ? lookupNumberInput : lookupCodeInput).focus?.();
  }
}

lookupPanel.addEventListener('toggle', () => {
  if (lookupPanel.open) prefillScoreLookup();
});
window.addEventListener('hashchange', openScoreLookupFromHash);
openScoreLookupFromHash();

lookupCodeInput.addEventListener('input', (e) => formatAccessCodeInput(e.target, e));

function renderLookupLoading() {
  const card = document.createElement('div');
  card.className = 'score-card is-loading';
  const pulse = document.createElement('span');
  pulse.className = 'score-card-pulse';
  pulse.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = 'Checking released score…';
  card.append(pulse, label);
  lookupResult.replaceChildren(card);
}

function renderLookupError(message) {
  const card = document.createElement('div');
  card.className = 'score-card is-error';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 8v4', 'M12 16h.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z']) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    icon.append(p);
  }
  const text = document.createElement('span');
  text.textContent = message;
  card.append(icon, text);
  lookupResult.replaceChildren(card);
}

function renderLookupSuccess(result) {
  const max = Number(result.max) || 0;
  const score = Number(result.score) || 0;
  const pending = Number(result.pending) || 0;
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((score / max) * 100))) : 0;

  const card = document.createElement('div');
  card.className = `score-card ${pending ? 'is-provisional' : 'is-ok'}`;

  const top = document.createElement('div');
  top.className = 'score-card-top';
  const title = document.createElement('strong');
  title.className = 'score-card-title';
  title.textContent = result.title || 'Examination';
  const pill = document.createElement('span');
  pill.className = `pill ${pending ? 'pill-warn' : 'pill-live'}`;
  const dot = document.createElement('span');
  dot.className = 'pill-dot';
  pill.append(dot, document.createTextNode(pending ? 'Provisional' : 'Released'));
  top.append(title, pill);

  const main = document.createElement('div');
  main.className = 'score-card-main';
  const points = document.createElement('div');
  points.className = 'score-card-points';
  points.append(document.createTextNode(`${score} / ${max} `));
  const unit = document.createElement('span');
  unit.textContent = 'pts';
  points.append(unit);
  const pctEl = document.createElement('div');
  pctEl.className = 'score-card-pct';
  pctEl.textContent = `${pct}%`;
  main.append(points, pctEl);

  const bar = document.createElement('div');
  bar.className = `bar ${pending ? 'warn' : 'ok'}`;
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span');
  fill.style.width = `${pct}%`;
  bar.append(fill);

  card.append(top, main, bar);

  if (pending) {
    const foot = document.createElement('div');
    foot.className = 'score-card-foot';
    foot.textContent = `${pending} points awaiting grading; score is provisional.`;
    card.append(foot);
  }

  lookupResult.replaceChildren(card);
}

lookupForm.addEventListener('input', () => {
  lookupGeneration++;
  lookupResult.replaceChildren();
});
lookupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const generation = ++lookupGeneration;
  const button = lookupForm.querySelector('[type="submit"]');
  button.disabled = true;
  renderLookupLoading();
  try {
    const result = await api('/api/public/result-lookup', { method: 'POST', body: {
      code: lookupCodeInput.value, number: lookupNumberInput.value
    }});
    if (generation === lookupGeneration) renderLookupSuccess(result);
  } catch (err) {
    if (generation === lookupGeneration) renderLookupError(err.message);
  } finally {
    button.disabled = false;
  }
});

loadInfo();
