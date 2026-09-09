/**
 * Student exam runner.
 *
 * Every guard here is a *deterrent and a record*: the authoritative checks
 * (the clock, the answer key, section locking) all live on the server.
 */
import { api, toast, fmtClock, escapeHtml, ICON } from './util.js';

const $ = (s) => document.querySelector(s);

const token = new URLSearchParams(location.search).get('t') || sessionStorage.getItem('rvm_token');
if (!token) location.href = '/';
sessionStorage.setItem('rvm_token', token);

const state = {
  info: null,
  paper: null,
  cursor: 0,
  current: null,
  secondsLeft: 0,
  violations: 0,
  maxViolations: 8,
  flagged: false,
  finished: false,
  saving: false,
  dirty: null,
  tabLocked: false
};

/* ==================================================================== boot */

async function boot() {
  try {
    state.info = await api('/api/public/exam-info');
    state.paper = await api(`/api/s/${token}/paper`);
  } catch (err) {
    return showFatal(err.message);
  }

  if (state.paper.status !== 'active') return renderResult();

  state.cursor = state.paper.cursor || 0;
  state.secondsLeft = state.paper.secondsLeft;
  state.violations = state.paper.violations || 0;
  state.maxViolations = state.paper.maxViolations || 8;
  state.flagged = state.paper.flagged;

  $('#barTitle').textContent = state.info.title;
  $('#barStudent').textContent = [sessionStorage.getItem('rvm_name'), sessionStorage.getItem('rvm_no')]
    .filter(Boolean).join(' · ') || 'Candidate';

  $('#totalCount').textContent = state.paper.total;
  renderSidebar();
  updateProgress();
  updateViolationMeter();
  startTimer();
  await loadItem(state.cursor);
  installGuards();
  startHeartbeat();
}

function showFatal(message) {
  $('#examMain').innerHTML = `
    <div class="card card-pad" style="grid-column:1/-1;text-align:center;padding:44px">
      <div class="veil-icon" style="margin-bottom:14px">${ICON.alert}</div>
      <h2>Exam unavailable</h2>
      <p class="muted" style="margin-top:8px">${escapeHtml(message)}</p>
      <a class="btn btn-primary" style="margin-top:20px" href="/">Back to the entry page</a>
    </div>`;
  $('.dock').classList.add('hidden');
}

/* ================================================================ sidebar */

function renderSidebar() {
  const host = $('#sections');
  host.innerHTML = state.paper.sections.map((sec) => {
    const answered = sec.questions.filter((q) => isAnswered(q.id)).length;
    const cls = [
      'sec-row',
      sec.index === sectionOf(state.cursor) ? 'active' : '',
      sec.locked ? 'done' : ''
    ].join(' ');
    return `<button class="${cls}" data-sec="${sec.index}" ${sec.reachable ? '' : 'disabled'}>
      <span class="sec-idx">${sec.index + 1}</span>
      <span class="sec-name">${escapeHtml(sec.title)}</span>
      <span class="sec-meta">${sec.locked ? '🔒' : `${answered}/${sec.count}`}</span>
    </button>`;
  }).join('');

  host.querySelectorAll('[data-sec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = state.paper.sections[Number(btn.dataset.sec)];
      goto(sec.start);
    });
  });

  renderPalette();
}

function renderPalette() {
  const host = $('#palette');
  const curSection = sectionOf(state.cursor);
  host.innerHTML = state.paper.sections.flatMap((sec) =>
    sec.questions.map((q) => {
      const cls = [
        'pal',
        isAnswered(q.id) ? 'answered' : '',
        q.index === state.cursor ? 'current' : '',
        sec.locked ? 'locked' : ''
      ].join(' ');
      const reachable = sec.index <= state.paper.maxSection && !sec.locked;
      return `<button class="${cls}" data-i="${q.index}" ${reachable ? '' : 'disabled'}
        title="Question ${q.index + 1} · ${escapeHtml(sec.title)}">${q.index + 1}</button>`;
    })
  ).join('');

  host.querySelectorAll('[data-i]').forEach((b) =>
    b.addEventListener('click', () => goto(Number(b.dataset.i))));
}

function sectionOf(index) {
  const sec = state.paper.sections.find((s) => index >= s.start && index < s.start + s.count);
  return sec ? sec.index : 0;
}

function isAnswered(qid) {
  const v = state.paper.answers[qid];
  if (v === undefined || v === null || v === '') return false;
  return !(Array.isArray(v) && v.length === 0);
}

function updateProgress() {
  const total = state.paper.total;
  const done = Object.keys(state.paper.answers).filter(isAnswered).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  $('#answeredCount').textContent = done;
  $('#ringNum').textContent = `${pct}%`;
  const circ = 2 * Math.PI * 26;
  $('#ringFg').setAttribute('stroke-dashoffset', String(circ * (1 - done / Math.max(1, total))));
  $('#dockProgress').textContent = `${done} of ${total} answered · ${pct}% complete`;
  renderPalette();

  const host = $('#sections');
  state.paper.sections.forEach((sec) => {
    const row = host.querySelector(`[data-sec="${sec.index}"]`);
    if (!row) return;
    const answered = sec.questions.filter((q) => isAnswered(q.id)).length;
    row.querySelector('.sec-meta').textContent = sec.locked ? '🔒' : `${answered}/${sec.count}`;
    row.classList.toggle('active', sec.index === sectionOf(state.cursor));
  });
}

function updateViolationMeter() {
  const max = state.maxViolations || 8;
  const shown = Math.min(max, 10);
  $('#vdots').innerHTML = Array.from({ length: shown }, (_, i) =>
    `<i class="${i < state.violations ? 'on' : ''}"></i>`).join('');
  $('#vlabel').textContent = `${state.violations} flag${state.violations === 1 ? '' : 's'}`;
  $('#vmeter').classList.toggle('hot', state.violations >= max * 0.6);
}

/* ================================================================== timer */

let timerInterval = null;
function startTimer() {
  paintTimer();
  timerInterval = setInterval(() => {
    state.secondsLeft = Math.max(0, state.secondsLeft - 1);
    paintTimer();
    if (state.secondsLeft <= 0) submit(true);
  }, 1000);
}

function paintTimer() {
  const el = $('#timer');
  $('#timerText').textContent = fmtClock(state.secondsLeft);
  el.classList.toggle('warn', state.secondsLeft <= 600 && state.secondsLeft > 120);
  el.classList.toggle('crit', state.secondsLeft <= 120);
  if (state.secondsLeft === 300) toast('5 minutes remaining.', 'warn', 5000);
  if (state.secondsLeft === 60) toast('1 minute remaining — the exam will submit automatically.', 'bad', 8000);
}

/* ================================================================ loading */

async function loadItem(index) {
  $('#qbody').innerHTML =
    '<div class="sk" style="height:26px;width:70%"></div>' +
    '<div class="sk" style="height:52px;margin-top:24px"></div>' +
    '<div class="sk" style="height:52px;margin-top:10px"></div>';

  try {
    const res = await api(`/api/s/${token}/item?i=${index}`);
    state.current = res;
    state.cursor = res.index;
    state.secondsLeft = Math.min(state.secondsLeft, res.secondsLeft);
    if (res.status !== 'active' && !state.finished) return renderResult();
    renderQuestion(res);
    renderSectionIntro(res);
    $('#qChip').textContent = `Question ${res.index + 1} of ${res.total}`;
    $('#qSectionName').textContent = res.sectionTitle;
    $('#lockNote').textContent = res.sectionLocked ? 'This section is locked.' : '';
    $('#prevBtn').disabled = res.index === 0 || lockedAt(res.index - 1);
    $('#nextBtn').textContent = isLastInSection(res.index) && res.index + 1 < res.total
      ? 'Next section →' : res.index + 1 >= res.total ? 'Review & submit' : 'Next →';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    $('#qbody').innerHTML = `<p class="mark-no">${escapeHtml(err.message)}</p>`;
  }
}

function lockedAt(index) {
  const sec = state.paper.sections[sectionOf(index)];
  return sec ? sec.locked : false;
}

function isLastInSection(index) {
  const sec = state.paper.sections[sectionOf(index)];
  return sec ? index === sec.start + sec.count - 1 : false;
}

function renderSectionIntro(res) {
  const sec = state.paper.sections[res.sectionIndex];
  const firstInSection = res.index === sec.start;
  $('#sectionIntro').innerHTML = firstInSection && sec.instructions
    ? `<div class="section-intro">
         <h3>${escapeHtml(sec.title)}</h3>
         <p>${escapeHtml(sec.instructions)}</p>
       </div>`
    : '';
}

function renderQuestion(res) {
  const q = res.question;
  let saved = res.saved;
  $('#qPoints').textContent = `${q.points} point${q.points === 1 ? '' : 's'}`;

  const locked = q.locked || state.finished;
  const dis = locked ? 'disabled' : '';

  if (q.kind === 'mcq' || q.kind === 'multiselect') {
    const multi = q.kind === 'multiselect';
    const chosen = multi ? (Array.isArray(saved) ? saved : []) : [String(saved)];
    $('#qbody').innerHTML = `
      <div class="qprompt">${escapeHtml(q.prompt)}</div>
      ${multi ? '<p class="tiny muted" style="margin-top:10px">Select <b>all</b> that apply.</p>' : ''}
      <div class="choices" role="${multi ? 'group' : 'radiogroup'}">
        ${q.choices.map((c) => `
          <button type="button" class="choice ${chosen.includes(String(c.key)) ? 'selected' : ''}"
                  data-key="${c.key}" ${multi ? 'data-multi' : ''} ${dis}>
            <span class="choice-key">${c.label}</span>
            <span class="choice-mark"></span>
            <span class="grow">${escapeHtml(c.text)}</span>
          </button>`).join('')}
      </div>`;

    $('#qbody').querySelectorAll('.choice').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = Number(btn.dataset.key);
        if (multi) {
          const set = new Set(Array.isArray(saved) ? saved : []);
          set.has(key) ? set.delete(key) : set.add(key);
          saved = [...set];
          btn.classList.toggle('selected', set.has(key));
        } else {
          saved = String(key);
          $('#qbody').querySelectorAll('.choice').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
        }
        saveAnswer(q.id, saved);
      });
    });
    return;
  }

  if (q.kind === 'truefalse') {
    const chosen = String(saved);
    $('#qbody').innerHTML = `
      <div class="qprompt">${escapeHtml(q.prompt)}</div>
      <div class="choices">
        ${q.choices.map((c, i) => `
          <button type="button" class="choice ${chosen === String(i) ? 'selected' : ''}" data-key="${i}" ${dis}>
            <span class="choice-key">${c.label}</span>
            <span class="choice-mark"></span>
            <span class="grow">${escapeHtml(c.text)}</span>
          </button>`).join('')}
      </div>`;
    $('#qbody').querySelectorAll('.choice').forEach((btn) => {
      btn.addEventListener('click', () => {
        saved = btn.dataset.key;
        $('#qbody').querySelectorAll('.choice').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        saveAnswer(q.id, saved);
      });
    });
    return;
  }

  if (q.kind === 'essay') {
    $('#qbody').innerHTML = `
      <div class="qprompt">${escapeHtml(q.prompt)}</div>
      <div class="answer-area" style="margin-top:20px">
        <textarea id="ansText" placeholder="Type your answer here…" ${dis}
          onkeydown="if(event.key==='Tab'){event.preventDefault()}"
        >${escapeHtml(saved || '')}</textarea>
        <div class="wordcount" id="wc">0 words</div>
      </div>`;
    wireTextarea(q);
    return;
  }

  // short / identification
  $('#qbody').innerHTML = `
    <div class="qprompt">${escapeHtml(q.prompt)}</div>
    <div class="answer-area" style="margin-top:20px">
      <input type="text" id="ansText" class="short-input" autocomplete="off"
             spellcheck="false" placeholder="Type your answer…" value="${escapeHtml(saved || '')}" ${dis}>
    </div>`;
  wireTextarea(q);
}

function wireTextarea(q) {
  const el = $('#ansText');
  if (!el) return;
  const wc = $('#wc');
  const update = () => {
    if (wc) wc.textContent = `${el.value.trim().split(/\s+/).filter(Boolean).length} words`;
  };
  update();
  let t;
  el.addEventListener('input', () => {
    update();
    clearTimeout(t);
    t = setTimeout(() => saveAnswer(q.id, el.value), 700);
  });
  el.addEventListener('blur', () => saveAnswer(q.id, el.value));
}

/* ================================================================== saving */

function setSaveState(kind, text) {
  const el = $('#saveState');
  el.className = `save-state ${kind}`;
  $('#saveText').textContent = text;
}

async function saveAnswer(questionId, value) {
  setSaveState('saving', 'Saving…');
  try {
    const res = await api(`/api/s/${token}/answer`, {
      method: 'POST',
      body: { questionId, value }
    });
    state.paper.answers[questionId] = value;
    state.secondsLeft = Math.min(state.secondsLeft, res.secondsLeft);
    setSaveState('saved', `Saved · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    updateProgress();
  } catch (err) {
    setSaveState('error', 'Not saved');
    toast(err.message, 'bad');
  }
}

/* ============================================================ navigation */

async function goto(index) {
  if (index < 0 || index >= state.paper.total) return;
  try {
    const res = await api(`/api/s/${token}/goto`, { method: 'POST', body: { index } });
    state.paper.maxSection = res.maxSection;
    state.cursor = res.cursor;
    refreshLocks();
    await loadItem(index);
  } catch (err) {
    toast(err.message, 'warn', 4200);
  }
}

function refreshLocks() {
  state.paper.sections.forEach((sec, i) => {
    sec.locked = i < state.paper.maxSection && state.info.lockSections;
    sec.reachable = i <= state.paper.maxSection;
  });
  renderSidebar();
}

$('#prevBtn').addEventListener('click', () => goto(state.cursor - 1));

$('#nextBtn').addEventListener('click', async () => {
  const next = state.cursor + 1;
  if (next >= state.paper.total) return beginSubmit();

  const movingToSection = sectionOf(next) !== sectionOf(state.cursor);
  if (movingToSection) {
    const current = state.paper.sections[sectionOf(state.cursor)];
    const blank = current.questions.filter((q) => !isAnswered(q.id)).length;
    const warning = state.info.lockSections
      ? `${current.title} will be locked and you will not be able to return to it.`
      : `You are moving on to the next section.`;
    const ok = confirm(
      `${blank ? `You have ${blank} unanswered question${blank === 1 ? '' : 's'} in this section.\n\n` : ''}${warning}\n\nContinue?`
    );
    if (!ok) return;
  }
  goto(next);
});

/* ================================================================= submit */

async function beginSubmit() {
  const total = state.paper.total;
  const done = Object.keys(state.paper.answers).filter(isAnswered).length;
  if (done < total) {
    const ok = confirm(
      `You have answered ${done} of ${total} questions.\n\n` +
      `${total - done} question(s) are still blank and will be marked as no answer.\n\n` +
      'Submit the examination now?'
    );
    if (!ok) return;
  } else {
    const ok = confirm('You have answered every question.\n\nSubmit the examination now?');
    if (!ok) return;
  }
  submit(false);
}

async function submit(auto) {
  if (state.finished) return;
  state.finished = true;
  clearInterval(timerInterval);
  stopHeartbeat();
  try {
    await api(`/api/s/${token}/submit`, { method: 'POST', body: { confirm: true } });
    if (auto) toast('Time is up — your exam was submitted automatically.', 'warn', 6000);
  } catch (err) {
    if (err.status !== 409) toast(err.message, 'bad');
  }
  removeGuards();
  renderResult();
}

$('#submitBtn').addEventListener('click', beginSubmit);
$('#submitTopBtn').addEventListener('click', beginSubmit);

/* ================================================================ result */

async function renderResult() {
  state.finished = true;
  clearInterval(timerInterval);
  stopHeartbeat();
  removeGuards();

  let data;
  try {
    data = await api(`/api/s/${token}/result`);
  } catch (err) {
    return showFatal(err.message);
  }

  $('.dock').classList.add('hidden');
  $('#examMain').classList.add('hidden');
  $('.appbar').classList.add('hidden');

  const s = data.summary;
  const pct = Math.max(0, Math.min(100, s.percent || 0));
  const circ = 2 * Math.PI * 74;
  const stroke = pct >= 75 ? '#059669' : pct >= 60 ? '#d97706' : '#e11d48';

  $('#resultHost').innerHTML = `
    <div class="shell shell-narrow">
      <div class="card">
        <div class="result-hero">
          <div class="score-ring">
            <svg width="172" height="172">
              <circle class="bg" cx="86" cy="86" r="74"></circle>
              <circle class="fg" id="scoreFg" cx="86" cy="86" r="74"
                stroke="${stroke}" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"></circle>
            </svg>
            <div class="mid">
              <div class="big">${data.showResult ? pct + '%' : '—'}</div>
              <div class="sub">${data.showResult ? `${s.score} / ${s.max} points` : 'Result hidden'}</div>
            </div>
          </div>

          <h1>Examination submitted</h1>
          <p class="muted" style="margin-top:8px">
            Thank you, ${escapeHtml(data.studentName)}.
            ${data.status === 'force_submitted' ? ' Your teacher submitted this attempt for you.' : ''}
            ${data.status === 'invalidated' ? ' This attempt was invalidated by your teacher.' : ''}
          </p>

          ${data.showResult ? `
            <div class="row center" style="justify-content:center;margin-top:20px;flex-wrap:wrap">
              <span class="pill pill-live"><span class="pill-dot"></span>${s.correct} correct</span>
              <span class="pill pill-bad"><span class="pill-dot"></span>${s.wrong} incorrect</span>
              ${s.manual ? `<span class="pill pill-warn"><span class="pill-dot"></span>${s.manual} awaiting your teacher</span>` : ''}
              ${data.violations ? `<span class="pill pill-info"><span class="pill-dot"></span>${data.violations} integrity flag(s)</span>` : ''}
            </div>` : `
            <p class="small muted" style="margin-top:16px">
              Your teacher will release the scores. ${s.manual ? 'Some items are still being graded.' : ''}
            </p>`}
        </div>
      </div>

      ${data.showResult && data.items.length ? `
        <h2 style="margin:26px 0 12px">Item review</h2>
        <div class="review-list">
          ${data.items.map((it, i) => `
            <div class="review-item">
              <div class="rh">
                <span class="qchip">${i + 1}</span>
                <span class="grow">${escapeHtml(it.prompt)}</span>
                <span class="${it.status === 'correct' ? 'mark-ok' : it.status === 'wrong' ? 'mark-no' : 'mark-man'}"
                      style="font-weight:700;white-space:nowrap">${it.awarded}/${it.points}</span>
              </div>
              <div class="rb">
                <div class="kv"><span class="k">Your answer</span>
                  <span>${!it.givenText ? '<i class="muted">— no answer —</i>' : escapeHtml(it.givenText)}</span></div>
                ${it.expected !== null ? `<div class="kv"><span class="k">Correct</span>
                  <span>${escapeHtml(Array.isArray(it.expected) ? it.expected.join(' / ') : String(it.expected))}</span></div>` : ''}
                ${it.note ? `<div class="kv"><span class="k">Comment</span><span>${escapeHtml(it.note)}</span></div>` : ''}
              </div>
            </div>`).join('')}
        </div>` : ''}

      <p class="center muted small" style="margin-top:28px">
        You may close this window. Your responses are stored on the server.
      </p>
    </div>`;

  requestAnimationFrame(() => {
    const fg = $('#scoreFg');
    if (fg) fg.setAttribute('stroke-dashoffset', String(circ * (1 - pct / 100)));
  });
  window.scrollTo({ top: 0 });
}

/* ======================================================== anti-cheat layer */

let heartbeatTimer = null;
let guardInstalled = false;

function installGuards() {
  if (guardInstalled) return;
  guardInstalled = true;

  // --- full screen
  if (state.info.requireFullscreen) {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    setTimeout(() => { if (!document.fullscreenElement) requestFullscreen(); }, 400);
  }

  $('#fsBtn').addEventListener('click', requestFullscreen);

  // --- tab / window focus
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flag('tab_hidden');
      showVeil('tab');
    }
  });
  window.addEventListener('blur', () => {
    if (!document.hidden) flag('window_blur');
  });

  // --- clipboard + menus + shortcuts
  ['copy', 'cut', 'paste'].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      e.preventDefault();
      flag(evt === 'paste' ? 'paste' : evt === 'cut' ? 'cut' : 'copy');
      toast(`${evt === 'paste' ? 'Pasting' : 'Copying'} is not allowed during the exam.`, 'warn');
    });
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    flag('contextmenu');
  });

  document.addEventListener('selectstart', (e) => {
    const tag = e.target?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
  });

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const combo =
      (e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'u', 'p', 's', 'a'].includes(k) ||
      (e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k) ||
      k === 'f12' || k === 'printscreen';

    if (combo && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      flag('devtools_key');
      toast('That shortcut is disabled during the exam.', 'warn');
    }

    // Number keys answer multiple-choice questions
    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(k)) {
      const target = document.activeElement?.tagName;
      if (target === 'INPUT' || target === 'TEXTAREA') return;
      const btn = document.querySelectorAll('.choice')[Number(k) - 1];
      if (btn && !btn.disabled) btn.click();
    }
    if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      if (e.key === 'ArrowRight' && !$('#nextBtn').disabled) $('#nextBtn').click();
      if (e.key === 'ArrowLeft' && !$('#prevBtn').disabled) $('#prevBtn').click();
    }
  });

  window.addEventListener('beforeprint', () => flag('print'));

  // Warn before navigating away
  window.addEventListener('beforeunload', (e) => {
    if (state.finished) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Detect a second tab of the same exam
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(`rvm-${token}`) : null;
  if (bc) {
    bc.postMessage({ hello: token });
    bc.onmessage = (ev) => {
      if (ev.data?.hello === token) {
        flag('second_tab');
        showVeil('second');
      }
      if (ev.data?.ping === token) bc.postMessage({ hello: token });
    };
    setInterval(() => bc.postMessage({ ping: token }), 4000);
  }

  // Reload counter
  const reloads = Number(sessionStorage.getItem('rvm_reloads') || 0) + 1;
  sessionStorage.setItem('rvm_reloads', String(reloads));
  if (reloads > 1) {
    api(`/api/s/${token}/flag`, { method: 'POST', body: { type: 'reload', detail: `reload #${reloads}` } })
      .catch(() => {});
  }
}

function removeGuards() {
  window.onbeforeunload = null;
  window.removeEventListener('beforeunload', () => {});
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  $('#fsBtn')?.classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function onFullscreenChange() {
  if (!document.fullscreenElement && !state.finished) {
    flag('fullscreen_exit');
    showVeil('fullscreen');
  } else {
    hideVeil();
  }
}

async function requestFullscreen() {
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    toast('Please press F11 (or use your browser menu) to enter full screen.', 'warn', 5000);
  }
}

async function flag(type, detail = '') {
  try {
    const res = await api(`/api/s/${token}/flag`, { method: 'POST', body: { type, detail } });
    state.violations = res.count;
    state.maxViolations = res.limit || state.maxViolations;
    state.flagged = res.flagged;
    updateViolationMeter();
    if (res.flagged) showVeil('limit');
  } catch { /* server unreachable — keep the exam usable */ }
}

/* ------------------------------------------------------------- veil modal */

const VEILS = {
  tab: {
    title: 'You left the exam tab',
    body: 'Switching away from the exam is recorded and reported to your teacher. Return now to continue.',
    icon: ICON.alert
  },
  fullscreen: {
    title: 'Full screen is required',
    body: 'The exam must stay in full screen. Click the button below to continue — this event has been logged.',
    icon: ICON.expand
  },
  second: {
    title: 'Exam already open elsewhere',
    body: 'This exam is open in another tab or window. Close the other copy and continue here.',
    icon: ICON.alert
  },
  limit: {
    title: 'Violation limit reached',
    body: 'You have triggered too many integrity events. Your teacher has been notified and may invalidate this attempt.',
    icon: ICON.shield
  }
};

function showVeil(kind) {
  if (state.finished || state.tabLocked) return;
  const v = VEILS[kind] || VEILS.tab;
  state.tabLocked = true;
  $('#veilIcon').innerHTML = v.icon;
  $('#veilTitle').textContent = v.title;
  $('#veilBody').textContent = v.body;
  $('#veilExtra').innerHTML =
    `<span class="pill pill-bad"><span class="pill-dot"></span>${state.violations} integrity event(s) recorded</span>`;
  $('#veil').classList.remove('hidden');
}

function hideVeil() {
  state.tabLocked = false;
  $('#veil').classList.add('hidden');
}

$('#veilBtn').addEventListener('click', async () => {
  if (state.info?.requireFullscreen && !document.fullscreenElement) await requestFullscreen();
  hideVeil();
  window.focus();
});

/* ------------------------------------------------------------- heartbeat */

function startHeartbeat() {
  const send = async () => {
    if (state.finished) return;
    try {
      const res = await api(`/api/s/${token}/heartbeat`, {
        method: 'POST',
        body: {
          visible: !document.hidden,
          fullscreen: !state.info.requireFullscreen || !!document.fullscreenElement,
          focus: document.hasFocus()
        }
      });
      state.secondsLeft = Math.min(state.secondsLeft, res.secondsLeft);
      state.violations = res.violations;
      state.flagged = res.flagged;
      updateViolationMeter();
      if (res.status !== 'active' && !state.finished) renderResult();
    } catch { /* network blip; retry on the next tick */ }
  };
  send();
  heartbeatTimer = setInterval(send, 4000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
}

/* ------------------------------------------------------------------ start */

try {
  await api(`/api/s/${token}/start`, { method: 'POST' });
  await boot();
} catch (err) {
  if (err.status === 409) await renderResult();
  else showFatal(err.message);
}
