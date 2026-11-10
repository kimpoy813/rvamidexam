/** SQLite-backed adapters for the storage-independent exam engine. */
import { getExamBlueprint, getExamSettings, getQuestions } from './db.js';
import { buildPaper as buildPaperFromData, gradePaper as gradePaperFromData } from './exam-engine.js';
export { rng, shuffleWith, hashString, letter, flattenPaper, normalizeAnswer,
  gradeOne, givenText, itemAnalysis, toCsv } from './exam-engine.js';

export function buildPaper(session, blueprint, settings) {
  const examId = session?.exam_id;
  return buildPaperFromData(session, blueprint || getExamBlueprint(examId), settings || getExamSettings(examId));
}

export function gradePaper(paper, answers, manualScores = {}, examId) {
  return gradePaperFromData(paper, answers, manualScores, getQuestions(examId));
}
