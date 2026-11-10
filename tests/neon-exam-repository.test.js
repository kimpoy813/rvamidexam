import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { initializeNeon } from '../server/neon/database.js';
import { getOwnedBlueprint, replaceOwnedBlueprint, joinExam, getAttemptSnapshot } from '../server/neon/exam-repository.js';
import { startAttempt, saveAnswer, submitAttempt, gradeAttempt } from '../server/neon/attempt-repository.js';
import { buildPaper, gradePaper } from '../server/lib/exam-engine.js';

const url = process.env.TEST_DATABASE_URL;
test('original exam bank supports isolated atomic edits and immutable attempt papers', { skip: !url, timeout:30000 }, async () => {
  const schema = 'test_' + crypto.randomBytes(8).toString('hex');
  const admin = new pg.Client({ connectionString:url }); await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection = new URL(url); connection.searchParams.set('options', `-csearch_path=${schema}`);
  const pool = new pg.Pool({ connectionString:connection.toString(), max:10 });
  try {
    await initializeNeon(pool); await initializeNeon(pool);
    const {rows:[teacher]} = await pool.query("INSERT INTO teachers(username,pass_hash,salt,created_at) VALUES ('one','hash','salt',0) RETURNING id");
    const {rows:[other]} = await pool.query("INSERT INTO teachers(username,pass_hash,salt,created_at) VALUES ('two','hash','salt',0) RETURNING id");
    await pool.query("INSERT INTO exams(id,title,access_code,settings,created_at,teacher_id) VALUES('exam','Exam','ABC-234',$1,0,$2)", [JSON.stringify({exam_open:'1',shuffle_choices:'0',shuffle_questions:'0'}),teacher.id]);
    const bank = [{ title:'Part A', instructions:'Read carefully', lock_after:false, questions:[
      {kind:'mcq',prompt:'Pick one',choices:['A','B'],answer:'B',points:2},
      {kind:'multiselect',prompt:'Pick both',choices:['A','B','C'],answer:['A','B'],points:4},
      {kind:'truefalse',prompt:'True?',choices:['True','False'],answer:'True',points:1},
      {kind:'short',prompt:'Name it',choices:[],answer:'Hello',points:1},
      {kind:'essay',prompt:'Explain',choices:[],answer:null,points:5}
    ]}];
    await assert.rejects(replaceOwnedBlueprint(pool, other.id, 'exam', bank), /Exam not found/);
    await assert.rejects(getOwnedBlueprint(pool, other.id, 'exam'), /Exam not found/);
    const saved = await replaceOwnedBlueprint(pool,teacher.id,'exam',bank);
    assert.deepEqual(saved[0].questions.map(q=>q.kind), ['mcq','multiselect','truefalse','short','essay']);
    assert.deepEqual(saved[0].questions[1].answer,['A','B']);
    await assert.rejects(replaceOwnedBlueprint(pool,teacher.id,'exam',[{questions:[{kind:'bad',prompt:'bad'}]}]), /Invalid question/);
    assert.equal((await getOwnedBlueprint(pool,teacher.id,'exam'))[0].questions.length,5);
    await pool.query(`CREATE FUNCTION fail_bank_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.prompt = 'force failure' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER fail_bank BEFORE INSERT ON questions FOR EACH ROW EXECUTE FUNCTION fail_bank_insert()');
    await assert.rejects(replaceOwnedBlueprint(pool,teacher.id,'exam',[{questions:[{prompt:'force failure',choices:['A','B'],answer:'A'}]}]), /forced failure/);
    assert.equal((await getOwnedBlueprint(pool,teacher.id,'exam'))[0].questions.length,5, 'failed transaction restores old bank');
    await pool.query('DROP TRIGGER fail_bank ON questions');
    const joined = await Promise.allSettled(Array.from({length:5},()=>joinExam(pool,{code:'abc-234',name:'Student One',number:'001'})));
    assert.equal(joined.filter(x=>x.status==='fulfilled').length,1);
    assert.ok(joined.filter(x=>x.status==='rejected').every(x=>x.reason.status===409));
    const token = joined.find(x=>x.status==='fulfilled').value.token;
    const snapshot = await getAttemptSnapshot(pool,token); assert.equal(snapshot.blueprint[0].questions.length,5);
    const paper = buildPaper({order_seed:5},snapshot.blueprint,snapshot.settings);
    assert.ok(!JSON.stringify(paper).includes('"answer":'));
    const questions = snapshot.blueprint[0].questions, essay = questions[4];
    const graded = gradePaper(paper, {[essay.id]:{value:'Essay response'}}, {}, questions);
    assert.equal(graded.pending,5);
    const manual = gradePaper(paper, {[essay.id]:{value:'Essay response'}}, {[essay.id]:{points:4}}, questions);
    assert.equal(manual.score,4); assert.equal(manual.pending,0);
    const started = await startAttempt(pool,token); assert.ok(started.deadline > Date.now());
    assert.equal((await startAttempt(pool,token)).deadline, started.deadline);
    await Promise.all([
      saveAnswer(pool,token,questions[0].id,'1'),
      saveAnswer(pool,token,questions[1].id,[0,1]),
      saveAnswer(pool,token,questions[2].id,'0'),
      saveAnswer(pool,token,questions[3].id,'Hello'),
      saveAnswer(pool,token,essay.id,'Essay response')
    ]);
    await assert.rejects(saveAnswer(pool,token,questions[0].id,'99'), /Invalid answer/);
    await replaceOwnedBlueprint(pool,teacher.id,'exam',[{title:'New',questions:[{prompt:'New question',choices:['X','Y'],answer:'X'}]}]);
    assert.equal((await getAttemptSnapshot(pool,token)).blueprint[0].questions.length,5);
    assert.equal((await getOwnedBlueprint(pool,teacher.id,'exam'))[0].questions.length,1);
    const submitted = await submitAttempt(pool,token); assert.equal(submitted.status,'submitted'); assert.equal(submitted.result,null);
    await assert.rejects(saveAnswer(pool,token,essay.id,'late'), /already submitted/);
    const stored = await pool.query('SELECT * FROM sessions'); assert.notEqual(stored.rows[0].token,token);
    assert.equal(Object.keys(JSON.parse(stored.rows[0].answers)).length,5);
    assert.equal(stored.rows[0].score,8); assert.equal(stored.rows[0].pending_manual,5);
    await assert.rejects(gradeAttempt(pool,other.id,stored.rows[0].token,essay.id,4), /Attempt not found/);
    await assert.rejects(gradeAttempt(pool,teacher.id,stored.rows[0].token,essay.id,6), /Invalid grade/);
    const after = await gradeAttempt(pool,teacher.id,stored.rows[0].token,essay.id,4,'Good work');
    assert.equal(after.score,12); assert.equal(after.pending,0);
    const late = await joinExam(pool,{code:'ABC-234',name:'Late Student',number:'002'});
    const lateStart = await startAttempt(pool,late.token);
    await pool.query('UPDATE sessions SET deadline=$1 WHERE token=$2', [Date.now()-1,crypto.createHash('sha256').update(late.token).digest('hex')]);
    await assert.rejects(saveAnswer(pool,late.token,lateStart.paper[0].questions[0].id,'0'), /time expired/);
    assert.equal((await pool.query('SELECT status FROM sessions WHERE token=$1', [crypto.createHash('sha256').update(late.token).digest('hex')])).rows[0].status,'auto_timeout');
    assert.equal(await getAttemptSnapshot(pool,'bad'),null);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
