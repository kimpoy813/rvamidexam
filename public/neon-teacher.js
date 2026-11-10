const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_teacher_token') || '';
let selected = '', examList = [], resultsGeneration = 0, progressGeneration = 0, progressTimer;
let currentProgress = null, currentResults = null, feedClearedAt = 0, feedExam = '', integrityGeneration=0, integrityDirty=false, loadedIntegrityExam='', detailsDirty=false, loadedDetailsExam='', detailsRevision='', detailsGeneration=0;
let editExamId = '', bankRevision = '', bankLocked = false, draftDirty = false, editorGeneration = 0, pasteSource = '', textDirty = false;
async function api(path, body) {
  const res = await fetch('/api/simple/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...(token ? { 'X-Teacher-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await res.json(); } catch { throw new Error('Could not reach the exam server.'); } if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function message(text, bad = false) { const node = $('#message'); node.textContent = text; node.className = 'neon-alert' + (bad ? ' error' : ''); }
function view(name) {
  $('#overviewView').classList.toggle('hidden', name !== 'overview');
  $('#questionsView').classList.toggle('hidden', name !== 'questions');
  $('#setupView').classList.toggle('hidden', name !== 'setup');
  $('#results').classList.toggle('hidden', name !== 'results');
  document.querySelectorAll('[data-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === name)));
}
function bankStatus() {
  $('#draftStatus').textContent = textDirty ? 'Pasted text changed — preview it before saving.' : bankLocked ? 'Question bank locked' : draftDirty ? 'Unsaved question-bank changes.' : editExamId ? 'Saved bank loaded' : 'New exam draft';
  $('#pasteStatus').textContent = textDirty ? 'New text is waiting to be parsed.' : editExamId && !draftDirty ? 'The saved bank is shown below.' : 'Preview ready. Check each type and answer key below.';
  $('.bank-savebar').classList.toggle('is-stale',textDirty); $('.bank-savebar').classList.toggle('is-dirty',draftDirty && !textDirty);
}
function dirty() { draftDirty = true; editorGeneration++; bankStatus(); }
function counts() {
  let items=0, points=0; const sections=[...$('#editors').children];
  sections.forEach(section=>{const questions=[...section.querySelector('.part-questions').children]; const sum=questions.reduce((n,q)=>n+(Number(q.querySelector('.points').value)||0),0); items+=questions.length; points+=sum; section.querySelector('.bp-sec-summary').textContent=`${questions.length} items · ${sum} pts`; });
  $('#bankCount').textContent=`${sections.length} parts · ${items} items · ${Math.round(points*1000)/1000} pts`;
}
function renumber() { document.querySelectorAll('#editors .part-editor').forEach(section=>[...section.querySelector('.part-questions').children].forEach((q,i)=>{ q.querySelector('h3').textContent=String(i+1); })); counts(); }
function part(initial = null) {
  const section=document.createElement('section'); section.className='part-editor bp-sec';
  const header=document.createElement('div'); header.className='bp-sec-head'; const nameWrap=document.createElement('div'); const name=document.createElement('h4'); const summary=document.createElement('div'); summary.className='tiny muted bp-sec-summary'; nameWrap.append(name,summary); header.append(nameWrap);
  const spacer=document.createElement('div'); spacer.className='spacer'; header.append(spacer); const tools=document.createElement('div'); tools.className='bp-sec-tools';
  const bulk=document.createElement('select'); bulk.setAttribute('aria-label','Set every question type in part');
  for (const [value,label] of [['','Set every item type…'],['mcq','Multiple choice'],['multiselect','Multiple answers'],['truefalse','True / False'],['short','Short answer'],['essay','Essay']]) {const option=document.createElement('option');option.value=value;option.textContent=label;bulk.append(option);}
  bulk.addEventListener('change',()=>{if(!bulk.value)return;const next=bulk.value;bulk.value='';if(!confirm('Change every question type in this part? Answer keys may need to be re-entered.'))return;for(const q of section.querySelectorAll('.question-editor')) { const type=q.querySelector('.kind'); if(type.value!==next){type.value=next;type.dispatchEvent(new window.Event('change',{bubbles:true}));} } });
  const edit=document.createElement('button');edit.type='button';edit.className='btn btn-ghost btn-sm';edit.textContent='Edit part';tools.append(bulk,edit);header.append(tools);section.append(header);
  const directions=document.createElement('div');directions.className='bp-sec-instructions';section.append(directions);
  const panel=document.createElement('div'); panel.className='bp-section-editor hidden';section.append(panel);
  const titleLabel=document.createElement('label');titleLabel.textContent='Part title';const title=document.createElement('input');title.className='part-title';title.required=true;title.maxLength=200;title.value=initial?.title || `Part ${$('#editors').children.length+1}`;titleLabel.append(title);panel.append(titleLabel);
  const instLabel=document.createElement('label');instLabel.textContent='Directions shown to students';const instructions=document.createElement('textarea');instructions.className='part-instructions';instructions.maxLength=10000;instructions.value=initial?.instructions || '';instLabel.append(instructions);panel.append(instLabel);
  const timerLabel=document.createElement('label');timerLabel.textContent='Part time limit in minutes (0 = no separate limit)';const timer=document.createElement('input');timer.type='number';timer.className='part-minutes';timer.min='0';timer.max='600';timer.step='1';timer.required=true;timer.value=String(initial?.minutes ?? 0);timerLabel.append(timer);panel.append(timerLabel);
  const lockLabel=document.createElement('label');const lock=document.createElement('input');lock.type='checkbox';lock.className='part-lock';lock.checked=initial?.lock_after !== false;lockLabel.append(lock,document.createTextNode(' Lock this part after leaving it (when exam option is on)'));panel.append(lockLabel);
  const done=document.createElement('button');done.type='button';done.className='btn btn-primary btn-sm';done.textContent='Done';done.addEventListener('click',()=>{panel.classList.add('hidden');edit.setAttribute('aria-expanded','false');});panel.append(done);
  const remove=document.createElement('button');remove.type='button';remove.className='btn btn-danger btn-sm';remove.textContent='Delete part';remove.addEventListener('click',()=>{if(!confirm('Remove this part and all its questions?'))return;section.remove();renumber();dirty();});panel.append(remove);
  edit.setAttribute('aria-expanded','false');edit.addEventListener('click',()=>{const open=panel.classList.toggle('hidden');edit.setAttribute('aria-expanded',String(!open));});
  const refresh=()=>{name.textContent=title.value || 'Untitled part';directions.textContent=instructions.value ? `Directions: ${instructions.value}` : '';directions.classList.toggle('hidden',!instructions.value);};title.addEventListener('input',refresh);instructions.addEventListener('input',refresh);refresh();
  const questions=document.createElement('div');questions.className='part-questions bp-question-list';section.append(questions);
  const add=document.createElement('button');add.type='button';add.className='btn btn-ghost btn-sm bp-add-question';add.textContent='+ Add question';add.addEventListener('click',()=>{editor(null,section);dirty();});section.append(add);
  $('#editors').append(section);counts();return section;
}
function editor(initial = null, section = $('#editors .part-editor:last-child')) {
  if (document.querySelectorAll('#editors .question-editor:not(.part-editor)').length >= 100) return message('An exam can have at most 100 questions.', true);
  if (!section) section=part();
  const box=document.createElement('div'); box.className='question-editor bp-q';
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
  updateKind();
  // Keep the editable controls as the source of truth while presenting the
  // same compact student-response preview used by the Render dashboard.
  const panel=document.createElement('div'); panel.className='bp-editor';
  for (const node of [...box.children]) if(node!==heading) panel.append(node);
  panel.classList.toggle('hidden',!!initial);
  const head=document.createElement('div'); head.className='bp-q-head'; heading.className='n'; head.append(heading);
  const quick=kind.cloneNode(true); quick.className='bp-kind-select'; quick.value=kind.value; quick.setAttribute('aria-label','Question type'); head.append(quick);
  const pointLabel=document.createElement('span');pointLabel.className='bp-points';head.append(pointLabel);
  const spacer=document.createElement('div');spacer.className='spacer';head.append(spacer);
  const toggle=document.createElement('button');toggle.type='button';toggle.className='btn btn-ghost btn-sm';toggle.textContent='Edit';toggle.setAttribute('aria-expanded',String(!initial));toggle.addEventListener('click',()=>{const hidden=panel.classList.toggle('hidden');toggle.setAttribute('aria-expanded',String(!hidden));});head.append(toggle);
  const promptView=document.createElement('div');promptView.className='bp-prompt';const response=document.createElement('div');response.className='bp-response';const answerView=document.createElement('div');answerView.className='bp-answer';
  box.prepend(head);box.append(promptView,response,answerView,panel);
  const renderPreview=()=>{
    quick.value=kind.value;pointLabel.textContent=`${points.value || 0} pts`;promptView.textContent=prompt.value || 'Enter a question';response.replaceChildren();
    const chosen=[...select.selectedOptions].filter(o=>o.value!=='').map(o=>Number(o.value)); const choices=[...optionsHost.querySelectorAll('.option')].map(x=>x.value);
    const text=kind.value==='short' ? textKey.value.trim() : kind.value==='essay' ? '' : chosen.map(i=>choices[i]).filter(Boolean).join(' / ');
    if(kind.value==='short' || kind.value==='essay'){const placeholder=document.createElement('div');placeholder.className=`bp-student-input${kind.value==='essay' ? ' essay' : ''}`;placeholder.textContent=kind.value==='essay' ? 'Student writes a long response…' : 'Student types a short answer…';response.append(placeholder);}
    else {const list=document.createElement('div');list.className=kind.value==='truefalse' ? 'bp-tf' : 'bp-choice-list';choices.forEach((value,i)=>{const row=document.createElement('div');row.className=kind.value==='truefalse' ? `bp-tf-option${chosen.includes(i) ? ' is-key' : ''}` : `bp-choice${chosen.includes(i) ? ' is-key' : ''}`; if(kind.value!=='truefalse'){const letter=document.createElement('span');letter.className='bp-choice-key';letter.textContent=String.fromCharCode(65+i);row.append(letter);} const label=document.createElement('span');label.className='grow';label.textContent=value || `Choice ${i+1}`;row.append(label);if(chosen.includes(i)){const key=document.createElement('span');key.className='tiny';key.textContent='✓ key';row.append(key);}list.append(row);});response.append(list);}
    answerView.classList.toggle('no-key',!text);answerView.replaceChildren();const label=document.createElement('b');label.textContent=text ? '✓ Answer key' : '⚠ No key';const value=document.createElement('span');value.textContent=text || 'This item will need manual grading.';answerView.append(label,value);
  };
  box.addEventListener('input',renderPreview);box.addEventListener('change',renderPreview);
  quick.addEventListener('change',()=>{ if(quick.value!==kind.value && !confirm('Change this question type? Review the answer key afterward.')){quick.value=kind.value;return;} kind.value=quick.value;kind.dispatchEvent(new window.Event('change',{bubbles:true})); });
  addChoice.addEventListener('click',renderPreview);removeChoice.addEventListener('click',renderPreview);renderPreview();
  section.querySelector('.part-questions').append(box); renumber();
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
  editExamId = ''; bankRevision = ''; bankLocked = false; draftDirty = false; textDirty = false; pasteSource = ''; editorGeneration++; $('#importText').value=''; $('#importPreview').replaceChildren(); $('#examSettings').open=true;
  $('#examTitle').value = ''; $('#duration').value = 60; $('#lockSections').checked=false; $('#shuffleQuestions').checked=false; $('#shuffleChoices').checked=false; $('#editors').replaceChildren(); editor(null,part());
  $('#bankMode').textContent = 'Creating a new exam. Configure parts and exam options below.';
  $('#saveBank').textContent = 'Create exam'; $('#saveBank').disabled = false; bankStatus();
}
async function loadBank({ confirmed=false } = {}) {
  if (!selected) return message('Select an exam first.', true);
  if (!confirmed && (draftDirty || textDirty) && !confirm('Discard unsaved pasted text and question edits, then reload the saved bank?')) return;
  const examId = selected, generation = ++editorGeneration;
  const data = await api(`exams/${encodeURIComponent(examId)}/bank`);
  if (generation !== editorGeneration || examId !== selected || !token) return;
  editExamId = examId; bankRevision = data.revision; bankLocked = data.locked; draftDirty = false; textDirty=false; pasteSource=data.text; $('#importText').value=data.text; $('#importPreview').replaceChildren(); $('#examSettings').open=false;
  $('#examTitle').value = data.title; $('#duration').value = data.duration; $('#lockSections').checked=data.lock_sections; $('#shuffleQuestions').checked=data.shuffle_questions; $('#shuffleChoices').checked=data.shuffle_choices; loadSections(groupedQuestions(data.questions));
  $('#bankMode').textContent = data.locked ? `Viewing ${data.title}. This exam has attempts and cannot be edited; create a new exam instead.` : `Editing ${data.title}. Saving replaces this exam's question bank.`;
  $('#saveBank').textContent = 'Save question bank'; $('#saveBank').disabled = data.locked; bankStatus();
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
  currentResults=null; $('#releaseResults').disabled=true; $('#releaseStatus').textContent='Results hidden'; $('#resultsTitle').textContent = 'Scoreboard'; $('#resultRows').replaceChildren(); $('#itemRows').replaceChildren(); $('#hardItems').textContent='No assessed answers yet.'; $('#distribution').replaceChildren(); for(const id of ['resSubmitted','resAverage','resHighest','resLowest','resPassing','resPending']) $('#'+id).textContent='—'; $('#resMedian').textContent='median —';
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
    button.addEventListener('click', () => { selected = e.id; currentProgress=null; select.value = selected; showSelection(); progress(); view('results'); results().catch(err => message(err.message,true)); });
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'btn btn-ghost btn-sm'; toggle.textContent = e.open ? 'Close exam' : 'Open exam';
    toggle.addEventListener('click', async () => { toggle.disabled = true; try { await api(`exams/${encodeURIComponent(e.id)}/open`, { open: !e.open }); await exams(); } catch(err) { message(err.message,true); toggle.disabled = false; } });
    const duplicate=document.createElement('button');duplicate.type='button';duplicate.className='btn btn-ghost btn-sm';duplicate.textContent='Duplicate';
    duplicate.addEventListener('click',async()=>{if((draftDirty || textDirty) && !confirm('Discard unsaved question-bank changes and open the copied exam?'))return;if(integrityDirty && !confirm('Discard unsaved integrity settings?'))return;if(detailsDirty && !confirm('Discard unsaved exam details?'))return;duplicate.disabled=true;const generation=editorGeneration;try{const copy=await api(`exams/${encodeURIComponent(e.id)}/duplicate`,{});if(editorGeneration!==generation){await exams();message('Exam copied as a closed exam. Your newer draft was kept.');return;}selected=copy.id;newDraft();await exams();await Promise.all([loadIntegritySettings(),loadDetails()]);message('Exam copied as a closed exam.');}catch(err){message(err.message,true);duplicate.disabled=false;}});
    const reset=document.createElement('button');reset.type='button';reset.className='btn btn-danger btn-sm';reset.textContent='Clear attempts';
    reset.addEventListener('click',async()=>{if(!confirm(`Delete ALL attempts, answers, grades, and result keys for “${e.title}”? Score release will be turned off. This cannot be undone.`)||!confirm('Are you sure? Export results first if you need them.'))return;reset.disabled=true;try{const r=await api(`exams/${encodeURIComponent(e.id)}/reset-attempts`,{});await exams();message(`Deleted ${r.removed} attempt(s). Reload the saved bank to edit it.`);}catch(err){message(err.message,true);reset.disabled=false;}});
    const remove=document.createElement('button');remove.type='button';remove.className='btn btn-danger btn-sm';remove.textContent='Delete exam';
    remove.addEventListener('click',async()=>{if(editExamId===e.id && (draftDirty||textDirty) && !confirm('Discard unsaved question-bank changes?'))return;if(!confirm(`Permanently delete “${e.title}” and ALL its attempts and results?`) || !confirm('This cannot be undone. Delete the exam and its data?'))return;remove.disabled=true;const generation=editorGeneration;try{await api(`exams/${encodeURIComponent(e.id)}/delete`,{});if(editExamId===e.id){if(generation===editorGeneration)newDraft();else{editExamId='';bankRevision='';bankLocked=false;draftDirty=true;$('#saveBank').disabled=false;$('#saveBank').textContent='Create exam';$('#bankMode').textContent='The original exam was deleted. Your edited draft can be saved as a new exam.';bankStatus();}}await exams();await Promise.all([loadIntegritySettings(),loadDetails()]);message('Exam deleted.');}catch(err){message(err.message,true);remove.disabled=false;}});
    const actions = document.createElement('div'); actions.className = 'row wrap'; actions.append(button,toggle,duplicate,reset,remove); row.append(details,actions); container.append(row);
  }
  await results(); await progress();
}
async function results() {
  const examId = selected; const generation = ++resultsGeneration; clearResults();
  if (!examId) return;
  const data = await api(`exams/${encodeURIComponent(examId)}/results`);
  if (generation !== resultsGeneration || examId !== selected) return;
  currentResults=data; $('#releaseResults').disabled=false; $('#releaseResults').textContent=data.resultsReleased ? 'Hide scores' : 'Release scores'; $('#releaseStatus').textContent=data.resultsReleased ? 'Scores released' : 'Results hidden'; $('#resultsTitle').textContent = 'Scoreboard'; renderAnalytics(data);
  const done = data.results.filter(r => r.submitted_at); const final = done.filter(r => !r.pending && r.completion_reason !== 'invalidated'); const totalScore = final.reduce((sum,r) => sum + (r.total ? r.score / r.total : 0), 0);
  $('#joinedKpi').textContent = data.results.length; $('#submittedKpi').textContent = done.length; $('#activeKpi').textContent = data.results.length - done.length;
  $('#averageKpi').textContent = final.length ? `${Math.round(totalScore / final.length * 100)}%` : '—';
  const tbody = $('#resultRows'); tbody.replaceChildren();
  for (const r of data.results) {
    const tr = document.createElement('tr');
    const used=r.submitted_at ? Math.max(0,Math.round((new Date(r.submitted_at)-new Date(r.started_at))/60000)) : null;
    for (const text of [r.student_name, r.student_no, r.student_class || '—', r.student_section || '—', r.completion_reason==='invalidated' ? 'Invalidated' : r.submitted_at ? (r.pending ? 'Needs grading' : r.completion_reason==='force_submitted' ? 'Teacher submitted' : r.completion_reason==='integrity_limit' ? 'Integrity limit' : 'Submitted') : 'In progress', r.submitted_at ? `${r.score} / ${r.total}${r.pending ? ` (${r.pending} pending)` : ''}` : '—', r.submitted_at && !r.pending && r.completion_reason!=='invalidated' && r.total ? `${Math.round(100*r.score/r.total)}%` : '—', used===null?'—':`${used} min`, activeFlags(r), r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—']) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
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
    details.append(list);
    if (r.integrity_events?.length) {
      const events=document.createElement('details'), summary=document.createElement('summary'); summary.textContent=`Integrity events (${r.integrity_total ?? r.integrity_events.length}${(r.integrity_total ?? r.integrity_events.length)>r.integrity_events.length ? ', latest 500 shown' : ''})`;events.append(summary);
      const eventList=document.createElement('ul'); for(const event of r.integrity_events) { const li=document.createElement('li'); li.textContent=`${eventLabel(event.type)} — ${new Date(event.at).toLocaleString()}`;eventList.append(li); } events.append(eventList);answerCell.append(events);
    }
    answerCell.append(details,actionControls(r,examId)); if(r.teacher_actions?.length){const history=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Teacher action history';history.append(summary);const list=document.createElement('ul');for(const event of r.teacher_actions){const item=document.createElement('li');item.textContent=`${event.action.replaceAll('_',' ')}${event.minutes ? ` (${event.minutes} min)` : ''} — ${new Date(event.at).toLocaleString()}`;list.append(item);}history.append(list);answerCell.append(history);} tr.append(answerCell); tbody.append(tr);
  }
  if (!data.results.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 11; td.textContent = 'No students have joined yet.'; tr.append(td); tbody.append(tr); }
}
function activeFlags(attempt){return attempt.integrity_count ?? Math.max(0,(attempt.integrity_total ?? attempt.integrity_events?.length ?? 0)-(attempt.integrity_cleared_total ?? attempt.integrity_cleared_count ?? 0));}
function eventLabel(type){return ({copy:'Copy blocked',cut:'Cut blocked',paste:'Paste blocked',tab_hidden:'Left exam tab',second_tab:'Second tab detected',duplicate_join:'Duplicate join attempt'})[type] || String(type).replaceAll('_',' ');}
function actionControls(attempt,examId) {
  const details=document.createElement('details');details.className='teacher-actions';const summary=document.createElement('summary');summary.textContent='Student actions';details.append(summary);
  const controls=document.createElement('div');controls.className='row wrap';
  const isSubmitted=!!attempt.submitted_at, expired=attempt.deadline && new Date(attempt.deadline).getTime()<=Date.now();
  const buttons=[];
  if(!isSubmitted && !expired) buttons.push(['extend','+10 min',10],['extend','+30 min',30]);
  if(!isSubmitted) buttons.push(['force_submit','Submit for them']); else buttons.push(['reopen','Reopen attempt']);
  const flagCount=activeFlags(attempt);
  if(flagCount) buttons.push(['dismiss_flag','Clear flags']);
  if(attempt.completion_reason!=='invalidated') buttons.push(['invalidate','Invalidate']);
  for(const [action,label,minutes] of buttons){const button=document.createElement('button');button.type='button';button.className=`btn btn-sm ${action==='invalidate'?'btn-danger':'btn-ghost'}`;button.textContent=label;
    button.addEventListener('click',async()=>{
      const questions={extend:`Add ${minutes} minutes to this student's overall deadline? Part timers are not extended.`,force_submit:'Submit the saved answers for this student? Unsaved changes may be lost.',invalidate:'Invalidate this attempt? It will be excluded from score statistics.',reopen:'Reopen this attempt? Saved answers remain, but manual grades are cleared. Existing part locks and part timers remain in effect. The student must check the original result tab.',dismiss_flag:'Clear the current flags? The event history will remain visible.'};
      if(!confirm(questions[action]))return;controls.querySelectorAll('button').forEach(b=>b.disabled=true);
      try {await api(`exams/${encodeURIComponent(examId)}/action`,{attemptId:attempt.attempt_id,action,...(minutes?{minutes}:{})}); await progress();if(selected===examId) await results();message('Student action saved.');}
      catch(err){message(err.message,true);controls.querySelectorAll('button').forEach(b=>b.disabled=false);}
    });controls.append(button);
  }
  details.append(controls);return details;
}
function renderAnalytics(data) {
  const submitted=data.results.filter(r=>r.submitted_at), final=submitted.filter(r=>!r.pending && r.total>0 && r.completion_reason!=='invalidated'), scores=final.map(r=>100*r.score/r.total).sort((a,b)=>a-b);
  const pct=n=>`${Math.round(n)}%`, avg=scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : null;
  const median=scores.length ? (scores[Math.floor((scores.length-1)/2)]+scores[Math.floor(scores.length/2)])/2 : null;
  $('#resSubmitted').textContent=`${submitted.length}/${data.results.length}`; $('#resAverage').textContent=avg===null?'—':pct(avg); $('#resMedian').textContent=`median ${median===null?'—':pct(median)}`;
  $('#resHighest').textContent=scores.length?pct(scores.at(-1)):'—'; $('#resLowest').textContent=scores.length?pct(scores[0]):'—'; $('#resPassing').textContent=String(scores.filter(n=>n>=75).length);
  $('#resPending').textContent=String(data.analysis.reduce((n,q)=>n+q.awaiting,0));
  const buckets=[0,0,0,0,0]; for(const score of scores) buckets[Math.max(0,Math.min(4,Math.floor(score/20)))]++;
  const dist=$('#distribution'); dist.replaceChildren(); const max=Math.max(1,...buckets);
  buckets.forEach((count,i)=>{const col=document.createElement('div'); col.className='dist-col'; const val=document.createElement('div');val.className='dist-val';val.textContent=count;const bar=document.createElement('div');bar.className='dist-bar';bar.style.height=`${Math.max(3,count/max*100)}px`;const label=document.createElement('div');label.className='dist-lab';label.textContent=i===4?'80–100%':`${i*20}–${i*20+19}%`;col.append(val,bar,label);dist.append(col);});
  const rows=$('#itemRows');rows.replaceChildren(); for(const q of data.analysis){const tr=document.createElement('tr'); const vals=[q.index+1,q.prompt,q.kind,q.points,q.correct,q.answered,q.assessed?`${pct(q.correct/q.assessed*100)} correct (${q.assessed} assessed)`:'No data'];for(const value of vals){const td=document.createElement('td');td.textContent=value;tr.append(td);}rows.append(tr);}
  if(!data.analysis.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.textContent='No questions yet.';tr.append(td);rows.append(tr);}
  const hardest=$('#hardItems');hardest.replaceChildren(); const ranked=data.analysis.filter(q=>q.assessed).sort((a,b)=>a.correct/a.assessed-b.correct/b.assessed).slice(0,5);
  if(!ranked.length) hardest.textContent='No assessed answers yet.';
  for(const q of ranked){const row=document.createElement('div');row.className='exam-row';const title=document.createElement('span');title.textContent=`${q.index+1}. ${q.prompt}`;const rate=document.createElement('strong');rate.textContent=pct(q.correct/q.assessed*100);row.append(title,rate);hardest.append(row);}
}
function renderMonitor(data) {
  const attempts=data.attempts, active=attempts.filter(a=>!a.submitted_at && new Date(a.deadline).getTime()>Date.now());
  $('#onlineKpi').textContent=attempts.filter(a=>a.recently_seen).length; $('#joinedKpi').textContent=attempts.length; $('#submittedKpi').textContent=attempts.filter(a=>a.submitted_at).length;
  $('#activeKpi').textContent=active.length; $('#progressKpi').textContent=active.length ? `${Math.round(active.reduce((n,a)=>n+(a.question_total || data.total ? a.answered/(a.question_total || data.total) : 0),0)/active.length*100)}%` : '0%';
  const final=attempts.filter(a=>a.submitted_at && !a.pending && a.total>0 && a.completion_reason!=='invalidated'); $('#averageKpi').textContent=final.length ? `${Math.round(final.reduce((n,a)=>n+a.score/a.total,0)/final.length*100)}%` : '—';
  $('#needsKpi').textContent=attempts.filter(a=>a.submitted_at && a.pending>0 && a.completion_reason!=='invalidated').length; $('#flagsKpi').textContent=attempts.filter(a=>a.integrity_count>0).length; $('#flagEvents').textContent=`${attempts.reduce((n,a)=>n+a.integrity_count,0)} active event(s)`; $('#rosterCount').textContent=`${attempts.length} joined`;
  const search=$('#rosterSearch').value.trim().toLowerCase(), filter=$('#rosterFilter').value;
  const shown=attempts.filter(a=>{
    const matches=[a.student_name,a.student_no,a.student_class,a.student_section,a.exam_title].some(v=>String(v||'').toLowerCase().includes(search));
    return matches && (filter==='all' || filter==='online' && a.recently_seen || filter==='active' && !a.submitted_at && new Date(a.deadline).getTime()>Date.now() || filter==='submitted' && a.submitted_at || filter==='flagged' && a.integrity_count>0 || filter==='manual' && a.submitted_at && a.pending>0 && a.completion_reason!=='invalidated');
  });
  const rows=$('#progressRows');const expanded=new Set([...rows.querySelectorAll('[data-attempt]')].filter(node=>node.querySelector('.teacher-actions')?.open).map(node=>node.dataset.attempt));const expandedEvents=new Set([...rows.querySelectorAll('[data-attempt]')].filter(node=>node.querySelector('.roster-events')?.open).map(node=>node.dataset.attempt));rows.replaceChildren();
  if(!shown.length){const empty=document.createElement('div');empty.className='feed-empty';empty.textContent=attempts.length?'No students match this filter.':'No students have joined yet.';if(!attempts.length && selected && $('#rosterScope').value==='current'){const hint=document.createElement('div');hint.textContent=`Share the access code ${$('#codeText').textContent} with your class.`;empty.append(hint);}rows.append(empty);}
  for(const a of shown){
    const row=document.createElement('div');row.className=`neon-roster-row${a.integrity_count ? ' flagged' : ''}`;row.dataset.attempt=a.attempt_id;
    const avatar=document.createElement('div');avatar.className='avatar';let hue=0;for(const ch of (a.student_no||a.student_name))hue=(hue*31+ch.charCodeAt(0))%360;avatar.style.background=`hsl(${hue} 62% 52%)`;avatar.textContent=a.student_name.trim().split(/\s+/).slice(0,2).map(n=>n[0]).join('').toUpperCase();const dot=document.createElement('span');dot.className=`dot${a.recently_seen?' on':''}`;avatar.append(dot);
    const person=document.createElement('div');person.className='neon-roster-person';const name=document.createElement('div');name.className='sname';name.textContent=a.student_name;const meta=document.createElement('div');meta.className='smeta';meta.textContent=[a.student_no,a.student_class,a.student_section,a.exam_title].filter(Boolean).join(' · ');person.append(name,meta);
    const deadline=document.createElement('div');deadline.className='neon-roster-time';const left=Math.max(0,Math.ceil((new Date(a.deadline).getTime()-Date.now())/1000));const clock=document.createElement('div');clock.className='time-left';clock.textContent=a.submitted_at?'Finished':`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;const timeLabel=document.createElement('div');timeLabel.className='smeta';timeLabel.textContent=a.submitted_at?'submitted':left?'remaining':'time expired';deadline.append(clock,timeLabel);
    const total=a.question_total ?? data.total;const progress=document.createElement('div');progress.className='progress-cell';const progressText=document.createElement('div');progressText.className='lab';progressText.textContent=`${a.answered} / ${total} saved`;const bar=document.createElement('div');bar.className='bar';const fill=document.createElement('span');fill.style.width=`${total?Math.min(100,Math.round(a.answered/total*100)):0}%`;bar.append(fill);progress.append(progressText,bar);
    const flags=document.createElement('div');flags.className=a.integrity_count?'flag-chip':'smeta';flags.textContent=a.integrity_count?`⚑ ${a.integrity_count} flag${a.integrity_count===1?'':'s'}`:'No flags';
    const state=a.completion_reason==='invalidated'?'Invalidated':a.submitted_at?(a.completion_reason==='force_submitted'?'Teacher submitted':a.completion_reason==='integrity_limit'?'Integrity limit':'Submitted'):left?'In progress':'Time expired';const pill=document.createElement('span');pill.className=`pill ${a.submitted_at?'pill-done':a.recently_seen?'pill-live':'pill-idle'}`;pill.textContent=state;const status=document.createElement('div');status.className='neon-roster-status';const presence=document.createElement('div');presence.className='smeta';presence.textContent=a.recently_seen?'Recently connected':'No recent heartbeat';status.append(pill,presence);
    const actions=actionControls(a,a.exam_id || selected);actions.open=expanded.has(a.attempt_id);row.append(avatar,person,deadline,progress,flags,status,actions);
    if(a.integrity_events?.length){const history=document.createElement('details');history.className='roster-events';history.open=expandedEvents.has(a.attempt_id);const heading=document.createElement('summary');heading.textContent=`View recent integrity events (${a.integrity_events.length})`;history.append(heading);const list=document.createElement('ul');for(const event of [...a.integrity_events].reverse().slice(0,20)){const item=document.createElement('li');item.textContent=`${eventLabel(event.type)} · ${new Date(event.at).toLocaleString()}`;list.append(item);}history.append(list);row.append(history);}rows.append(row);
  }
  const events=[]; for(const a of attempts){for(const e of a.integrity_events||[]) events.push({at:e.at,text:`${a.student_name}: ${eventLabel(e.type)}`});if(a.submitted_at)events.push({at:a.submitted_at,text:`${a.student_name}${a.exam_title ? ` (${a.exam_title})` : ''}: ${a.completion_reason==='integrity_limit' ? 'submitted at integrity limit' : 'submitted'}`});}
  const feed=$('#activityFeed');feed.replaceChildren();const visible=events.filter(e=>new Date(e.at).getTime()>feedClearedAt).sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,100);
  if(!visible.length){const empty=document.createElement('div');empty.className='feed-empty';empty.textContent='Integrity events and submissions will appear here as the dashboard refreshes.';feed.append(empty);}
  for(const event of visible){const row=document.createElement('div');row.className='feed-item info';const text=document.createElement('div');text.textContent=event.text;const when=document.createElement('div');when.className='feed-when';when.textContent=new Date(event.at).toLocaleString();text.append(when);row.append(text);feed.append(row);}
}
$('#rosterSearch').addEventListener('input',()=>{if(currentProgress)renderMonitor(currentProgress);});
$('#rosterScope').addEventListener('change',()=>{currentProgress=null;feedExam='';progress();});
$('#rosterFilter').addEventListener('change',()=>{if(currentProgress)renderMonitor(currentProgress);});
$('#clearFeed').addEventListener('click',()=>{feedClearedAt=Date.now();if(currentProgress)renderMonitor(currentProgress);});
function csvCell(value){ const text=String(value ?? ''); const safe=/^[\s\u0000-\u001f]*[=+@-]/.test(text) ? "'"+text : text;return `"${safe.replaceAll('"','""')}"`; }
$('#releaseResults').addEventListener('click',async e=>{
  if(!currentResults || !selected) return;
  const button=e.currentTarget,examId=selected,released=!currentResults.resultsReleased;
  if(!confirm(released ? 'Release scores for submitted attempts? Scores awaiting manual grading will be shown as provisional.' : 'Hide scores again? Students who already saw or saved their scores will still know them.'))return;
  button.disabled=true;
  try {await api(`exams/${encodeURIComponent(examId)}/release-results`,{released});if(selected===examId) await results();message(released?'Scores released.':'Scores hidden.');}
  catch(err){message(err.message,true);if(selected===examId)button.disabled=false;}
});
$('#exportCsv').addEventListener('click',()=>{
  if(!currentResults) return message('Select an exam and wait for results to load.',true);
  const questions=currentResults.questions;
  const rows=[['Student','Student number','Class','Section','Status','Score','Total','Percent','Pending points','Integrity events','Started','Submitted','Minutes used',...questions.map((q,i)=>`Answer ${i+1}: ${q.prompt}`)]];
  for(const r of currentResults.results) {
    const answerText=q=>{const value=r.answers[q.id];if(Array.isArray(value))return value.map(v=>Number.isInteger(v)?q.choices[v]??'':String(v)).join(', ');return Number.isInteger(value)?q.choices[value]??'':value ?? '';};
    const status=r.completion_reason==='invalidated'?'Invalidated':r.submitted_at?r.pending?'Needs grading':r.completion_reason==='force_submitted'?'Teacher submitted':r.completion_reason==='integrity_limit'?'Integrity limit':'Submitted':'In progress';
    rows.push([r.student_name,r.student_no,r.student_class,r.student_section,status,r.submitted_at?r.score:'',r.submitted_at?r.total:'',r.submitted_at && !r.pending && r.completion_reason!=='invalidated' && r.total ? Math.round(r.score/r.total*100) : '',r.submitted_at?r.pending:'',activeFlags(r),r.started_at,r.submitted_at,r.submitted_at?Math.max(0,Math.round((new Date(r.submitted_at)-new Date(r.started_at))/60000)):'',...questions.map(answerText)]);
  }
  const csv='\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='exam-results.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function progress() {
  const examId = selected, scope=$('#rosterScope').value, generation = ++progressGeneration;
  if (!examId) { currentProgress=null; $('#connectionStatus').classList.add('off'); $('#connectionStatus span').textContent='No exam selected'; $('#progressRows').textContent = 'Select an exam.'; $('#activityFeed').replaceChildren(); return; }
  try {
    const data = scope==='all' ? await api('progress-all') : await api(`exams/${encodeURIComponent(examId)}/progress`);
    if (generation !== progressGeneration || examId !== selected || scope!==$('#rosterScope').value || !token) return;
    const feedScope=scope==='all'?'all':examId; currentProgress=data; if(feedExam!==feedScope){feedExam=feedScope;feedClearedAt=0;} renderMonitor(data);
    $('#connectionStatus').classList.remove('off'); $('#connectionStatus span').textContent='Updated';
    $('#progressStatus').textContent = 'Refreshes every 10 seconds. Recent connection is based on a heartbeat, not proof of attention; browser signals are best-effort and are not proof of misconduct. Open a student’s recent events below.';
  } catch (err) {
    if (generation === progressGeneration && examId === selected && token) { $('#connectionStatus').classList.add('off'); $('#connectionStatus span').textContent='Disconnected'; $('#progressStatus').textContent = `Could not refresh progress: ${err.message}`; }
  }
}
async function showDashboard() { const me = await api('me'); $('#auth').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); $('#welcome').textContent = `Teacher dashboard · ${me.username}`; await exams(); await progress(); clearInterval(progressTimer); progressTimer = setInterval(() => { if (!document.hidden) progress(); }, 10000); }
const detailFields={school:'#detailSchool',subject:'#detailSubject',term:'#detailTerm',instructions:'#detailInstructions',proctor_notes:'#detailNotes'};
function detailValues(){return Object.fromEntries(Object.entries(detailFields).map(([key,selector])=>[key,$(selector).value]));}
async function loadDetails(force=false) {
  const examId=selected;if(!force && detailsDirty && loadedDetailsExam===examId)return;
  if(force && detailsDirty && !confirm('Discard unsaved exam details and reload?'))return;
  const generation=++detailsGeneration;detailsDirty=false;loadedDetailsExam=examId;detailsRevision='';for(const selector of Object.values(detailFields))$(selector).disabled=true;$('#saveDetails').disabled=true;$('#regenerateCode').disabled=true;$('#detailsStatus').textContent=examId?'Loading details…':'Select an exam.';
  if(!examId)return;
  try{const data=await api(`exams/${encodeURIComponent(examId)}/details`);if(generation!==detailsGeneration || selected!==examId)return;for(const [key,selector] of Object.entries(detailFields)){$(selector).value=data[key];$(selector).disabled=false;}detailsRevision=data.revision;$('#detailsStatus').textContent='Details loaded for selected exam.';$('#saveDetails').disabled=false;$('#regenerateCode').disabled=false;}
  catch(err){if(generation===detailsGeneration)$('#detailsStatus').textContent=err.message;}
}
$('#detailsForm').addEventListener('input',()=>{detailsDirty=true;$('#detailsStatus').textContent='Unsaved exam details.';});
$('#detailsForm').addEventListener('submit',async e=>{e.preventDefault();const examId=selected,button=$('#saveDetails'),values=detailValues(),revision=detailsRevision;if(!examId||!revision)return;button.disabled=true;
  try{const data=await api(`exams/${encodeURIComponent(examId)}/details`,{...values,revision});if(examId===selected && revision===detailsRevision){detailsRevision=data.revision;detailsDirty=JSON.stringify(detailValues())!==JSON.stringify(values);$('#detailsStatus').textContent=detailsDirty?'Earlier values saved; newer changes are not saved.':'Exam details saved.';}message('Exam details saved.');}
  catch(err){if(examId===selected)$('#detailsStatus').textContent=err.message;message(err.message,true);}finally{if(examId===selected)button.disabled=false;}
});
$('#editDetailsBank').addEventListener('click',()=>document.querySelector('[data-view=questions]').click());
$('#reloadDetails').addEventListener('click',()=>loadDetails(true));
$('#regenerateCode').addEventListener('click',async e=>{const examId=selected,button=e.currentTarget;if(!examId || !confirm('Generate a new code? The old code will no longer work for joining or checking results. Share the new code with students.'))return;button.disabled=true;
  try{const data=await api(`exams/${encodeURIComponent(examId)}/new-code`,{});await exams();message(`New access code: ${data.code}`);}catch(err){message(err.message,true);}finally{if(examId===selected)button.disabled=false;}
});
async function loadIntegritySettings() {
  const examId=selected;if(integrityDirty && loadedIntegrityExam===examId)return;const generation=++integrityGeneration;integrityDirty=false;loadedIntegrityExam=examId;$('#maxViolations').disabled=true;$('#autoSubmitViolations').disabled=true;$('#saveIntegrity').disabled=true;$('#integrityStatus').textContent=examId?'Loading settings…':'Select an exam to configure the limit.';
  if(!examId)return;
  try {const settings=await api(`exams/${encodeURIComponent(examId)}/integrity-settings`);if(generation!==integrityGeneration || examId!==selected)return;$('#maxViolations').value=settings.max_violations;$('#autoSubmitViolations').checked=settings.auto_submit_on_violations;$('#maxViolations').disabled=false;$('#autoSubmitViolations').disabled=false;$('#integrityStatus').textContent='Settings loaded for the selected exam.';$('#saveIntegrity').disabled=false;}
  catch(err){if(generation===integrityGeneration)$('#integrityStatus').textContent=err.message;}
}
$('#integritySettings').addEventListener('input',()=>{integrityDirty=true;});
$('#integritySettings').addEventListener('submit',async e=>{e.preventDefault();const examId=selected,button=$('#saveIntegrity'),maxViolations=Number($('#maxViolations').value),autoSubmit=$('#autoSubmitViolations').checked;
  if(!examId || !Number.isInteger(maxViolations) || maxViolations<0 || maxViolations>500 || (autoSubmit && !maxViolations))return message('Choose a limit from 1 to 500 for auto-submit, or 0 to disable the limit.',true);
  if(autoSubmit && !confirm('Enable auto-submit when the integrity limit is reached? Browser checks can be unreliable, and unsaved answers may be lost.'))return;
  button.disabled=true;try{await api(`exams/${encodeURIComponent(examId)}/integrity-settings`,{maxViolations,autoSubmit});if(examId===selected){integrityDirty=Number($('#maxViolations').value)!==maxViolations || $('#autoSubmitViolations').checked!==autoSubmit;$('#integrityStatus').textContent=integrityDirty?'Saved earlier values; newer changes are not saved.':'Integrity settings saved.';}message('Integrity settings saved.');}catch(err){message(err.message,true);}finally{if(examId===selected)button.disabled=false;}
});
$('#setupNewExam').addEventListener('click',()=>$('#newExam').click());
$('#changePassword').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('password',{current:$('#currentPassword').value,next:$('#nextPassword').value});$('#currentPassword').value='';$('#nextPassword').value='';message('Password changed. Other teacher sessions were signed out.');}catch(err){message(err.message,true);}finally{button.disabled=false;}});
$('#login').addEventListener('submit', async e => { e.preventDefault(); const b = e.currentTarget.querySelector('[type=submit]'); b.disabled = true; try { const r = await api('login', { username:$('#username').value.trim(), password:$('#password').value }); token = r.token; sessionStorage.setItem('simple_teacher_token',token); $('#password').value = ''; await showDashboard(); message('Signed in.'); } catch(err) { message(err.message,true); } finally { b.disabled = false; } });
$('#showRegister').addEventListener('click',()=>{$('#authHeading').textContent='Create a teacher account';$('#authSubtitle').textContent='Create your own account to manage your exams.';$('#login').classList.add('hidden');$('#showRegister').classList.add('hidden');$('#registerForm').classList.remove('hidden');$('#registerUsername').focus();});
$('#showLogin').addEventListener('click',()=>{$('#authHeading').textContent='Teacher sign in';$('#authSubtitle').textContent='Monitor your class live, review responses and release scores.';$('#registerForm').classList.add('hidden');$('#login').classList.remove('hidden');$('#showRegister').classList.remove('hidden');$('#username').focus();});
$('#registerForm').addEventListener('submit',async e=>{e.preventDefault();const button=$('#register'),username=$('#registerUsername').value.trim(),password=$('#registerPassword').value;if(password!==$('#registerConfirm').value)return message('Passwords do not match.',true);button.disabled=true;try{await api('register',{username,password});$('#username').value=username;$('#registerPassword').value='';$('#registerConfirm').value='';$('#showLogin').click();message('Account created. Please sign in.');}catch(err){message(err.message,true);}finally{button.disabled=false;}});
$('#copyCode').addEventListener('click',async()=>{const code=$('#codeText').textContent;if(!selected)return message('Select an exam first.',true);try{if(!window.navigator.clipboard?.writeText)throw new Error('Copy unavailable. Select and copy the code manually.');await window.navigator.clipboard.writeText(code);message('Access code copied.');}catch(err){message(err.message,true);}});
$('#logout').addEventListener('click', async () => { try { await api('logout', {}); } catch {} sessionStorage.removeItem('simple_teacher_token'); token = ''; selected = ''; currentProgress=null; currentResults=null; resultsGeneration++; progressGeneration++; clearInterval(progressTimer); newDraft(); $('#importText').value = ''; $('#importPreview').replaceChildren(); $('#dashboard').classList.add('hidden'); $('#auth').classList.remove('hidden'); message('Signed out.'); });
$('#examSelect').addEventListener('change', e => {
  const editing=!$('#questionsView').classList.contains('hidden');
  if(!$('#setupView').classList.contains('hidden') && detailsDirty && !confirm('Discard unsaved exam details and switch exams?')){e.target.value=selected;return;}
  if(!$('#setupView').classList.contains('hidden') && integrityDirty && !confirm('Discard unsaved integrity settings and switch exams?')){e.target.value=selected;return;}
  if(editing && (draftDirty || textDirty) && !confirm('Discard unsaved question-bank changes and switch exams?')) { e.target.value=selected; return; }
  currentProgress=null; $('#progressRows').textContent='Loading saved progress…'; $('#activityFeed').replaceChildren(); selected=e.target.value; editorGeneration++; showSelection(); $('#progressRows').textContent='Loading saved progress…'; progress(); results().catch(err=>message(err.message,true));
  if(!$('#setupView').classList.contains('hidden')) {loadIntegritySettings();loadDetails();}
  if(editing && selected) loadBank({confirmed:true}).catch(err=>message(err.message,true));
});
$('#newExam').addEventListener('click', () => { if ((draftDirty || textDirty) && !confirm('Discard unsaved pasted text and question edits and start a new exam?')) return; newDraft(); view('questions'); });
$('#loadBank').addEventListener('click', () => loadBank().catch(err => message(err.message,true)));
$('#showFormat').addEventListener('click', () => $('#formatHelp').classList.toggle('hidden'));
$('#create').addEventListener('input', () => { dirty(); counts(); }); $('#create').addEventListener('change', () => { dirty(); counts(); });
document.querySelectorAll('[data-view]').forEach(tab => tab.addEventListener('click', () => { view(tab.dataset.view); if (tab.dataset.view === 'setup') {loadIntegritySettings();loadDetails();} if (tab.dataset.view === 'overview') progress(); if (tab.dataset.view === 'results') results().catch(err => message(err.message,true)); if (tab.dataset.view === 'questions' && selected && selected !== editExamId) loadBank().catch(err => message(err.message,true)); }));
$('#refreshExams').addEventListener('click', () => exams().catch(err => message(err.message,true)));
$('#addQuestion').addEventListener('click', () => { editor(); dirty(); });
$('#addPart').addEventListener('click', () => { const p=part(); editor(null,p); dirty(); }); $('#refreshResults').addEventListener('click', () => results().catch(err => message(err.message,true)));
$('#importText').addEventListener('input', () => { textDirty=$('#importText').value !== pasteSource; editorGeneration++; $('#importPreview').replaceChildren(); bankStatus(); });
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0], generation=editorGeneration; if (!file) return;
  if (file.size > 200000) { message('File is too large; use a file under 200 KB.', true); return; }
  try { const text=await file.text(); if(generation!==editorGeneration || e.target.files[0]!==file) return; $('#importText').value=text; $('#importText').dispatchEvent(new window.Event('input',{bubbles:true})); }
  catch { message('Could not read this file.', true); }
});
$('#previewImport').addEventListener('click', async e => {
  if (!textDirty && editExamId && !draftDirty) return message('The current text is already reflected in the preview.');
  if (draftDirty && !confirm('Replace the unsaved question preview with the pasted text?')) return;
  if (editExamId && textDirty && !confirm('Previewing replaces the draft. Review all question types, answer keys, and part settings before saving. Continue?')) return;
  const button=e.currentTarget; button.disabled=true; const preview=$('#importPreview'); preview.replaceChildren();
  const text=$('#importText').value, generation=editorGeneration;
  try {
    const data=await api('import-preview',{text});
    if(text!==$('#importText').value || generation!==editorGeneration || !token) return;
    const old=readSections();
    if(editExamId && old.length===data.sections.length && data.sections.every((s,i)=>s.title===old[i].title)) {
      data.sections.forEach((s,i)=>{
        s.minutes=old[i].minutes;s.lock_after=old[i].lock_after;
        for (const q of s.questions) {
          const candidates=old[i].questions.filter(previous=>previous.prompt.trim()===q.prompt.trim());
          if(candidates.length===1) {
            const prior=candidates[0];
            if(q.answer===null && prior.answer===null && ['mcq','multiselect','truefalse'].includes(prior.kind) && prior.kind!==q.kind) { q.kind=prior.kind; q.choices=prior.choices; }
            if(q.kind===prior.kind) q.shuffle=prior.shuffle;
          }
        }
      });
    } else if(editExamId && !confirm('Parts changed. Previewing replaces part timers and locking settings; review them before saving. Continue?')) return;
    loadSections(data.sections); pasteSource=text; textDirty=false; dirty();
    if(!$('#examTitle').value.trim() && data.title && data.title!=='Imported Exam') $('#examTitle').value=data.title;
    if(data.warnings.length) { const list=document.createElement('ul');list.className='warn-box';for(const w of data.warnings){const item=document.createElement('li');item.textContent=w;list.append(item);}preview.append(list); }
    message('Pasted questions are ready to review below.');
  } catch(err) { message(err.message,true); }
  finally { button.disabled=false; }
});
$('#create').addEventListener('submit', async e => {
  e.preventDefault(); if (bankLocked) return;
  if (textDirty) return message('The pasted text has changed. Preview it before saving.',true);
  if (!$('#examTitle').checkValidity() || !$('#duration').checkValidity()) { $('#examSettings').open=true; return message('Enter an exam title and a time limit between 1 and 600 minutes.',true); }
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
