/**
 * Exam engine: deterministic per-student randomisation, one-question-at-a-time
 * delivery, and automatic grading.
 */
import { getExamBlueprint, getExamSettings, getQuestions } from './db.js';

/* --------------------------------------------------------------- shuffling */

/** Deterministic PRNG (mulberry32) so a student always gets the same paper. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleWith(list, rand) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Stable 32-bit string hash so choice order is tied to the question, not index. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------------------------------- student's paper */

/**
 * Builds the ordered paper for one session. Question order is shuffled once per
 * student (seeded), choice order is shuffled per question. The result is stable
 * for the life of the session, so refreshing never reshuffles the paper.
 */
export function buildPaper(session, blueprint, settings) {
  const examId = session?.exam_id;
  if (!blueprint) blueprint = getExamBlueprint(examId);
  if (!settings) settings = getExamSettings(examId);
  const shuffleQuestions = settings.shuffle_questions === '1';
  const shuffleChoices = settings.shuffle_choices === '1';

  return blueprint.map((section, sectionIndex) => {
    let questions = section.questions;
    if (shuffleQuestions && questions.length > 1) {
      const rand = rng((session.order_seed ^ hashString(section.id)) >>> 0);
      questions = shuffleWith(questions, rand);
    }
    return {
      ...section,
      sectionIndex,
      lock_after: settings.lock_sections === '1' ? section.lock_after : false,
      questions: questions.map((q) => {
        // A true/false item may be stored without explicit options (the seed
        // and a hand-written JSON import both allow that). Always present the
        // two options so grading and the student UI agree on what "0" means.
        const source = q.kind === 'truefalse' && !q.choices.length
          ? ['True', 'False']
          : q.choices;

        let choices = source.map((text, key) => ({ key, text }));
        if (shuffleChoices && q.shuffle && choices.length > 1) {
          const rand = rng((session.order_seed ^ hashString(q.id)) >>> 0);
          choices = shuffleWith(choices, rand);
        }
        return {
          id: q.id,
          kind: q.kind,
          prompt: q.prompt,
          points: q.points,
          choices: choices.map((c, i) => ({ ...c, label: letter(i) })),
          hasAnswer: q.answer != null
        };
      })
    };
  });
}

export function letter(i) {
  return String.fromCharCode(65 + (i % 26));
}

export function flattenPaper(paper) {
  return paper.flatMap((s) => s.questions.map((q) => ({ section: s, question: q })));
}

/* ---------------------------------------------------------------- grading */

export function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Grades one answer.
 * Returns { correct: boolean|null, points, pending }
 * `correct === null` means "needs a human" (essay, unreferenced short answer).
 */
export function gradeOne(question, value) {
  if (value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0)) {
    return { correct: false, points: 0, pending: false, blank: true };
  }

  switch (question.kind) {
    case 'mcq': {
      const chosen = choiceText(question, value);
      const right = String(question.answer ?? '');
      return match(chosen, right)
        ? { correct: true, points: question.points }
        : { correct: false, points: 0 };
    }
    case 'multiselect': {
      const chosen = new Set((Array.isArray(value) ? value : [value]).map((v) => choiceText(question, v)));
      const right = new Set((question.answer || []).map(normalizeAnswer));
      const wrong = [...chosen].some((c) => !right.has(c));
      const complete = [...right].every((r) => chosen.has(r));
      if (complete && !wrong) return { correct: true, points: question.points };
      if (!wrong && chosen.size > 0) {
        // Partial credit, proportional to the share of correct options chosen.
        const share = chosen.size / Math.max(1, right.size);
        return { correct: null, points: +(question.points * share * 0.5).toFixed(3) };
      }
      return { correct: false, points: 0 };
    }
    case 'truefalse': {
      // The client submits the index of the chosen option, so map it back to
      // its text before comparing with the stored key.
      const chosen = choiceText(question, value);
      const right = normalizeAnswer(question.answer);
      return chosen === right
        ? { correct: true, points: question.points }
        : { correct: false, points: 0 };
    }
    case 'short': {
      if (!question.hasAnswer) return { correct: null, points: 0, pending: true };
      const accepted = (Array.isArray(question.answer) ? question.answer : [question.answer])
        .map(normalizeAnswer)
        .filter(Boolean);
      const given = normalizeAnswer(value);
      return accepted.includes(given)
        ? { correct: true, points: question.points }
        : { correct: false, points: 0 };
    }
    case 'essay':
      return { correct: null, points: 0, pending: true };
    default:
      return { correct: null, points: 0, pending: true };
  }
}

/**
 * Resolves a submitted choice to its text.
 *
 * Choices arrive in two shapes depending on where the question came from:
 *   - the raw bank / importer:  ['Alpha', 'Beta']
 *   - a student's paper:        [{ key: 0, text: 'Alpha', label: 'A' }, …]
 * Both must grade identically.
 */
function choiceText(question, key) {
  const idx = Number(key);
  if (!Number.isFinite(idx)) return normalizeAnswer(key);

  const list = question.choices || [];
  // A student's paper stores choices as objects that carry their original bank
  // index in `key`. That index is what the browser submits, and after shuffling
  // it is NOT the array position — so look it up by `key` first.
  const choice =
    list.find((c) => c != null && typeof c === 'object' && c.key === idx) ?? list[idx];

  if (choice != null) {
    return normalizeAnswer(typeof choice === 'object' ? choice.text : choice);
  }
  return normalizeAnswer(key);
}

/** Human-readable form of a submitted answer, for review screens and exports. */
export function givenText(question, value) {
  if (value === null || value === undefined || value === '') return '';
  const list = question.choices || [];
  const resolve = (v) => {
    const idx = Number(v);
    const hit = Number.isFinite(idx)
      ? list.find((c) => c != null && typeof c === 'object' && c.key === idx) ?? list[idx]
      : undefined;
    if (hit != null) return typeof hit === 'object' ? hit.text : String(hit);
    return String(v);
  };
  if (Array.isArray(value)) return value.map(resolve).join(' + ');
  if (['mcq', 'multiselect', 'truefalse'].includes(question.kind)) return resolve(value);
  return String(value);
}

function match(a, b) {
  return normalizeAnswer(a) === normalizeAnswer(b);
}

/**
 * Grades a whole submitted paper.
 * @returns {{score, max, pending, items: Object}}
 */
export function gradePaper(paper, answers, manualScores = {}, examId) {
  let score = 0;
  let max = 0;
  let pending = 0;
  const items = {};

  // A student's paper never carries the answer key (see buildPaper), so the key
  // is resolved here from the authoritative bank. Grading can therefore not
  // silently depend on whatever the student-facing shape happens to contain.
  const bank = new Map(getQuestions(examId).map((q) => [q.id, q]));

  for (const section of paper) {
    for (const q of section.questions) {
      const given = answers[q.id]?.value;
      const manual = manualScores[q.id];

      // Grade against the bank's copy of the item, which carries the key.
      const source = bank.get(q.id);
      const gradeable = source
        ? {
            ...q,
            kind: source.kind,
            points: source.points,
            choices: q.choices.length ? q.choices : source.choices,
            answer: source.answer ?? null,
            hasAnswer: source.answer != null
          }
        : { ...q, answer: null, hasAnswer: false };

      const auto = gradeOne(gradeable, given);
      max += gradeable.points;

      let points = auto.points;
      let correct = auto.correct;
      let status = auto.correct === true ? 'correct' : auto.correct === false ? 'wrong' : 'manual';

      if (manual && typeof manual.points === 'number') {
        points = Math.max(0, Math.min(gradeable.points, manual.points));
        correct = points >= gradeable.points * 0.999;
        status = 'manual';
      } else if (auto.pending) {
        pending += gradeable.points;
      }

      score += points;
      items[q.id] = {
        questionId: q.id,
        sectionId: section.id,
        kind: gradeable.kind,
        prompt: q.prompt,
        points: gradeable.points,
        given: given ?? null,
        givenText: givenText(gradeable, given ?? ''),
        expected: gradeable.hasAnswer ? gradeable.answer : null,
        correct,
        status,
        awarded: +points.toFixed(3),
        manualNote: manual?.note || ''
      };
    }
  }

  return {
    score: +score.toFixed(3),
    max: +max.toFixed(3),
    pending: +pending.toFixed(3),
    percent: max ? +((score / max) * 100).toFixed(1) : 0,
    items
  };
}

/* ------------------------------------------------------------ statistics */

export function itemAnalysis(paper, gradedSessions) {
  const rows = [];
  for (const section of paper) {
    for (const q of section.questions) {
      let answered = 0;
      let correct = 0;
      const options = {};
      for (const g of gradedSessions) {
        const item = g.items[q.id];
        if (!item) continue;
        if (item.given !== null && item.given !== undefined && item.given !== '') {
          answered++;
          const key = Array.isArray(item.given)
            ? item.given.map((v) => String(v)).join('+')
            : String(item.given);
          options[key] = (options[key] || 0) + 1;
        }
        if (item.correct === true) correct++;
      }
      rows.push({
        sectionId: section.id,
        sectionTitle: section.title,
        questionId: q.id,
        kind: q.kind,
        prompt: q.prompt,
        points: q.points,
        answered,
        correct,
        difficulty: answered ? +(correct / answered).toFixed(2) : null,
        optionCounts: options
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------- CSV */

export function toCsv(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
