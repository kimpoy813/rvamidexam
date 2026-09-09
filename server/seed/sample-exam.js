/**
 * Placeholder question bank.
 *
 * This is loaded only when the database has no questions yet, so the system is
 * usable the moment it starts. Replace it from /admin (paste your own items or
 * upload JSON/CSV) — the sample never overwrites a bank you have already saved.
 */
export const SAMPLE_EXAM = {
  title: 'Midterm Examination (SAMPLE)',
  sections: [
    {
      title: 'Part I. Multiple Choice',
      instructions:
        'Read each question carefully and choose the letter of the best answer. There is only one correct answer per item.',
      lock_after: true,
      questions: [
        {
          kind: 'mcq',
          prompt: 'Which study technique is most effective for long-term retention of new material?',
          choices: [
            'Re-reading the chapter several times in one sitting',
            'Spaced retrieval practice over several days',
            'Highlighting every important sentence',
            'Copying the notes out word for word'
          ],
          answer: 'Spaced retrieval practice over several days',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'A source is considered "peer-reviewed" when:',
          choices: [
            'It was published on a website with many readers',
            'Experts in the same field evaluated it before publication',
            'It was written by a professor at a large university',
            'It has been cited at least once by another author'
          ],
          answer: 'Experts in the same field evaluated it before publication',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'Which of the following best describes plagiarism?',
          choices: [
            'Quoting a source and citing it correctly',
            'Summarising an idea in your own words with a citation',
            'Presenting another person’s words or ideas as your own',
            'Disagreeing with the opinion of an author'
          ],
          answer: 'Presenting another person’s words or ideas as your own',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'In a research paper, the purpose of the thesis statement is to:',
          choices: [
            'List every source the writer consulted',
            'State the central argument the paper will support',
            'Summarise the conclusion in one sentence',
            'Describe the layout of the document'
          ],
          answer: 'State the central argument the paper will support',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'A student finds two articles that disagree about the same topic. The most reasonable next step is to:',
          choices: [
            'Pick the article that matches their own opinion',
            'Ignore both and rely on a textbook instead',
            'Compare the evidence and methodology behind each claim',
            'Quote both without commenting on the disagreement'
          ],
          answer: 'Compare the evidence and methodology behind each claim',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'Which citation detail is NOT normally required in a bibliography entry?',
          choices: [
            'Author’s name',
            'Title of the work',
            'Year of publication',
            'The reader’s own opinion of the work'
          ],
          answer: 'The reader’s own opinion of the work',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: '“The results suggest a correlation, not a causation.” This means:',
          choices: [
            'The two variables move together, but one may not cause the other',
            'The experiment proved one variable causes the other',
            'The data are unreliable and should be discarded',
            'The sample size was too large'
          ],
          answer: 'The two variables move together, but one may not cause the other',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'When taking notes from a lecture, the Cornell method divides the page into:',
          choices: [
            'A timeline, a glossary and a summary',
            'Cue column, note-taking area and summary section',
            'Headings, subheadings and footnotes',
            'Questions, answers and teacher comments'
          ],
          answer: 'Cue column, note-taking area and summary section',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'Which behaviour best reflects academic integrity during an online examination?',
          choices: [
            'Searching the internet for answers to unfamiliar items',
            'Messaging a classmate to confirm an answer',
            'Answering independently using only the permitted materials',
            'Sharing your screen with a friend for moral support'
          ],
          answer: 'Answering independently using only the permitted materials',
          points: 2
        },
        {
          kind: 'mcq',
          prompt: 'The main advantage of outlining an essay before writing it is that:',
          choices: [
            'It guarantees a higher grade',
            'It makes the structure and argument clear before drafting',
            'It removes the need for a conclusion',
            'It shortens the required word count'
          ],
          answer: 'It makes the structure and argument clear before drafting',
          points: 2
        }
      ]
    },
    {
      title: 'Part II. True or False',
      instructions: 'Write TRUE if the statement is correct and FALSE if it is not.',
      lock_after: true,
      questions: [
        { kind: 'truefalse', choices: ['True', 'False'], prompt: 'Paraphrasing a source still requires a citation.', answer: 'True', points: 1, shuffle: false },
        { kind: 'truefalse', choices: ['True', 'False'], prompt: 'A primary source is always more accurate than a secondary source.', answer: 'False', points: 1, shuffle: false },
        { kind: 'truefalse', choices: ['True', 'False'], prompt: 'Cramming the night before an exam is generally less effective than distributed study.', answer: 'True', points: 1, shuffle: false },
        { kind: 'truefalse', choices: ['True', 'False'], prompt: 'Wikipedia is normally accepted as a citable academic source.', answer: 'False', points: 1, shuffle: false },
        { kind: 'truefalse', choices: ['True', 'False'], prompt: 'A well-designed survey question should avoid leading the respondent toward one answer.', answer: 'True', points: 1, shuffle: false }
      ]
    },
    {
      title: 'Part III. Identification',
      instructions: 'Type the word or short phrase that correctly completes each item. Spelling counts.',
      lock_after: true,
      questions: [
        { kind: 'short', prompt: 'The practice of spacing study sessions across several days is called ______ practice.', answer: ['spaced', 'spaced practice', 'distributed'], points: 2 },
        { kind: 'short', prompt: 'A formal list of the sources used in a paper is called a ______.', answer: ['bibliography', 'works cited', 'references', 'reference list'], points: 2 },
        { kind: 'short', prompt: 'The acronym used for evaluating a source’s Currency, Relevance, Authority, Accuracy and Purpose is ______.', answer: ['CRAAP', 'the CRAAP test'], points: 2 },
        { kind: 'short', prompt: 'Restating an author’s idea in your own words, while keeping the original meaning, is called ______.', answer: ['paraphrasing', 'paraphrase'], points: 2 },
        { kind: 'short', prompt: 'In an experiment, the variable that the researcher deliberately changes is the ______ variable.', answer: ['independent'], points: 2 }
      ]
    },
    {
      title: 'Part IV. Essay',
      instructions:
        'Write a well-organised response of about 150–200 words. Your answer will be graded by your teacher.',
      lock_after: true,
      questions: [
        {
          kind: 'essay',
          prompt:
            'Explain why academic integrity matters in online learning. Give at least two specific examples of how a student can demonstrate integrity during a remote examination, and describe one consequence of dishonesty for the learning community.',
          points: 15,
          answer: null
        }
      ]
    }
  ]
};
