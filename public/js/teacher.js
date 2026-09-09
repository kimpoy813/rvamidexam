/**
 * Teacher dashboard: live roster over SSE (with polling fallback),
 * per-student review and grading, results, and exam configuration.
 */
import {
  api, toast, fmtClock, fmtAgo, fmtTime, fmtDateTime, initials, hueOf,
  escapeHtml, copyText, debounce, ICON
} from './util.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  roster: null,
  results: null,
  settings: null,
  settingsLoaded: false,
  settingsDirty: false,
  settingsSaving: false,
  settingsRevision: 0,
  storage: null,
  exams: [],
  currentExamId: null,
  filter: 'all',
  search: '',
  tab: 'live',
  scope: 'current',   // 'current' = monitor the selected exam, 'all' = every exam
  sse: null,
  poll: null,
  allPoll: null,
  lastFeedAt: 0,
  drawerToken: null,
  // Structured question-bank draft shown in the teacher preview. Raw pasted
  // text is parsed into this object once; edits are then saved as JSON so a
  // type correction in the preview can never be lost by re-parsing the text.
  bankDraft: null,
  bankDraftSource: '',
  bankTextStale: false,
  bankDraftDirty: false,
  bankDraftTitleExplicit: false,
  bankEditing: null,
  bankEditingSection: null,
  bankWarnings: [],
  bankKeyApplied: []
};

let setupSaveTimer = null;
let setupSaveQueued = false;
let pendingSaveNotice = '';

/* ==================================================================== auth */

async function init() {
  // Only show the "Default: teacher / rvm-exam-2026" hint while that default
  // password is actually still in use.
  api('/api/public/auth-hint').then((hint) => {
    $('#defaultHint').classList.toggle('hidden', !hint.showDefaultHint);
  }).catch(() => {});

  if (!localStorage.getItem('rvm_teacher_token')) return showLogin();
  try {
    const me = await api('/api/teacher/me');
    $('#dTitle').textContent = me.examTitle;
    $('#codeText').textContent = me.accessCode || '—';
    showApp();
  } catch {
    localStorage.removeItem('rvm_teacher_token');
    showLogin();
  }
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  disconnect();
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  connect();
  loadExams();
  loadSettings();
  loadStorage();
  loadExam();
  refreshResults();
  // /admin is the direct question-bank shortcut printed by the server.
  if (location.pathname === '/admin') switchTab('questions');
  setInterval(() => paintRoster(state.roster), 1000); // keep "ago" labels fresh
}

/* ================================================================== exams */

async function loadExams() {
  try {
    const res = await api('/api/teacher/exams');
    state.exams = res.exams;
    state.currentExamId = res.currentId;
    paintExams();
  } catch (err) {
    if (err.status === 401) showLogin();
  }
}

function paintExams() {
  const current = state.exams.find((e) => e.id === state.currentExamId) || state.exams[0];

  $('#examSelect').innerHTML = state.exams.map((e) =>
    `<option value="${e.id}" ${e.id === state.currentExamId ? 'selected' : ''}>${escapeHtml(e.title)}</option>`
  ).join('');

  if (current) {
    $('#dTitle').textContent = current.title;
    $('#codeText').textContent = current.access_code || '—';
  }
  $('#examCount').textContent = `${state.exams.length} exam${state.exams.length === 1 ? '' : 's'}`;

  $('#examBody').innerHTML = state.exams.map((e) => {
    const isCurrent = e.id === state.currentExamId;
    return `<tr>
      <td>
        <div style="font-weight:650">${escapeHtml(e.title)}${isCurrent
          ? ' <span class="pill pill-live" style="margin-left:6px"><span class="pill-dot"></span>active</span>'
          : ''}</div>
      </td>
      <td class="mono">${escapeHtml(e.access_code || '—')}</td>
      <td class="small muted">${e.counts.questions} items · ${e.counts.points} pts</td>
      <td><span class="pill ${e.settings.exam_open === '1' ? 'pill-done' : 'pill-idle'}"><span class="pill-dot"></span>${e.settings.exam_open === '1' ? 'open' : 'closed'}</span></td>
      <td style="white-space:nowrap">
        ${isCurrent ? '' : `<button class="btn btn-ghost btn-sm" data-use="${e.id}">Use</button>`}
        <button class="btn btn-ghost btn-sm" data-dup="${e.id}">Duplicate</button>
        <button class="btn btn-ghost btn-sm" data-del="${e.id}" ${state.exams.length <= 1 ? 'disabled' : ''}>Delete</button>
      </td>
    </tr>`;
  }).join('');

  $$('#examBody [data-use]').forEach((b) =>
    b.addEventListener('click', () => switchExam(b.dataset.use)));
  $$('#examBody [data-dup]').forEach((b) =>
    b.addEventListener('click', () => duplicateExamRow(b.dataset.dup)));
  $$('#examBody [data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteExamRow(b.dataset.del)));
}

function canDiscardBankChanges(action = 'continue') {
  if (!state.bankDraftDirty && !state.bankTextStale) return true;
  return confirm(`You have unsaved question-bank changes. Discard them and ${action}?`);
}

async function switchExam(id) {
  if (id === state.currentExamId) return;
  if (!canDiscardBankChanges('switch exams')) {
    $('#examSelect').value = state.currentExamId;
    return;
  }
  if (!(await flushSetupSave())) {
    $('#examSelect').value = state.currentExamId;
    return;
  }
  try {
    await api(`/api/teacher/exams/${id}/select`, { method: 'POST', body: {} });
    await reloadForExam();
    toast('Switched exam.', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function reloadForExam() {
  await loadExams();
  connect(); // re-subscribe the live stream to the new current exam
  await loadSettings({ force: true });
  // Never leave the previous exam's pasted text or draft visible after using
  // the exam switcher.
  state.bankDraft = null;
  state.bankTextStale = false;
  state.bankDraftDirty = false;
  state.bankDraftTitleExplicit = false;
  await loadExam({ force: true });
  refreshResults();
}

async function newExam() {
  if (!canDiscardBankChanges('create a new exam')) return;
  if (!(await flushSetupSave())) return;
  const title = prompt('New exam title:');
  if (title === null) return;
  try {
    await api('/api/teacher/exams', { method: 'POST', body: { title } });
    await reloadForExam();
    switchTab('setup');
    toast('Exam created. Add its questions in the Question bank below.', 'ok', 4200);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function duplicateExamRow(id) {
  if (!canDiscardBankChanges('duplicate this exam')) return;
  if (!(await flushSetupSave())) return;
  try {
    await api(`/api/teacher/exams/${id}/duplicate`, { method: 'POST', body: {} });
    await reloadForExam();
    toast('Exam duplicated.', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function deleteExamRow(id) {
  const exam = state.exams.find((e) => e.id === id);
  if (!exam) return;
  if (!confirm(`Delete "${exam.title}" and every one of its student attempts?\n\nThis cannot be undone.`)) return;
  if (!(await flushSetupSave())) return;
  try {
    await api(`/api/teacher/exams/${id}`, { method: 'DELETE' });
    await reloadForExam();
    toast('Exam deleted.', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

$('#examSelect').addEventListener('change', (e) => switchExam(e.target.value));
$('#newExamBtn').addEventListener('click', newExam);
$('#newExamBtn2').addEventListener('click', newExam);

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/teacher/login', {
      method: 'POST',
      body: { username: $('#lUser').value.trim(), password: $('#lPass').value }
    });
    localStorage.setItem('rvm_teacher_token', res.token);
    $('#lPass').value = '';
    toast('Signed in.', 'ok');
    location.reload();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  if (state.settingsDirty && !(await flushSetupSave())) return;
  await api('/api/teacher/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('rvm_teacher_token');
  location.reload();
});

/* ==================================================================== tabs */

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  ['live', 'results', 'setup', 'questions'].forEach((t) => {
    // Keep the question bank at the end of Exam setup for the familiar flow,
    // while also giving it a dedicated one-click Questions tab.
    const visible = t === name || (name === 'setup' && t === 'questions');
    $(`#tab-${t}`).classList.toggle('hidden', !visible);
  });
  if (name === 'results') refreshResults();
  if (name === 'setup') loadSettings();
  if (name === 'questions') loadExam();
}

/* ============================================================== live feed */

function connect() {
  disconnect();
  try {
    const token = localStorage.getItem('rvm_teacher_token');
    const url = `/api/teacher/live?t=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    state.sse = es;

    es.addEventListener('roster', (ev) => {
      // In "All exams" mode the combined poll drives the view; the SSE stream
      // still carries only the selected exam, so ignore it.
      if (state.scope === 'all') return;
      applyRoster(JSON.parse(ev.data));
      setConn(true, 'Live');
    });
    es.onerror = () => {
      setConn(false, 'Reconnecting…');
      startPolling();
    };
    es.onopen = () => { stopPolling(); setConn(true, 'Live'); };
  } catch {
    startPolling();
  }
}

function disconnect() {
  state.sse?.close();
  state.sse = null;
  stopPolling();
  stopAllPolling();
}

function startPolling() {
  if (state.poll) return;
  state.poll = setInterval(async () => {
    try {
      applyRoster(await api('/api/teacher/roster'));
      setConn(true, 'Polling');
    } catch {
      setConn(false, 'Offline');
    }
  }, 2500);
}

function stopPolling() {
  clearInterval(state.poll);
  state.poll = null;
}

/* Combined "all exams" monitoring — polls the aggregated roster. */
function startAllPolling() {
  if (state.allPoll) return;
  const fetchAll = async () => {
    try {
      applyRoster(await api('/api/teacher/roster?all=1'));
      setConn(true, 'All exams · live');
    } catch {
      setConn(false, 'Offline');
    }
  };
  fetchAll();
  state.allPoll = setInterval(fetchAll, 2500);
}

function stopAllPolling() {
  clearInterval(state.allPoll);
  state.allPoll = null;
}

$('#scopeSelect').addEventListener('change', (e) => {
  state.scope = e.target.value;
  if (state.scope === 'all') {
    startAllPolling();
  } else {
    stopAllPolling();
    // Refresh the selected exam's roster immediately.
    api('/api/teacher/roster').then(applyRoster).catch(() => {});
  }
});

function setConn(ok, label) {
  $('#conn').classList.toggle('off', !ok);
  $('#connText').textContent = label;
}

function applyRoster(data) {
  const first = !state.roster;
  state.roster = data;
  paintRoster(data);
  paintFeed(data.feed || []);

  const s = data.summary;
  $('#rosterCount').textContent = `${s.total} joined${s.examCount ? ` · ${s.examCount} exams` : ''}`;
  $('#tabManual').textContent = s.needsManual;
  $('#tabManual').classList.toggle('hidden', !s.needsManual);
  const pill = $('#examOpenPill');
  pill.className = `pill ${s.examOpen ? 'pill-live' : 'pill-idle'}`;
  pill.innerHTML = `<span class="pill-dot"></span>${s.examOpen ? 'Exam open' : 'Exam closed'}`;

  if (!first && s.submitted > (state.prevSubmitted ?? 0)) {
    const newest = data.students
      .filter((x) => x.submitted)
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))[0];
    if (newest) toast(`${newest.name} submitted · ${newest.percent ?? '—'}%`, 'ok', 4200);
  }
  state.prevSubmitted = s.submitted;
}

/* ------------------------------------------------------------- KPI cards */

function paintRoster(data) {
  if (!data) return;
  const s = data.summary;

  const cards = [
    { l: 'Online now', v: s.online, sub: `${s.inProgress} in progress`, c: 'var(--ok)' },
    { l: 'Joined', v: s.total, sub: s.examCount ? `${s.examCount} exams` : `${s.paperTotal} questions each`, c: 'var(--brand)' },
    { l: 'Submitted', v: s.submitted, sub: s.total ? `${Math.round((s.submitted / s.total) * 100)}% of class` : '—', c: 'var(--violet)' },
    { l: 'Average progress', v: `${Math.round(s.averageProgress * 100)}%`, sub: 'of those still writing', c: 'var(--info)' },
    { l: 'Needs grading', v: s.needsManual, sub: 'essay / manual items', c: 'var(--warn)' },
    { l: 'Integrity flags', v: s.flagged, sub: `${s.violations} total events`, c: 'var(--bad)' },
    { l: 'Average score', v: s.averagePercent === null ? '—' : `${s.averagePercent}%`,
      sub: s.highest === null ? 'no submissions yet' : `high ${s.highest}% · low ${s.lowest}%`, c: 'var(--ok)' }
  ];
  if (s.examCount) {
    cards.unshift({ l: 'Live exams', v: s.examCount, sub: 'being monitored', c: 'var(--brand)' });
  }

  $('#kpis').innerHTML = cards.map((k) => `
    <div class="kpi" style="--accent:${k.c}">
      <div class="kpi-label">${k.l}</div>
      <div class="kpi-value">${k.v}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');

  paintExamStrip(data.exams);
  paintStudents(data.students);
}

function paintExamStrip(exams) {
  const el = $('#examStrip');
  if (!el) return;
  if (!exams || !exams.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = exams.map((e) => `
    <span class="pill ${e.examOpen ? 'pill-live' : 'pill-idle'}" style="margin:0 6px 6px 0">
      <span class="pill-dot"></span>${escapeHtml(e.title)}
      <span class="mono" style="opacity:.8"> ${escapeHtml(e.accessCode)}</span>
      <b style="margin-left:4px">${e.inProgress} writing</b> / ${e.submitted} done
    </span>`).join('');
}

function paintStudents(students) {
  const host = $('#roster');
  if (!students.length) {
    host.innerHTML = `<div class="feed-empty">
      No students have joined yet.<br>
      Share the access code <b class="mono">${escapeHtml($('#codeText').textContent)}</b>
      and the link <b>${escapeHtml(location.origin)}/</b> with your class.
    </div>`;
    return;
  }

  const q = state.search.toLowerCase();
  const rows = students
    .filter((st) => {
      if (q && !`${st.name} ${st.studentNo} ${st.classSection}`.toLowerCase().includes(q)) return false;
      switch (state.filter) {
        case 'online': return st.online;
        case 'active': return !st.submitted;
        case 'submitted': return st.submitted;
        case 'flagged': return st.flagged || st.violations > 0;
        case 'manual': return st.needsManual;
        default: return true;
      }
    })
    .sort((a, b) => {
      if (a.submitted !== b.submitted) return a.submitted ? 1 : -1;
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      if (b.violations !== a.violations) return b.violations - a.violations;
      return a.name.localeCompare(b.name);
    });

  if (!rows.length) {
    host.innerHTML = '<div class="feed-empty">No students match this filter.</div>';
    return;
  }

  host.innerHTML = rows.map((st) => {
    const hue = hueOf(st.studentNo || st.name);
    const pct = Math.round(st.progress * 100);
    const timeCls = st.submitted ? 'done' : st.secondsLeft <= 120 ? 'crit' : st.secondsLeft <= 600 ? 'warn' : '';
    const statusPill = st.submitted
      ? (st.status === 'invalidated'
          ? '<span class="pill pill-bad"><span class="pill-dot"></span>Invalidated</span>'
          : st.status === 'force_submitted'
            ? '<span class="pill pill-warn"><span class="pill-dot"></span>Force-submitted</span>'
            : '<span class="pill pill-done"><span class="pill-dot"></span>Submitted</span>')
      : st.online
        ? '<span class="pill pill-live"><span class="pill-dot"></span>Writing now</span>'
        : '<span class="pill pill-idle"><span class="pill-dot"></span>Disconnected</span>';

    return `<div class="srow ${st.flagged ? 'flagged' : ''} ${!st.submitted && !st.online ? 'offline' : ''}"
                 data-token="${st.token}">
      <div class="avatar" style="background:hsl(${hue} 62% 52%)">
        ${escapeHtml(initials(st.name))}
        <span class="dot ${st.online ? 'on' : ''}"></span>
      </div>

      <div style="min-width:0">
        <div class="sname">${escapeHtml(st.name)}</div>
        <div class="smeta">${escapeHtml(st.studentNo)}${st.classSection ? ' · ' + escapeHtml(st.classSection) : ''}</div>
        ${st.examTitle ? `<div class="smeta" style="color:var(--brand);font-weight:650">${escapeHtml(st.examTitle)}</div>` : ''}
      </div>

      <div>
        <div class="time-left ${timeCls}">${st.submitted ? 'finished' : fmtClock(st.secondsLeft)}</div>
        <div class="smeta">${st.submitted ? fmtTime(st.submittedAt) : st.started ? 'remaining' : 'not started'}</div>
      </div>

      <div class="progress-cell">
        <div class="lab">${st.answered}/${st.total} answered</div>
        <div class="bar ${pct === 100 ? 'ok' : pct > 60 ? '' : 'warn'}"><span style="width:${st.submitted ? 100 : pct}%"></span></div>
      </div>

      <div class="sec-cell">
        <div class="smeta" style="font-weight:600;color:var(--ink-2)">${escapeHtml(st.sectionTitle || '—')}</div>
        <div class="smeta">${st.submitted ? 'complete' : `question ${st.questionNumber}`}</div>
      </div>

      <div class="score-cell">
        ${st.submitted
          ? `${st.percent ?? 0}<span class="of">%</span>`
          : '<span class="of">—</span>'}
      </div>

      <div class="flag-cell">
        ${st.violations
          ? `<span class="flag-chip ${st.flagged ? '' : 'mild'}">⚑ ${st.violations}</span>`
          : '<span class="smeta">clean</span>'}
      </div>

      <div style="display:flex;align-items:center;gap:8px">${statusPill}</div>
    </div>`;
  }).join('');

  host.querySelectorAll('[data-token]').forEach((el) =>
    el.addEventListener('click', () => openDrawer(el.dataset.token)));
}

$('#rosterSearch').addEventListener('input', debounce((e) => {
  state.search = e.target.value.trim();
  if (state.roster) paintStudents(state.roster.students);
}, 180));

$('#rosterFilter').addEventListener('change', (e) => {
  state.filter = e.target.value;
  if (state.roster) paintStudents(state.roster.students);
});

/* ------------------------------------------------------------ activity feed */

const FEED_KIND = (type) => {
  if (type.startsWith('violation')) return 'bad';
  if (type === 'submit') return 'ok';
  if (type === 'flagged') return 'bad';
  if (type === 'graded' || type === 'teacher_action') return 'info';
  if (type === 'start' || type === 'join' || type === 'resume') return 'info';
  return 'mild';
};

const FEED_ICON = {
  bad: '⚑', ok: '✓', info: '•', mild: '!'
};

function paintFeed(feed) {
  const host = $('#feed');
  if (!feed.length) {
    host.innerHTML = '<div class="feed-empty">Integrity events and submissions will appear here in real time.</div>';
    return;
  }
  const fresh = feed.filter((f) => f.at > state.lastFeedAt);
  state.lastFeedAt = Math.max(state.lastFeedAt, ...feed.map((f) => f.at));

  host.innerHTML = feed.slice(0, 40).map((f) => {
    const kind = FEED_KIND(f.type);
    const label = f.type.startsWith('violation:')
      ? f.type.slice('violation:'.length).replace(/_/g, ' ')
      : f.type.replace(/_/g, ' ');
    return `<div class="feed-item ${kind}">
      <div class="ic">${FEED_ICON[kind] || '•'}</div>
      <div>
        <div><b>${escapeHtml(f.name)}</b> — ${escapeHtml(label)}</div>
        ${f.detail ? `<div class="tiny muted">${escapeHtml(f.detail)}</div>` : ''}
        <div class="feed-when">${fmtAgo(Date.now() - f.at)}</div>
      </div>
    </div>`;
  }).join('');

  if (fresh.some((f) => f.type.startsWith('violation') || f.type === 'flagged')) {
    const worst = fresh.filter((f) => f.type.startsWith('violation') || f.type === 'flagged').pop();
    if (worst) toast(`⚑ ${worst.name}: ${worst.type.replace('violation:', '').replace(/_/g, ' ')}`, 'bad', 4000);
  }
}

$('#clearFeed').addEventListener('click', () => {
  state.lastFeedAt = Date.now();
  $('#feed').innerHTML = '<div class="feed-empty">Feed cleared. New events will appear here.</div>';
});

/* ================================================================= drawer */

async function openDrawer(token) {
  state.drawerToken = token;
  let data;
  try {
    data = await api(`/api/teacher/session/${token}`);
  } catch (err) {
    return toast(err.message, 'bad');
  }

  const s = data.session;
  const g = data.grade;
  const hue = hueOf(s.studentNo || s.name);

  $('#drawerHost').innerHTML = `
    <div class="drawer-scrim" id="dScrim"></div>
    <aside class="drawer">
      <div class="drawer-head">
        <div class="avatar" style="background:hsl(${hue} 62% 52%)">${escapeHtml(initials(s.name))}</div>
        <div class="grow" style="min-width:0">
          <div style="font-size:17px;font-weight:700;letter-spacing:-.02em">${escapeHtml(s.name)}</div>
          <div class="tiny muted">${escapeHtml(s.studentNo)}${s.classSection ? ' · ' + escapeHtml(s.classSection) : ''}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="dClose">✕</button>
      </div>

      <div class="drawer-body">
        <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
          <div class="kpi" style="--accent:${g.percent >= 75 ? 'var(--ok)' : g.percent >= 60 ? 'var(--warn)' : 'var(--bad)'}">
            <div class="kpi-label">Score</div>
            <div class="kpi-value">${s.submittedAt ? g.score : '—'}</div>
            <div class="kpi-sub">${s.submittedAt ? `${g.percent}% of ${g.max}` : 'in progress'}</div>
          </div>
          <div class="kpi" style="--accent:var(--info)">
            <div class="kpi-label">Time left</div>
            <div class="kpi-value">${s.submittedAt ? fmtClock((s.submittedAt - s.startedAt) / 1000) : fmtClock(s.secondsLeft)}</div>
            <div class="kpi-sub">${s.submittedAt ? 'time used' : 'remaining'}</div>
          </div>
          <div class="kpi" style="--accent:${s.violations ? 'var(--bad)' : 'var(--ok)'}">
            <div class="kpi-label">Flags</div>
            <div class="kpi-value">${s.violations}</div>
            <div class="kpi-sub">${s.flagged ? 'limit reached' : 'integrity events'}</div>
          </div>
        </div>

        <div class="row wrap" style="margin-top:14px">
          <span class="pill ${s.submittedAt ? 'pill-done' : 'pill-live'}"><span class="pill-dot"></span>${s.status.replace('_', ' ')}</span>
          <span class="pill pill-idle"><span class="pill-dot"></span>${s.reloads} reload(s)</span>
          <span class="pill pill-idle"><span class="pill-dot"></span>${escapeHtml(s.ip || 'ip unknown')}</span>
        </div>

        ${g.pending > 0 ? `<div class="warn-box">${g.pending} point(s) still need manual grading (essay / open items).</div>` : ''}

        <h3 style="margin:22px 0 10px">Activity timeline</h3>
        <div class="card card-pad" style="padding:16px">
          ${data.events.length ? `<div class="tl">${data.events.slice(-40).reverse().map((e) => {
            const kind = FEED_KIND(e.type);
            return `<div class="tl-item">
              <div class="tl-time">${fmtTime(e.at)}</div>
              <div class="tl-dot ${kind}">${FEED_ICON[kind] || '•'}</div>
              <div class="tl-text"><b>${escapeHtml(e.type.replace(/_/g, ' '))}</b>${e.detail ? ` — ${escapeHtml(e.detail)}` : ''}</div>
            </div>`;
          }).join('')}</div>` : '<p class="muted small">No events recorded.</p>'}
        </div>

        <h3 style="margin:22px 0 10px">Responses</h3>
        <div id="dReview">
          ${data.paper.flatMap((sec, si) => [
            `<div class="tiny muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px">${escapeHtml(sec.title)}</div>`,
            ...sec.questions.map((q, qi) => {
              const item = g.items[q.id];
              const given = renderGiven(q);
              const cls = item.status === 'correct' ? 'mark-ok' : item.status === 'wrong' ? 'mark-no' : 'mark-man';
              const needsManual = q.kind === 'essay' || (q.kind === 'short' && q.expected === null);
              return `<div class="qreview">
                <div class="row" style="align-items:flex-start;gap:8px">
                  <span class="qchip">${si + 1}.${qi + 1}</span>
                  <span class="qp grow">${escapeHtml(q.prompt)}</span>
                  <span class="${cls}" style="font-weight:750;white-space:nowrap">${item.awarded}/${q.points}</span>
                </div>
                <div class="rowline"><span class="k">Answer</span>
                  <span class="grow">${given ? escapeHtml(given) : '<i class="muted">— no answer —</i>'}</span></div>
                ${q.expected !== null ? `<div class="rowline"><span class="k">Key</span>
                  <span>${escapeHtml(Array.isArray(q.expected) ? q.expected.join(' / ') : String(q.expected))}</span></div>` : ''}
                ${needsManual ? `
                  <div class="grade-inline">
                    <input type="number" min="0" max="${q.points}" step="0.5" id="gp-${q.id}"
                           value="${item.awarded}" aria-label="Points">
                    <span class="tiny muted">/ ${q.points}</span>
                    <input type="text" id="gn-${q.id}" placeholder="Comment for the student"
                           value="${escapeHtml(item.manualNote || '')}">
                    <button class="btn btn-primary btn-sm" data-grade="${q.id}">Save</button>
                  </div>` : ''}
              </div>`;
            })
          ]).join('')}
        </div>
      </div>

      <div class="drawer-foot">
        <button class="btn btn-ghost btn-sm" data-action="extend" data-min="10">+10 min</button>
        <button class="btn btn-ghost btn-sm" data-action="extend" data-min="30">+30 min</button>
        ${s.submittedAt
          ? `<button class="btn btn-ghost btn-sm" data-action="reopen">Reopen attempt</button>`
          : `<button class="btn btn-ghost btn-sm" data-action="force_submit">Submit for them</button>`}
        ${s.violations ? `<button class="btn btn-ghost btn-sm" data-action="dismiss_flag">Clear flags</button>` : ''}
        <div class="spacer"></div>
        <button class="btn btn-danger btn-sm" data-action="invalidate">Invalidate</button>
      </div>
    </aside>`;

  $('#dClose').addEventListener('click', closeDrawer);
  $('#dScrim').addEventListener('click', closeDrawer);

  $$('#drawerHost [data-grade]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const qid = btn.dataset.grade;
      try {
        await api(`/api/teacher/session/${token}/grade`, {
          method: 'POST',
          body: { points: Number($(`#gp-${qid}`).value), note: $(`#gn-${qid}`).value }
        });
        toast('Grade saved.', 'ok');
        openDrawer(token);
        refreshResults();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  });

  $$('#drawerHost [data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      if (action === 'invalidate' &&
          !confirm(`Invalidate ${s.name}'s attempt? They will not be able to continue.`)) return;
      if (action === 'force_submit' && !confirm('Submit this exam on the student\u2019s behalf?')) return;
      try {
        await api(`/api/teacher/session/${token}/action`, {
          method: 'POST',
          body: { action, minutes: Number(btn.dataset.min || 0) }
        });
        toast('Done.', 'ok');
        if (action !== 'extend') closeDrawer();
        else openDrawer(token);
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  });
}

/**
 * The server resolves this. Choices are shuffled per student, so a stored key
 * is not an array position — deriving the text here would show the wrong one.
 */
function renderGiven(q) {
  return q.givenText || '';
}

function closeDrawer() {
  state.drawerToken = null;
  $('#drawerHost').innerHTML = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.drawerToken) closeDrawer();
});

/* ================================================================ results */

async function refreshResults() {
  try {
    state.results = await api('/api/teacher/results');
    paintResults();
  } catch (err) {
    if (err.status === 401) return showLogin();
  }
}

$('#refreshResults').addEventListener('click', refreshResults);

function paintResults() {
  const r = state.results;
  if (!r) return;

  $('#resultKpis').innerHTML = [
    { l: 'Submitted', v: `${r.submitted}/${r.total}`, sub: `${r.inProgress} still writing`, c: 'var(--brand)' },
    { l: 'Average', v: r.average === null ? '—' : `${r.average}%`, sub: `median ${r.median ?? '—'}%`, c: 'var(--violet)' },
    { l: 'Highest', v: r.highest === null ? '—' : `${r.highest}%`, sub: 'best in class', c: 'var(--ok)' },
    { l: 'Lowest', v: r.lowest === null ? '—' : `${r.lowest}%`, sub: 'needs support', c: 'var(--bad)' },
    { l: 'At or above 75%', v: r.passing, sub: `${r.submitted ? Math.round((r.passing / r.submitted) * 100) : 0}% of those submitted`, c: 'var(--info)' },
    { l: 'Awaiting grading', v: r.needsManual, sub: 'essay / manual items', c: 'var(--warn)' }
  ].map((k) => `
    <div class="kpi" style="--accent:${k.c}">
      <div class="kpi-label">${k.l}</div><div class="kpi-value">${k.v}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');

  const maxDist = Math.max(1, ...r.distribution);
  const labels = ['0–19%', '20–39%', '40–59%', '60–79%', '80–100%'];
  $('#dist').innerHTML = r.distribution.map((n, i) => `
    <div class="dist-col">
      <div class="dist-val">${n}</div>
      <div class="dist-bar" style="height:${Math.round((n / maxDist) * 100)}%;opacity:${.45 + i * .14}"></div>
      <div class="dist-lab">${labels[i]}</div>
    </div>`).join('');

  const hard = r.items
    .filter((i) => i.difficulty !== null)
    .sort((a, b) => a.difficulty - b.difficulty)
    .slice(0, 6);
  $('#hardItems').innerHTML = hard.length ? hard.map((it) => `
    <div style="padding:9px 0;border-bottom:1px solid var(--line-2)">
      <div class="row" style="gap:8px;align-items:flex-start">
        <span class="grow small" style="line-height:1.45">${escapeHtml(truncate(it.prompt, 110))}</span>
        <span class="grade-badge ${gradeClass(it.difficulty * 100)}">${Math.round(it.difficulty * 100)}%</span>
      </div>
      <div class="tiny muted" style="margin-top:4px">${it.correct} of ${it.answered} answered correctly</div>
    </div>`).join('') : '<p class="muted small">No submitted papers yet.</p>';

  $('#scoreBody').innerHTML = r.rows.length ? r.rows.map((row) => `
    <tr class="clickable" data-token="${row.token}">
      <td>
        <div style="font-weight:650">${escapeHtml(row.name)}</div>
        <div class="tiny muted">${escapeHtml(row.studentNo)}</div>
      </td>
      <td class="small">${escapeHtml(row.classSection || '—')}</td>
      <td>${row.status === 'invalidated'
            ? '<span class="pill pill-bad"><span class="pill-dot"></span>Invalidated</span>'
            : row.status === 'force_submitted'
              ? '<span class="pill pill-warn"><span class="pill-dot"></span>Forced</span>'
              : '<span class="pill pill-done"><span class="pill-dot"></span>Submitted</span>'}</td>
      <td><b>${row.score}</b><span class="tiny muted"> / ${row.max}</span></td>
      <td><span class="grade-badge ${gradeClass(row.percent)}">${row.percent}%</span></td>
      <td class="small mono">${row.durationMin === null ? '—' : row.durationMin + ' min'}</td>
      <td>${row.violations ? `<span class="flag-chip ${row.flagged ? '' : 'mild'}">⚑ ${row.violations}</span>` : '<span class="tiny muted">clean</span>'}</td>
      <td class="small muted">${fmtDateTime(row.submittedAt)}</td>
      <td><button class="btn btn-ghost btn-sm">Review</button></td>
    </tr>`).join('') : '<tr><td colspan="9" class="feed-empty">No submissions yet.</td></tr>';

  $$('#scoreBody [data-token]').forEach((tr) =>
    tr.addEventListener('click', () => openDrawer(tr.dataset.token)));

  $('#itemBody').innerHTML = r.items.map((it, i) => `
    <tr>
      <td class="mono muted">${i + 1}</td>
      <td>${escapeHtml(truncate(it.prompt, 120))}<div class="tiny muted">${escapeHtml(it.sectionTitle)}</div></td>
      <td><span class="pill pill-idle">${it.kind}</span></td>
      <td class="mono">${it.points}</td>
      <td class="mono">${it.correct}</td>
      <td class="mono">${it.answered}</td>
      <td>
        ${it.difficulty === null ? '<span class="tiny muted">no data</span>' : `
          <div class="row" style="gap:8px">
            <div class="bar grow ${it.difficulty >= .75 ? 'ok' : it.difficulty >= .5 ? '' : 'bad'}">
              <span style="width:${Math.round(it.difficulty * 100)}%"></span>
            </div>
            <span class="tiny mono">${Math.round(it.difficulty * 100)}%</span>
          </div>`}
      </td>
    </tr>`).join('');
}

function gradeClass(pct) {
  if (pct >= 85) return 'g-a';
  if (pct >= 75) return 'g-b';
  if (pct >= 60) return 'g-c';
  return 'g-f';
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

$('#exportCsv').addEventListener('click', async () => {
  const res = await fetch('/api/teacher/export.csv', {
    headers: { 'X-Teacher-Token': localStorage.getItem('rvm_teacher_token') }
  });
  if (!res.ok) return toast('Export failed.', 'bad');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `exam-results-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV downloaded.', 'ok');
});

/* ================================================================== setup */

const SETUP_FIELDS = [
  'sTitle', 'sSchool', 'sSubject', 'sTerm', 'sDuration', 'sInstructions',
  'sNotes', 'sMaxV', 'sAutoSubmit', 'sOpen', 'sShow', 'sShuffleQ',
  'sShuffleC', 'sLock', 'sFs', 'sResume'
];

function setSetupSaveStatus(label, tone = 'idle') {
  const badge = $('#setupSaveState');
  badge.textContent = label;
  badge.className = `pill pill-${tone}`;
}

function restoreStorageTone() {
  if (!state.storage) return;
  const replaced = Boolean(state.storage.storageWasReplaced);
  $('#storageStatus').classList.toggle('bad', replaced);
  $('#storageStatus').classList.toggle('warn', !state.storage.durable && !replaced);
}

async function loadStorage() {
  const card = $('#storageStatus');
  try {
    const info = await api('/api/teacher/storage');
    const previousStorageId = localStorage.getItem('rvm_exam_storage_id');
    const storageWasReplaced = Boolean(previousStorageId && info.storageId && previousStorageId !== info.storageId);
    if (info.storageId) localStorage.setItem('rvm_exam_storage_id', info.storageId);
    state.storage = { ...info, storageWasReplaced };
    card.classList.toggle('warn', !info.durable && !storageWasReplaced);
    card.classList.toggle('bad', storageWasReplaced);
    $('#storageIcon').textContent = storageWasReplaced ? '!' : (info.durable ? '✓' : '!');
    $('#storageTitle').textContent = storageWasReplaced
      ? 'The database was replaced since your last visit'
      : info.durable
        ? (info.mode === 'persistent-disk' ? 'Persistent storage connected' : 'Setup stored on this computer')
        : 'Storage is temporary — setup can reset';
    $('#storageDetail').textContent = storageWasReplaced
      ? 'This usually means the host restarted without an attached persistent disk. Save the setup again and fix the storage configuration before the exam.'
      : info.warning || (info.mode === 'persistent-disk'
        ? 'Changes are written to the attached data disk and survive service restarts and redeploys.'
        : 'Exam details and controls save automatically to SQLite and remain after reopening the system.');
  } catch (err) {
    card.classList.add('warn');
    $('#storageIcon').textContent = '?';
    $('#storageTitle').textContent = 'Could not verify data storage';
    $('#storageDetail').textContent = err.message;
  }
}

function applySettings(s) {
  $('#sTitle').value = s.exam_title;
  $('#sSchool').value = s.school;
  $('#sSubject').value = s.subject;
  $('#sTerm').value = s.term;
  $('#sDuration').value = s.duration_minutes;
  $('#sInstructions').value = s.instructions;
  $('#sNotes').value = s.proctor_notes;
  $('#sMaxV').value = s.max_violations;
  $('#sAutoSubmit').checked = s.auto_submit_on_violations === '1';
  $('#sOpen').checked = s.exam_open === '1';
  $('#sShow').checked = s.show_result_to_student === '1';
  $('#sShuffleQ').checked = s.shuffle_questions === '1';
  $('#sShuffleC').checked = s.shuffle_choices === '1';
  $('#sLock').checked = s.lock_sections === '1';
  $('#sFs').checked = s.require_fullscreen === '1';
  $('#sResume').checked = s.allow_resume === '1';
  $('#dTitle').textContent = s.exam_title;
  $('#codeText').textContent = s.access_code;
}

async function loadSettings({ force = false } = {}) {
  // A late GET must never overwrite fields the teacher has already edited.
  if (state.settingsDirty && !force) return state.settings;
  const revisionAtRequest = state.settingsRevision;
  try {
    const s = await api('/api/teacher/settings');
    if (!force && (state.settingsDirty || revisionAtRequest !== state.settingsRevision)) return state.settings;
    state.settings = s;
    state.settingsLoaded = true;
    state.settingsDirty = false;
    applySettings(s);
    setSetupSaveStatus('Saved', 'live');
    return s;
  } catch (err) {
    setSetupSaveStatus('Load failed', 'bad');
    if (err.status === 401) showLogin();
    return null;
  }
}

function collectSettings() {
  return {
    exam_title: $('#sTitle').value,
    school: $('#sSchool').value,
    subject: $('#sSubject').value,
    term: $('#sTerm').value,
    duration_minutes: $('#sDuration').value,
    instructions: $('#sInstructions').value,
    proctor_notes: $('#sNotes').value,
    max_violations: $('#sMaxV').value,
    auto_submit_on_violations: $('#sAutoSubmit').checked,
    exam_open: $('#sOpen').checked,
    show_result_to_student: $('#sShow').checked,
    shuffle_questions: $('#sShuffleQ').checked,
    shuffle_choices: $('#sShuffleC').checked,
    lock_sections: $('#sLock').checked,
    require_fullscreen: $('#sFs').checked,
    allow_resume: $('#sResume').checked
  };
}

function cacheSavedSettings(saved) {
  state.settings = saved;
  $('#dTitle').textContent = saved.exam_title;
  $('#codeText').textContent = saved.access_code;
  const exam = state.exams.find((item) => item.id === state.currentExamId);
  if (exam) {
    exam.title = saved.exam_title;
    exam.access_code = saved.access_code;
    exam.settings = saved;
    paintExams();
  }
}

function queueSetupSave({ immediate = false, notice = '' } = {}) {
  if (!state.settingsLoaded) return;
  state.settingsDirty = true;
  state.settingsRevision += 1;
  if (notice) pendingSaveNotice = notice;
  setSetupSaveStatus(immediate ? 'Saving…' : 'Unsaved changes', immediate ? 'info' : 'warn');
  clearTimeout(setupSaveTimer);
  if (state.settingsSaving) setupSaveQueued = true;
  setupSaveTimer = setTimeout(() => saveSetup(), immediate ? 0 : 650);
}

let activeSetupSave = null;
async function saveSetup({ notice = '', force = false } = {}) {
  if (notice) pendingSaveNotice = notice;
  clearTimeout(setupSaveTimer);
  setupSaveTimer = null;
  if (!state.settingsLoaded) return false;

  if (activeSetupSave) {
    setupSaveQueued = true;
    const ok = await activeSetupSave;
    return ok && state.settingsDirty ? saveSetup() : ok;
  }

  if (!state.settingsDirty && !force) {
    setSetupSaveStatus('Saved', 'live');
    if (pendingSaveNotice) {
      toast(pendingSaveNotice, 'ok');
      pendingSaveNotice = '';
    }
    return true;
  }

  const revision = state.settingsRevision;
  const payload = collectSettings();
  state.settingsSaving = true;
  setSetupSaveStatus('Saving…', 'info');

  activeSetupSave = (async () => {
    try {
      const saved = await api('/api/teacher/settings', { method: 'POST', body: payload });
      cacheSavedSettings(saved);
      restoreStorageTone();
      if (revision === state.settingsRevision) {
        state.settingsDirty = false;
        setSetupSaveStatus(`Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'live');
      } else {
        setupSaveQueued = true;
      }
      return true;
    } catch (err) {
      state.settingsDirty = true;
      setSetupSaveStatus('Save failed — retry', 'bad');
      $('#storageStatus').classList.add('bad');
      toast(`Setup was not saved: ${err.message}`, 'bad', 5000);
      pendingSaveNotice = '';
      return false;
    } finally {
      state.settingsSaving = false;
    }
  })();

  const ok = await activeSetupSave;
  activeSetupSave = null;
  const repeat = setupSaveQueued;
  setupSaveQueued = false;
  if (ok && repeat && state.settingsDirty) return saveSetup();
  if (ok && pendingSaveNotice) {
    toast(pendingSaveNotice, 'ok');
    pendingSaveNotice = '';
  }
  return ok;
}

async function flushSetupSave() {
  clearTimeout(setupSaveTimer);
  setupSaveTimer = null;
  return saveSetup();
}

SETUP_FIELDS.forEach((id) => {
  const field = $(`#${id}`);
  if (field.type === 'checkbox') {
    field.addEventListener('change', () => {
      const notice = id === 'sOpen'
        ? (field.checked ? 'Exam opened to students.' : 'Exam closed — no new entries.')
        : '';
      queueSetupSave({ immediate: true, notice });
    });
  } else {
    field.addEventListener('input', () => queueSetupSave());
    // Save immediately when a teacher leaves a field, without waiting for the
    // debounce timer (important if the browser is closed right afterwards).
    field.addEventListener('change', () => queueSetupSave({ immediate: true }));
  }
});

$('#saveSettings').addEventListener('click', () =>
  saveSetup({ notice: 'Exam details saved.', force: true }));
$('#saveSecurity').addEventListener('click', () =>
  saveSetup({ notice: 'Anti-cheating controls saved.', force: true }));
$('#saveSetupNow').addEventListener('click', () =>
  saveSetup({ notice: 'All exam setup saved.', force: true }));

$('#newCode').addEventListener('click', async () => {
  if (!(await flushSetupSave())) return;
  try {
    setSetupSaveStatus('Saving…', 'info');
    const s = await api('/api/teacher/settings', { method: 'POST', body: { new_access_code: true } });
    cacheSavedSettings(s);
    state.settingsDirty = false;
    restoreStorageTone();
    setSetupSaveStatus('Saved', 'live');
    toast(`New access code: ${s.access_code}`, 'ok');
  } catch (err) {
    setSetupSaveStatus('Save failed — retry', 'bad');
    toast(err.message, 'bad');
  }
});

function saveSetupOnPageHide() {
  if (!state.settingsLoaded || !state.settingsDirty) return;
  clearTimeout(setupSaveTimer);
  setupSaveTimer = null;
  // keepalive allows this final request to finish while the tab is closing.
  fetch('/api/teacher/settings', {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      'X-Teacher-Token': localStorage.getItem('rvm_teacher_token') || ''
    },
    body: JSON.stringify(collectSettings())
  }).catch(() => {});
}

window.addEventListener('pagehide', saveSetupOnPageHide);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.settingsDirty) saveSetup();
});

$('#codeCopy').addEventListener('click', async () => {
  const ok = await copyText($('#codeText').textContent);
  toast(ok ? 'Access code copied.' : 'Copy failed.', ok ? 'ok' : 'bad');
});

$('#changePass').addEventListener('click', async () => {
  const current = prompt('Current password:');
  if (current === null) return;
  const next = prompt('New password (at least 6 characters):');
  if (next === null) return;
  try {
    await api('/api/teacher/password', { method: 'POST', body: { current, next } });
    toast('Password changed.', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
});

$('#resetAttempts').addEventListener('click', async () => {
  if (!confirm('Delete EVERY student attempt, response and score? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Export the CSV first if you need the data.')) return;
  try {
    await api('/api/teacher/reset-attempts', { method: 'POST', body: {} });
    toast('All attempts cleared.', 'ok');
    refreshResults();
  } catch (err) { toast(err.message, 'bad'); }
});

/* --------------------------------------------------------- question bank */

const BANK_KINDS = [
  ['mcq', 'Multiple choice'],
  ['multiselect', 'Multiple select'],
  ['truefalse', 'True / False'],
  ['short', 'Short answer'],
  ['essay', 'Essay']
];
const BANK_KIND_SET = new Set(BANK_KINDS.map(([value]) => value));

const SAMPLE_FORMAT = `# Part I. Multiple Choice
Choose the letter of the best answer.

1. Which planet is closest to the Sun?  [2]
A. Venus
B. Mercury *
C. Earth
D. Mars

2. Select every prime number. [3] (multi)
- 2 *
- 3 *
- 4
- 5 *

# Part II. Modified True or False
Write TRUE if correct. If false, write the word that makes the statement incorrect.

3.The sky appears blue because of light scattering. (short)
Ans: TRUE

4.Whitespace is wasted space. (short)
Ans: FALSE | WASTED | ACTIVE

# Part III. Identification
5. What is the chemical symbol for gold? (short)
Ans: Au | gold

# Part IV. Essay
6. Explain why the sky appears blue. //  [10]`;

$('#loadSampleText').addEventListener('click', () => {
  const help = $('#formatHelp');
  help.style.display = help.style.display === 'none' ? 'block' : 'none';
  $('#formatSample').textContent = SAMPLE_FORMAT;
});

function cloneBank(value) {
  return JSON.parse(JSON.stringify(value));
}

function bankCounts(sections = state.bankDraft?.sections || []) {
  return {
    sections: sections.length,
    questions: sections.reduce((n, sec) => n + (sec.questions?.length || 0), 0),
    points: sections.reduce(
      (n, sec) => n + (sec.questions || []).reduce((m, q) => m + Number(q.points || 0), 0),
      0
    )
  };
}

function setBankDraft(data, {
  sourceText = $('#bankText').value,
  dirty = false,
  titleExplicit = false,
  warnings = [],
  keyApplied = []
} = {}) {
  state.bankDraft = {
    title: data.title || state.settings?.exam_title || $('#sTitle').value || 'Untitled Exam',
    sections: cloneBank(data.sections || data.blueprint || [])
  };
  state.bankDraftSource = sourceText;
  state.bankTextStale = false;
  state.bankDraftDirty = dirty;
  state.bankDraftTitleExplicit = titleExplicit;
  state.bankEditing = null;
  state.bankEditingSection = null;
  state.bankWarnings = warnings || [];
  state.bankKeyApplied = keyApplied || [];
  paintBankWarnings();
  renderBankDraft();
  updateBankStatus();
}

async function loadExam({ force = false } = {}) {
  try {
    const data = await api('/api/teacher/exam');
    const canReplace = force || !state.bankDraft || (!state.bankDraftDirty && !state.bankTextStale);
    if (canReplace) {
      $('#bankText').value = data.text;
      setBankDraft(
        { title: data.title, sections: data.blueprint },
        { sourceText: data.text, dirty: false }
      );
    } else {
      const c = data.counts;
      $('#bankCount').textContent = `${c.sections} parts · ${c.questions} items · ${c.points} pts`;
    }
  } catch { /* not signed in yet */ }
}

$('#bankText').addEventListener('input', () => {
  state.bankTextStale = $('#bankText').value !== state.bankDraftSource;
  updateBankStatus();
});

$('#loadCurrent').addEventListener('click', async () => {
  if ((state.bankDraftDirty || state.bankTextStale) &&
      !confirm('Discard the unsaved pasted text and preview edits, then reload the saved question bank?')) return;
  await loadExam({ force: true });
  toast('Saved question bank reloaded.', 'ok');
});

async function parsePastedBank() {
  const source = $('#bankText').value;
  const res = await fetch('/api/teacher/parse', {
    method: 'POST',
    headers: {
      'X-Teacher-Token': localStorage.getItem('rvm_teacher_token'),
      'Content-Type': 'text/plain'
    },
    body: source
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not read that text.');
  setBankDraft(
    { title: data.title, sections: data.sections },
    {
      sourceText: source,
      dirty: true,
      titleExplicit: data.titleExplicit === true,
      warnings: data.warnings || [],
      keyApplied: data.keyApplied || []
    }
  );
  return data;
}

$('#previewBank').addEventListener('click', async () => {
  try {
    const data = await parsePastedBank();
    toast(
      `Read ${data.counts.questions} items in ${data.counts.sections} parts (${data.counts.points} pts). Review the types below.`,
      'ok',
      4200
    );
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('#importBank').addEventListener('click', async () => {
  try {
    // If the teacher changed the paste box after the last preview, parse those
    // latest words first. Otherwise save the structured draft, including every
    // type/key correction made in the preview editor.
    if (!state.bankDraft || state.bankTextStale) await parsePastedBank();
    validateBankDraft(state.bankDraft);

    const counts = bankCounts();
    if (!confirm(
      `Save ${counts.questions} questions in ${counts.sections} parts?\n\n` +
      'This replaces the selected exam’s saved question bank.'
    )) return;
    if (!(await flushSetupSave())) return;

    const data = await api('/api/teacher/exam', {
      method: 'POST',
      body: {
        title: state.bankDraftTitleExplicit
          ? state.bankDraft.title
          : ($('#sTitle').value.trim() || state.settings?.exam_title || state.bankDraft.title),
        sections: state.bankDraft.sections
      }
    });

    toast(`Saved ${data.counts.questions} questions.`, 'ok');
    await loadSettings();
    await loadExams();
    await loadExam({ force: true });
    refreshResults();
  } catch (err) {
    toast(err.message, 'bad', 5000);
  }
});

function paintBankWarnings() {
  const keyNote = state.bankKeyApplied.length
    ? `<div class="warn-box" style="border-color:#a7f3d0;background:var(--ok-soft);color:#047857"><b>Answer key read</b>
        &nbsp;applied to ${state.bankKeyApplied.length} item(s): ${escapeHtml(state.bankKeyApplied.join(', '))}</div>`
    : '';

  $('#bankWarnings').innerHTML =
    (state.bankWarnings.length
      ? `<div class="warn-box"><b>${state.bankWarnings.length} thing(s) to check</b><ul>
        ${state.bankWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
      : '') + keyNote;
}

function bankKindOptions(selected, placeholder = false) {
  return `${placeholder ? '<option value="">Set every item type…</option>' : ''}${BANK_KINDS.map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`
  ).join('')}`;
}

function answerValues(answer) {
  if (answer === null || answer === undefined || answer === '') return [];
  return Array.isArray(answer) ? answer.map(String) : [String(answer)];
}

function booleanAnswer(answer) {
  const values = answerValues(answer);
  const found = values.find((v) => /^(true|false|t|f|yes|no)$/i.test(v.trim()));
  if (!found) return null;
  return /^(true|t|yes)$/i.test(found.trim()) ? 'True' : 'False';
}

function canonicalBoolean(answer) {
  return booleanAnswer(answer) || 'True';
}

function answerMatchesChoice(answer, choice) {
  const wanted = String(choice).trim().toLocaleLowerCase();
  return answerValues(answer).some((value) => value.trim().toLocaleLowerCase() === wanted);
}

function renderResponsePreview(q) {
  if (q.kind === 'mcq' || q.kind === 'multiselect') {
    const choices = q.choices || [];
    return `<div class="bp-response">
      ${choices.length ? `<div class="bp-choice-list">${choices.map((choice, i) => `
        <div class="bp-choice ${answerMatchesChoice(q.answer, choice) ? 'is-key' : ''}">
          <span class="bp-choice-key">${String.fromCharCode(65 + i)}</span>
          <span class="grow">${escapeHtml(choice)}</span>
          ${answerMatchesChoice(q.answer, choice) ? '<span class="tiny">✓ key</span>' : ''}
        </div>`).join('')}</div>` : '<div class="tiny muted">No choices yet — choose Edit to add them.</div>'}
    </div>`;
  }

  if (q.kind === 'truefalse') {
    const expected = canonicalBoolean(q.answer);
    return `<div class="bp-response"><div class="bp-tf">
      ${['True', 'False'].map((value) =>
        `<div class="bp-tf-option ${value === expected && q.answer != null ? 'is-key' : ''}">${value}${value === expected && q.answer != null ? ' · key' : ''}</div>`
      ).join('')}
    </div></div>`;
  }

  if (q.kind === 'essay') {
    return '<div class="bp-response"><div class="bp-student-input essay">Student writes a long response…</div></div>';
  }

  return '<div class="bp-response"><div class="bp-student-input">Student types a short answer…</div></div>';
}

function renderQuestionEditor(q, si, qi) {
  const key = `${si}:${qi}`;
  const choices = (q.choices || []).join('\n');
  const answers = answerValues(q.answer).join('\n');
  const kind = BANK_KIND_SET.has(q.kind) ? q.kind : 'short';
  const showChoices = kind === 'mcq' || kind === 'multiselect';
  const showTextAnswer = showChoices || kind === 'short';
  const showTf = kind === 'truefalse';

  return `<div class="bp-editor" data-bank-editor="${key}">
    <div class="bp-editor-grid">
      <div class="field">
        <label>Question type</label>
        <select data-edit-kind>${bankKindOptions(kind)}</select>
      </div>
      <div class="field">
        <label>Points</label>
        <input type="number" min="0.1" max="10000" step="0.1" data-edit-points value="${escapeHtml(q.points ?? 1)}">
      </div>
    </div>
    <div class="field">
      <label>Question / statement</label>
      <textarea rows="3" data-edit-prompt>${escapeHtml(q.prompt || '')}</textarea>
    </div>
    <div class="field ${showChoices ? '' : 'hidden'}" data-edit-choices-wrap>
      <label>Choices <span class="muted">— one per line</span></label>
      <textarea class="bp-lines" rows="4" data-edit-choices>${escapeHtml(choices)}</textarea>
    </div>
    <div class="field ${showTextAnswer ? '' : 'hidden'}" data-edit-answer-wrap>
      <label>Answer key <span class="muted">— accepted answers, one per line; leave blank for manual grading</span></label>
      <textarea class="bp-lines" rows="3" data-edit-answer>${escapeHtml(answers)}</textarea>
    </div>
    <div class="field ${showTf ? '' : 'hidden'}" data-edit-tf-wrap>
      <label>Correct answer</label>
      <select data-edit-tf>
        <option value="True" ${canonicalBoolean(q.answer) === 'True' ? 'selected' : ''}>TRUE</option>
        <option value="False" ${canonicalBoolean(q.answer) === 'False' ? 'selected' : ''}>FALSE</option>
      </select>
    </div>
    <div class="tiny muted" data-editor-help style="margin-top:7px"></div>
    <div class="bp-editor-actions">
      <button class="btn btn-primary btn-sm" type="button" data-bank-save-question="${key}">Apply changes</button>
      <button class="btn btn-ghost btn-sm" type="button" data-bank-cancel-question>Cancel</button>
      <div class="spacer"></div>
      <button class="btn btn-danger btn-sm" type="button" data-bank-delete-question="${key}">Delete question</button>
    </div>
  </div>`;
}

function renderSectionEditor(sec, si) {
  return `<div class="bp-section-editor" data-bank-section-editor="${si}">
    <div class="field">
      <label>Part title</label>
      <input type="text" data-edit-section-title value="${escapeHtml(sec.title || '')}">
    </div>
    <div class="field">
      <label>Directions shown to students</label>
      <textarea rows="2" data-edit-section-instructions>${escapeHtml(sec.instructions || '')}</textarea>
    </div>
    <div class="bp-editor-actions">
      <button class="btn btn-primary btn-sm" type="button" data-bank-save-section="${si}">Apply changes</button>
      <button class="btn btn-ghost btn-sm" type="button" data-bank-cancel-section>Cancel</button>
      <div class="spacer"></div>
      <button class="btn btn-danger btn-sm" type="button" data-bank-delete-section="${si}">Delete part</button>
    </div>
  </div>`;
}

function renderQuestionCard(q, si, qi) {
  const key = `${si}:${qi}`;
  const noKey = q.answer === null || q.answer === undefined || q.answer === '';
  const answer = answerValues(q.answer).join(' / ');
  return `<div class="bp-q" data-bank-question="${key}">
    <div class="bp-q-head">
      <span class="n">${qi + 1}</span>
      <select class="bp-kind-select" data-bank-kind="${key}" aria-label="Question ${qi + 1} type">
        ${bankKindOptions(q.kind)}
      </select>
      <span class="bp-points">${Number(q.points || 0)} pt${Number(q.points || 0) === 1 ? '' : 's'}</span>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" type="button" data-bank-edit-question="${key}">Edit</button>
    </div>
    <div class="bp-prompt">${escapeHtml(q.prompt || '')}</div>
    ${renderResponsePreview(q)}
    <div class="bp-answer ${noKey ? 'no-key' : ''}">
      <b>${noKey ? '⚠ No key' : '✓ Answer key'}</b>
      <span>${noKey ? 'This item will need manual grading.' : escapeHtml(answer)}</span>
    </div>
    ${state.bankEditing === key ? renderQuestionEditor(q, si, qi) : ''}
  </div>`;
}

function renderBankDraft() {
  const sections = state.bankDraft?.sections || [];
  const counts = bankCounts(sections);
  $('#bankCount').textContent = `${counts.sections} parts · ${counts.questions} items · ${counts.points} pts`;

  $('#bankPreview').innerHTML = sections.length ? sections.map((sec, si) => {
    const secPoints = (sec.questions || []).reduce((n, q) => n + Number(q.points || 0), 0);
    if (state.bankEditingSection === si) {
      return `<section class="bp-sec">${renderSectionEditor(sec, si)}</section>`;
    }
    return `<section class="bp-sec">
      <div class="bp-sec-head">
        <div>
          <h4>${escapeHtml(sec.title || `Part ${si + 1}`)}</h4>
          <div class="tiny muted bp-sec-summary">${sec.questions?.length || 0} items · ${secPoints} pts</div>
        </div>
        <div class="spacer"></div>
        <div class="bp-sec-tools">
          <select data-bank-bulk-kind="${si}" aria-label="Set every question type in ${escapeHtml(sec.title || `Part ${si + 1}`)}">
            ${bankKindOptions('', true)}
          </select>
          <button class="btn btn-ghost btn-sm" type="button" data-bank-edit-section="${si}">Edit part</button>
        </div>
      </div>
      ${sec.instructions ? `<div class="bp-sec-instructions"><b>Directions:</b> ${escapeHtml(sec.instructions)}</div>` : ''}
      <div class="bp-question-list">
        ${(sec.questions || []).map((q, qi) => renderQuestionCard(q, si, qi)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm bp-add-question" type="button" data-bank-add-question="${si}">+ Add question</button>
    </section>`;
  }).join('') : '<div class="feed-empty">Nothing to preview yet. Paste questions above or add a part.</div>';

  wireBankPreview();
}

function updateBankStatus() {
  const bar = $('.bank-savebar');
  if (!bar) return;
  bar.classList.toggle('is-stale', state.bankTextStale);
  bar.classList.toggle('is-dirty', state.bankDraftDirty && !state.bankTextStale);

  if (state.bankTextStale) {
    $('#bankDraftStatus').textContent = 'Pasted text changed — preview it before saving.';
    $('#bankPasteStatus').textContent = 'New text is waiting to be parsed.';
  } else if (state.bankDraftDirty) {
    $('#bankDraftStatus').textContent = 'Unsaved question-bank changes.';
    $('#bankPasteStatus').textContent = 'Preview ready. Check each type and answer key below.';
  } else {
    $('#bankDraftStatus').textContent = 'Preview matches the saved question bank.';
    $('#bankPasteStatus').textContent = 'The saved bank is shown below.';
  }
}

function markBankDraftChanged() {
  state.bankDraftDirty = true;
  state.bankTextStale = false;
  updateBankStatus();
}

function changeQuestionKind(q, nextKind) {
  if (!BANK_KIND_SET.has(nextKind)) return;
  const oldKind = q.kind;
  const oldAnswer = q.answer;
  const oldChoices = Array.isArray(q.choices) ? q.choices.slice() : [];
  q.kind = nextKind;

  if (nextKind === 'short') {
    q.choices = [];
    if (oldKind === 'truefalse' && oldAnswer != null) q.answer = canonicalBoolean(oldAnswer).toUpperCase();
    q.shuffle = false;
    return;
  }

  if (nextKind === 'truefalse') {
    q.choices = ['True', 'False'];
    q.answer = booleanAnswer(oldAnswer);
    q.shuffle = false;
    return;
  }

  if (nextKind === 'essay') {
    q.choices = [];
    q.answer = null;
    q.shuffle = false;
    return;
  }

  // Moving between choice types keeps existing options and keys. Converting a
  // True/False item gives the editor its two existing labels as a useful start.
  q.choices = oldChoices.length ? oldChoices : oldKind === 'truefalse' ? ['True', 'False'] : [];
  q.answer = nextKind === 'multiselect' && oldAnswer != null && !Array.isArray(oldAnswer)
    ? [oldAnswer]
    : oldAnswer;
  if (nextKind === 'mcq' && Array.isArray(q.answer)) q.answer = q.answer[0] ?? null;
  q.shuffle = true;
}

function splitEditorLines(value) {
  return String(value || '')
    .split(/\r?\n|\s+\|\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function syncQuestionEditorFields(editor) {
  const kind = editor.querySelector('[data-edit-kind]').value;
  const choiceKind = kind === 'mcq' || kind === 'multiselect';
  editor.querySelector('[data-edit-choices-wrap]').classList.toggle('hidden', !choiceKind);
  editor.querySelector('[data-edit-answer-wrap]').classList.toggle('hidden', !(choiceKind || kind === 'short'));
  editor.querySelector('[data-edit-tf-wrap]').classList.toggle('hidden', kind !== 'truefalse');
  const help = editor.querySelector('[data-editor-help]');
  help.textContent = kind === 'short'
    ? 'Students get a one-line text box. Add alternate accepted spellings on separate lines.'
    : kind === 'truefalse'
      ? 'Students choose one of two buttons.'
      : kind === 'essay'
        ? 'Students get a long text area and the teacher grades the response manually.'
        : kind === 'multiselect'
          ? 'Students may choose several options; list every correct option in the key.'
          : 'Students choose one option; the key must exactly match one listed choice.';
}

function saveQuestionEditor(key) {
  const [si, qi] = key.split(':').map(Number);
  const q = state.bankDraft?.sections?.[si]?.questions?.[qi];
  const card = $(`[data-bank-question="${key}"]`);
  const editor = card?.querySelector('[data-bank-editor]');
  if (!q || !editor) return;

  const prompt = editor.querySelector('[data-edit-prompt]').value.trim();
  const points = Number(editor.querySelector('[data-edit-points]').value);
  const kind = editor.querySelector('[data-edit-kind]').value;
  if (!prompt) return toast('A question cannot have an empty prompt.', 'bad');
  if (!Number.isFinite(points) || points <= 0) return toast('Points must be greater than zero.', 'bad');

  const choices = splitEditorLines(editor.querySelector('[data-edit-choices]').value);
  const enteredAnswers = splitEditorLines(editor.querySelector('[data-edit-answer]').value);
  let answer = null;

  if (kind === 'mcq' || kind === 'multiselect') {
    if (choices.length < 2) return toast('Multiple-choice questions need at least two choices.', 'bad');
    const resolved = [];
    for (const entered of enteredAnswers) {
      const match = choices.find((choice) => choice.toLocaleLowerCase() === entered.toLocaleLowerCase());
      if (!match) return toast(`The answer “${entered}” is not in the choice list.`, 'bad', 5000);
      if (!resolved.includes(match)) resolved.push(match);
    }
    if (kind === 'mcq' && resolved.length > 1) {
      return toast('Multiple choice accepts one correct answer. Use Multiple select for several.', 'bad', 5000);
    }
    answer = kind === 'multiselect' ? (resolved.length ? resolved : null) : (resolved[0] ?? null);
  } else if (kind === 'short') {
    answer = enteredAnswers.length > 1 ? enteredAnswers : (enteredAnswers[0] ?? null);
  } else if (kind === 'truefalse') {
    answer = editor.querySelector('[data-edit-tf]').value;
  }

  q.prompt = prompt;
  q.points = points;
  q.kind = kind;
  q.answer = answer;
  q.choices = kind === 'truefalse' ? ['True', 'False']
    : kind === 'mcq' || kind === 'multiselect' ? choices : [];
  q.shuffle = kind === 'mcq' || kind === 'multiselect';
  delete q._new;
  delete q._dirtyBeforeAdd;
  delete q._beforeTypeChange;
  delete q._dirtyBeforeTypeChange;
  state.bankEditing = null;
  markBankDraftChanged();
  renderBankDraft();
  toast('Question updated in the preview. Save the bank when you are ready.', 'ok');
}

function wireBankPreview() {
  $$('#bankPreview [data-bank-kind]').forEach((select) => {
    select.addEventListener('change', () => {
      const [si, qi] = select.dataset.bankKind.split(':').map(Number);
      const q = state.bankDraft.sections[si].questions[qi];
      const beforeTypeChange = cloneBank(q);
      changeQuestionKind(q, select.value);
      // Choice types need options, so open the details immediately if this was
      // converted from a text-only item.
      const needsDetails = (['mcq', 'multiselect'].includes(select.value) && q.choices.length < 2) ||
        (select.value === 'truefalse' && q.answer == null);
      if (needsDetails) {
        q._beforeTypeChange = beforeTypeChange;
        q._dirtyBeforeTypeChange = state.bankDraftDirty;
      }
      state.bankEditing = needsDetails ? `${si}:${qi}` : null;
      markBankDraftChanged();
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-edit-question]').forEach((button) => {
    button.addEventListener('click', () => {
      state.bankEditing = button.dataset.bankEditQuestion;
      state.bankEditingSection = null;
      renderBankDraft();
      $(`[data-bank-editor="${state.bankEditing}"]`)?.scrollIntoView?.({ block: 'nearest' });
    });
  });

  $$('#bankPreview [data-bank-cancel-question]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.closest('[data-bank-editor]')?.dataset.bankEditor;
      if (key) {
        const [si, qi] = key.split(':').map(Number);
        const pending = state.bankDraft.sections[si].questions[qi];
        if (pending?._new) {
          state.bankDraft.sections[si].questions.splice(qi, 1);
          state.bankDraftDirty = Boolean(pending._dirtyBeforeAdd);
          updateBankStatus();
        } else if (pending?._beforeTypeChange) {
          state.bankDraft.sections[si].questions[qi] = pending._beforeTypeChange;
          state.bankDraftDirty = Boolean(pending._dirtyBeforeTypeChange);
          updateBankStatus();
        }
      }
      state.bankEditing = null;
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-edit-kind]').forEach((select) => {
    const editor = select.closest('[data-bank-editor]');
    syncQuestionEditorFields(editor);
    select.addEventListener('change', () => syncQuestionEditorFields(editor));
  });

  $$('#bankPreview [data-bank-save-question]').forEach((button) => {
    button.addEventListener('click', () => saveQuestionEditor(button.dataset.bankSaveQuestion));
  });

  $$('#bankPreview [data-bank-delete-question]').forEach((button) => {
    button.addEventListener('click', () => {
      const [si, qi] = button.dataset.bankDeleteQuestion.split(':').map(Number);
      if (!confirm(`Delete question ${qi + 1} from this part?`)) return;
      state.bankDraft.sections[si].questions.splice(qi, 1);
      state.bankEditing = null;
      markBankDraftChanged();
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-bulk-kind]').forEach((select) => {
    select.addEventListener('change', () => {
      if (!select.value) return;
      const si = Number(select.dataset.bankBulkKind);
      const sec = state.bankDraft.sections[si];
      const label = BANK_KINDS.find(([value]) => value === select.value)?.[1] || select.value;
      if (!confirm(`Change every item in “${sec.title}” to ${label}?`)) {
        select.value = '';
        return;
      }
      sec.questions.forEach((q) => changeQuestionKind(q, select.value));
      markBankDraftChanged();
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-add-question]').forEach((button) => {
    button.addEventListener('click', () => {
      const si = Number(button.dataset.bankAddQuestion);
      const questions = state.bankDraft.sections[si].questions;
      questions.push({
        kind: 'short', prompt: '', choices: [], answer: null, points: 1, shuffle: false,
        _new: true, _dirtyBeforeAdd: state.bankDraftDirty
      });
      state.bankEditing = `${si}:${questions.length - 1}`;
      markBankDraftChanged();
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-edit-section]').forEach((button) => {
    button.addEventListener('click', () => {
      state.bankEditingSection = Number(button.dataset.bankEditSection);
      state.bankEditing = null;
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-cancel-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const editor = button.closest('[data-bank-section-editor]');
      const si = Number(editor?.dataset.bankSectionEditor);
      const sec = state.bankDraft.sections[si];
      if (sec?._new) {
        state.bankDraft.sections.splice(si, 1);
        state.bankDraftDirty = Boolean(sec._dirtyBeforeAdd);
        updateBankStatus();
      }
      state.bankEditingSection = null;
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-save-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const si = Number(button.dataset.bankSaveSection);
      const editor = $(`[data-bank-section-editor="${si}"]`);
      const title = editor.querySelector('[data-edit-section-title]').value.trim();
      if (!title) return toast('A part needs a title.', 'bad');
      state.bankDraft.sections[si].title = title;
      state.bankDraft.sections[si].instructions = editor.querySelector('[data-edit-section-instructions]').value.trim();
      delete state.bankDraft.sections[si]._new;
      delete state.bankDraft.sections[si]._dirtyBeforeAdd;
      state.bankEditingSection = null;
      markBankDraftChanged();
      renderBankDraft();
    });
  });

  $$('#bankPreview [data-bank-delete-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const si = Number(button.dataset.bankDeleteSection);
      const sec = state.bankDraft.sections[si];
      if (!confirm(`Delete “${sec.title}” and its ${sec.questions.length} questions?`)) return;
      state.bankDraft.sections.splice(si, 1);
      state.bankEditingSection = null;
      markBankDraftChanged();
      renderBankDraft();
    });
  });
}

$('#addBankSection').addEventListener('click', () => {
  if (!state.bankDraft) {
    state.bankDraft = { title: state.settings?.exam_title || 'Untitled Exam', sections: [] };
  }
  state.bankDraft.sections.push({
    title: `Part ${state.bankDraft.sections.length + 1}`,
    instructions: '',
    questions: [],
    lock_after: true,
    _new: true,
    _dirtyBeforeAdd: state.bankDraftDirty
  });
  state.bankEditingSection = state.bankDraft.sections.length - 1;
  markBankDraftChanged();
  renderBankDraft();
});

function validateBankDraft(draft) {
  if (!draft?.sections?.length) throw new Error('Add at least one part before saving.');
  let total = 0;
  draft.sections.forEach((sec, si) => {
    if (!String(sec.title || '').trim()) throw new Error(`Part ${si + 1} needs a title.`);
    if (!Array.isArray(sec.questions) || !sec.questions.length) {
      throw new Error(`${sec.title || `Part ${si + 1}`} has no questions.`);
    }
    sec.questions.forEach((q, qi) => {
      total++;
      const where = `${sec.title} · question ${qi + 1}`;
      if (!BANK_KIND_SET.has(q.kind)) throw new Error(`${where} has an unknown type.`);
      if (!String(q.prompt || '').trim()) throw new Error(`${where} has an empty prompt.`);
      if (!Number.isFinite(Number(q.points)) || Number(q.points) <= 0) {
        throw new Error(`${where} must be worth more than zero points.`);
      }
      if (q.kind === 'mcq' || q.kind === 'multiselect') {
        if (!Array.isArray(q.choices) || q.choices.length < 2) {
          throw new Error(`${where} needs at least two choices.`);
        }
        for (const answer of answerValues(q.answer)) {
          if (!q.choices.some((choice) => choice.toLocaleLowerCase() === answer.toLocaleLowerCase())) {
            throw new Error(`${where} has an answer key that is not in its choices.`);
          }
        }
      }
    });
  });
  if (!total) throw new Error('Add at least one question before saving.');
}

/* ------------------------------------------------------------------ start */

init();
