import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaper, gradePaper } from '../server/lib/exam-engine.js';

test('storage-independent engine builds and grades with supplied authoritative questions', () => {
  const question = { id: 'q1', kind: 'short', prompt: 'Answer?', points: 2, choices: [], answer: ['yes'], shuffle: false };
  const blueprint = [{ id: 's1', title: 'Section', lock_after: false, questions: [question] }];
  const settings = { shuffle_questions: '0', shuffle_choices: '0', lock_sections: '0' };
  const paper = buildPaper({ order_seed: 1 }, blueprint, settings);
  assert.equal(paper[0].questions[0].answer, undefined, 'answer key must not be sent to students');
  const result = gradePaper(paper, { q1: { value: 'yes' } }, {}, [question]);
  assert.equal(result.score, 2);
  assert.throws(() => gradePaper(paper, {}, {}, undefined), /question bank/);
});
