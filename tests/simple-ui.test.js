import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { JSDOM } from 'jsdom';

const url = process.env.TEST_DATABASE_URL;
test('simplified teacher and student interfaces complete an exam', { skip: !url, timeout: 30000 }, async () => {
  const name = 'test_' + crypto.randomBytes(8).toString('hex'); const admin = new pg.Client({ connectionString:url }); await admin.connect(); await admin.query(`CREATE SCHEMA "${name}"`);
  const conn = new URL(url); conn.searchParams.set('options', `-csearch_path=${name}`); process.env.DATABASE_URL = conn.toString();
  const { default:handler, closeTestPool } = await import('../api/handler.js');
  const server = http.createServer(handler); server.listen(0,'127.0.0.1'); await once(server,'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const original = Object.fromEntries(['document','sessionStorage','fetch','confirm'].map(k => [k,globalThis[k]])); const nativeFetch = globalThis.fetch;
  let teacherDom, studentDom;
  const wait = async fn => { for (let i=0;i<60;i++) { if (fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error('UI did not reach expected state'); };
  function use(dom) { globalThis.document = dom.window.document; globalThis.sessionStorage = dom.window.sessionStorage; globalThis.fetch = (url,opts) => nativeFetch(String(url).startsWith('/') ? base+url : url,opts); globalThis.confirm = () => true; }
  try {
    teacherDom = new JSDOM(fs.readFileSync(new URL('../public/neon-teacher.html', import.meta.url),'utf8'), { url:base+'/teacher' }); use(teacherDom);
    await import('../public/neon-teacher.js?simple-ui-test'); const t = teacherDom.window.document; const fill = (node,val) => { node.value=val; };
    fill(t.querySelector('#username'),'ui_teacher'); fill(t.querySelector('#password'),'strong-test-password'); t.querySelector('#register').click();
    await wait(()=>/Account created/.test(t.querySelector('#message').textContent)); t.querySelector('#login').dispatchEvent(new teacherDom.window.Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>!t.querySelector('#dashboard').classList.contains('hidden'));
    t.querySelector('#newExam').click(); assert.equal(t.querySelector('#questionsView').classList.contains('hidden'), false);
    assert.equal(t.querySelector('[data-view=questions]').getAttribute('aria-selected'), 'true');
    fill(t.querySelector('#examTitle'),'Test from UI'); fill(t.querySelector('.prompt'),'Select the answer'); [...t.querySelectorAll('.option')].forEach((x,i)=>fill(x,`Option ${i+1}`));
    t.querySelector('#addQuestion').click(); const second = t.querySelectorAll('.question-editor')[1]; fill(second.querySelector('.prompt'),'Second question'); [...second.querySelectorAll('.option')].forEach((x,i)=>fill(x,`Second ${i+1}`));
    t.querySelector('#create').dispatchEvent(new teacherDom.window.Event('submit',{bubbles:true,cancelable:true})); await wait(()=>/Exam created/.test(t.querySelector('#message').textContent));
    const code = t.querySelector('#message').textContent.match(/code ([0-9A-F]+)/)[1];
    studentDom = new JSDOM(fs.readFileSync(new URL('../public/neon.html', import.meta.url),'utf8'), { url:base+'/' }); use(studentDom); await import('../public/neon-student.js?simple-ui-test'); const s = studentDom.window.document;
    fill(s.querySelector('#code'),code); fill(s.querySelector('#name'),'Test Student'); fill(s.querySelector('#number'),'001'); s.querySelector('#joinForm').dispatchEvent(new studentDom.window.Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>s.querySelectorAll('.choice input').length===4); const radio=s.querySelector('.choice input'); radio.checked=true; radio.dispatchEvent(new studentDom.window.Event('change',{bubbles:true})); await wait(()=>/Answer saved/.test(s.querySelector('#save').textContent));
    assert.equal(s.querySelector('#progress').textContent, '1 / 2'); s.querySelector('#next').click(); assert.equal(s.querySelector('#qChip').textContent, 'Question 2');
    const secondRadio = s.querySelector('.choice input'); secondRadio.checked=true; secondRadio.dispatchEvent(new studentDom.window.Event('change',{bubbles:true})); await wait(()=>/Answer saved/.test(s.querySelector('#save').textContent));
    s.querySelector('#prev').click(); assert.equal(s.querySelector('.choice input').checked, true); s.querySelector('#next').click(); s.querySelector('#submit').click();
    await wait(()=>!s.querySelector('#result').classList.contains('hidden')); assert.match(s.querySelector('#score').textContent,/2 \/ 2/);
    use(teacherDom); t.querySelector('[data-view=results]').click(); await wait(()=>/Test Student/.test(t.querySelector('#resultRows').textContent));
    assert.match(t.querySelector('#resultRows').textContent,/2 \/ 2/); assert.equal(t.querySelector('#joinedKpi').textContent, '1');
  } finally {
    teacherDom?.window.close(); studentDom?.window.close(); for (const [key,value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key]=value; }
    server.closeAllConnections(); await new Promise(r=>server.close(r)); await closeTestPool(); delete process.env.DATABASE_URL;
    await admin.query(`DROP SCHEMA "${name}" CASCADE`); await admin.end();
  }
});
