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
  filter: 'all',
  search: '',
  tab: 'live',
  sse: null,
  poll: null,
  lastFeedAt: 0,
  drawerToken: null
};

/* ==================================================================== auth */

async function init() {
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
  loadSettings();
  loadExam();
  refreshResults();
  setInterval(() => paintRoster(state.roster), 1000); // keep "ago" labels fresh
}

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
  ['live', 'results', 'setup'].forEach((t) =>
    $(`#tab-${t}`).classList.toggle('hidden', t !== name));
  if (name === 'results') refreshResults();
  if (name === 'setup') loadSettings();
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
  $('#rosterCount').textContent = `${s.total} joined`;
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

  $('#kpis').innerHTML = [
    { l: 'Online now', v: s.online, sub: `${s.inProgress} in progress`, c: 'var(--ok)' },
    { l: 'Joined', v: s.total, sub: `${s.paperTotal} questions each`, c: 'var(--brand)' },
    { l: 'Submitted', v: s.submitted, sub: s.total ? `${Math.round((s.submitted / s.total) * 100)}% of class` : '—', c: 'var(--violet)' },
    { l: 'Average progress', v: `${Math.round(s.averageProgress * 100)}%`, sub: 'of those still writing', c: 'var(--info)' },
    { l: 'Needs grading', v: s.needsManual, sub: 'essay / manual items', c: 'var(--warn)' },
    { l: 'Integrity flags', v: s.flagged, sub: `${s.violations} total events`, c: 'var(--bad)' },
    { l: 'Average score', v: s.averagePercent === null ? '—' : `${s.averagePercent}%`,
      sub: s.highest === null ? 'no submissions yet' : `high ${s.highest}% · low ${s.lowest}%`, c: 'var(--ok)' }
  ].map((k) => `
    <div class="kpi" style="--accent:${k.c}">
      <div class="kpi-label">${k.l}</div>
      <div class="kpi-value">${k.v}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');

  paintStudents(data.students);
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

async function loadSettings() {
  try {
    const s = await api('/api/teacher/settings');
    state.settings = s;
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
  } catch (err) {
    if (err.status === 401) showLogin();
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

$('#saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/teacher/settings', { method: 'POST', body: collectSettings() });
    toast('Exam details saved.', 'ok');
    loadSettings();
  } catch (err) { toast(err.message, 'bad'); }
});

$('#saveSecurity').addEventListener('click', async () => {
  try {
    await api('/api/teacher/settings', { method: 'POST', body: collectSettings() });
    toast('Anti-cheating controls saved.', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
});

$('#sOpen').addEventListener('change', async (e) => {
  try {
    await api('/api/teacher/settings', { method: 'POST', body: { exam_open: e.target.checked } });
    toast(e.target.checked ? 'Exam opened to students.' : 'Exam closed — no new entries.', e.target.checked ? 'ok' : 'warn');
  } catch (err) { toast(err.message, 'bad'); e.target.checked = !e.target.checked; }
});

$('#newCode').addEventListener('click', async () => {
  try {
    const s = await api('/api/teacher/settings', { method: 'POST', body: { new_access_code: true } });
    $('#codeText').textContent = s.access_code;
    toast(`New access code: ${s.access_code}`, 'ok');
  } catch (err) { toast(err.message, 'bad'); }
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

# Part II. True or False
Write TRUE or FALSE.

3. Water boils at 100 °C at sea level.
Ans: TRUE

# Part III. Identification

4. What is the chemical symbol for gold?
Ans: Au | gold

# Part IV. Essay
5. Explain why the sky appears blue. //  [10]`;

$('#loadSampleText').addEventListener('click', () => {
  const help = $('#formatHelp');
  help.style.display = help.style.display === 'none' ? 'block' : 'none';
  $('#formatSample').textContent = SAMPLE_FORMAT;
});

async function loadExam() {
  try {
    const data = await api('/api/teacher/exam');
    $('#bankCount').textContent =
      `${data.counts.sections} parts · ${data.counts.questions} items · ${data.counts.points} pts`;
    if (!$('#bankText').value.trim()) $('#bankText').value = data.text;
    paintPreview(data.blueprint, []);
  } catch { /* not signed in yet */ }
}

$('#loadCurrent').addEventListener('click', async () => {
  const data = await api('/api/teacher/exam');
  $('#bankText').value = data.text;
  paintPreview(data.blueprint, []);
  toast('Current question bank loaded into the editor.', 'ok');
});

$('#previewBank').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/teacher/parse', {
      method: 'POST',
      headers: {
        'X-Teacher-Token': localStorage.getItem('rvm_teacher_token'),
        'Content-Type': 'text/plain'
      },
      body: $('#bankText').value
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read that text.');
    paintPreview(data.sections, data.warnings || []);
    toast(`Read ${data.counts.questions} items in ${data.counts.sections} parts (${data.counts.points} pts).`, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('#importBank').addEventListener('click', async () => {
  if (!confirm('Replace the entire question bank with this text?\n\nExisting submitted attempts keep the paper they started with.')) return;
  try {
    const res = await fetch('/api/teacher/exam', {
      method: 'POST',
      headers: {
        'X-Teacher-Token': localStorage.getItem('rvm_teacher_token'),
        'Content-Type': 'text/plain'
      },
      body: $('#bankText').value
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed.');
    toast(`Imported ${data.counts.questions} items.`, 'ok');
    paintPreview((await api('/api/teacher/exam')).blueprint, data.warnings || []);
    loadExam();
    refreshResults();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

function paintPreview(sections, warnings) {
  $('#bankWarnings').innerHTML = warnings?.length
    ? `<div class="warn-box"><b>${warnings.length} thing(s) to check</b><ul>
        ${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : '';

  $('#bankPreview').innerHTML = sections.length ? sections.map((sec) => `
    <div class="bp-sec">
      <h4>${escapeHtml(sec.title)} <span class="tiny muted">· ${sec.questions.length} items ·
        ${sec.questions.reduce((n, q) => n + Number(q.points || 0), 0)} pts</span></h4>
      ${sec.instructions ? `<div class="tiny muted" style="margin-top:3px">${escapeHtml(sec.instructions)}</div>` : ''}
      ${sec.questions.slice(0, 6).map((q, i) => `
        <div class="bp-q"><span class="n">${i + 1}.</span>
          <span>${escapeHtml(truncate(q.prompt, 100))}
            <span class="tiny muted"> · ${q.kind}${q.answer === null || q.answer === undefined ? ' · no key' : ''}</span>
          </span></div>`).join('')}
      ${sec.questions.length > 6 ? `<div class="tiny muted" style="padding-top:6px">+ ${sec.questions.length - 6} more</div>` : ''}
    </div>`).join('') : '<div class="feed-empty">Nothing to show yet.</div>';
}

/* ------------------------------------------------------------------ start */

init();
