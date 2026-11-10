const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_teacher_token') || '';
let selected = '', examList = [], resultsGeneration = 0, progressGeneration = 0, progressTimer;
async function api(path, body) {
  const res = await fetch('/api/simple/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...(token ? { 'X-Teacher-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await res.json(); } catch { throw new Error('Could not reach the exam server.'); } if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function message(text, bad = false) { const node = $('#message'); node.textContent = text; node.className = 'neon-alert' + (bad ? ' error' : ''); }
function view(name) {
  $('#overviewView').classList.toggle('hidden', name !== 'overview');
  $('#questionsView').classList.toggle('hidden', name !== 'questions');
  $('#results').classList.toggle('hidden', name !== 'results');
  document.querySelectorAll('[data-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === name)));
}
function editor(initial = null) {
  if ($('#editors').children.length >= 100) return message('An exam can have at most 100 questions.', true);
  const box = document.createElement('div'); box.className = 'question-editor';
  const heading = document.createElement('h3'); heading.textContent = `Question ${$('#editors').children.length + 1}`; box.append(heading);
  function field(label, type, placeholder) { const l = document.createElement('label'); l.textContent = label; const input = document.createElement('input'); input.type = type; input.required = true; input.placeholder = placeholder; l.append(input); box.append(l); return input; }
  const prompt = field('Question', 'text', 'Enter your question'); prompt.className = 'prompt'; prompt.maxLength = 2000;
  if (initial) prompt.value = initial.prompt;
  const choices = initial?.choices || ['', '', '', ''];
  for (let n = 0; n < choices.length; n++) { const choice = field(`Choice ${n + 1}`, 'text', `Choice ${n + 1}`); choice.className = 'option'; choice.maxLength = 500; choice.value = choices[n]; }
  const label = document.createElement('label'); label.textContent = 'Correct choice'; const select = document.createElement('select'); select.className = 'answer';
  for (let n = 0; n < choices.length; n++) { const option = document.createElement('option'); option.value = String(n); option.textContent = `Choice ${n + 1}`; select.append(option); } if (initial) select.value = String(initial.answer); label.append(select); box.append(label);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-ghost btn-sm'; remove.textContent = 'Remove question'; remove.style.marginTop = '12px'; remove.addEventListener('click', () => { box.remove(); [...$('#editors').children].forEach((node,i) => { node.querySelector('h3').textContent = `Question ${i + 1}`; }); }); box.append(remove); $('#editors').append(box);
}
function showSelection() {
  const exam = examList.find(e => e.id === selected);
  $('#dashboardTitle').textContent = exam?.title || 'Your exams';
  $('#codeText').textContent = exam?.code || '—';
  $('#openStatus').textContent = exam ? (exam.open ? 'Exam open' : 'Exam closed') : 'No exam selected';
  $('#openStatus').className = `pill ${exam?.open ? 'pill-live' : 'pill-idle'}`;
}
function clearResults() {
  for (const selector of ['#joinedKpi', '#activeKpi', '#submittedKpi', '#averageKpi']) $(selector).textContent = '—';
  $('#resultsTitle').textContent = 'Results'; $('#resultRows').replaceChildren();
}
async function exams() {
  const data = await api('exams'); examList = data.exams;
  if (!examList.some(e => e.id === selected)) selected = examList[0]?.id || '';
  const select = $('#examSelect'); select.replaceChildren();
  if (!examList.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No exams yet'; select.append(option); }
  for (const e of examList) { const option = document.createElement('option'); option.value = e.id; option.textContent = e.title; select.append(option); }
  select.value = selected; showSelection();
  const container = $('#exams'); container.replaceChildren();
  if (!examList.length) { container.textContent = 'No exams yet. Select + New to create an exam.'; clearResults(); return; }
  for (const e of examList) {
    const row = document.createElement('div'); row.className = 'exam-row'; const details = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = e.title; const meta = document.createElement('div'); meta.className = 'muted tiny'; meta.textContent = `Code: ${e.code} · ${e.duration} minutes · ${e.open ? 'Open' : 'Closed'}`; details.append(title, meta);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm'; button.textContent = 'View results';
    button.addEventListener('click', () => { selected = e.id; select.value = selected; showSelection(); view('results'); results().catch(err => message(err.message,true)); });
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'btn btn-ghost btn-sm'; toggle.textContent = e.open ? 'Close exam' : 'Open exam';
    toggle.addEventListener('click', async () => { toggle.disabled = true; try { await api(`exams/${encodeURIComponent(e.id)}/open`, { open: !e.open }); await exams(); } catch(err) { message(err.message,true); toggle.disabled = false; } });
    const actions = document.createElement('div'); actions.className = 'row wrap'; actions.append(button,toggle); row.append(details,actions); container.append(row);
  }
  await results(); await progress();
}
async function results() {
  const examId = selected; const generation = ++resultsGeneration; clearResults();
  if (!examId) return;
  const data = await api(`exams/${encodeURIComponent(examId)}/results`);
  if (generation !== resultsGeneration || examId !== selected) return;
  $('#resultsTitle').textContent = `${data.title} · Results`;
  const done = data.results.filter(r => r.submitted_at); const totalScore = done.reduce((sum,r) => sum + (r.total ? r.score / r.total : 0), 0);
  $('#joinedKpi').textContent = data.results.length; $('#submittedKpi').textContent = done.length; $('#activeKpi').textContent = data.results.length - done.length;
  $('#averageKpi').textContent = done.length ? `${Math.round(totalScore / done.length * 100)}%` : '—';
  const tbody = $('#resultRows'); tbody.replaceChildren();
  for (const r of data.results) {
    const tr = document.createElement('tr');
    for (const text of [r.student_name, r.student_no, r.submitted_at ? 'Submitted' : 'In progress', r.submitted_at ? `${r.score} / ${r.total}` : '—']) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    const answerCell = document.createElement('td'); const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'View answers'; details.append(summary); const list = document.createElement('ol');
    for (const q of data.questions) { const item = document.createElement('li'); const answer = r.answers[q.id]; item.textContent = `${q.prompt} — ${Number.isInteger(answer) ? q.choices[answer] : 'Not answered'} (correct: ${q.choices[q.answer]})`; list.append(item); }
    details.append(list); answerCell.append(details); tr.append(answerCell); tbody.append(tr);
  }
  if (!data.results.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.textContent = 'No students have joined yet.'; tr.append(td); tbody.append(tr); }
}
async function progress() {
  const examId = selected, generation = ++progressGeneration;
  if (!examId) { $('#progressRows').textContent = 'Select an exam.'; return; }
  try {
    const data = await api(`exams/${encodeURIComponent(examId)}/progress`);
    if (generation !== progressGeneration || examId !== selected || !token) return;
    const rows = $('#progressRows'); rows.replaceChildren();
    if (!data.attempts.length) rows.textContent = 'No students have joined yet.';
    for (const attempt of data.attempts) {
      const row = document.createElement('div'); row.className = 'exam-row';
      const name = document.createElement('strong'); name.textContent = `${attempt.student_name} (${attempt.student_no})`;
      const status = document.createElement('span'); status.className = 'muted tiny';
      const state = attempt.submitted_at ? 'Submitted' : new Date(attempt.deadline).getTime() <= Date.now() ? 'Time expired' : 'Not submitted';
      status.textContent = `${attempt.answered} / ${data.total} saved · ${state}`; row.append(name, status); rows.append(row);
    }
    $('#progressStatus').textContent = 'Saved progress refreshes every 10 seconds. This does not show whether students are online or provide integrity alerts.';
  } catch (err) {
    if (generation === progressGeneration && examId === selected && token) $('#progressStatus').textContent = `Could not refresh progress: ${err.message}`;
  }
}
async function showDashboard() { const me = await api('me'); $('#auth').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); $('#welcome').textContent = `Teacher dashboard · ${me.username}`; await exams(); await progress(); clearInterval(progressTimer); progressTimer = setInterval(() => { if (!document.hidden) progress(); }, 10000); }
$('#login').addEventListener('submit', async e => { e.preventDefault(); const b = e.currentTarget.querySelector('[type=submit]'); b.disabled = true; try { const r = await api('login', { username:$('#username').value.trim(), password:$('#password').value }); token = r.token; sessionStorage.setItem('simple_teacher_token',token); $('#password').value = ''; await showDashboard(); message('Signed in.'); } catch(err) { message(err.message,true); } finally { b.disabled = false; } });
$('#register').addEventListener('click', async e => { const button = e.currentTarget; button.disabled = true; try { await api('register', { username:$('#username').value.trim(), password:$('#password').value }); message('Account created. Please sign in.'); } catch(err) { message(err.message,true); } finally { button.disabled = false; } });
$('#logout').addEventListener('click', async () => { try { await api('logout', {}); } catch {} sessionStorage.removeItem('simple_teacher_token'); token = ''; selected = ''; resultsGeneration++; progressGeneration++; clearInterval(progressTimer); $('#dashboard').classList.add('hidden'); $('#auth').classList.remove('hidden'); message('Signed out.'); });
$('#examSelect').addEventListener('change', e => { selected = e.target.value; showSelection(); $('#progressRows').textContent = 'Loading saved progress…'; progress(); results().catch(err => message(err.message,true)); });
$('#newExam').addEventListener('click', () => view('questions'));
document.querySelectorAll('[data-view]').forEach(tab => tab.addEventListener('click', () => { view(tab.dataset.view); if (tab.dataset.view === 'results') results().catch(err => message(err.message,true)); }));
$('#refreshExams').addEventListener('click', () => exams().catch(err => message(err.message,true)));
$('#addQuestion').addEventListener('click', () => editor()); $('#refreshResults').addEventListener('click', () => results().catch(err => message(err.message,true)));
$('#importText').addEventListener('input', () => $('#importPreview').replaceChildren());
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 200000) { message('File is too large; use a file under 200 KB.', true); return; }
  try { $('#importText').value = await file.text(); $('#importPreview').replaceChildren(); }
  catch { message('Could not read this file.', true); }
});
$('#previewImport').addEventListener('click', async e => {
  const button = e.currentTarget; button.disabled = true; const preview = $('#importPreview'); preview.replaceChildren();
  try {
    const data = await api('import-preview', { text: $('#importText').value });
    const info = document.createElement('p'); info.textContent = `${data.questions.length} questions found. ${data.warnings.join(' ')}`; preview.append(info);
    const list = document.createElement('ol');
    for (const q of data.questions) { const li = document.createElement('li'); li.textContent = `${q.prompt} — Correct: ${q.choices[q.answer]}`; list.append(li); }
    preview.append(list);
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn btn-primary'; apply.textContent = 'Use these questions';
    apply.addEventListener('click', () => {
      if (!confirm('Replace the questions currently in the editor with this import?')) return;
      $('#editors').replaceChildren(); for (const q of data.questions) editor(q);
      if (!$('#examTitle').value.trim() && data.title && data.title !== 'Imported Exam') $('#examTitle').value = data.title;
      preview.replaceChildren(); message('Questions added to the editor. Review them, then create the exam.');
    }); preview.append(apply);
  } catch (err) { message(err.message, true); }
  finally { button.disabled = false; }
});
$('#create').addEventListener('submit', async e => { e.preventDefault(); const button = e.currentTarget.querySelector('[type=submit]'); button.disabled = true; try { const questions = [...$('#editors').children].map(box => ({ prompt:box.querySelector('.prompt').value, choices:[...box.querySelectorAll('.option')].map(x => x.value), answer:Number(box.querySelector('.answer').value) })); const result = await api('exams', { title:$('#examTitle').value, duration:Number($('#duration').value), questions }); selected = result.id; $('#examTitle').value = ''; $('#editors').replaceChildren(); editor(); await exams(); view('overview'); message(`Exam created. Share code ${result.code} with your students.`); } catch(err) { message(err.message,true); } finally { button.disabled = false; } });
editor(); if (token) showDashboard().catch(e => { token = ''; sessionStorage.removeItem('simple_teacher_token'); message(e.message,true); });
