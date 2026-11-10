const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_teacher_token') || '';
let selected = '', examList = [], resultsGeneration = 0, progressGeneration = 0, progressTimer;
let editExamId = '', bankRevision = '', bankLocked = false, draftDirty = false, editorGeneration = 0;
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
function dirty() { draftDirty = true; editorGeneration++; $('#draftStatus').textContent = 'Unsaved changes'; }
function renumber() { document.querySelectorAll('#editors .question-editor').forEach((q,i) => { q.querySelector('h3').textContent = `Question ${i+1}`; }); }
function part(initial = null) {
  const section = document.createElement('div'); section.className = 'part-editor';
  const head = document.createElement('h3'); head.textContent = 'Part'; section.append(head);
  const titleLabel = document.createElement('label'); titleLabel.textContent = 'Part title';
  const title = document.createElement('input'); title.className='part-title'; title.required=true; title.maxLength=200; title.value=initial?.title || `Part ${$('#editors').children.length+1}`; titleLabel.append(title); section.append(titleLabel);
  const instLabel = document.createElement('label'); instLabel.textContent='Part instructions'; const instructions=document.createElement('textarea'); instructions.className='part-instructions'; instructions.maxLength=10000; instructions.value=initial?.instructions || ''; instLabel.append(instructions); section.append(instLabel);
  const timerLabel=document.createElement('label'); timerLabel.textContent='Part time limit in minutes (0 = no separate limit)'; const timer=document.createElement('input'); timer.type='number'; timer.className='part-minutes'; timer.min='0'; timer.max='600'; timer.step='1'; timer.required=true; timer.value=String(initial?.minutes ?? 0); timerLabel.append(timer); section.append(timerLabel);
  const lockLabel=document.createElement('label'); const lock=document.createElement('input'); lock.type='checkbox'; lock.className='part-lock'; lock.checked=initial?.lock_after !== false; lockLabel.append(lock,document.createTextNode(' Lock this part after leaving it (when exam option is on)')); section.append(lockLabel);
  const questions = document.createElement('div'); questions.className='part-questions'; section.append(questions);
  const add = document.createElement('button'); add.type='button'; add.className='btn btn-ghost btn-sm'; add.textContent='+ Add question to part'; add.addEventListener('click',()=>{ editor(null,section); dirty(); }); section.append(add);
  const remove = document.createElement('button'); remove.type='button'; remove.className='btn btn-ghost btn-sm'; remove.textContent='Remove part'; remove.addEventListener('click',()=>{ if (!confirm('Remove this part and all its questions?')) return; section.remove(); renumber(); dirty(); }); section.append(remove);
  $('#editors').append(section); return section;
}
function editor(initial = null, section = $('#editors .part-editor:last-child')) {
  if (document.querySelectorAll('#editors .question-editor:not(.part-editor)').length >= 100) return message('An exam can have at most 100 questions.', true);
  if (!section) section=part();
  const box=document.createElement('div'); box.className='question-editor';
  const heading=document.createElement('h3'); box.append(heading);
  function field(label, type, cls) { const l=document.createElement('label'); l.textContent=label; const input=document.createElement('input'); input.type=type; input.className=cls; l.append(input); box.append(l); return input; }
  const prompt=field('Question','text','prompt'); prompt.required=true; prompt.maxLength=10000; prompt.value=initial?.prompt || '';
  const kindLabel=document.createElement('label'); kindLabel.textContent='Question type'; const kind=document.createElement('select'); kind.className='kind';
  for (const [value,name] of [['mcq','Multiple choice'],['multiselect','Multiple answers'],['truefalse','True / False'],['short','Short answer'],['essay','Essay']]) { const opt=document.createElement('option'); opt.value=value; opt.textContent=name; kind.append(opt); } kind.value=initial?.kind || 'mcq'; kindLabel.append(kind); box.append(kindLabel);
  const points=field('Points','number','points'); points.min='0'; points.max='1000'; points.step='any'; points.required=true; points.value=String(initial?.points ?? 1);
  const shuffleLabel=document.createElement('label'); const shuffle=document.createElement('input'); shuffle.type='checkbox'; shuffle.className='question-shuffle'; shuffle.checked=initial?.shuffle !== false; shuffleLabel.append(shuffle,document.createTextNode(' Allow choices to be shuffled')); box.append(shuffleLabel);
  const optionsHost=document.createElement('div'); optionsHost.className='options-host'; box.append(optionsHost);
  const keyLabel=document.createElement('label'); keyLabel.textContent='Correct choice (select multiple for multiple answers; leave blank for manual grading)'; const select=document.createElement('select'); select.className='answer'; keyLabel.append(select); box.append(keyLabel);
  const textLabel=document.createElement('label'); textLabel.textContent='Accepted answers (separate alternatives with |; leave blank for manual grading)'; const textKey=document.createElement('input'); textKey.className='text-key'; textKey.value=Array.isArray(initial?.answer) ? initial.answer.join(' | ') : typeof initial?.answer === 'string' ? initial.answer : ''; textLabel.append(textKey); box.append(textLabel);
  const remove=document.createElement('button'); remove.type='button'; remove.className='btn btn-ghost btn-sm'; remove.textContent='Remove question'; remove.addEventListener('click',()=>{ box.remove(); renumber(); dirty(); }); box.append(remove);
  const addChoice=document.createElement('button'); addChoice.type='button'; addChoice.className='btn btn-ghost btn-sm'; addChoice.textContent='+ Add choice';
  const removeChoice=document.createElement('button'); removeChoice.type='button'; removeChoice.className='btn btn-ghost btn-sm'; removeChoice.textContent='Remove last choice'; box.append(addChoice,removeChoice);
  function refreshKey(selected = []) { select.multiple=kind.value==='multiselect'; select.replaceChildren(); if (kind.value !== 'multiselect') { const blank=document.createElement('option'); blank.value=''; blank.textContent='No key — manual grading'; select.append(blank); } [...optionsHost.querySelectorAll('.option')].forEach((_,n)=>{ const option=document.createElement('option'); option.value=String(n); option.textContent=`Choice ${n+1}`; option.selected=selected.includes(n); select.append(option); }); if (!select.multiple && !selected.length) select.value=''; }
  function choice(value='') { const label=document.createElement('label'); label.textContent=`Choice ${optionsHost.children.length+1}`; const input=document.createElement('input'); input.type='text'; input.className='option'; input.maxLength=2000; input.value=value; label.append(input); optionsHost.append(label); }
  const initialChoices = initial?.choices?.length ? initial.choices : kind.value==='truefalse' ? ['True','False'] : ['', '', '', '']; initialChoices.forEach(choice);
  let initialSelected = typeof initial?.answer === 'number' ? [initial.answer] : (Array.isArray(initial?.answer) ? initial.answer : initial?.answer == null ? [] : [initial.answer]).map(a => initialChoices.indexOf(a)).filter(n => n>=0);
  // New manually-entered MCQs start with the first option selected, as before.
  if (!initial) initialSelected=[0]; refreshKey(initialSelected);
  function updateKind() { const choiceKind=['mcq','multiselect','truefalse'].includes(kind.value); optionsHost.classList.toggle('hidden',!choiceKind); keyLabel.classList.toggle('hidden',!choiceKind); textLabel.classList.toggle('hidden',kind.value!=='short'); addChoice.classList.toggle('hidden',!choiceKind || kind.value==='truefalse'); removeChoice.classList.toggle('hidden',!choiceKind || kind.value==='truefalse'); optionsHost.querySelectorAll('input').forEach(i=>{i.required=choiceKind; i.disabled=!choiceKind || kind.value==='truefalse';}); textKey.disabled=kind.value!=='short'; select.disabled=!choiceKind; }
  kind.addEventListener('change',()=>{ if (kind.value==='truefalse') { optionsHost.replaceChildren(); choice('True'); choice('False'); } else if (['mcq','multiselect'].includes(kind.value) && optionsHost.children.length<2) { optionsHost.replaceChildren(); choice(); choice(); } refreshKey([]); updateKind(); });
  addChoice.addEventListener('click',()=>{if(optionsHost.children.length>=20)return message('At most 20 choices.',true); const selected=[...select.selectedOptions].map(o=>Number(o.value)); choice(); refreshKey(selected); updateKind(); dirty();});
  removeChoice.addEventListener('click',()=>{if(optionsHost.children.length<=2)return message('At least 2 choices are required.',true); const selected=[...select.selectedOptions].filter(o=>o.value!=='').map(o=>Number(o.value)); optionsHost.lastElementChild.remove(); refreshKey(selected.filter(n=>n<optionsHost.children.length)); dirty();});
  updateKind(); section.querySelector('.part-questions').append(box); renumber();
}
function readSections() {
  return [...$('#editors').children].map(section => ({ title:section.querySelector('.part-title').value, instructions:section.querySelector('.part-instructions').value, lock_after:section.querySelector('.part-lock').checked, minutes:Number(section.querySelector('.part-minutes').value),
    questions:[...section.querySelector('.part-questions').children].map(box => {
      const kind=box.querySelector('.kind').value, choices=['mcq','multiselect','truefalse'].includes(kind) ? [...box.querySelectorAll('.option')].map(x=>x.value.trim()) : [];
      const select=box.querySelector('.answer'), chosen=[...select.selectedOptions].filter(o=>o.value!=='').map(o=>choices[Number(o.value)]);
      let answer=kind==='multiselect' ? (chosen.length ? chosen : null) : ['mcq','truefalse'].includes(kind) ? (chosen[0] ?? null) : kind==='short' ? (box.querySelector('.text-key').value.split('|').map(x=>x.trim()).filter(Boolean)) : null;
      if (kind==='short') answer=answer.length ? (answer.length===1 ? answer[0] : answer) : null;
      return {kind,prompt:box.querySelector('.prompt').value,points:Number(box.querySelector('.points').value),choices,answer,shuffle:box.querySelector('.question-shuffle').checked};
    }) }));
}
function loadSections(sections) { $('#editors').replaceChildren(); for (const s of sections) { const node=part(s); for(const q of s.questions) editor(q,node); } }
function groupedQuestions(qs) {
  const sections=[]; for(const q of qs) { const index=q.section?.index ?? 0; if(!sections[index]) sections[index]={title:q.section?.title || 'Part 1',instructions:q.section?.instructions || '',minutes:q.section?.minutes ?? 0,lock_after:q.section?.lock_after ?? false,questions:[]}; sections[index].questions.push(q); } return sections.filter(Boolean);
}
function newDraft() {
  editExamId = ''; bankRevision = ''; bankLocked = false; draftDirty = false; editorGeneration++;
  $('#examTitle').value = ''; $('#duration').value = 60; $('#lockSections').checked=false; $('#shuffleQuestions').checked=false; $('#shuffleChoices').checked=false; $('#editors').replaceChildren(); editor(null,part());
  $('#bankMode').textContent = 'Creating a new exam. Configure parts and exam options below.';
  $('#draftStatus').textContent = 'New exam draft'; $('#saveBank').textContent = 'Create exam'; $('#saveBank').disabled = false;
}
async function loadBank() {
  if (!selected) return message('Select an exam first.', true);
  if (draftDirty && !confirm('Discard unsaved question edits and reload the selected exam?')) return;
  const examId = selected, generation = ++editorGeneration;
  const data = await api(`exams/${encodeURIComponent(examId)}/bank`);
  if (generation !== editorGeneration || examId !== selected || !token) return;
  editExamId = examId; bankRevision = data.revision; bankLocked = data.locked; draftDirty = false;
  $('#examTitle').value = data.title; $('#duration').value = data.duration; $('#lockSections').checked=data.lock_sections; $('#shuffleQuestions').checked=data.shuffle_questions; $('#shuffleChoices').checked=data.shuffle_choices; loadSections(groupedQuestions(data.questions));
  $('#bankMode').textContent = data.locked ? `Viewing ${data.title}. This exam has attempts and cannot be edited; create a new exam instead.` : `Editing ${data.title}. Saving replaces this exam's question bank.`;
  $('#draftStatus').textContent = data.locked ? 'Question bank locked' : 'Saved bank loaded';
  $('#saveBank').textContent = 'Save question bank'; $('#saveBank').disabled = data.locked;
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
  const done = data.results.filter(r => r.submitted_at); const final = done.filter(r => !r.pending); const totalScore = final.reduce((sum,r) => sum + (r.total ? r.score / r.total : 0), 0);
  $('#joinedKpi').textContent = data.results.length; $('#submittedKpi').textContent = done.length; $('#activeKpi').textContent = data.results.length - done.length;
  $('#averageKpi').textContent = final.length ? `${Math.round(totalScore / final.length * 100)}%` : '—';
  const tbody = $('#resultRows'); tbody.replaceChildren();
  for (const r of data.results) {
    const tr = document.createElement('tr');
    for (const text of [r.student_name, r.student_no, r.submitted_at ? (r.pending ? 'Needs grading' : 'Submitted') : 'In progress', r.submitted_at ? `${r.score} / ${r.total}${r.pending ? ` (${r.pending} pending)` : ''}` : '—']) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    const answerCell = document.createElement('td'); const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'View answers and grade'; details.append(summary); const list = document.createElement('ol');
    for (const q of data.questions) {
      const item = document.createElement('li'), answer = r.answers[q.id];
      const display = Array.isArray(answer) ? answer.map(n=>q.choices[n]).join(', ') : Number.isInteger(answer) ? q.choices[answer] : answer || 'Not answered';
      const expected = q.kind ? (Array.isArray(q.answer) ? q.answer.join(', ') : q.answer ?? 'Manual grading') : q.choices[q.answer];
      const description=document.createElement('div'); description.textContent=`${q.prompt} — ${display} (key: ${expected})`; item.append(description);
      if (r.submitted_at) {
        const label=document.createElement('label'); label.textContent=`Award points (0–${q.points ?? 1}) `; const points=document.createElement('input'); points.type='number'; points.min='0'; points.max=String(q.points ?? 1); points.step='any'; points.style.width='80px'; const prior=r.manual_scores?.[q.id]; points.value=prior ? String(prior.points) : ''; label.append(points); item.append(label);
        const button=document.createElement('button'); button.type='button'; button.className='btn btn-ghost btn-sm'; button.textContent='Save grade'; button.addEventListener('click',async()=>{ if(points.value === '' || !points.checkValidity()) return message('Enter a valid grade.',true); button.disabled=true; try { await api(`exams/${encodeURIComponent(examId)}/grade`,{attemptId:r.attempt_id,questionId:q.id,points:Number(points.value)}); await results(); message('Grade saved.'); } catch(err){ message(err.message,true); button.disabled=false; } }); item.append(button);
      }
      list.append(item);
    }
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
$('#logout').addEventListener('click', async () => { try { await api('logout', {}); } catch {} sessionStorage.removeItem('simple_teacher_token'); token = ''; selected = ''; resultsGeneration++; progressGeneration++; clearInterval(progressTimer); newDraft(); $('#importText').value = ''; $('#importPreview').replaceChildren(); $('#dashboard').classList.add('hidden'); $('#auth').classList.remove('hidden'); message('Signed out.'); });
$('#examSelect').addEventListener('change', e => { selected = e.target.value; editorGeneration++; showSelection(); $('#progressRows').textContent = 'Loading saved progress…'; progress(); results().catch(err => message(err.message,true)); });
$('#newExam').addEventListener('click', () => { if (draftDirty && !confirm('Discard unsaved question edits and start a new exam?')) return; newDraft(); view('questions'); });
$('#loadBank').addEventListener('click', () => loadBank().catch(err => message(err.message,true)));
$('#showFormat').addEventListener('click', () => $('#formatHelp').classList.toggle('hidden'));
$('#create').addEventListener('input', dirty); $('#create').addEventListener('change', dirty);
document.querySelectorAll('[data-view]').forEach(tab => tab.addEventListener('click', () => { view(tab.dataset.view); if (tab.dataset.view === 'results') results().catch(err => message(err.message,true)); }));
$('#refreshExams').addEventListener('click', () => exams().catch(err => message(err.message,true)));
$('#addQuestion').addEventListener('click', () => { editor(); dirty(); });
$('#addPart').addEventListener('click', () => { const p=part(); editor(null,p); dirty(); }); $('#refreshResults').addEventListener('click', () => results().catch(err => message(err.message,true)));
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
    const text = $('#importText').value; const data = await api('import-preview', { text });
    if (text !== $('#importText').value || !token) return;
    const info = document.createElement('p'); info.textContent = `${data.sections.reduce((n,s)=>n+s.questions.length,0)} questions in ${data.sections.length} parts. ${data.warnings.join(' ')} Review part timers and locking before saving.`; preview.append(info);
    for(const section of data.sections) { const h=document.createElement('strong'); h.textContent=section.title; preview.append(h); const list=document.createElement('ol'); for(const q of section.questions) { const li=document.createElement('li'); li.textContent=`${q.prompt} (${q.kind}, ${q.points} points) — Correct: ${q.answer == null ? 'manual grading' : Array.isArray(q.answer) ? q.answer.join(', ') : q.answer}`; list.append(li); } preview.append(list); }
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn btn-primary'; apply.textContent = 'Use these questions';
    apply.addEventListener('click', () => {
      if (!confirm('Replace the questions currently in the editor with this import?')) return;
      loadSections(data.sections); dirty();
      if (!$('#examTitle').value.trim() && data.title && data.title !== 'Imported Exam') $('#examTitle').value = data.title;
      preview.replaceChildren(); message('Questions added to the editor. Review them, then save.');
    }); preview.append(apply);
  } catch (err) { message(err.message, true); }
  finally { button.disabled = false; }
});
$('#create').addEventListener('submit', async e => {
  e.preventDefault(); if (bankLocked) return;
  const form = e.currentTarget, button = $('#saveBank');
  const payload = { title:$('#examTitle').value, duration:Number($('#duration').value), sections:readSections(), lock_sections:$('#lockSections').checked, shuffle_questions:$('#shuffleQuestions').checked, shuffle_choices:$('#shuffleChoices').checked };
  const editing = editExamId, currentToken = token;
  const controls = [...form.elements, $('#newExam'), $('#loadBank'), $('#previewImport'), $('#importFile')];
  controls.forEach(c => { c.disabled = true; });
  try {
    const result = editing ? await api(`exams/${encodeURIComponent(editing)}/bank`, { ...payload, revision:bankRevision }) : await api('exams', payload);
    if (token !== currentToken) return;
    selected = result.id; newDraft(); await exams(); view('overview');
    message(editing ? 'Question bank saved.' : `Exam created. Share code ${result.code} with your students.`);
  } catch(err) { message(err.message,true); }
  finally { controls.forEach(c => { c.disabled = false; }); button.disabled = bankLocked; }
});
newDraft(); if (token) showDashboard().catch(e => { token = ''; sessionStorage.removeItem('simple_teacher_token'); message(e.message,true); });
