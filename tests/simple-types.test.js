import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import pg from 'pg';

const url=process.env.TEST_DATABASE_URL;
test('Vercel API preserves parts and all question types through answers and grading', {skip:!url,timeout:30000}, async()=>{
  const schema='test_'+crypto.randomBytes(8).toString('hex'); const admin=new pg.Client({connectionString:url}); await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection=new URL(url); connection.searchParams.set('options',`-csearch_path=${schema}`); process.env.DATABASE_URL=connection.toString();
  const {default:handler,closeTestPool}=await import('../api/handler.js'); const server=http.createServer(handler); server.listen(0,'127.0.0.1'); await once(server,'listening'); const base=`http://127.0.0.1:${server.address().port}/api/simple/`;
  const call=async(path,body,teacher,student)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(teacher?{'X-Teacher-Token':teacher}:{}),...(student?{'X-Exam-Token':student}:{})},...(body===undefined?{}:{body:JSON.stringify(path === 'join' ? {studentClass:'Grade 10',studentSection:'A',...body} : body)})});return {status:r.status,data:await r.json()};};
  try {
    await call('register',{username:'teacher_types',password:'strong-password-123'}); const teacher=(await call('login',{username:'teacher_types',password:'strong-password-123'})).data.token;
    await call('register',{username:'teacher_other',password:'strong-password-123'}); const other=(await call('login',{username:'teacher_other',password:'strong-password-123'})).data.token;
    const sections=[{title:'Part One',instructions:'Choose carefully',questions:[
      {kind:'mcq',prompt:'Select',choices:['A','B'],answer:'B',points:2},
      {kind:'multiselect',prompt:'Select several',choices:['A','B','C'],answer:['A','C'],points:4},
      {kind:'truefalse',prompt:'True?',choices:['True','False'],answer:'True',points:1}
    ]},{title:'Part Two',instructions:'Write answers',questions:[
      {kind:'short',prompt:'Word',choices:[],answer:['hello','hi'],points:1.5},
      {kind:'essay',prompt:'Explain',choices:[],answer:null,points:5}
    ]}];
    const preview=await call('import-preview',{text:JSON.stringify({title:'Types',sections})},teacher); assert.equal(preview.status,200); assert.equal(preview.data.sections.length,2);
    for (const kind of ['mcq','multiselect','truefalse','short']) {const choices=kind==='short'?[]:kind==='truefalse'?['True','False']:['A','B'];const bad=await call('exams',{title:'Missing key',duration:10,sections:[{title:'P',questions:[{kind,prompt:'Question',choices,answer:null}]}]},teacher);assert.equal(bad.status,400);assert.match(bad.data.error,/answer key/);}
    const created=await call('exams',{title:'Types',duration:10,sections:preview.data.sections},teacher); assert.equal(created.status,201,JSON.stringify(created.data));
    const bank=await call(`exams/${created.data.id}/bank`,undefined,teacher); assert.equal(bank.data.questions.length,5);
    const joined=await call('join',{code:created.data.code,name:'Student One',number:'001'}); const token=joined.data.token; const resultLookup={code:created.data.code,number:'001'};
    const attempt=await call('attempt',undefined,undefined,token); const qs=attempt.data.questions; assert.equal(qs[0].section.title,'Part One'); assert.equal(qs[3].section.instructions,'Write answers'); assert.ok(!JSON.stringify(qs).includes('"answer"'));
    const values=[1,[0,2],0,'Hello','My essay'];
    assert.ok((await Promise.all(qs.map((q,i)=>call('attempt/answer',{questionId:q.id,answer:values[i]},undefined,token)))).every(r=>r.status===200));
    assert.equal((await call('attempt/answer',{questionId:qs[1].id,answer:[0,0]},undefined,token)).status,400);
    const submitted=await call('attempt/submit',{},undefined,token); assert.equal(submitted.data.submitted,true); assert.equal('score' in submitted.data,false); assert.equal('pending' in submitted.data,false);
    const results=(await call(`exams/${created.data.id}/results`,undefined,teacher)).data; const row=results.results[0]; assert.equal(results.analysis[4].awaiting,1); assert.equal(results.analysis[4].assessed,0); assert.equal(row.pending,5); assert.equal(row.answers[qs[4].id],'My essay');
    assert.equal((await call(`exams/${created.data.id}/release-results`,{released:true},teacher)).status,200); let released=await call('result-lookup',resultLookup);assert.equal(released.data.pending,5);assert.equal(released.data.score,8.5);
    const body={attemptId:row.attempt_id,questionId:qs[4].id,points:4};
    assert.equal((await call(`exams/${created.data.id}/grade`,body,other)).status,404);
    assert.equal((await call(`exams/${created.data.id}/grade`,{...body,points:6},teacher)).status,400);
    const graded=await call(`exams/${created.data.id}/grade`,body,teacher); assert.equal(graded.data.score,12.5); assert.equal(graded.data.pending,0);released=await call('result-lookup',resultLookup);assert.equal(released.data.pending,0);assert.equal(released.data.score,12.5);
    assert.equal('score' in (await call('attempt',undefined,undefined,token)).data,false);
    const actionPath=`exams/${created.data.id}/action`, attemptId=row.attempt_id;
    const act=(action,extra={},who=teacher)=>call(actionPath,{attemptId,action,...extra},who);
    assert.equal((await act('reopen',{},other)).status,404);
    assert.equal((await act('extend',{minutes:10})).status,409);
    assert.equal((await act('reopen')).status,200);
    assert.equal((await call('result-lookup',resultLookup)).status,404); let resumed=(await call('attempt',undefined,undefined,token)).data; assert.equal(resumed.submitted,false); assert.equal(resumed.answers[qs[4].id],'My essay');
    assert.equal((await act('extend',{minutes:0})).status,400); const before=new Date(resumed.deadline).getTime();
    const extended=await act('extend',{minutes:10}); assert.equal(extended.status,200);assert.equal(new Date(extended.data.deadline).getTime()-before,600000);
    const heartbeat=await call('attempt/heartbeat',{},undefined,token);assert.equal(new Date(heartbeat.data.deadline).getTime(),new Date(extended.data.deadline).getTime());
    await call('attempt/integrity',{type:'paste'},undefined,token);assert.equal((await act('dismiss_flag')).status,200);
    let progress=(await call(`exams/${created.data.id}/progress`,undefined,teacher)).data;assert.equal(progress.attempts[0].integrity_count,0);assert.equal(progress.attempts[0].integrity_events.length,1);
    assert.equal((await act('force_submit')).status,200);resumed=(await call('attempt',undefined,undefined,token)).data;assert.equal(resumed.submitted,true);assert.equal(resumed.completionReason,'force_submitted');
    let after=(await call(`exams/${created.data.id}/results`,undefined,teacher)).data;assert.equal(after.results[0].pending,5);assert.deepEqual(after.results[0].manual_scores,{});assert.equal(after.results[0].teacher_actions.length,4);
    assert.equal((await act('invalidate')).status,200);after=(await call(`exams/${created.data.id}/results`,undefined,teacher)).data;assert.equal(after.results[0].completion_reason,'invalidated');assert.equal((await call('result-lookup',resultLookup)).status,404);assert.equal(after.analysis[0].answered,0);
    assert.equal((await act('invalidate')).status,409);
    const parallel=await call('join',{code:created.data.code,name:'Student One',number:'001'});assert.equal(parallel.status,201);
    assert.equal((await call('result-lookup',resultLookup)).status,404);assert.equal((await act('reopen')).status,409);await call('attempt/submit',{},undefined,parallel.data.token);assert.equal((await call('result-lookup',resultLookup)).data.score,0);
    assert.equal((await act('reopen')).status,200);
    const late=await call('join',{code:created.data.code,name:'Late Student',number:'002'}); const lp=(await call('attempt',undefined,undefined,late.data.token)).data;
    await call('attempt/answer',{questionId:lp.questions[4].id,answer:'Late essay'},undefined,late.data.token);
    await admin.query(`UPDATE "${schema}".simple_attempts SET deadline=now()-interval '1 second' WHERE token_hash=$1`,[crypto.createHash('sha256').update(late.data.token).digest('hex')]);
    assert.equal((await call('attempt/answer',{questionId:lp.questions[0].id,answer:0},undefined,late.data.token)).status,409);
    const expired=(await call('attempt',undefined,undefined,late.data.token)).data; assert.equal(expired.submitted,true); assert.equal('pending' in expired,false);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); await closeTestPool(); delete process.env.DATABASE_URL; await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
