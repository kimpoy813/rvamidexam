# RVM Midterm Exam — secure online examination

A self-contained examination platform for running a timed, proctored midterm online.
Students answer in the browser; every response, score and integrity event is stored
on the server so the teacher can watch the class live and review everything later —
the same idea as Google Forms, but built for a supervised exam.

**Zero runtime dependencies.** Node 22+ only — it uses the SQLite engine that ships
with Node, so `npm start` works on a clean checkout with no `npm install`.
The test suite is the one exception: it uses `jsdom` (a devDependency) to drive the
real pages, so run `npm install` before `npm test`.

---

## Quick start

```bash
node --version        # needs 22.5 or newer
npm start
```

Then open:

| Page | URL | Who |
| --- | --- | --- |
| Student entry | `http://localhost:4000/` | students |
| Exam runner | `http://localhost:4000/exam` | students (after joining) |
| Teacher dashboard | `http://localhost:4000/teacher` | you |

The console prints the access code and the default teacher login on every start:

```
Access code  EQH-939
Teacher      teacher / rvm-exam-2026   (default — change it in the dashboard)
```

Change the teacher password immediately (**Exam setup → Access & security →
Teacher password**). Override the defaults with `EXAM_TEACHER_USER`,
`EXAM_TEACHER_PASSWORD` and `PORT` if you prefer.

Everything is stored in `data/exam.sqlite` (git-ignored). Delete that file to start
from scratch.

---

## Giving the exam to students

1. Open **/teacher** and sign in.
2. Copy the access code from the top bar and send it to the class with the link.
3. Each student enters the code, their full name, student number and class/section.
4. The timer starts the moment they press **Start** — not when they open the page.

The live monitor then shows everyone who has joined, updating in real time.

---

## What students get

- **One hour**, counted by the server. Reloading, closing the tab or changing the
  device clock does not add time. When the clock hits zero the paper is submitted
  automatically.
- **Four parts** (Multiple choice, True/False, Identification, Essay) with their own
  instructions, a question map, and a progress ring.
- **Autosave** after every response, so a dropped connection costs nothing.
- **A shuffled paper.** Question order and A/B/C/D order are randomised per student
  from a seed stored with their session, so it is stable across reloads but different
  from their neighbour's.
- Keyboard shortcuts: `1`–`9` to pick an option, `←`/`→` to move between items.
- An item review screen after submitting (can be turned off).

---

## Anti-cheating

Everything below is recorded against the session and appears in the teacher's live
feed and in each student's timeline.

| Control | How it works |
| --- | --- |
| Server-side clock | The deadline is stored on the server at start; the client countdown is only a display. |
| Answer key never leaves the server | The student API sends `hasAnswer: true`, never the key. Grading resolves the key from the database. |
| One question at a time | `/item?i=N` returns a single question, so the whole paper cannot be pulled in one request. |
| Per-student shuffling | Seeded per session, so screen-sharing and looking sideways do not transfer. |
| Full-screen enforcement | Leaving full screen raises a blocking overlay and logs the event. |
| Tab / window detection | `visibilitychange` and `blur` are logged; the heartbeat also detects the transition server-side. |
| Clipboard & menu blocking | Copy, cut, paste, right-click, text selection and print are blocked and logged. |
| Shortcut blocking | F12, Ctrl+C/V/X/U/P/S, Ctrl+Shift+I/J/C/K are intercepted. |
| Second-tab detection | A `BroadcastChannel` handshake spots the exam opened twice. |
| Reload counter | Reloads are counted and reported. |
| Single live attempt | Joining again with the same student number while another device is active is refused. |
| Section locking | Moving past a part locks it; the server refuses edits and navigation back into it. |
| Violation threshold | After N events the student is flagged (and can be auto-submitted). |
| Identity capture | Name, student number, class, IP and user agent are stored. |

These are deterrents plus an audit trail — a determined student on their own machine
can still defeat browser-level checks. The controls that cannot be bypassed from the
client are the server-side clock, the hidden answer key, the per-student shuffle and
the section locks.

---

## What the teacher gets

**Live monitor** — a card per student showing online status, time remaining,
questions answered, current part, current question number, integrity flags and score
so far, plus class KPIs and an activity feed that pushes over Server-Sent Events
(with automatic polling fallback).

**Per-student drawer** — click any student for their full timeline, every response
against the answer key, and inline grading for essays and open items. From there you
can add time, submit on their behalf, reopen an attempt, clear flags or invalidate it.

**Results** — scoreboard, score distribution, average/median/high/low, pass count,
and item analysis showing how the class did on each question. **Export CSV** produces
one row per student with every answer, ready for a spreadsheet.

**Exam setup** — title, subject, term, duration, instructions, access code, and every
anti-cheating control as a toggle.

---

## Loading your own questions

Go to **/teacher → Exam setup → Question bank**, paste your exam and press
**Preview**, then **Import**. Plain text, JSON and CSV are all accepted.

### Plain text

```
# Part I. Multiple Choice
Choose the letter of the best answer.

1. Which planet is closest to the Sun?  [2]
A. Venus
B. Mercury *
C. Earth
D. Mars

2. Select every prime number. [3] (multi)
- 2 *
- 3 *
- 4
- 5 *

# Part II. True or False
Write TRUE or FALSE.

3. Water boils at 100 °C at sea level.
Ans: TRUE

# Part III. Identification

4. What is the chemical symbol for gold?
Ans: Au | gold

# Part IV. Essay

5. Explain why the sky appears blue. //  [10]
```

| Syntax | Meaning |
| --- | --- |
| `# Heading` | starts a new part (the first one becomes the exam title) |
| lines before item 1 | that part's instructions |
| `1.` / `1)` | a new item |
| `A.` … `J.` or `-` | a choice |
| trailing `*` | marks the correct choice |
| `[n]` | points for the item (default 1) |
| `(multi)` | allow several correct choices (partial credit) |
| `Ans: x \| y` | answer key; `\|` lists accepted spellings |
| `Ans: TRUE` / `FALSE` | becomes a True/False item |
| `//` | essay, graded manually |

An item with no key is kept and graded manually rather than discarded. **Preview**
lists anything it could not read.

### JSON

```json
{
  "title": "Midterm Examination",
  "sections": [
    {
      "title": "Part I. Multiple Choice",
      "instructions": "Choose the best answer.",
      "questions": [
        { "kind": "mcq", "prompt": "…", "choices": ["a", "b", "c"], "answer": "b", "points": 2 },
        { "kind": "truefalse", "prompt": "…", "answer": "True", "points": 1 },
        { "kind": "short", "prompt": "…", "answer": ["Au", "gold"], "points": 2 },
        { "kind": "essay", "prompt": "…", "points": 10 }
      ]
    }
  ]
}
```

Importing replaces the question bank. Attempts already in progress keep the paper
they started with, so an import never invalidates a live exam.

---

## Grading

Multiple choice, True/False, multi-select and identification are marked
automatically. Matching ignores case, accents, punctuation and extra whitespace, so
`" manila "` and `MAYNILA` both match a key of `Manila | Maynila`. Multi-select gives
partial credit when some — but not all — correct options are chosen and none are
wrong. Essays and any item without a key stay **pending** until you grade them.

---

## Project layout

```
server/
  index.js               HTTP server, routing, bootstrap
  lib/db.js              SQLite schema and data access
  lib/exam.js            shuffling, grading, item analysis, CSV
  lib/http.js            router, JSON bodies, static files, SSE hub
  lib/importer.js        text / JSON / CSV question importers
  lib/live.js            roster snapshot, SSE broadcast, violations
  routes/student.js      student API
  routes/teacher.js      teacher API
  seed/sample-exam.js    placeholder bank (loaded only when empty)
public/
  index.html  exam.html  teacher.html
  css/        app.css  exam.css  teacher.css
  js/         student-entry.js  exam.js  teacher.js  util.js
tests/
  exam.test.js           API end-to-end tests against a real server
  ui.test.js             drives the real pages in jsdom
```

## Tests

```bash
npm install     # only needed for jsdom
npm test
```

25 tests, all against a real server on a temporary database.

`tests/exam.test.js` exercises the HTTP API: the 60-minute clock, access-code
rejection, key concealment, per-student shuffling, autosave and grading, section
locking, violation flagging, teacher grading and time extension, results, CSV
export, the importer, and a full-marks paper built by the real shuffle logic.

`tests/ui.test.js` loads the actual `exam.html` and runs the actual `exam.js` in
jsdom, then clicks: booting and rendering a question, an answer reaching the server,
true/false rendering both options, typing an essay, the progress ring updating, and
the entry form's validation. This layer exists because a syntax check happily passes
a page whose click handler assigns to a `const` — that only throws when a student
actually clicks.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `EXAM_DATA_DIR` | `./data` | where the database lives |
| `EXAM_DB` | `$EXAM_DATA_DIR/exam.sqlite` | database path |
| `EXAM_TEACHER_USER` | `teacher` | teacher username |
| `EXAM_TEACHER_PASSWORD` | `rvm-exam-2026` | teacher password |
