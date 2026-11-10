import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import pg from 'pg';
const url=process.env.TEST_DATABASE_URL;
test('existing simple exams and integer scores survive the additive grading upgrade',{skip:!url,timeout:30000},async()=>{
  const schema='test_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Client({connectionString:url}); await admin.connect();await admin.query(`CREATE SCHEMA "${schema}"`);
  const conn=new URL(url);conn.searchParams.set('options',`-csearch_path=${schema}`);const setup=new pg.Client({connectionString:conn.toString()});await setup.connect();
  const token=crypto.randomBytes(32).toString('base64url'), digest=crypto.createHash('sha256').update(token).digest('hex');
  await setup.query(`CREATE TABLE simple_teachers (id TEXT PRIMARY KEY, username TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE simple_exams (id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL REFERENCES simple_teachers(id),title TEXT NOT NULL,code TEXT UNIQUE NOT NULL,duration INTEGER NOT NULL,questions JSONB NOT NULL,open BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE simple_attempts (token_hash TEXT PRIMARY KEY,exam_id TEXT NOT NULL REFERENCES simple_exams(id),student_name TEXT NOT NULL,student_no TEXT NOT NULL,answers JSONB NOT NULL DEFAULT '{}'::jsonb,started_at TIMESTAMPTZ NOT NULL DEFAULT now(),deadline TIMESTAMPTZ NOT NULL,submitted_at TIMESTAMPTZ,score INTEGER,total INTEGER);
    INSERT INTO simple_teachers(id,username,salt,password_hash) VALUES('teacher','existing','salt','hash');`);
  await setup.query('INSERT INTO simple_exams(id,teacher_id,title,code,duration,questions) VALUES($1,$2,$3,$4,$5,$6)', ['exam','teacher','Existing exam','CODE',10,JSON.stringify([{id:'q',prompt:'Old question',choices:['A','B'],answer:0}])]);
  await setup.query("INSERT INTO simple_attempts(token_hash,exam_id,student_name,student_no,answers,deadline,submitted_at,score,total) VALUES($1,'exam','Old Student','001',$2,now(),now(),1,1)",[digest,JSON.stringify({q:0})]);
  process.env.DATABASE_URL=conn.toString();const {default:handler,closeTestPool}=await import('../api/handler.js');const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/simple/attempt`,{headers:{'X-Exam-Token':token}});const body=await response.json();assert.equal(response.status,200);assert.equal(body.score,1);assert.equal(body.total,1);assert.equal(body.pending,0);assert.equal(body.answers.q,0);
    const fields=await setup.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='simple_attempts'",[schema]);assert.equal(fields.rows.find(r=>r.column_name==='score').data_type,'double precision');
    const persisted=await setup.query('SELECT score,total,pending,manual_scores FROM simple_attempts');assert.deepEqual(persisted.rows[0],{score:1,total:1,pending:0,manual_scores:{}});
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));await closeTestPool();delete process.env.DATABASE_URL;await setup.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
