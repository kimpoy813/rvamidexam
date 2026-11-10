/** Validation and import preview for the original sectioned exam format.
 * These helpers are internal until the full PostgreSQL routes are connected. */
import { parseAny } from '../lib/importer.js';
import { normalizeAnswer } from '../lib/exam-engine.js';
const invalid = message => Object.assign(new Error(message), { status:400 });

export function normalizeBlueprint(sections) {
  if (!Array.isArray(sections) || sections.length > 100) throw invalid('Invalid sections.');
  let total = 0;
  return sections.map((s, si) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.questions)) throw invalid(`Invalid part ${si + 1}.`);
    const title = String(s.title || `Part ${si + 1}`).trim(), instructions = String(s.instructions || '').trim(), minutes = Number(s.minutes ?? 0);
    if (!title || title.length > 200 || instructions.length > 10000 || !Number.isInteger(minutes) || minutes < 0 || minutes > 600) throw invalid(`Invalid details for part ${si + 1}.`);
    return { title, instructions, minutes, lock_after:s.lock_after !== false, questions:s.questions.map((q, qi) => {
      if (++total > 1000) throw invalid('Too many questions.');
      const where = `part ${si + 1}, question ${qi + 1}`;
      if (!q || typeof q !== 'object') throw invalid(`Invalid question at ${where}.`);
      const kind = q.kind || 'mcq', prompt = String(q.prompt || '').trim(), points = Number(q.points ?? 1);
      let choices = q.choices ?? [], answer = q.answer ?? null;
      if (!['mcq','multiselect','truefalse','short','essay'].includes(kind) || !prompt || prompt.length > 10000 || !Number.isFinite(points) || points < 0 || points > 1000 || !Array.isArray(choices) || choices.length > 20 || choices.some(c => typeof c !== 'string' || !c.trim() || c.length > 2000)) throw invalid(`Invalid question details at ${where}.`);
      choices = choices.map(c => c.trim());
      if (kind === 'truefalse' && !choices.length) choices = ['True','False'];
      if (['mcq','multiselect'].includes(kind) && choices.length < 2) throw invalid(`At least two choices are required at ${where}.`);
      if (kind === 'truefalse' && (choices.length !== 2 || new Set(choices.map(normalizeAnswer)).size !== 2 || !choices.every(c => ['true','false'].includes(normalizeAnswer(c))))) throw invalid(`True/false choices must be True and False at ${where}.`);
      if (['short','essay'].includes(kind) && choices.length) throw invalid(`Text questions cannot have choices at ${where}.`);
      if (choices.length && new Set(choices.map(normalizeAnswer)).size !== choices.length) throw invalid(`Choices must be distinct at ${where}.`);
      if (answer !== null && !(typeof answer === 'string' || (Array.isArray(answer) && answer.length <= 20 && answer.every(a => typeof a === 'string')))) throw invalid(`Invalid answer key at ${where}.`);
      if (JSON.stringify(answer).length > 20000) throw invalid(`Answer key is too long at ${where}.`);
      if (kind === 'essay' && answer !== null) throw invalid(`Essay questions are manually graded at ${where}.`);
      if (kind === 'multiselect' && answer !== null && (!Array.isArray(answer) || !answer.length)) throw invalid(`Multiple answers must be a non-empty list at ${where}.`);
      if (['mcq','truefalse'].includes(kind) && answer !== null && typeof answer !== 'string') throw invalid(`A single answer is required at ${where}.`);
      if (kind === 'short' && answer !== null && !(typeof answer === 'string' || (Array.isArray(answer) && answer.length))) throw invalid(`Invalid short-answer key at ${where}.`);
      if (answer !== null) {
        const answers = (Array.isArray(answer) ? answer : [answer]).map(a => a.trim());
        if (answers.some(a => !normalizeAnswer(a))) throw invalid(`Blank answer key at ${where}.`);
        if (['mcq','multiselect','truefalse'].includes(kind) && answers.some(a => !choices.some(c => normalizeAnswer(a) === normalizeAnswer(c)))) throw invalid(`The answer key does not match a choice at ${where}.`);
        if (kind === 'multiselect' && new Set(answers.map(normalizeAnswer)).size !== answers.length) throw invalid(`Duplicate answers at ${where}.`);
        answer = Array.isArray(answer) ? answers : answers[0];
      }
      return { kind, prompt, points, choices, answer, shuffle:q.shuffle !== false, tags:String(q.tags || '').slice(0,2000) };
    }) };
  });
}

export function previewOriginalImport(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 200000) throw invalid('Provide up to 200 KB of exam text.');
  let parsed;
  try { parsed = parseAny(text); } catch (e) { throw invalid(`Could not parse exam: ${e.message}`); }
  const sections = normalizeBlueprint(parsed.sections);
  if (!sections.some(s => s.questions.length)) throw invalid('No questions found.');
  const warnings = [...(parsed.warnings || [])];
  sections.forEach((s, i) => s.questions.forEach((q, j) => {
    if (q.kind !== 'essay' && q.answer === null) warnings.push(`Part ${i + 1}, question ${j + 1} has no answer key and requires manual grading.`);
  }));
  return { title:String(parsed.title || 'Imported Exam'), titleExplicit:!!parsed.titleExplicit, sections, warnings };
}
