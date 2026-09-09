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
// Later options on the same line as an earlier one, as produced by copying a
// PDF: "A. Melting of ice    B. Rusting of iron". Two spaces or a tab are
// required before the marker so prose such as "the value of x. B. is 5" is not
// chopped into choices.
const INLINE_CHOICES = /(?:\s{2,}|\t)([A-J])\s*[.)]\s+/g;
const ITEM_START = /^\s*(\d+)\s*[.)]\s+(.*)$/;
const ANSWER_LINE = /^\s*(?:ans|answer|key)\s*:?\s*(.+)$/i;
// Not end-anchored: the documented form is "3. Prompt [3] (multi)", where the
// marker sits before the multiselect flag rather than at the end of the line.
const POINTS_TAG = /\[\s*(\d+(?:\.\d+)?)\s*\]/;
const POINTS_WORDS = /\(\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?)\s*\)/i;

// A trailing answer key. Real exam papers keep the answers on a separate page
// rather than marking them inline, so a teacher pastes the paper and the key
// together and expects both to be understood.
const KEY_HEADING = /^\s*(answer\s*key|answer\s*sheet|key\s*to\b|answers?)\s*[:\-]?\s*$/i;
const KEY_ENTRY = /(\d{1,3})\s*[.):\-]\s*/g;
const KEY_RANGE = /^\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*[.):\-]\s*(.*)$/;
const TRUE_FALSE_KEY = /^(true|false|t|f|yes|no|tama|mali)$/i;
// "PART I. MULTIPLE CHOICE", "Part 2: True or False", "III - Identification".
// A separator after the numeral is required, otherwise "[ivxlcdm]+" happily
// matches the start of ordinary words ("Mid"term, "L"aws, "Ci"rcuits).
// Mirrors PART_HEADING in tools/doc2exam.py.
const PART_HEADING =
  /^\s*(?:#{1,3}\s*)?(?:part\s+([ivxlcdm]+|\d+)\s*[.)\-:–—]?\s*|([ivxlcdm]+|\d+)\s*[.)\-:–—]\s*)([A-Za-z][A-Za-z /&,'’()\-]{2,60})\s*$/i;
// "Part N. <label>" — the label may be any words (quotes, question marks and
// custom names included), so a part is never mistaken for the exam title.
const PART_PREFIX = /^\s*(?:#{1,3}\s*)?part\s+([ivxlcdm]+|\d+)\s*[.)\-:–—]?\s*([^\s].*?)\s*$/i;
const SECTION_WORDS = [
  'multiple choice', 'multiple-choice', 'true or false', 'true/false',
  'identification', 'matching', 'essay', 'short answer', 'fill in', 'fill-in',
  'problem solving', 'computation', 'enumeration', 'modified', 'analogy'
];

/** Python str.title() equivalent, so headings normalise the same way. */
function titleCaseWords(s) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Recognise a part heading and return its normalised title, or null.
 * A numeral alone is not enough — the label must name a kind of section, so an
 * ordinary title like "Laws of Motion" is never mistaken for "Part L. aws of
 * Motion". Mirrors looks_like_part() in tools/doc2exam.py.
 */
function looksLikePart(line) {
  const str = String(line).trim();

  // A heading that literally starts with "Part N." is unambiguously a part,
  // whatever it is called ("Word Scramble", "Number Puzzle", …).
  const pm = str.match(PART_PREFIX);
  if (pm) {
    const label = pm[2].replace(/^[.:,\-]+|[.:,\-]+$/g, '').trim();
    if (label) return `Part ${pm[1].toUpperCase()}. ${titleCaseWords(label)}`;
  }

  const m = str.match(PART_HEADING);
  if (m) {
    const label = (m[3] || '').trim().replace(/^[.:,\-]+|[.:,\-]+$/g, '');
    if (SECTION_WORDS.some((w) => label.toLowerCase().includes(w))) {
      const num = (m[1] || m[2] || '').toUpperCase();
      return `Part ${num}. ${titleCaseWords(label)}`;
    }
  }
  return null;
}

/**
 * Peel a trailing answer key off the paper.
 * Returns the body lines plus a map of item number -> key value.
 */
function splitKeyBlock(lines) {
  const start = lines.findIndex((l) => KEY_HEADING.test(l));
  if (start === -1) return { body: lines, key: new Map() };

  const key = new Map();
  for (const rawLine of lines.slice(start + 1)) {
    const line = rawLine.trim();
    if (!line || /^#{1,3}\s+/.test(line)) continue;

    // "1-5. B A C D A" — spread the listed values across the range.
    const range = line.match(KEY_RANGE);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      const values = range[3].trim().split(/[\s,;]+/).filter(Boolean);
      if (values.length && hi >= lo) {
        values.forEach((value, offset) => {
          if (lo + offset <= hi) key.set(lo + offset, value.replace(/^[ .,;]+|[ .,;]+$/g, ''));
        });
        continue;
      }
    }

    // Several entries may share a line: "1. B   2. A   3. C".
    const entries = [...line.matchAll(KEY_ENTRY)];
    entries.forEach((m, i) => {
      const end = i + 1 < entries.length ? entries[i + 1].index : line.length;
      const value = line.slice(m.index + m[0].length, end).trim().replace(/^[,;]+|[,;]+$/g, '');
      if (value) key.set(parseInt(m[1], 10), value);
    });
  }

  // Require a couple of entries before believing this was really a key, so a
  // stray "Answer" heading in the middle of a paper cannot swallow it.
  if (key.size < 2) return { body: lines, key: new Map() };
  return { body: lines.slice(0, start), key };
}

/**
 * Attach a key value to an item. Mirrors tools/doc2exam.py so the dashboard
 * paste path and the document converter agree on how a key is read.
 */
function applyKey(item, value) {
  const v = String(value).trim();
  if (!v) return false;

  if (item.choices.length) {
    if (/^[A-J]$/i.test(v)) {
      if (item.starred.length) return false; // an inline "*" already marked it
      const idx = v.toUpperCase().charCodeAt(0) - 65;
      if (idx < item.choices.length) {
        item.starred = [idx];
        return true;
      }
      return false;
    }
    // A key written out in full rather than as a letter.
    const found = item.choices.findIndex((c) => c.trim().toLowerCase() === v.toLowerCase());
    if (found !== -1) {
      item.starred = [found];
      return true;
    }
    return false;
  }

  if (TRUE_FALSE_KEY.test(v)) {
    item.answerLine = /^(true|t|yes|tama)$/i.test(v) ? 'TRUE' : 'FALSE';
    return true;
  }

  item.answerLine = v;
  return true;
}

export function parseExamText(text, fallbackTitle = 'Imported Exam') {
  const allLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const { body: lines, key } = splitKeyBlock(allLines);
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

  // A paper usually opens with its own title on a plain line, e.g.
  // "GE ELEC 103 - Midterm Examination". Take the first non-empty line as the
  // title unless it is a heading, an item, or a part heading.
  let body = lines;
  if (!titleSeen) {
    const firstIdx = lines.findIndex((l) => l.trim());
    if (firstIdx !== -1) {
      const first = lines[firstIdx].trim();
      if (!first.startsWith('#') && !ITEM_START.test(first) && !looksLikePart(first)) {
        title = first;
        titleSeen = true;
        body = lines.slice(0, firstIdx).concat(lines.slice(firstIdx + 1));
      }
    }
  }

  for (const rawLine of body) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // ---- bare part heading ("PART I. MULTIPLE CHOICE" with no "#" prefix)
    if (!ITEM_START.test(line)) {
      const part = looksLikePart(line);
      if (part) {
        pushSection(part, sections.length);
        continue;
      }
    }

    // ---- section heading
    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, '').trim();
      // A paper that opens straight into "# PART I. MULTIPLE CHOICE" has no
      // title line of its own. Only a heading that is not a part heading can
      // be the exam title, or the first part loses its name to the title.
      if (!titleSeen && !looksLikePart(heading)) {
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
    // Copying out of a PDF usually collapses every option onto one line:
    //   A. Melting of ice    B. Rusting of iron    C. Dissolving sugar
    // Split on the later markers before falling through to the single-choice
    // case. Two spaces (or a tab) are required before a marker so that prose
    // like "The value of x. B. is 5" is not chopped into choices.
    if (item && LETTER_CHOICE.test(line) && line.match(INLINE_CHOICES)) {
      // Drop the leading marker first; INLINE_CHOICES only matches the later
      // ones, since it keys off the whitespace that separates them.
      const parts = line
        .replace(LETTER_CHOICE, '$2')
        .replace(INLINE_CHOICES, '\u0000')
        .split('\u0000')
        .map((part) => part.trim())
        .filter(Boolean);
      for (let raw of parts) {
        raw = raw.trim();
        const starred = /\*\s*$/.test(raw);
        if (starred) raw = raw.replace(/\*\s*$/, '').trim();
        if (!raw) continue;
        item.choices.push(raw);
        if (starred) item.starred.push(item.choices.length - 1);
      }
      continue;
    }

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

  // ---- apply a trailing answer sheet, numbered by position across the paper
  let globalNumber = 0;
  const keyApplied = [];
  for (const sec of sections) {
    for (const q of sec.questions) {
      globalNumber += 1;
      if (key.has(globalNumber) && applyKey(q, key.get(globalNumber))) {
        keyApplied.push(globalNumber);
      }
    }
  }

  // ---- resolve kinds and answers
  const resolved = sections
    .map((sec) => ({
      title: sec.title,
      instructions: sec.instructions.trim(),
      questions: uniformizeSection(sec.questions.map((q, i) => resolveQuestion(q, sec, i, warnings)))
    }))
    .filter((sec) => sec.questions.length);

  if (!resolved.length) {
    warnings.push('No questions were found. Check that each item starts with a number like "1."');
  }

  return { title, sections: resolved, warnings, keyApplied };
}

/**
 * A "True or False" section can be answered by writing: the key lists TRUE or
 * FALSE plus the word that should have been written (e.g. "FALSE | READING").
 * When any item in a section is answered that way, turn every pure True/False
 * item in the same section into a text-entry item too, so the whole section is
 * typed rather than a confusing mix of buttons and inputs.
 */
function uniformizeSection(questions) {
  const writeStyle = questions.some((q) => q.mixedBoolean);
  return questions.map((q) => {
    delete q.mixedBoolean;
    if (writeStyle && q.kind === 'truefalse') {
      return {
        kind: 'short',
        prompt: q.prompt,
        points: q.points,
        choices: [],
        answer: q.answer === 'True' ? 'TRUE' : 'FALSE',
        shuffle: false
      };
    }
    return q;
  });
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
    const booleanCount = alternatives.filter((a) => TRUE_FALSE_KEY.test(a)).length;
    const allBoolean = alternatives.length > 0 && booleanCount === alternatives.length;
    if (allBoolean) {
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
    // A key like "FALSE | READING" accepts a boolean word OR the word that
    // should have been written — this item is answered by typing, not by
    // clicking True/False. Flag it so the whole section can be made uniform.
    const mixedBoolean = booleanCount > 0 && booleanCount < alternatives.length;
    return {
      kind: 'short',
      prompt: q.prompt,
      points: q.points,
      choices: [],
      answer: alternatives.length > 1 ? alternatives : alternatives[0],
      shuffle: false,
      mixedBoolean
    };
  }

  warnings.push(`${where}: no answer key provided — it will be graded manually.`);
  return { kind: 'short', prompt: q.prompt, points: q.points, choices: [], answer: null, shuffle: false };
}

/* --------------------------------------------------------------------- JSON */

export function parseExamJson(text) {
  const data = JSON.parse(String(text).trim());

  const normalizeQuestion = (q) => {
    const choices = q.choices || q.options || [];
    let answer = q.answer ?? q.correct ?? q.correct_answer ?? q.key ?? null;

    // An integer answer is a choice index; resolve it to the option's text.
    const asIndex = (a) => {
      if (!choices.length) return a;
      if (Array.isArray(a)) {
        return a.map((v) => (Number.isInteger(v) ? choices[v] : v)).filter(Boolean);
      }
      if (Number.isInteger(a)) return choices[a] ?? a;
      return a;
    };
    answer = asIndex(answer);

    return {
      kind: q.kind || (choices.length ? 'mcq' : 'short'),
      prompt: q.prompt || q.question || q.text || q.stem || '',
      choices,
      answer,
      points: Number(q.points ?? q.score ?? q.marks ?? 1),
      shuffle: q.shuffle !== false
    };
  };

  const normalizeSection = (sec, i) => ({
    title: sec.title || sec.name || `Part ${i + 1}`,
    instructions: sec.instructions || sec.description || '',
    lock_after: sec.lock_after !== false,
    questions: (sec.questions || sec.items || []).map(normalizeQuestion)
  });

  let title = 'Imported Exam';
  let sections;

  if (Array.isArray(data)) {
    const flatQuestions = data.length > 0 && data.every(
      (x) => x && typeof x === 'object' && !x.questions && !x.items && (x.prompt || x.question || x.text || x.kind)
    );
    if (flatQuestions) {
      // A bare list of questions rather than sections.
      sections = [{ title: 'Part 1', instructions: '', questions: data.map(normalizeQuestion) }];
    } else {
      sections = data.map(normalizeSection);
    }
  } else {
    title = data.title || 'Imported Exam';
    if (Array.isArray(data.questions)) {
      // Questions at the top level, without any sections wrapper.
      sections = [{
        title: data.title || 'Part 1',
        instructions: data.instructions || data.description || '',
        questions: data.questions.map(normalizeQuestion)
      }];
    } else {
      sections = (data.sections || data.parts || []).map(normalizeSection);
    }
  }

  if (!sections.length) throw new Error('JSON must contain a "sections" array (or a list of questions).');

  return { title, sections, warnings: [] };
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
