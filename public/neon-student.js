import { addIcon } from './neon-icons.js';
const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('simple_exam_token') || '';
let queue = Promise.resolve(), clock, paper = null, current = 0, submitting = false, moving = false, pending = 0, serverOffset = 0, confirmed = {}, timerLevel = '';
const scheduled = new Map(), failed = new Map(), versions = new Map();
async function api(path, body, keepalive=false) {
  const res = await fetch('/api/simple/' + path, { method:body === undefined ? 'GET' : 'POST', keepalive, headers:{ ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...(token ? { 'X-Exam-Token':token } : {}) }, body:body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data=await res.json(); } catch { throw new Error('Could not reach the exam server.'); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), {status:res.status}); return data;
}
function error(message) { const notice=$('#message');notice.textContent=message;const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='alert-dismiss';dismiss.setAttribute('aria-label','Dismiss message');dismiss.textContent='×';dismiss.addEventListener('click',()=>notice.classList.add('hidden'));notice.append(dismiss);notice.classList.remove('hidden'); }
const answered = value => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
function status() {
  const state=scheduled.size || pending ? 'saving' : failed.size ? 'error' : 'saved';
  $('#save').textContent = state==='saving' ? 'Saving…' : state==='error' ? 'Some answers did not save.' : 'Answer saved.';$('#save').className=`save-state ${state}`;
  $('#retrySaves').classList.toggle('hidden', !failed.size); $('#discardSaves').classList.toggle('hidden', !failed.size);
}
function queueSave(questionId, value, version) {
  pending++; status();
  queue=queue.then(async()=>{
    try { await api('attempt/answer',{questionId,answer:value}); confirmed[questionId]=value; if (versions.get(questionId)===version) failed.delete(questionId); }
    catch(err) { if (versions.get(questionId)===version) { failed.set(questionId,{value,version}); error('Your answer could not be saved. Retry, or discard unsaved changes before moving on. '+err.message); } }
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
// Browser events are best-effort signals, not proof of cheating. They do not
// detect another browser profile or physical device with different credentials.
let monitoring=false, tabChannel=null, tabPing=null, heartbeatTimer=null, lastSecondTab=0, heartbeatInFlight=false;
const integrityStorageKey='simple_integrity_pending';
let integrityEvents=[], integrityInFlight=false, integrityTimer=null, integrityError=false;
try {const saved=JSON.parse(sessionStorage.getItem(integrityStorageKey)||'null');if(saved?.token===token && Array.isArray(saved.events)) integrityEvents=saved.events.filter(e=>e && /^[A-Za-z0-9_-]{22}$/.test(e.eventId) && ['copy','cut','paste','second_tab','tab_hidden'].includes(e.type));} catch { /* Keep the exam usable if storage is unavailable. */ }
function saveIntegrityQueue(){try{if(integrityEvents.length)sessionStorage.setItem(integrityStorageKey,JSON.stringify({token,events:integrityEvents}));else sessionStorage.removeItem(integrityStorageKey);}catch{error('Integrity events cannot be saved in this browser. Keep this tab open and notify your teacher.');}}
function integrityStatus(){const text=integrityEvents.length ? `${integrityEvents.length} integrity event(s) waiting to sync.${integrityError?' Check your connection and keep this tab open.':''}` : '';$('#integritySync').textContent=text;$('#integritySyncCard').classList.toggle('hidden',!text);$('#resultIntegritySync').textContent=text;$('#integritySyncInline').textContent=text;}
function flag(type) {
  const bytes=new Uint8Array(16);window.crypto.getRandomValues(bytes);const eventId=window.btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  integrityEvents.push({type,eventId});saveIntegrityQueue();integrityStatus();flushIntegrity();
}
async function flushIntegrity(){
  if(integrityInFlight || !token || !integrityEvents.length)return;
  integrityInFlight=true;const attemptToken=token;
  try {
    while(integrityEvents.length && token===attemptToken){
      const current=integrityEvents[0],state=await api('attempt/integrity',current,true);
      if(token!==attemptToken)break;integrityEvents.shift();integrityError=false;saveIntegrityQueue();integrityStatus();
      if(state.submitted && monitoring && !submitting) await load();
    }
  }catch {integrityError=true;integrityStatus();}
  finally {integrityInFlight=false;if(integrityEvents.length && token===attemptToken){if(!integrityTimer)integrityTimer=setTimeout(()=>{integrityTimer=null;flushIntegrity();},10000);}else if(integrityTimer){clearTimeout(integrityTimer);integrityTimer=null;}}
}
window.addEventListener('online',()=>{if(integrityTimer){clearTimeout(integrityTimer);integrityTimer=null;}flushIntegrity();});
for (const type of ['copy','cut','paste']) document.addEventListener(type,e=>{
  if(!monitoring) return;
  e.preventDefault(); flag(type); error(`${type[0].toUpperCase()+type.slice(1)} is not allowed during the exam.`);
},true);
function showIntegrityWarning(text) {
  $('#integrityBody').textContent=text; $('#integrityVeil').classList.remove('hidden');
  $('#exam').inert=true; $('#integrityContinue').focus();
}
$('#integrityContinue').addEventListener('click',()=>{ $('#integrityVeil').classList.add('hidden'); $('#exam').inert=false; });
document.addEventListener('visibilitychange',()=>{
  if(monitoring && document.hidden) { flag('tab_hidden'); showIntegrityWarning('Leaving the exam tab triggers an integrity event. Keep this tab open so it can sync to your teacher.'); }
});
async function heartbeat() {
  if(!monitoring || heartbeatInFlight) return;
  heartbeatInFlight=true;
  try { const state=await api('attempt/heartbeat',paper?.questions[current] ? {questionId:paper.questions[current].id} : {}); if(state.submitted && monitoring && !submitting) await load(); else if(monitoring && paper && state.deadline) { paper.deadline=state.deadline; serverOffset=new Date(state.serverTime).getTime()-Date.now(); } }
  catch { /* A missed heartbeat is not evidence of misconduct. */ }
  finally { heartbeatInFlight=false; }
}
function startMonitoring() {
  if(monitoring) return;
  monitoring=true; heartbeat(); heartbeatTimer=setInterval(heartbeat,10000);
  if(typeof window.BroadcastChannel !== 'function') return;
  tabChannel=new window.BroadcastChannel(`simple-exam-${token}`);
  const report=()=>{ if(Date.now()-lastSecondTab<10000) return; lastSecondTab=Date.now();flag('second_tab');error('This exam is open in another tab or window. Close the other copy.');showIntegrityWarning('This exam is open in another tab or window. Close the other copy before continuing.'); };
  tabChannel.onmessage=e=>{ if(e.data==='hello'){report();tabChannel?.postMessage('present');} else if(e.data==='present') report(); };
  tabChannel.postMessage('hello');
  tabPing=setInterval(()=>tabChannel?.postMessage('hello'),5000);
}
function stopMonitoring() { monitoring=false;clearInterval(tabPing);clearInterval(heartbeatTimer);heartbeatTimer=null;tabPing=null;tabChannel?.close();tabChannel=null; }
async function ensureResultKey() {
  let key=sessionStorage.getItem('simple_result_key');
  if(!key && token) { const r=await api('attempt/result-key',{}); key=r.resultKey;sessionStorage.setItem('simple_result_key',key); }
  return key;
}
function showResult(a) {
  const unsaved=scheduled.size || pending || failed.size;
  stopMonitoring(); integrityStatus(); flushIntegrity(); $('#integrityVeil').classList.add('hidden'); $('#exam').inert=false; clearInterval(clock); for (const item of scheduled.values()) clearTimeout(item.timer); scheduled.clear();
  document.body.classList.remove('exam-body'); $('#exam').classList.add('hidden'); $('#join').classList.add('hidden'); $('#result').classList.remove('hidden');
  $('#resultKeyDisplay').textContent=sessionStorage.getItem('simple_result_key') || 'Unavailable — use the button below to retry.';
  $('#score').textContent=`${a.completionReason==='invalidated' ? 'Your teacher invalidated this attempt. ' : a.completionReason==='integrity_limit' ? 'Your attempt was submitted after reaching the integrity-event limit. ' : ''}Your teacher will release the results.${unsaved ? ' Some changes may not have been saved before submission.' : ''}`;
}
function palette() {
  const target=$('#palette'); target.replaceChildren();
  paper.questions.forEach((q,i)=>{ const done=answered(paper.answers[q.id]); const button=document.createElement('button'); button.type='button'; button.className=`pal${done ? ' answered' : ''}${i===current ? ' current' : ''}`; button.textContent=String(i+1); button.setAttribute('aria-label',`Question ${i+1}${done ? ', answered' : ', unanswered'}`); if(i===current) button.setAttribute('aria-current','step'); const section=q.section?.index ?? 0; button.disabled=moving || (paper.lockSections && section < paper.maxSection && !!q.section?.lock_after); button.addEventListener('click',()=>go(i,true)); target.append(button); });
  const completed=paper.questions.filter(q=>answered(paper.answers[q.id])).length, percent=paper.questions.length?Math.round(completed/paper.questions.length*100):0;
  $('#progress').textContent=`${completed} / ${paper.questions.length}`;$('#mobileProgress').textContent=`${completed} / ${paper.questions.length} answered`;$('#progressPercent').textContent=`${percent}%`;$('#progressCircle').style.strokeDashoffset=String(163.36*(1-percent/100));
  const parts=$('#parts');parts.replaceChildren();const seen=new Set();
  paper.questions.forEach((q,i)=>{const section=q.section?.index ?? 0;if(seen.has(section))return;seen.add(section);const group=paper.questions.filter(x=>(x.section?.index ?? 0)===section);const button=document.createElement('button');button.type='button';button.className=`sec-row${section===(paper.questions[current].section?.index ?? 0)?' active':''}`;button.disabled=moving || submitting || (paper.lockSections && section<paper.maxSection && !!q.section?.lock_after);const title=document.createElement('span');title.className='sec-name';title.textContent=q.section?.title || `Part ${section+1}`;const meta=document.createElement('span');meta.className='sec-meta';meta.textContent=`${group.filter(x=>answered(paper.answers[x.id])).length}/${group.length}`;button.append(title,meta);button.addEventListener('click',()=>go(i,true));parts.append(button);});
}
function paint() {
  if(!paper?.questions.length) return;
  const q=paper.questions[current], target=$('#questions'); target.replaceChildren();
  $('#qChip').textContent=`Question ${current+1}`; $('#qPoints').textContent=`${q.points ?? 1} ${(q.points ?? 1) === 1 ? 'point' : 'points'}`; $('#position').textContent=`${current+1} of ${paper.questions.length}`;
  $('#prev').disabled=moving || current===0; $('#next').disabled=moving || current===paper.questions.length-1;
  if(q.section) { const section=document.createElement('div'); section.className='muted small'; section.textContent=[q.section.title,q.section.instructions].filter(Boolean).join(' — '); target.append(section); }
  const title=document.createElement('h2'); title.className='qprompt'; title.id='questionPrompt'; title.textContent=q.prompt; target.append(title);
  const kind=q.kind || 'mcq';
  const hint=document.createElement('p');hint.className='answer-hint';hint.id='answerHint';hint.textContent=kind==='multiselect'?'Select all answers that apply.':kind==='short'||kind==='essay'?'Your response saves as you type.':'Select one answer.';target.append(hint);
  if(kind==='short' || kind==='essay') {
    const label=document.createElement('label'); label.textContent=kind==='essay' ? 'Your essay response' : 'Your answer';
    const input=document.createElement(kind==='essay' ? 'textarea' : 'input'); input.maxLength=8000; input.value=paper.answers[q.id] || ''; input.disabled=submitting || moving || partExpired(); if(kind==='essay') input.rows=8;
    input.addEventListener('input',()=>record(q,input.value,true)); label.append(input); target.append(label);
  } else {
    const choices=document.createElement('div'); choices.className='choices';choices.setAttribute('role',kind==='multiselect'?'group':'radiogroup');choices.setAttribute('aria-labelledby','questionPrompt');choices.setAttribute('aria-describedby','answerHint');
    q.choices.forEach((choice,n)=>{
      const key=q.choiceKeys?.[n] ?? n, multi=kind==='multiselect', selected=multi ? (paper.answers[q.id] || []).includes(key) : paper.answers[q.id]===key;
      const label=document.createElement('label'); label.className=`choice${selected ? ' selected' : ''}`;
      const input=document.createElement('input'); input.type=multi ? 'checkbox' : 'radio'; input.name=`q-${q.id}`; input.value=String(key); input.checked=selected; input.disabled=submitting || moving || partExpired();
      const text=document.createElement('span'); text.textContent=choice; label.append(input,text); choices.append(label);
      input.addEventListener('change',()=>{ const value=multi ? [...choices.querySelectorAll('input:checked')].map(x=>Number(x.value)) : key; record(q,value); choices.querySelectorAll('.choice').forEach(option=>option.classList.toggle('selected',option.querySelector('input').checked)); });
    }); target.append(choices);
  }
  palette();
}
function partExpired() { return !!paper?.sectionDeadline && Date.now()+serverOffset >= new Date(paper.sectionDeadline).getTime(); }
function applyState(a) { paper=a; serverOffset=new Date(a.serverTime).getTime()-Date.now(); confirmed={...a.answers}; }
function tick() {
  const now=Date.now()+serverOffset, seconds=Math.max(0,Math.ceil((new Date(paper.deadline).getTime()-now)/1000));
  $('#timer').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} remaining`;
  const level=seconds<=60?'critical':seconds<=300?'warning':'normal';$('#timer').classList.toggle('warn',level==='warning');$('#timer').classList.toggle('crit',level==='critical');
  if(level!==timerLevel){timerLevel=level;$('#timerNotice').textContent=level==='critical'?'One minute or less remains.':level==='warning'?'Five minutes or less remain.':'';}
  if (paper.sectionDeadline) {
    const left=Math.max(0,Math.ceil((new Date(paper.sectionDeadline).getTime()-now)/1000));
    $('#sectionTimer').textContent=left ? `Part time: ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}` : 'Part time expired. Move to another part or submit.';
    if (!left) document.querySelectorAll('#questions input, #questions textarea').forEach(el=>{el.disabled=true;});
  } else $('#sectionTimer').textContent='';
  if(!seconds && !moving){clearInterval(clock);finish(true);}
}
function render(a) {
  submitting=false; moving=false; failed.clear(); versions.clear(); $('#submit').disabled=false; $('#submitTop').disabled=false;
  applyState(a); const index=a.questions.findIndex(q=>(q.section?.index ?? 0)===a.currentSection); current=Math.max(0,index); startMonitoring();
  const description=[[a.school,a.subject,a.term].filter(Boolean).join(' · '),a.proctorNotes,a.instructions].filter(Boolean).join('\n\n');$('#examInfoText').textContent=description;$('#examInfoCard').classList.toggle('hidden',!description);
  $('#result').classList.add('hidden'); $('#join').classList.add('hidden'); $('#exam').classList.remove('hidden'); document.body.classList.add('exam-body'); $('#title').textContent=a.title; paint();
  clearInterval(clock); clock=setInterval(tick,1000); tick();
}
async function go(index,fromNavigation=false) {
  if (moving || submitting || index<0 || index>=paper.questions.length) return;
  const from=paper.questions[current].section?.index ?? 0, target=paper.questions[index].section?.index ?? 0;
  if (from===target) { flush(paper.questions[current].id); current=index; paint(); finishNavSelection(fromNavigation); heartbeat(); return; }
  if (paper.lockSections && target>from && paper.questions[current].section?.lock_after && !confirm('Leaving this part locks it. Continue?')) return;
  moving=true; paint(); for(const id of [...scheduled.keys()]) flush(id); await queue;
  if(failed.size) { error('An answer did not save. Retry or discard unsaved changes before changing parts.'); moving=false; paint(); return; }
  try {
    const a=await api('attempt/navigate',{section:target}); if(a.submitted){moving=false;showResult(a);return;}
    const wanted=paper.questions[index].id; applyState(a); current=paper.questions.findIndex(q=>q.id===wanted); if(current<0) current=0; moving=false; paint(); tick(); finishNavSelection(fromNavigation); heartbeat();
  } catch(e){ error(e.message); moving=false; paint(); }
}
function finishNavSelection(fromNavigation) {
  if(!fromNavigation || !window.matchMedia?.('(max-width: 980px)').matches) return;
  $('#navigationToggle').setAttribute('aria-expanded','false');$('#questionCard').focus({preventScroll:true});$('#questionCard').scrollIntoView?.({block:'start'});
}
// Reserve exactly enough room for the fixed action bar, including save errors
// and mobile safe areas, so its controls never cover the final question.
if(typeof window.ResizeObserver==='function') new window.ResizeObserver(entries=>{
  document.body.style.setProperty('--exam-dock-height',`${Math.ceil(entries[0].contentRect.height)}px`);
}).observe(document.querySelector('#exam .dock'));
$('#navigationToggle').addEventListener('click',e=>{const button=e.currentTarget;button.setAttribute('aria-expanded',String(button.getAttribute('aria-expanded')!=='true'));});
async function load(){flushIntegrity();const a=await api('attempt'); try {await ensureResultKey();} catch { error('Could not create your private result key. You can retry after submitting.'); } if(a.submitted) showResult(a); else render(a);}
async function finish(expired=false) {
  const buttons=[$('#submit'),$('#submitTop')]; if(submitting || moving) return;
  const unanswered=paper.questions.filter(q=>!answered(paper.answers[q.id])).length;
  if(!expired && !confirm(`${unanswered ? `${unanswered} question${unanswered===1?' is':'s are'} unanswered. ` : 'All questions have an answer. '}Submit your exam? You cannot change answers afterward.`)) return;
  submitting=true; buttons.forEach(b=>{b.disabled=true;}); paint(); for(const id of [...scheduled.keys()]) flush(id); await queue;
  if(failed.size && !expired){error('An answer did not save. Retry before submitting.'); submitting=false; buttons.forEach(b=>{b.disabled=false;}); paint(); return;}
  try {const a=await api('attempt/submit',{}); showResult(a);} catch(e){error(e.message);submitting=false;buttons.forEach(b=>{b.disabled=false;});paint();}
}
const retry=document.createElement('button'); retry.type='button'; retry.id='retrySaves'; retry.className='btn btn-ghost btn-sm hidden'; retry.textContent='Retry saving answers'; $('#save').after(retry);
retry.addEventListener('click',()=>{for(const [id,item] of [...failed]) {failed.delete(id); queueSave(id,item.value,item.version);} status();});
const discard=document.createElement('button'); discard.type='button'; discard.id='discardSaves'; discard.className='btn btn-ghost btn-sm hidden'; discard.textContent='Discard unsaved answers'; retry.after(discard);
discard.addEventListener('click',()=>{ if(!confirm('Discard unsaved changes and keep the last saved answers?')) return; for(const id of failed.keys()){ if(confirmed[id] === undefined) delete paper.answers[id]; else paper.answers[id]=confirmed[id]; } failed.clear(); $('#message').classList.add('hidden'); status(); paint(); });
for(const [selector,icon] of Object.entries({'#showExamInfo':'eye','#resultLookup button':'eye','#startExam':'right','#prev':'left','#next':'right','#submit':'check','#submitTop':'check','#retrySaves':'refresh','#discardSaves':'reset','#copyResultKey':'copy','#checkReopen':'refresh'})) addIcon($(selector),icon);
let infoGeneration=0;
$('#code').addEventListener('input',()=>{infoGeneration++;$('#entryExamInfo').textContent='';$('#heroTitle').textContent='Ready for your examination?';$('#heroMeta').textContent='Your teacher will provide your exam access code. Read the instructions before you begin.';$('#heroStats').replaceChildren();});
$('#showExamInfo').addEventListener('click',async e=>{const button=e.currentTarget,code=$('#code').value,generation=++infoGeneration;button.disabled=true;try{const info=await api('exam-info',{code});if(generation!==infoGeneration || code!==$('#code').value)return;$('#heroTitle').textContent=info.title;$('#heroMeta').textContent=[info.school,info.subject,info.term].filter(Boolean).join(' · ') || 'Read the instructions before you begin.';const stats=$('#heroStats');stats.replaceChildren();for(const [value,label] of [[info.duration,'minutes'],[info.question_count,'questions']]){const stat=document.createElement('div');stat.className='hero-stat';const strong=document.createElement('div');strong.className='v';strong.textContent=value;const caption=document.createElement('div');caption.className='k';caption.textContent=label;stat.append(strong,caption);stats.append(stat);}
  $('#entryExamInfo').textContent=[info.title,[info.school,info.subject,info.term].filter(Boolean).join(' · '),`${info.duration} minutes · ${info.question_count} questions · ${info.open?'Open':'Closed'}`,info.proctor_notes,info.instructions].filter(Boolean).join('\n');}catch(err){if(generation===infoGeneration)$('#entryExamInfo').textContent=err.message;}finally{button.disabled=false;}});
$('#resultLookup').addEventListener('submit',async e=>{
  e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;const output=$('#lookupResult');output.textContent='Checking…';
  try {const r=await api('result-lookup',{code:$('#resultCode').value,number:$('#resultNumber').value,resultKey:$('#resultKeyInput').value});output.textContent=`${r.title}: ${r.score} / ${r.total}${r.pending ? ` (${r.pending} points awaiting grading; score is provisional)` : ''}`;}
  catch(err){output.textContent=err.message;}finally{button.disabled=false;}
});
$('#copyResultKey').addEventListener('click',async e=>{
  const button=e.currentTarget;button.disabled=true;
  try { const key=await ensureResultKey();$('#resultKeyDisplay').textContent=key;if(!navigator.clipboard?.writeText) throw new Error('Copy is unavailable. Write down the key shown above.');await navigator.clipboard.writeText(key);error('Result key copied. Keep it private.'); }
  catch(err){error(err.message || 'Could not retrieve the result key. Try again.');}finally{button.disabled=false;}
});
$('#checkReopen').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try {await queue;const a=await api('attempt');if(a.submitted) error('The attempt is still submitted. Ask your teacher if you need it reopened.');else {$('#message').classList.add('hidden');render(a);}} catch(err){error(err.message);} finally{button.disabled=false;}});
$('#newAttempt').addEventListener('click',()=>{ if(!confirm('Have you saved your private result key? Leaving also prevents checking whether this attempt was reopened in this tab.')) return;if(integrityEvents.length && !confirm('Some integrity events are still waiting to sync. Leaving now may lose them. Leave anyway?'))return;integrityEvents=[];saveIntegrityQueue();sessionStorage.removeItem('simple_exam_token');sessionStorage.removeItem('simple_result_key');token='';window.location.reload(); });
$('#prev').addEventListener('click',()=>go(current-1));
$('#next').addEventListener('click',()=>go(current+1));
$('#submit').addEventListener('click',()=>finish()); $('#submitTop').addEventListener('click',()=>finish());
$('#agreeRules').addEventListener('change',()=>{$('#startExam').disabled=!$('#agreeRules').checked;});
$('#joinForm').addEventListener('submit',async e=>{e.preventDefault();if(!$('#agreeRules').checked)return error('Please read and agree to the examination rules.');const b=$('#startExam');b.disabled=true;$('#message').classList.add('hidden');try {const r=await api('join',{code:$('#code').value,name:$('#name').value,number:$('#number').value,studentClass:$('#studentClass').value,studentSection:$('#studentSection').value});token=r.token;sessionStorage.setItem('simple_exam_token',token);sessionStorage.setItem('simple_result_key',r.resultKey);await load();} catch(e){error(e.message);} finally {b.disabled=!$('#agreeRules').checked;}});
window.addEventListener('beforeunload', e => { if (scheduled.size || pending || failed.size || integrityEvents.length) { e.preventDefault(); e.returnValue = ''; } });
if(token) load().catch(e=>error(e.message));

document.addEventListener('keydown',e=>{
  if(!monitoring || submitting || moving || !$('#integrityVeil').classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const target=e.target;if(target?.closest?.('input,textarea,select,button,[contenteditable="true"]')) return;
  if(/^[1-9]$/.test(e.key)){const input=$$('#questions .choice input')[Number(e.key)-1];if(input && !input.disabled){e.preventDefault();input.click();}}
  else if(e.key==='ArrowRight' && !$('#next').disabled){e.preventDefault();$('#next').click();}
  else if(e.key==='ArrowLeft' && !$('#prev').disabled){e.preventDefault();$('#prev').click();}
});
function $$(selector){return document.querySelectorAll(selector);}
