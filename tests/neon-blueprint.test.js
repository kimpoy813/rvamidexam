import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBlueprint, previewOriginalImport } from '../server/neon/blueprint.js';
import { gradeOne } from '../server/lib/exam-engine.js';

test('original format preview retains sections, instructions, question kinds, keys and points', () => {
  const input = JSON.stringify({title:'Complete exam',sections:[
    {title:'Part A',instructions:'Choose carefully',lock_after:false,minutes:10,questions:[
      {kind:'mcq',prompt:'One',choices:['A','B'],answer:'B',points:2},
      {kind:'multiselect',prompt:'Many',choices:['A','B','C'],answer:['A','C'],points:3},
      {kind:'truefalse',prompt:'True?',answer:'True',points:1}
    ]},
    {title:'Part B',instructions:'Explain your answer',questions:[
      {kind:'short',prompt:'Term?',answer:['first','second'],points:1.5},
      {kind:'essay',prompt:'Why?',points:5}
    ]}
  ]});
  const draft = previewOriginalImport(input);
  assert.equal(draft.title,'Complete exam'); assert.equal(draft.sections.length,2);
  assert.equal(draft.sections[0].instructions,'Choose carefully'); assert.equal(draft.sections[0].lock_after,false); assert.equal(draft.sections[0].minutes,10);
  assert.deepEqual(draft.sections.flatMap(s=>s.questions.map(q=>q.kind)),['mcq','multiselect','truefalse','short','essay']);
  assert.deepEqual(draft.sections[0].questions[1].answer,['A','C']);
  assert.deepEqual(draft.sections[0].questions[2].choices,['True','False']);
  assert.deepEqual(draft.sections[1].questions[0].answer,['first','second']);
  assert.equal(draft.sections[1].questions[0].points,1.5); assert.equal(draft.sections[1].questions[1].answer,null);
});

test('text import keeps parts and missing answer keys are flagged for manual grading', () => {
  const draft = previewOriginalImport('Exam title\n# Part I\nChoose the best answer\n1. Pick one\nA. Yes\nB. No\n# Part II\nWrite a response\n2. Explain [5] //');
  assert.equal(draft.sections.length,2); assert.equal(draft.sections[0].instructions,'Choose the best answer');
  assert.equal(draft.sections[1].questions[0].kind,'essay'); assert.equal(draft.sections[1].questions[0].points,5);
  assert.ok(draft.warnings.some(w=>/manual grading/i.test(w)));
  for (const kind of ['mcq','multiselect','truefalse']) assert.equal(gradeOne({kind,answer:null,points:2,choices:['Yes','No']},[0]).pending,true);
});

test('invalid banks cannot be silently saved or graded against a mismatched key', () => {
  const q = (kind,choices,answer) => [{questions:[{kind,prompt:'Question',choices,answer}]}];
  assert.throws(()=>normalizeBlueprint(q('mcq',['A','B'],'C')),/does not match/);
  assert.throws(()=>normalizeBlueprint(q('multiselect',['A','B'],'A')),/non-empty list/);
  assert.throws(()=>normalizeBlueprint(q('mcq',['A','a'],'A')),/distinct/);
  assert.throws(()=>normalizeBlueprint(q('essay',[], 'key')),/manually graded/);
  assert.throws(()=>previewOriginalImport('No questions present'),/No questions/);
});

test('CSV import preserves a multiselect answer list and section', () => {
  const csv = 'section,kind,prompt,A,B,C,D,E,F,answer,points\nPart A,multiselect,Choose,A,B,C,,,,A|C,3\nPart B,essay,Explain,,,,,,,,5';
  const draft = previewOriginalImport(csv);
  assert.equal(draft.sections.length,2);
  assert.deepEqual(draft.sections[0].questions[0].answer,['A','C']);
  assert.equal(draft.sections[0].questions[0].points,3);
  assert.equal(draft.sections[1].questions[0].kind,'essay');
  assert.equal(draft.sections[1].questions[0].points,5);
});
