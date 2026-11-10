import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import pg from 'pg';
import { JSDOM } from 'jsdom';

const url=process.env.TEST_DATABASE_URL;
test('teacher roster actions refresh, handle conflicts, and target the correct exam', {skip:!url,timeout:30000}, async()=>{
  const schema='test_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Client({connectionString:url});await admin.connect();await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection=new URL(url);connection.searchParams.set('options',`-csearch_path=${schema}`);process.env.DATABASE_URL=connection.toString();
  const {default:handler,closeTestPool}=await import('../api/handler.js');const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const nativeFetch=globalThis.fetch;const original=Object.fromEntries(['document','sessionStorage','fetch','confirm','window'].map(k=>[k,globalThis[k]]));
  const call=async(path,body,teacher,student)=>{const res=await nativeFetch(`${base}/api/simple/${path}`,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(teacher?{'X-Teacher-Token':teacher}:{}),...(student?{'X-Exam-Token':student}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};};
  const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI did not reach expected state');};
  let dom;
  try {
    await call('register',{username:'teacher_actions',password:'strong-actions-password'});const teacher=(await call('login',{username:'teacher_actions',password:'strong-actions-password'})).data.token;
    const create=title=>call('exams',{title,duration:20,questions:[{prompt:'Question',choices:['A','B'],answer:0}]},teacher);
    const first=(await create('First exam')).data, second=(await create('Second exam')).data;
    const joined=(await call('join',{code:second.code,name:'Student Actions',number:'S01',studentClass:'10',studentSection:'A'})).data;
    await call('attempt/integrity',{type:'paste'},undefined,joined.token);
    const initial=(await call(`exams/${second.id}/progress`,undefined,teacher)).data.attempts[0],id=initial.attempt_id;
    dom=new JSDOM(fs.readFileSync(new URL('../public/neon-teacher.html',import.meta.url),'utf8'),{url:base+'/teacher'});dom.window.sessionStorage.setItem('simple_teacher_token',teacher);
    globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.sessionStorage=dom.window.sessionStorage;globalThis.confirm=()=>true;globalThis.fetch=(input,opts)=>nativeFetch(String(input).startsWith('/')?base+input:input,opts);
    await import('../public/neon-teacher.js?actions-ui-test');const d=dom.window.document;
    await wait(()=>d.querySelector('#examSelect').options.length===2);d.querySelector('#examSelect').value=first.id;d.querySelector('#examSelect').dispatchEvent(new dom.window.Event('change',{bubbles:true}));d.querySelector('#rosterScope').value='all';d.querySelector('#rosterScope').dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    await wait(()=>d.querySelector('#progressRows .teacher-actions'));const panel=()=>d.querySelector('#progressRows .teacher-actions');const row=()=>d.querySelector('#progressRows .neon-roster-row');
    assert.match(row().textContent,/Second exam/);assert.match(panel().querySelector('summary').getAttribute('aria-label'),/Student Actions/);panel().open=true;
    const action=(name)=>[...panel().querySelectorAll('button')].find(b=>b.textContent===name);
    action('Clear flags').focus();action('Clear flags').click();await wait(()=>/Flags cleared for Student Actions/.test(d.querySelector('#message').textContent));assert.match(row().textContent,/No flags/);assert.equal(panel().open,true);assert.equal([...panel().querySelectorAll('button')].every(b=>!b.disabled),true);
    let releaseResponse,actionCalls=0;const gate=new Promise(resolve=>{releaseResponse=resolve;});globalThis.fetch=async(input,opts)=>{const result=await nativeFetch(String(input).startsWith('/')?base+input:input,opts);if(String(input).endsWith('/action')){actionCalls++;await gate;}return result;};
    action('+10 min').click();action('+10 min').click();await wait(()=>actionCalls===1);assert.ok([...panel().querySelectorAll('button')].every(b=>b.disabled));releaseResponse();await wait(()=>/Added 10 minutes for/.test(d.querySelector('#message').textContent));assert.equal(actionCalls,1);globalThis.fetch=(input,opts)=>nativeFetch(String(input).startsWith('/')?base+input:input,opts);const extended=(await call(`exams/${second.id}/progress`,undefined,teacher)).data.attempts[0];assert.equal(new Date(extended.deadline)-new Date(initial.deadline),600000);
    let failProgress=true;globalThis.fetch=(input,opts)=>{if(String(input).endsWith('/progress-all') && failProgress){failProgress=false;return Promise.reject(new Error('offline'));}return nativeFetch(String(input).startsWith('/')?base+input:input,opts);};
    action('Submit for them').click();await wait(()=>/dashboard could not refresh/.test(d.querySelector('#message').textContent));assert.match(d.querySelector('#message').textContent,/Submitted saved answers/);assert.ok(d.querySelector('#message').classList.contains('error'));d.querySelector('#refreshExams').click();await wait(()=>!!action('Reopen attempt'));assert.equal(action('Submit for them'),undefined);globalThis.fetch=(input,opts)=>nativeFetch(String(input).startsWith('/')?base+input:input,opts);
    action('Reopen attempt').click();await wait(()=>/Attempt reopened for/.test(d.querySelector('#message').textContent));assert.ok(action('+10 min'));
    action('Invalidate').click();await wait(()=>/Attempt invalidated for/.test(d.querySelector('#message').textContent));assert.match(row().textContent,/Invalidated/);assert.equal(action('Invalidate'),undefined);
    action('Reopen attempt').click();await wait(()=>/Attempt reopened for/.test(d.querySelector('#message').textContent));assert.ok(action('Submit for them'));
    // Another teacher submits before this dashboard refreshes: a conflict must
    // report the error and replace stale actions instead of leaving dead buttons.
    assert.equal((await call(`exams/${second.id}/action`,{attemptId:id,action:'force_submit'},teacher)).status,200);
    action('Submit for them').click();await wait(()=>/already submitted/.test(d.querySelector('#message').textContent));assert.ok(action('Reopen attempt'));assert.equal(action('Submit for them'),undefined);assert.equal([...panel().querySelectorAll('button')].every(b=>!b.disabled),true);
  } finally {
    dom?.window.close();for(const [key,value] of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
    server.closeAllConnections();await new Promise(r=>server.close(r));await closeTestPool();delete process.env.DATABASE_URL;await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
