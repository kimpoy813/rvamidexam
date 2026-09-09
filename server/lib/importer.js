/**
 * Importers: turn a teacher's question text (or JSON/CSV) into the exam
 * structure stored in the database.
 *
 * Supported plain-text grammar
 * ----------------------------
 *   # Part I. Multiple Choice        -> new section (title)
 *   Choose the best answer.          -> section instructions (lines before item 1)
 *
 *   1. What is 2 + 2?  [2]           -> item, worth 2 points
 *   A. three
 *   B. four *                        -> trailing * marks the correct choice
 *   C. five
 *
 *   2. Pick every prime number [3] (multi)
 *   - 2 *
 *   - 3 *
 *   - 4
 *
 *   3. The exam lasts one hour.      -> "Ans:" gives the key
 *   Ans: TRUE                        -> TRUE/FALSE keys become a True/False item
 *
 *   4. Capital of the Philippines?
 *   Ans: Manila | Maynila            -> "|" lists accepted spellings
 *
 *   5. Explain the water cycle. //   -> "//" marks an essay (graded manually)
 */

const LETTER_CHOICE = /^\s*([A-J])\s*[.)]\s*(.+)$/i;
const BULLET_CHOICE = /^\s*[-*•]\s+(.+)$/;
const ITEM_START = /^\s*(\d+)\s*[.)]\s+(.*)$/;
const ANSWER_LINE = /^\s*(?:ans|answer|key)\s*:?\s*(.+)$/i;
// Not end-anchored: the documented form is "3. Prompt [3] (multi)", where the
// marker sits before the multiselect flag rather than at the end of the line.
const POINTS_TAG = /\[\s*(\d+(?:\.\d+)?)\s*\]/;
const POINTS_WORDS = /\(\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?)\s*\)/i;

export function parseExamText(text, fallbackTitle = 'Imported Exam') {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const warnings = [];
  const sections = [];
  let section = null;
  let item = null;
  let title = fallbackTitle;
  let titleSeen = false;

  const pushSection = (name, index) => {
    section = {
      title: name.trim() || `Part ${index + 1}`,
      instructions: '',
      questions: []
    };
    sections.push(section);
    item = null;
  };

  const pushItem = (rawPrompt) => {
    if (!section) pushSection(`Part ${sections.length + 1}`, sections.length);
    let prompt = rawPrompt;
    let points = 1;
    let forcedKind = null;

    // Strip the marker wherever it sits rather than truncating the line, so a
    // trailing "(multi)" or "//" after the points tag still gets read.
    for (const tag of [POINTS_TAG, POINTS_WORDS]) {
      const m = prompt.match(tag);
      if (m) {
        points = parseFloat(m[1]);
        prompt = prompt.replace(m[0], '').trim();
        break;
      }
    }
    if (/\(\s*multi(?:ple)?\s*\)/i.test(prompt)) {
      forcedKind = 'multiselect';
      prompt = prompt.replace(/\(\s*multi(?:ple)?\s*\)/i, '').trim();
    }
    if (/(^|\s)\/\/\s*$/.test(prompt)) {
      forcedKind = 'essay';
      prompt = prompt.replace(/\/\/\s*$/, '').trim();
    }

    item = {
      prompt,
      points,
      choices: [],
      starred: [],
      answerLine: null,
      forcedKind,
      essayFlag: false
    };
    section.questions.push(item);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // ---- section heading
    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, '').trim();
      if (!titleSeen) {
        title = heading;
        titleSeen = true;
        continue;
      }
      pushSection(heading, sections.length);
      continue;
    }

    // ---- new item
    const itemMatch = line.match(ITEM_START);
    if (itemMatch && !/^\s*[A-J]\s*[.)]\s/i.test(line)) {
      if (!itemMatch[2].trim()) continue;
      pushItem(itemMatch[2]);
      continue;
    }

    // ---- answer key line
    const answerMatch = line.match(ANSWER_LINE);
    if (answerMatch && item) {
      item.answerLine = answerMatch[1].trim();
      continue;
    }

    // ---- essay marker on its own line
    if (/^\/\/+\s*$/.test(line) && item) {
      item.essayFlag = true;
      continue;
    }

    // ---- choices
    const letterMatch = line.match(LETTER_CHOICE);
    const bulletMatch = line.match(BULLET_CHOICE);
    if (item && (letterMatch || bulletMatch)) {
      let text0 = (letterMatch ? letterMatch[2] : bulletMatch[1]).trim();
      const starred = /\*\s*$/.test(text0);
      if (starred) text0 = text0.replace(/\*\s*$/, '').trim();
      // A bullet line may also be a plain instruction; only treat it as a
      // choice when the item has no answer key yet and looks like an option.
      item.choices.push(text0);
      if (starred) item.starred.push(item.choices.length - 1);
      continue;
    }

    // ---- anything else is section instructions or a wrapped prompt line
    if (!item) {
      if (!section) pushSection(`Part ${sections.length + 1}`, sections.length);
      section.instructions += (section.instructions ? ' ' : '') + line.trim();
    } else if (!item.choices.length && !item.answerLine) {
      item.prompt += ' ' + line.trim();
    }
  }

  // ---- resolve kinds and answers
  const resolved = sections
    .map((sec) => ({
      title: sec.title,
      instructions: sec.instructions.trim(),
      questions: sec.questions.map((q, i) => resolveQuestion(q, sec, i, warnings))
    }))
    .filter((sec) => sec.questions.length);

  if (!resolved.length) {
    warnings.push('No questions were found. Check that each item starts with a number like "1."');
  }

  return { title, sections: resolved, warnings };
}

function resolveQuestion(q, sec, index, warnings) {
  const where = `${sec.title} · item ${index + 1}`;

  if (q.forcedKind === 'essay' || q.essayFlag) {
    if (q.forcedKind === 'essay' && q.choices.length) {
      warnings.push(`${where}: essay marker used but choices were listed — choices ignored.`);
    }
    return { kind: 'essay', prompt: q.prompt, points: q.points, choices: [], answer: null };
  }

  if (q.choices.length) {
    if (q.starred.length === 0) {
      warnings.push(`${where}: no correct choice marked with "*". It will need manual grading.`);
      return {
        kind: 'mcq',
        prompt: q.prompt,
        points: q.points,
        choices: q.choices,
        answer: null
      };
    }
    const multi = q.forcedKind === 'multiselect' || q.starred.length > 1;
    const answers = q.starred.map((i) => q.choices[i]);
    return {
      kind: multi ? 'multiselect' : 'mcq',
      prompt: q.prompt,
      points: q.points,
      choices: q.choices,
      answer: multi ? answers : answers[0],
      shuffle: true
    };
  }

  // No choices: use the answer line (if any).
  if (q.answerLine) {
    const alternatives = q.answerLine.split('|').map((s) => s.trim()).filter(Boolean);
    const looksBoolean = alternatives.every((a) => /^(true|false|t|f|yes|no|tama|mali)$/i.test(a));
    if (looksBoolean) {
      const right = /^(true|t|yes|tama)$/i.test(alternatives[0]);
      return {
        kind: 'truefalse',
        prompt: q.prompt,
        points: q.points,
        choices: ['True', 'False'],
        answer: right ? 'True' : 'False',
        shuffle: false
      };
    }
    return {
      kind: 'short',
      prompt: q.prompt,
      points: q.points,
      choices: [],
      answer: alternatives.length > 1 ? alternatives : alternatives[0],
      shuffle: false
    };
  }

  warnings.push(`${where}: no answer key provided — it will be graded manually.`);
  return { kind: 'short', prompt: q.prompt, points: q.points, choices: [], answer: null, shuffle: false };
}

/* --------------------------------------------------------------------- JSON */

export function parseExamJson(text) {
  const data = JSON.parse(text);
  const sections = Array.isArray(data) ? data : data.sections || data.parts;
  if (!Array.isArray(sections)) throw new Error('JSON must contain a "sections" array.');

  return {
    title: data.title || 'Imported Exam',
    sections: sections.map((sec, i) => ({
      title: sec.title || sec.name || `Part ${i + 1}`,
      instructions: sec.instructions || sec.description || '',
      lock_after: sec.lock_after !== false,
      questions: (sec.questions || sec.items || []).map((q) => ({
        kind: q.kind || (q.choices?.length ? 'mcq' : 'short'),
        prompt: q.prompt || q.question || q.text || '',
        choices: q.choices || q.options || [],
        answer: q.answer ?? q.correct ?? null,
        points: Number(q.points ?? q.score ?? 1),
        shuffle: q.shuffle !== false
      }))
    })),
    warnings: []
  };
}

/* ---------------------------------------------------------------------- CSV */

/**
 * CSV columns: section, kind, prompt, choiceA..choiceF, answer, points
 * A header row is optional; columns are matched by position.
 */
export function parseExamCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return { title: 'Imported Exam', sections: [], warnings: ['Empty CSV'] };

  const header = rows[0].map((c) => c.trim().toLowerCase());
  const hasHeader = header.includes('prompt') || header.includes('question');
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const bySection = new Map();
  for (const row of dataRows) {
    if (!row.some((c) => c.trim())) continue;
    const [sectionName = 'Part 1', kind = '', prompt = ''] = row;
    const choices = row.slice(3, 9).map((c) => c.trim()).filter(Boolean);
    const answer = (row[9] || '').trim();
    const points = parseFloat(row[10]) || 1;
    if (!prompt.trim()) continue;

    if (!bySection.has(sectionName)) bySection.set(sectionName, []);
    bySection.get(sectionName).push({
      kind: kind || (choices.length ? 'mcq' : 'short'),
      prompt: prompt.trim(),
      choices,
      answer: answer || null,
      points,
      shuffle: true
    });
  }

  return {
    title: 'Imported Exam',
    sections: [...bySection.entries()].map(([title, questions], i) => ({
      title: title || `Part ${i + 1}`,
      instructions: '',
      questions
    })),
    warnings: []
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------------------------------------------------------------- dispatch */

export function parseAny(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Nothing to import.');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseExamJson(trimmed);
  const firstLine = trimmed.split('\n')[0];
  if ((firstLine.match(/,/g) || []).length >= 4 && !/^\s*\d+\s*[.)]/.test(trimmed.split('\n').find((l) => l.trim()) || '')) {
    return parseExamCsv(trimmed);
  }
  return parseExamText(trimmed);
}

export function examToText(blueprint) {
  const out = [];
  blueprint.forEach((sec, si) => {
    out.push(`# ${sec.title}`);
    if (sec.instructions) out.push(sec.instructions);
    out.push('');
    sec.questions.forEach((q, qi) => {
      const suffix = q.points !== 1 ? `  [${q.points}]` : '';
      if (q.kind === 'essay') {
        out.push(`${qi + 1}. ${q.prompt} //${suffix}`);
        out.push('');
        return;
      }
      if (q.choices?.length) {
        const multi = q.kind === 'multiselect' ? ' (multi)' : '';
        out.push(`${qi + 1}. ${q.prompt}${multi}${suffix}`);
        const right = new Set(Array.isArray(q.answer) ? q.answer : [q.answer]);
        q.choices.forEach((c, ci) => {
          const star = right.has(c) ? ' *' : '';
          out.push(`${String.fromCharCode(65 + ci)}. ${c}${star}`);
        });
        out.push('');
        return;
      }
      out.push(`${qi + 1}. ${q.prompt}${suffix}`);
      if (q.answer != null) {
        out.push(`Ans: ${Array.isArray(q.answer) ? q.answer.join(' | ') : q.answer}`);
      }
      out.push('');
    });
    if (si < blueprint.length - 1) out.push('');
  });
  return out.join('\n');
}
