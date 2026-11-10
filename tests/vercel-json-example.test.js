import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExamJson } from '../server/lib/importer.js';
import { normalizeBlueprint } from '../server/neon/blueprint.js';

test('teacher JSON example imports as a valid bank with all five question types', async () => {
  const html = await readFile(new URL('../public/neon-teacher.html', import.meta.url), 'utf8');
  const sample = html.match(/<pre id="jsonSample">([\s\S]*?)<\/pre>/);
  assert.ok(sample, 'JSON example is present in the teacher dashboard');
  const parsed = parseExamJson(sample[1]);
  assert.equal(parsed.title, 'Sample Exam');
  assert.deepEqual(parsed.sections.flatMap(s => s.questions.map(q => q.kind)), ['mcq', 'multiselect', 'truefalse', 'short', 'essay']);
  const normalized = normalizeBlueprint(parsed.sections);
  assert.equal(normalized[0].questions[0].answer, 'Mercury');
  assert.deepEqual(normalized[0].questions[1].answer, ['2', '3']);
  assert.equal(normalized[1].questions[1].answer, null);
});
