const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_exam_token') || '';
let queue = Promise.resolve(), clock, paper = null, current = 0, submitting = false, pending = 0;
const scheduled = new Map(), failed = new Map(), versions = new Map();
async function api(path, body) {
  const res = await fetch('/api/simple/' + path, { method:body === undefined ? 'GET' : 'POST', headers:{ ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...(token ? { 'X-Exam-Token':token } : {}) }, body:body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data=await res.json(); } catch { throw new Error('Could not reach the exam server.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function error(message) { $('#message').textContent=message; $('#message').classList.remove('hidden'); }
const answered = value => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
function status() {
  $('#save').textContent = scheduled.size || pending ? 'Saving…' : failed.size ? 'Some answers did not save.' : 'Answer saved.';
  $('#retrySaves').classList.toggle('hidden', !failed.size);
}
function queueSave(questionId, value, version) {
  pending++; status();
  queue=queue.then(async()=>{
    try { await api('attempt/answer',{questionId,answer:value}); if (versions.get(questionId)===version) failed.delete(questionId); }
    catch(err) { if (versions.get(questionId)===version) { failed.set(questionId,{value,version}); error('Your answer could not be saved. Retry before submitting. '+err.message); } }
    finally { pending--; status(); }
  });
}
function flush(questionId) {
  const item=scheduled.get(questionId); if (!item) return;
  clearTimeout(item.timer); scheduled.delete(questionId); queueSave(questionId,item.value,item.version);
}
function record(q, value, debounce=false) {
  paper.answers[q.id]=value; const version=(versions.get(q.id)||0)+1; versions.set(q.id,version); failed.delete(q.id);
  const previous=scheduled.get(q.id); if(previous) clearTimeout(previous.timer);
  const item={value,version,timer:null}; scheduled.set(q.id,item);
  if(debounce) item.timer=setTimeout(()=>flush(q.id),500); else flush(q.id);
  $('#message').classList.add('hidden'); status(); palette();
}
function showResult(a) {
  clearInterval(clock); for (const item of scheduled.values()) clearTimeout(item.timer); scheduled.clear();
  $('#exam').classList.add('hidden'); $('#join').classList.add('hidden'); $('#result').classList.remove('hidden');
  $('#score').textContent=`Score: ${a.score} / ${a.total}${a.pending ? ` (${a.pending} points awaiting teacher grading)` : ''}${failed.size ? ' Some answers could not be saved before submission.' : ''}`;
  sessionStorage.removeItem('simple_exam_token');
}
function palette() {
  const target=$('#palette'); target.replaceChildren();
  paper.questions.forEach((q,i)=>{ const done=answered(paper.answers[q.id]); const button=document.createElement('button'); button.type='button'; button.className=`pal${done ? ' answered' : ''}${i===current ? ' current' : ''}`; button.textContent=String(i+1); button.setAttribute('aria-label',`Question ${i+1}${done ? ', answered' : ', unanswered'}`); if(i===current) button.setAttribute('aria-current','step'); button.addEventListener('click',()=>{ flush(paper.questions[current].id); current=i; paint(); }); target.append(button); });
  $('#progress').textContent=`${paper.questions.filter(q=>answered(paper.answers[q.id])).length} / ${paper.questions.length}`;
}
function paint() {
  if(!paper?.questions.length) return;
  const q=paper.questions[current], target=$('#questions'); target.replaceChildren();
  $('#qChip').textContent=`Question ${current+1}`; $('#qPoints').textContent=`${q.points ?? 1} ${(q.points ?? 1) === 1 ? 'point' : 'points'}`; $('#position').textContent=`${current+1} of ${paper.questions.length}`;
  $('#prev').disabled=current===0; $('#next').disabled=current===paper.questions.length-1;
  if(q.section) { const section=document.createElement('div'); section.className='muted small'; section.textContent=[q.section.title,q.section.instructions].filter(Boolean).join(' — '); target.append(section); }
  const title=document.createElement('div'); title.className='qprompt'; title.textContent=q.prompt; target.append(title);
  const kind=q.kind || 'mcq';
  if(kind==='short' || kind==='essay') {
    const label=document.createElement('label'); label.textContent=kind==='essay' ? 'Your essay response' : 'Your answer';
    const input=document.createElement(kind==='essay' ? 'textarea' : 'input'); input.maxLength=8000; input.value=paper.answers[q.id] || ''; input.disabled=submitting; if(kind==='essay') input.rows=8;
    input.addEventListener('input',()=>record(q,input.value,true)); label.append(input); target.append(label);
  } else {
    const choices=document.createElement('div'); choices.className='choices';
    q.choices.forEach((choice,n)=>{
      const multi=kind==='multiselect', selected=multi ? (paper.answers[q.id] || []).includes(n) : paper.answers[q.id]===n;
      const label=document.createElement('label'); label.className=`choice${selected ? ' selected' : ''}`;
      const input=document.createElement('input'); input.type=multi ? 'checkbox' : 'radio'; input.name=`q-${q.id}`; input.value=String(n); input.checked=selected; input.disabled=submitting;
      const text=document.createElement('span'); text.textContent=choice; label.append(input,text); choices.append(label);
      input.addEventListener('change',()=>{ const value=multi ? [...choices.querySelectorAll('input:checked')].map(x=>Number(x.value)) : n; record(q,value); paint(); });
    }); target.append(choices);
  }
  palette();
}
function render(a) {
  paper=a; current=0; $('#join').classList.add('hidden'); $('#exam').classList.remove('hidden'); document.body.classList.add('exam-body'); $('#title').textContent=a.title; paint();
  const tick=()=>{ const seconds=Math.max(0,Math.ceil((new Date(a.deadline).getTime()-Date.now())/1000)); $('#timer').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} remaining`; if(!seconds){clearInterval(clock);finish(true);} };
  clearInterval(clock); clock=setInterval(tick,1000); tick();
}
async function load(){const a=await api('attempt'); if(a.submitted) showResult(a); else render(a);}
async function finish(expired=false) {
  const buttons=[$('#submit'),$('#submitTop')]; if(submitting) return;
  if(!expired && !confirm('Submit your exam? You cannot change answers afterward.')) return;
  submitting=true; buttons.forEach(b=>{b.disabled=true;}); paint(); for(const id of [...scheduled.keys()]) flush(id); await queue;
  if(failed.size && !expired){error('An answer did not save. Retry before submitting.'); submitting=false; buttons.forEach(b=>{b.disabled=false;}); paint(); return;}
  try {const a=await api('attempt/submit',{}); showResult(a);} catch(e){error(e.message);submitting=false;buttons.forEach(b=>{b.disabled=false;});paint();}
}
const retry=document.createElement('button'); retry.type='button'; retry.id='retrySaves'; retry.className='btn btn-ghost btn-sm hidden'; retry.textContent='Retry saving answers'; $('#save').after(retry);
retry.addEventListener('click',()=>{for(const [id,item] of [...failed]) {failed.delete(id); queueSave(id,item.value,item.version);} status();});
$('#prev').addEventListener('click',()=>{if(current>0){flush(paper.questions[current].id);current--;paint();}});
$('#next').addEventListener('click',()=>{if(paper && current<paper.questions.length-1){flush(paper.questions[current].id);current++;paint();}});
$('#submit').addEventListener('click',()=>finish()); $('#submitTop').addEventListener('click',()=>finish());
$('#joinForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');b.disabled=true;$('#message').classList.add('hidden');try {const r=await api('join',{code:$('#code').value,name:$('#name').value,number:$('#number').value});token=r.token;sessionStorage.setItem('simple_exam_token',token);await load();} catch(e){error(e.message);} finally {b.disabled=false;}});
window.addEventListener('beforeunload', e => { if (scheduled.size || pending || failed.size) { e.preventDefault(); e.returnValue = ''; } });
if(token) load().catch(e=>error(e.message));
