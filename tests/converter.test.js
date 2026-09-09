/**
 * Tests for tools/doc2exam.py.
 *
 * Only the plain-text path is exercised here, because that needs nothing but
 * the standard library. The .docx/.pdf/.xlsx readers sit behind imports inside
 * their own functions, so this suite runs anywhere python3 exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const TOOL = new URL('../tools/doc2exam.py', import.meta.url).pathname;

const dir = mkdtempSync(path.join(tmpdir(), 'rvm-conv-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let python = null;
try {
  await run('python3', ['--version']);
  python = 'python3';
} catch {
  python = null;
}

async function convert(text, args = []) {
  const file = path.join(dir, `exam-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, text, 'utf8');
  const { stdout } = await run(python, [TOOL, file, ...args]);
  return stdout;
}

const PAPER = `MIDTERM EXAMINATION IN SCIENCE
Grade 10 - Second Semester

PART I. MULTIPLE CHOICE
Directions: Choose the letter of the correct answer.

1. Which of the following is a chemical change?
A. Melting of ice
B. Rusting of iron
C. Dissolving sugar
D. Breaking glass

2. What do you call the smallest unit of an element?
A. Molecule
B. Atom
C. Compound
D. Ion

PART II. TRUE OR FALSE
Directions: Write TRUE if the statement is correct.

3. Sound travels faster in water than in air.
4. The mitochondria is the powerhouse of the cell.

PART III. IDENTIFICATION

5. The process by which plants make their own food.

ANSWER KEY
1. B   2. B   3. TRUE   4. FALSE
5. Photosynthesis
`;

test('python3 is available to run the converter', (t) => {
  if (!python) t.skip('python3 not found');
  assert.ok(python);
});

test('reads the title, parts and instructions from a plain paper', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(PAPER));

  assert.equal(out.title, 'MIDTERM EXAMINATION IN SCIENCE');
  assert.equal(out.sections.length, 3);
  assert.deepEqual(
    out.sections.map((s) => s.title),
    // The roman numeral keeps its written case; only the label is title-cased.
    ['Part I. Multiple Choice', 'Part II. True Or False', 'Part III. Identification'],
    'part headings should be detected case-insensitively'
  );
  assert.match(out.sections[0].instructions, /Choose the letter of the correct answer/);
});

test('applies a separate answer key sheet to lettered items', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(PAPER));
  const mcq = out.sections[0].questions;

  assert.equal(mcq.length, 2);
  assert.equal(mcq[0].kind, 'mcq');
  assert.equal(mcq[0].answer, 'Rusting of iron', 'key "1. B" should resolve to choice B');
  assert.equal(mcq[1].answer, 'Atom', 'key "2. B" should resolve to choice B');
  assert.equal(mcq[0].choices.length, 4);
});

test('turns TRUE/FALSE keys into true/false items', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(PAPER));
  const tf = out.sections[1].questions;

  assert.equal(tf.length, 2);
  assert.equal(tf[0].kind, 'truefalse');
  assert.equal(tf[0].answer, 'True');
  assert.equal(tf[1].answer, 'False');
  assert.deepEqual(tf[0].choices, ['True', 'False']);
});

test('turns a free-text key into an identification item', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(PAPER));
  const ident = out.sections[2].questions;

  assert.equal(ident.length, 1);
  assert.equal(ident[0].kind, 'short');
  assert.equal(ident[0].answer, 'Photosynthesis');
  assert.equal(ident[0].shuffle, false, 'identification answers must not be shuffled');
});

test('an inline * beats the key sheet', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(`QUIZ
PART I. MULTIPLE CHOICE
1. Pick one.
A. wrong
B. wrong too
C. right *

ANSWER KEY
1. A
`));
  assert.equal(out.sections[0].questions[0].answer, 'right',
    'the inline marker should win over a contradicting key');
});

test('points, essays and multiselect markers are honoured', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(`QUIZ
PART I. MULTIPLE CHOICE
1. Worth three.  [3]
A. a *
B. b

2. Pick every prime. [4] (multi)
- 2 *
- 3 *
- 4

PART II. ESSAY
3. Explain the water cycle. //  [10]
`));
  const [mcqSection, essaySection] = out.sections;
  assert.equal(mcqSection.questions[0].points, 3);
  assert.equal(mcqSection.questions[1].kind, 'multiselect');
  assert.equal(mcqSection.questions[1].points, 4);
  assert.deepEqual(mcqSection.questions[1].answer, ['2', '3']);
  assert.equal(essaySection.questions[0].kind, 'essay');
  assert.equal(essaySection.questions[0].points, 10);
});

test('--check reports without emitting JSON', async (t) => {
  if (!python) return t.skip('python3 not found');
  const file = path.join(dir, 'check.txt');
  writeFileSync(file, PAPER, 'utf8');
  const { stdout, stderr } = await run(python, [TOOL, file, '--check']);

  assert.equal(stdout.trim(), '', '--check should print nothing to stdout');
  assert.match(stderr, /questions\s+5/);
  assert.match(stderr, /answer key\s+applied to 5 items/);
});

test('items with no key at all are flagged, not dropped', async (t) => {
  if (!python) return t.skip('python3 not found');
  const file = path.join(dir, 'nokey.txt');
  writeFileSync(file, `QUIZ
PART I. IDENTIFICATION
1. Something with no answer supplied.
`, 'utf8');
  const { stdout, stderr } = await run(python, [TOOL, file]);
  const out = JSON.parse(stdout);

  assert.equal(out.sections[0].questions.length, 1, 'the item must be kept');
  assert.equal(out.sections[0].questions[0].answer, null);
  assert.match(stderr, /no answer key provided/);
});

test('the output imports into the server question format', async (t) => {
  if (!python) return t.skip('python3 not found');
  const out = JSON.parse(await convert(PAPER));
  const { parseExamJson } = await import('../server/lib/importer.js');

  // The server's own JSON importer must accept exactly what the tool emits.
  const parsed = parseExamJson(JSON.stringify(out));
  assert.equal(parsed.sections.length, 3);
  assert.equal(parsed.sections.reduce((n, s) => n + s.questions.length, 0), 5);
  assert.equal(parsed.sections[0].questions[0].answer, 'Rusting of iron');
});
