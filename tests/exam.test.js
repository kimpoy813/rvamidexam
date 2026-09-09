/**
 * End-to-end tests against the real server and the real database.
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'rvm-exam-'));
process.env.EXAM_DATA_DIR = dir;
process.env.EXAM_DB = path.join(dir, 'test.sqlite');
process.env.EXAM_TEACHER_PASSWORD = 'test-pass';

const BASE = 'http://127.0.0.1:4123';
process.env.PORT = '4123';
process.env.HOST = '127.0.0.1';

/* --------------------------------------------------------------- bootstrap */

const serverModule = await import('../server/index.js');
await new Promise((r) => setTimeout(r, 400));

test.after(async () => {
  serverModule.httpServer.closeAllConnections?.();
  await new Promise((r) => serverModule.httpServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const { getSettings, setSettings } = await import('../server/lib/db.js');
const accessCode = getSettings().access_code;

async function call(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Teacher-Token'] = token;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/* ------------------------------------------------------------------- tests */

test('public exam info describes the paper', async () => {
  const { status, data } = await call('GET', '/api/public/exam-info');
  assert.equal(status, 200);
  assert.equal(data.durationMinutes, 60, 'the exam must last one hour');
  assert.equal(data.sections.length, 4);
  assert.equal(data.totalQuestions, 21);
  assert.equal(data.totalPoints, 50);
});

test('a wrong access code is rejected', async () => {
  const { status } = await call('POST', '/api/sessions', {
    access_code: 'ZZZ-999', student_name: 'Impostor', student_no: 'X1'
  });
  assert.equal(status, 403);
});

test('teacher login works with the configured password', async () => {
  const bad = await call('POST', '/api/teacher/login', { username: 'teacher', password: 'nope' });
  assert.equal(bad.status, 401);

  const good = await call('POST', '/api/teacher/login', { username: 'teacher', password: 'test-pass' });
  assert.equal(good.status, 200);
  assert.ok(good.data.token);
});

const teacher = (await call('POST', '/api/teacher/login', {
  username: 'teacher', password: 'test-pass'
})).data.token;

test('starting a session begins a server-side 60 minute clock', async () => {
  const joined = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Ana Reyes', student_no: 'S-001', class_section: '10-StMary'
  });
  assert.equal(joined.status, 201);
  const token = joined.data.token;

  const started = await call('POST', `/api/s/${token}/start`, {});
  assert.equal(started.status, 200);
  // Allow a couple of seconds of slack for the round trip.
  assert.ok(started.data.secondsLeft > 3590 && started.data.secondsLeft <= 3600,
    `expected ~3600s, got ${started.data.secondsLeft}`);

  const paper = await call('GET', `/api/s/${token}/paper`);
  assert.equal(paper.data.total, 21);
  assert.equal(paper.data.sections.length, 4);
  assert.equal(paper.data.sections[0].locked, false);
  return token;
});

test('the answer key is never sent to the student', async () => {
  const joined = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Ben Cruz', student_no: 'S-002', class_section: '10-StMary'
  });
  const token = joined.data.token;
  await call('POST', `/api/s/${token}/start`, {});

  const item = await call('GET', `/api/s/${token}/item?i=0`);
  assert.equal(item.status, 200);
  const raw = JSON.stringify(item.data);
  assert.ok(!/"answer"/.test(raw), 'the response must not contain an answer field');
  // Not a bare /correct/i grep: a legitimate choice in the sample bank is
  // literally "Quoting a source and citing it correctly", so the word shows up
  // as ordinary choice text whenever the shuffle puts that item first. Assert
  // the real property instead — nothing marks which choice is right.
  assert.ok(!/"is_?correct"|"isCorrect"|"correct"\s*:/.test(raw), 'no choice may be flagged correct');
  for (const c of item.data.question.choices) {
    assert.deepEqual(
      Object.keys(c).sort(),
      ['key', 'label', 'text'],
      `choice ${c.label} must expose only key/label/text, got ${Object.keys(c).join(',')}`
    );
  }
  assert.equal(
    Object.keys(item.data.question).filter((k) => /answer|correct|solution|key$/i.test(k)).length,
    0,
    'the question object must not carry a key field'
  );
  assert.ok(item.data.question.choices.length >= 2);
});

test('two students receive different question orders', async () => {
  const order = async (name, no) => {
    const j = await call('POST', '/api/sessions', {
      access_code: accessCode, student_name: name, student_no: no, class_section: '10-StMary'
    });
    await call('POST', `/api/s/${j.data.token}/start`, {});
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const it = await call('GET', `/api/s/${j.data.token}/item?i=${i}`);
      ids.push(it.data.question.id);
    }
    return ids;
  };
  const a = await order('Carla Diaz', 'S-100');
  const b = await order('Dino Santos', 'S-101');
  assert.notDeepEqual(a, b, 'shuffling should give each student a different order');
  assert.equal(new Set(a).size, 5);
  assert.equal(new Set(b).size, 5);
});

test('answers are saved and graded on submit', async () => {
  const j = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Elsa Gomez', student_no: 'S-003', class_section: '10-StMary'
  });
  const token = j.data.token;
  await call('POST', `/api/s/${token}/start`, {});
  const paper = (await call('GET', `/api/s/${token}/paper`)).data;

  // Answer the first three multiple-choice items with choice key 0.
  for (const sec of paper.sections.slice(0, 1)) {
    for (const q of sec.questions.slice(0, 3)) {
      const saved = await call('POST', `/api/s/${token}/answer`, { questionId: q.id, value: 0 });
      assert.equal(saved.data.saved, true);
    }
  }

  const after = (await call('GET', `/api/s/${token}/paper`)).data;
  const answered = Object.values(after.answers).filter((v) => v !== '').length;
  assert.equal(answered, 3, 'exactly three answers should be stored');

  const submit = await call('POST', `/api/s/${token}/submit`, { confirm: true });
  assert.equal(submit.data.submitted, true);

  // Scores are withheld by default: the student sees a confirmation only.
  assert.equal(submit.data.showResult, false, 'results should be hidden from the student');
  assert.equal(submit.data.grade, null, 'no grade should be returned to the student');

  // The teacher still sees the mark.
  const detail = (await call('GET', `/api/teacher/session/${token}`, undefined, teacher)).data;
  assert.ok(detail.grade.max > 0, 'the teacher should still see a graded paper');
  assert.equal(Object.keys(detail.grade.items).length, 21);

  // A submitted paper can no longer be changed.
  const late = await call('POST', `/api/s/${token}/answer`, { questionId: 'x', value: 1 });
  assert.equal(late.status, 409);
});

test('students can revisit an earlier part when section locking is off', async () => {
  assert.equal(getSettings().lock_sections, '0', 'locking is off by default');

  const j = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Nora Vil', student_no: 'S-007', class_section: '10-StMary'
  });
  const token = j.data.token;
  await call('POST', `/api/s/${token}/start`, {});
  const paper = (await call('GET', `/api/s/${token}/paper`)).data;

  const moved = await call('POST', `/api/s/${token}/goto`, { index: paper.sections[1].start });
  assert.equal(moved.status, 200);
  const back = await call('POST', `/api/s/${token}/goto`, { index: 0 });
  assert.equal(back.status, 200, 'going back should be allowed');

  const firstQ = paper.sections[0].questions[0].id;
  const edit = await call('POST', `/api/s/${token}/answer`, { questionId: firstQ, value: 1 });
  assert.equal(edit.status, 200, 'an earlier answer should still be editable');
});

test('locked sections cannot be revisited once locking is enabled', async () => {
  setSettings({ lock_sections: '1' });
  try {
    const j = await call('POST', '/api/sessions', {
      access_code: accessCode, student_name: 'Felipe Lim', student_no: 'S-004', class_section: '10-StMary'
    });
    const token = j.data.token;
    await call('POST', `/api/s/${token}/start`, {});
    const paper = (await call('GET', `/api/s/${token}/paper`)).data;
    const secondStart = paper.sections[1].start;

    // Move into section 2, which locks section 1 behind us.
    const moved = await call('POST', `/api/s/${token}/goto`, { index: secondStart });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.maxSection, 1);

    const back = await call('POST', `/api/s/${token}/goto`, { index: 0 });
    assert.equal(back.status, 403);
    assert.match(back.data.error, /locked/i);

    // Editing an item in the locked section is refused too.
    const firstQ = paper.sections[0].questions[0].id;
    const edit = await call('POST', `/api/s/${token}/answer`, { questionId: firstQ, value: 0 });
    assert.equal(edit.status, 403);
  } finally {
    setSettings({ lock_sections: '0' });
  }
});

test('withheld results are not present anywhere in the student response', async () => {
  assert.equal(getSettings().show_result_to_student, '0', 'results are hidden by default');

  const j = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Ivy Mora', student_no: 'S-008', class_section: '10-StMary'
  });
  const token = j.data.token;
  await call('POST', `/api/s/${token}/start`, {});

  const paper = (await call('GET', `/api/s/${token}/paper`)).data;
  for (const q of paper.sections[0].questions.slice(0, 3)) {
    await call('POST', `/api/s/${token}/answer`, { questionId: q.id, value: 0 });
  }
  await call('POST', `/api/s/${token}/submit`, { confirm: true });

  // The raw JSON must not contain the mark — hiding it in the UI is not enough,
  // because the number would still be readable in the network response.
  const raw = await (await fetch(`${BASE}/api/s/${token}/result`)).text();
  assert.equal(JSON.parse(raw).summary, null, 'the summary must be omitted entirely');
  assert.doesNotMatch(raw, /"percent"/, 'no percentage should be sent');
  assert.doesNotMatch(raw, /"score"/, 'no score should be sent');
  assert.doesNotMatch(raw, /"correct"\s*:/, 'no correct count should be sent');
  assert.doesNotMatch(raw, /"awarded"/, 'no per-item marks should be sent');

  // The teacher still sees everything.
  const detail = (await call('GET', `/api/teacher/session/${token}`, undefined, teacher)).data;
  assert.ok(detail.grade.max > 0);
  assert.ok(typeof detail.grade.percent === 'number');

  // Turning results back on restores the student-facing summary.
  setSettings({ show_result_to_student: '1' });
  try {
    const shown = (await call('GET', `/api/s/${token}/result`)).data;
    assert.equal(shown.showResult, true);
    assert.ok(shown.summary && shown.summary.max > 0, 'the summary should come back');
    assert.ok(shown.items.length === 21, 'the item review should come back');
  } finally {
    setSettings({ show_result_to_student: '0' });
  }
});

test('integrity events are counted and flag the student at the limit', async () => {
  const j = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Grace Tan', student_no: 'S-005', class_section: '10-StMary'
  });
  const token = j.data.token;
  await call('POST', `/api/s/${token}/start`, {});

  const limit = Number(getSettings().max_violations);
  for (let i = 0; i < limit; i++) {
    await call('POST', `/api/s/${token}/flag`, { type: 'tab_hidden' });
  }
  const last = await call('POST', `/api/s/${token}/flag`, { type: 'tab_hidden' });
  assert.equal(last.data.count, limit + 1);
  assert.equal(last.data.flagged, true);

  const roster = (await call('GET', '/api/teacher/roster', undefined, teacher)).data;
  const me = roster.students.find((s) => s.token === token);
  assert.equal(me.flagged, true);
  assert.equal(me.violations, limit + 1);
});

test('the live roster reports progress in real time', async () => {
  const roster = (await call('GET', '/api/teacher/roster', undefined, teacher)).data;
  assert.ok(roster.students.length >= 5);
  assert.ok(roster.summary.total >= 5);
  assert.ok(Array.isArray(roster.feed), 'the snapshot must carry an activity feed');

  const ana = roster.students.find((s) => s.name === 'Ana Reyes');
  assert.ok(ana, 'Ana should appear in the roster');
  assert.equal(ana.total, 21);
  assert.ok(ana.secondsLeft <= 3600);
});

test('a teacher can extend the clock for one student', async () => {
  const roster = (await call('GET', '/api/teacher/roster', undefined, teacher)).data;
  const ana = roster.students.find((s) => s.name === 'Ana Reyes');
  const before = ana.secondsLeft;

  await call('POST', `/api/teacher/session/${ana.token}/action`, { action: 'extend', minutes: 10 }, teacher);
  const after = (await call('GET', '/api/teacher/roster', undefined, teacher)).data
    .students.find((s) => s.token === ana.token);
  assert.ok(after.secondsLeft >= before + 590, `expected ~+600s, got ${after.secondsLeft - before}`);
});

test('essay answers stay pending until the teacher grades them', async () => {
  const j = await call('POST', '/api/sessions', {
    access_code: accessCode, student_name: 'Hiro Reyes', student_no: 'S-006', class_section: '10-StMary'
  });
  const token = j.data.token;
  await call('POST', `/api/s/${token}/start`, {});
  const paper = (await call('GET', `/api/s/${token}/paper`)).data;
  const essay = paper.sections[3].questions[0];

  await call('POST', `/api/s/${token}/goto`, { index: essay.index });
  await call('POST', `/api/s/${token}/answer`, { questionId: essay.id, value: 'A thoughtful essay.' });
  const sub = await call('POST', `/api/s/${token}/submit`, { confirm: true });
  assert.equal(sub.data.showResult, false, 'the student should not see the pending mark');

  const detail = (await call('GET', `/api/teacher/session/${token}`, undefined, teacher)).data;
  assert.equal(detail.grade.pending, 15, 'the 15-point essay should be pending for the teacher');

  await call('POST', `/api/teacher/session/${token}/grade`,
    { questionId: essay.id, points: 12, note: 'Well argued.' }, teacher);

  const after = (await call('GET', `/api/teacher/session/${token}`, undefined, teacher)).data;
  assert.equal(after.grade.pending, 0);
  assert.equal(after.grade.items[essay.id].awarded, 12);
});

test('results summarise the class and export as CSV', async () => {
  const results = (await call('GET', '/api/teacher/results', undefined, teacher)).data;
  assert.ok(results.submitted >= 2);
  assert.ok(results.items.length === 21);
  assert.ok(Array.isArray(results.distribution) && results.distribution.length === 5);
});

test('the CSV export contains a header and every student', async () => {
  const res = await fetch(BASE + '/api/teacher/export.csv', {
    headers: { 'X-Teacher-Token': teacher }
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /Student Name/);
  assert.match(csv, /Ana Reyes/);
  assert.match(csv, /Hiro Reyes/);
});

test('grading is exact for objective items', async () => {
  const { gradeOne } = await import('../server/lib/exam.js');

  const mcq = { kind: 'mcq', choices: ['Alpha', 'Beta', 'Gamma'], answer: 'Beta', points: 2 };
  assert.equal(gradeOne(mcq, 1).points, 2);
  assert.equal(gradeOne(mcq, 0).points, 0);
  assert.equal(gradeOne(mcq, '').points, 0);

  const tf = { kind: 'truefalse', choices: ['True', 'False'], answer: 'True', points: 1 };
  assert.equal(gradeOne(tf, 0).points, 1);
  assert.equal(gradeOne(tf, 1).points, 0);

  const short = { kind: 'short', choices: [], answer: ['Manila', 'Maynila'], points: 2, hasAnswer: true };
  assert.equal(gradeOne(short, '  manila ').points, 2);
  assert.equal(gradeOne(short, 'MAYNILA').points, 2);
  assert.equal(gradeOne(short, 'Cebu').points, 0);

  const essay = { kind: 'essay', choices: [], answer: null, points: 15 };
  assert.equal(gradeOne(essay, 'anything').pending, true);
});

/**
 * Regression test: a student's paper carries choices as { key, text, label }
 * objects, not the flat strings the importer produces. Grading used to compare
 * against "[object Object]" and mark every correct answer wrong.
 */
test('a perfect paper built by buildPaper scores full marks', async () => {
  const { buildPaper, gradePaper } = await import('../server/lib/exam.js');
  const { getSettings } = await import('../server/lib/db.js');
  const settings = getSettings();

  for (const seed of [1, 4242, 999983]) {
    const paper = buildPaper({ order_seed: seed }, undefined, settings);
    const answers = {};

    // Answer every objective item correctly using the paper's own objects.
    const { getQuestions } = await import('../server/lib/db.js');
    const bank = new Map(getQuestions().map((q) => [q.id, q]));

    for (const section of paper) {
      for (const q of section.questions) {
        const truth = bank.get(q.id);
        if (q.kind === 'mcq') {
          answers[q.id] = { value: q.choices.find((c) => c.text === truth.answer).key };
        } else if (q.kind === 'truefalse') {
          answers[q.id] = { value: q.choices.find((c) => c.text === truth.answer).key };
        } else if (q.kind === 'multiselect') {
          answers[q.id] = { value: q.choices.filter((c) => truth.answer.includes(c.text)).map((c) => c.key) };
        } else if (q.kind === 'short') {
          const a = Array.isArray(truth.answer) ? truth.answer[0] : truth.answer;
          answers[q.id] = { value: a };
        } else {
          answers[q.id] = { value: 'An essay.' };
        }
      }
    }

    const grade = gradePaper(paper, answers);
    const objectiveMax = grade.max - 15; // minus the 15-point essay
    assert.equal(grade.score, objectiveMax,
      `seed ${seed}: every objective item should be correct (${grade.score}/${objectiveMax})`);
    assert.equal(grade.pending, 15, 'only the essay should remain pending');
    const wrong = Object.values(grade.items).filter((i) => i.status === 'wrong');
    assert.deepEqual(wrong.map((w) => w.prompt), [], 'nothing should be marked wrong');
  }
});

test('shuffling is deterministic for the same seed', async () => {
  const { buildPaper } = await import('../server/lib/exam.js');
  const { getSettings } = await import('../server/lib/db.js');
  const settings = getSettings();
  const a = buildPaper({ order_seed: 12345 }, undefined, settings);
  const b = buildPaper({ order_seed: 12345 }, undefined, settings);
  const c = buildPaper({ order_seed: 99999 }, undefined, settings);

  const ids = (p) => p.flatMap((s) => s.questions.map((q) => q.id));
  assert.deepEqual(ids(a), ids(b), 'the same seed must produce the same paper');
  assert.notDeepEqual(ids(a), ids(c), 'different seeds must produce different papers');
});

test('the text importer reads sections, choices, keys and points', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const text = `# Part A. Choice
Pick one.

1. What is 2 + 2?  [2]
A. three
B. four *
C. five

# Part B. True or False
2. The sky is blue.
Ans: TRUE

# Part C. Essay
3. Explain gravity. //  [10]`;

  const parsed = parseExamText(text);
  assert.equal(parsed.sections.length, 3);
  assert.equal(parsed.sections[0].questions[0].kind, 'mcq');
  assert.equal(parsed.sections[0].questions[0].answer, 'four');
  assert.equal(parsed.sections[0].questions[0].points, 2);
  assert.equal(parsed.sections[1].questions[0].kind, 'truefalse');
  assert.equal(parsed.sections[1].questions[0].answer, 'True');
  assert.equal(parsed.sections[2].questions[0].kind, 'essay');
  assert.equal(parsed.sections[2].questions[0].points, 10);
});

test('a points tag is read even when something follows it', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const parsed = parseExamText(`# Part I. Multiple Choice
1. Select every prime number. [3] (multi)
- 2 *
- 3 *
- 4

2. Which gas do plants use? (2 pts)
A. Oxygen
B. CO2 *

3. Explain photosynthesis. [5] //
`);
  const [first, second, third] = parsed.sections[0].questions;

  // Regression: the tag used to be end-anchored, so "[3] (multi)" lost both the
  // points and the multiselect flag, and left a literal "[3]" in the prompt.
  assert.equal(first.kind, 'multiselect');
  assert.equal(first.points, 3);
  assert.equal(first.prompt, 'Select every prime number.');
  assert.deepEqual(first.answer, ['2', '3']);

  assert.equal(second.points, 2);
  assert.equal(second.prompt, 'Which gas do plants use?');

  assert.equal(third.kind, 'essay');
  assert.equal(third.points, 5);
  assert.equal(third.prompt, 'Explain photosynthesis.');
});

test('a trailing answer key is applied back to the paper', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const parsed = parseExamText(`# Part I. Multiple Choice
Directions: Choose the letter of the correct answer.

1. Which of the following is a chemical change?
A. Melting of ice
B. Rusting of iron
C. Dissolving sugar

2. What is the smallest unit of an element?
A. Molecule
B. Atom
C. Compound

# Part II. True or False

3. Sound travels faster in water than in air.
4. The mitochondria is the powerhouse of the cell.

# Part III. Identification

5. The process by which plants make their own food.

ANSWER KEY
1. B    2. B
3. TRUE    4. FALSE
5. Photosynthesis
`);
  // Regression: the key block used to be parsed as paper content, which
  // invented a bogus item and left every real answer null.
  const [mcq, tf, ident] = parsed.sections;

  assert.deepEqual(parsed.keyApplied, [1, 2, 3, 4, 5]);
  assert.equal(parsed.warnings.length, 0, parsed.warnings.join('; '));

  assert.equal(mcq.questions.length, 2, 'the key must not create extra items');
  assert.equal(mcq.questions[0].answer, 'Rusting of iron');
  assert.equal(mcq.questions[1].answer, 'Atom');

  assert.equal(tf.questions[0].kind, 'truefalse');
  assert.equal(tf.questions[0].answer, 'True');
  assert.equal(tf.questions[1].answer, 'False');

  assert.equal(ident.questions[0].kind, 'short');
  assert.equal(ident.questions[0].answer, 'Photosynthesis');
});

test('an answer key may use ranges and one entry per line', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const parsed = parseExamText(`# Part I. Multiple Choice
1. One?
A. a
B. b
C. c

2. Two?
A. a
B. b
C. c

3. Three?
A. a
B. b
C. c

4. Four?
A. a
B. b
C. c

5. Five?
A. a
B. b
C. c

ANSWER KEY
1-3. B A C
4. A
5. C
`);
  const qs = parsed.sections[0].questions;

  assert.deepEqual(parsed.keyApplied, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    qs.map((q) => q.answer),
    ['b', 'a', 'c', 'a', 'c']
  );
});

test('an inline star still wins over a contradicting key sheet', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const parsed = parseExamText(`# Part I. Multiple Choice
1. Which is marked inline?
A. inline *
B. other
C. third

2. Which is not marked?
A. a
B. b
C. c

ANSWER KEY
1. C
2. B
`);
  const [first, second] = parsed.sections[0].questions;

  assert.equal(first.answer, 'inline', 'the inline marker should beat the key sheet');
  assert.equal(second.answer, 'b', 'the key should fill in the unmarked item');
  assert.deepEqual(parsed.keyApplied, [2], 'item 1 was already marked inline');
});

test('a stray "Answer" heading does not swallow the paper', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const parsed = parseExamText(`# Part I. Multiple Choice
1. Which is prime?
A. 4
B. 7 *

Answer the following questions carefully.

2. Which is even?
A. 3
B. 8 *
`);
  // Only one key-like entry follows the stray heading, which is not enough to
  // treat it as an answer sheet, so both items must survive untouched.
  assert.equal(parsed.sections[0].questions.length, 2);
  assert.equal(parsed.sections[0].questions[0].answer, '7');
  assert.equal(parsed.sections[0].questions[1].answer, '8');
});

test('a part heading is not mistaken for the exam title', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');

  // Regression: the first "#" heading was always taken as the title, so a paper
  // opening straight into a part heading lost that part's name and the exam was
  // titled "PART I. MULTIPLE CHOICE".
  const opensOnPart = parseExamText(`# PART I. MULTIPLE CHOICE
Directions: Choose the letter of the best answer.

1. Which of these is prime?
A. 4
B. 7 *
`);
  assert.equal(opensOnPart.title, 'Imported Exam');
  assert.equal(opensOnPart.sections[0].title, 'Part I. Multiple Choice');

  const withTitle = parseExamText(`# GE ELEC 103 Midterm Exam
# PART I. MULTIPLE CHOICE

1. Which of these is prime?
A. 4
B. 7 *
`);
  assert.equal(withTitle.title, 'GE ELEC 103 Midterm Exam');
  assert.equal(withTitle.sections[0].title, 'Part I. Multiple Choice');

  const titleOnly = parseExamText(`# My Exam Title
1. Which of these is prime?
A. 4
B. 7 *
`);
  assert.equal(titleOnly.title, 'My Exam Title');
});

test('an ordinary title is never read as a roman-numeral part', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');

  // Regression: "[ivxlcdm]+" matches the start of ordinary words, so "Midterm"
  // parsed as part "Mid", "Laws" as part "L", "My" as part "M".
  for (const title of [
    'Midterm Exam in Circuits and Devices',
    'Laws of Motion',
    'My Exam Title',
    'I Am a Legend'
  ]) {
    const parsed = parseExamText(`# ${title}
1. Which of these is prime?
A. 4
B. 7 *
`);
    assert.equal(parsed.title, title, `"${title}" should stay the exam title`);
    assert.equal(parsed.sections[0].title, 'Part 1');
  }
});

test('choices collapsed onto one line are split apart', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  // Copying a paper out of a PDF usually puts every option on a single line.
  const parsed = parseExamText(`# Part I. Multiple Choice
1. Which of the following is a chemical change?
A. Melting of ice    B. Rusting of iron    C. Dissolving sugar    D. Breaking glass
2. What is the smallest unit of an element?
A. Molecule    B. Atom    C. Compound    D. Ion

ANSWER KEY
1. B    2. B
`);
  const qs = parsed.sections[0].questions;

  assert.deepEqual(qs[0].choices, ['Melting of ice', 'Rusting of iron', 'Dissolving sugar', 'Breaking glass']);
  assert.deepEqual(qs[1].choices, ['Molecule', 'Atom', 'Compound', 'Ion']);
  assert.equal(qs[0].answer, 'Rusting of iron');
  assert.equal(qs[1].answer, 'Atom');
  for (const q of qs) {
    for (const c of q.choices) {
      assert.ok(!/^[A-J]\s*[.)]/.test(c), `choice "${c}" still carries its letter marker`);
    }
  }
});

test('one-line choices honour a star and a tab separator', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const starred = parseExamText(`# Part I. Multiple Choice
1. Which of the following is a chemical change?
A. Melting of ice    B. Rusting of iron *    C. Dissolving sugar
`);
  assert.equal(starred.sections[0].questions[0].answer, 'Rusting of iron');

  const tabbed = parseExamText(`# Part I. Multiple Choice
1. Pick one.
A) alpha\tB) beta *\tC) gamma
`);
  const q = tabbed.sections[0].questions[0];
  assert.deepEqual(q.choices, ['alpha', 'beta', 'gamma']);
  assert.equal(q.answer, 'beta');
});

test('prose is not chopped into choices', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  // A single space before a letter marker must not start a new choice, or any
  // sentence containing "x. B." would be shredded.
  const parsed = parseExamText(`# Part I. Identification
1. The value of x. B. is 5 and it matters.
Ans: five
`);
  const q = parsed.sections[0].questions[0];

  assert.equal(q.kind, 'short');
  assert.deepEqual(q.choices, []);
  assert.equal(q.answer, 'five');
  assert.equal(q.prompt, 'The value of x. B. is 5 and it matters.');
});

test('a paper written without "#" markers still splits into parts', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  // Regression: bare "PART I. MULTIPLE CHOICE" lines were ignored, so a whole
  // four-part paper collapsed into one unnamed section and the title line was
  // swallowed as instructions.
  const parsed = parseExamText(`GE ELEC 103 - Midterm Examination

PART I. MULTIPLE CHOICE
Directions: Choose the letter of the correct answer.

1. Which of the following is a chemical change?
A. Melting of ice    B. Rusting of iron    C. Dissolving sugar

PART II. TRUE OR FALSE
Directions: Write TRUE if the statement is correct.

2. Sound travels faster in water than in air.

PART III. IDENTIFICATION

3. The process by which plants make their own food.

PART IV. ESSAY

4. Explain the importance of renewable energy. //  [10]

ANSWER KEY
1. B
2. TRUE
3. Photosynthesis
`);

  assert.equal(parsed.title, 'GE ELEC 103 - Midterm Examination');
  assert.deepEqual(parsed.sections.map((s) => s.title), [
    'Part I. Multiple Choice',
    'Part II. True Or False',
    'Part III. Identification',
    'Part IV. Essay'
  ]);
  assert.deepEqual(parsed.keyApplied, [1, 2, 3]);
  assert.equal(parsed.warnings.length, 0, parsed.warnings.join('; '));

  const kinds = parsed.sections.flatMap((s) => s.questions.map((q) => q.kind));
  assert.deepEqual(kinds, ['mcq', 'truefalse', 'short', 'essay']);
  assert.equal(parsed.sections[3].questions[0].points, 10);
  assert.match(parsed.sections[0].instructions, /Choose the letter of the correct answer/);
});

test('the dashboard importer and the document converter agree on headings', async () => {
  const { parseExamText } = await import('../server/lib/importer.js');
  const parsed = parseExamText(`PART I. MULTIPLE CHOICE
1. Which of these is prime?
A. 4
B. 7 *

PART II. TRUE OR FALSE
2. Water boils at 100 C.
`);
  // tools/doc2exam.py normalises these to title case; the two must match or the
  // same paper imports differently depending on which route is used.
  assert.deepEqual(parsed.sections.map((s) => s.title), [
    'Part I. Multiple Choice',
    'Part II. True Or False'
  ]);
});

test('the teacher API refuses anonymous callers', async () => {
  const { status } = await call('GET', '/api/teacher/roster');
  assert.equal(status, 401);
});
