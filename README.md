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
| Question bank editor | `http://localhost:4000/admin` | you (teacher sign-in required) |

The console prints the access code and the default teacher login on every start:

```
Access code  EQH-939
Teacher      teacher / rvm-exam-2026   (default — change it in the dashboard)
```

Change the teacher password immediately (**Exam setup → Access & security →
Teacher password**). Override the defaults with `EXAM_TEACHER_USER`,
`EXAM_TEACHER_PASSWORD` and `PORT` if you prefer.

Everything is stored in `data/exam.sqlite` (git-ignored). Exam setup saves
automatically as you type; the green **Saved** badge confirms that SQLite has
committed it. Closing and reopening the local server uses the same database. Delete
that file only when you intentionally want to start from scratch.

---

## Giving the exam to students

1. Open **/teacher** and sign in.
2. Copy the access code from the top bar and send it to the class with the link.
3. Each student enters the code, their full name, student number and class/section.
4. The timer starts the moment they press **Start** — not when they open the page.

The live monitor then shows everyone who has joined, updating in real time.

---

## What students get

- **A per-exam time limit**, counted by the server. Reloading, closing the tab or
  changing the device clock does not add time. When the clock hits zero the paper
  is submitted automatically.
- **Several parts** (Multiple choice, True/False, Identification, Essay, …) with
  their own instructions, a question map, and a progress ring.
- **Autosave** after every response — including the last text typed before moving
  on or submitting — so a dropped connection costs nothing.
- **A shuffled paper.** Question order and A/B/C/D order are randomised per student
  from a seed stored with their session, so it is stable across reloads but different
  from their neighbour's.
- Keyboard shortcuts: `1`–`9` to pick an option, `←`/`→` to move between items.
- **Free navigation** — students can jump to any question from the question map and
  change an answer any time before submitting. No confirmation pop-ups on the way.
  (Section locking is available as a toggle, off by default.)
- **No score on screen.** Submitting shows a confirmation only; results stay with the
  teacher. (Also a toggle — turn on *Show results to students* to release an item
  review immediately.)

---

## Anti-cheating

Browser-side monitoring is intentionally lighter. The platform records tab changes,
second-tab opens, and clipboard attempts; the rest of the safeguards stay
server-side.

| Control | How it works |
| --- | --- |
| Server-side clock | The deadline is stored on the server at start; the client countdown is only a display. |
| Answer key never leaves the server | The student API sends `hasAnswer: true`, never the key. Grading resolves the key from the database. |
| One question at a time | `/item?i=N` returns a single question, so the whole paper cannot be pulled in one request. |
| Per-student shuffling | Seeded per session, so screen-sharing and looking sideways do not transfer. |
| Tab detection | `visibilitychange` plus the heartbeat record when an exam tab that was visible becomes hidden. |
| Clipboard blocking | Copy, cut, and paste are blocked in the browser and logged. |
| Second-tab detection | A `BroadcastChannel` handshake spots the exam opened twice. |
| Single live attempt | Joining again with the same student number while another device is active is refused. |
| Section locking *(off by default)* | When enabled, moving past a part locks it and the server refuses edits and navigation back into it. |
| Violation threshold | After N tab or clipboard-related events the student is flagged (and can be auto-submitted). |
| Identity capture | Name, student number, class, IP and user agent are stored. |

These are deterrents plus an audit trail — a determined student on their own machine
can still defeat browser-level checks. The controls that cannot be bypassed from the
client are the server-side clock, the hidden answer key, the per-student shuffle and
the section locks.

---

## What the teacher gets

**Multiple exams** — create as many exams as you need from the dashboard. Each one
keeps its own question bank, title, duration, access code, and its own roster of
attempts and results. Use the switcher in the top bar (or the *Your exams* list in
**Exam setup**) to change which exam you are editing and monitoring; students are
routed to the exam whose access code they enter.

**Live monitor** — a card per student showing online status, time remaining,
questions answered, current part, current question number, integrity flags and score
so far, plus class KPIs and an activity feed refreshed by polling every 2.5 seconds. Several exams can be open at once, each with its
own access code and timer; switch the **This exam / All exams** scope in the monitor
to watch every exam in a single combined view — each student is tagged with the exam
they are writing and each exam gets its own live headcount.

**Per-student drawer** — click any student for their full timeline, every response
against the answer key, and inline grading for essays and open items. From there you
can add time, submit on their behalf, reopen an attempt, clear flags or invalidate it.

**Results** — scoreboard, score distribution, average/median/high/low, pass count,
and item analysis showing how the class did on each question. **Export CSV** produces
one row per student with every answer, ready for a spreadsheet.

**Exam setup** — title, subject, term, duration, instructions, access code, and every
anti-cheating control as a toggle. Changes auto-save after a short pause (and
immediately when leaving a field); a persistent-storage banner plus visible
**Unsaved / Saving / Saved / Save failed** state makes durability explicit.

---

## Loading your own questions

Go to **/teacher → Questions** (or open **/admin**), paste your exam and press
**Preview pasted questions**. The teacher preview shows every item with the same
response control students will receive. Use the type menu on an item (or **Edit**
for its prompt, answer key, choices, and points), then press **Save question bank**.
Plain text, JSON and CSV are all accepted. The bank you save **replaces the
currently selected exam** (see the switcher in the top bar), so create a separate
exam first if you want to keep the current one.

### From a Word, PDF or Excel file

`tools/doc2exam.py` turns a document into the JSON the importer accepts, so an
existing exam paper does not have to be retyped.

```bash
pip install python-docx pdfplumber openpyxl      # once

python3 tools/doc2exam.py exam.docx --check      # dry run: report only
python3 tools/doc2exam.py exam.docx > exam.json  # then paste exam.json into the dashboard
```

`.docx`, `.pdf`, `.xlsx`, `.csv`, `.txt` and `.md` all work. `--check` prints what it
found and lists anything it could not read, without emitting JSON — run that first.

It understands a normal exam layout: a part heading (`PART I. MULTIPLE CHOICE`),
numbered items, lettered choices, and an **answer key at the end of the paper**,
which is how most exam documents are actually written:

```
ANSWER KEY
1. B   2. A   3. C   4. TRUE   5. FALSE
6. Photosynthesis   7. Chloroplast
```

A key value is read as a choice letter, a true/false, or free text, whichever fits
the item. An inline `*` always wins over the key sheet. `--default-points 2` sets the
points for items that do not state their own.

Legacy `.doc` and `.ppt` need re-saving as `.docx`/`.pdf` first — those formats are
binary and not worth guessing at.

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
| `(short)` | force a typed short answer (including when the key is `TRUE` or `FALSE`) |
| `Ans: x \| y` | answer key; `\|` lists accepted spellings |
| `Ans: TRUE` / `FALSE` | becomes a True/False item unless `(short)` or modified True/False directions require typing |
| `//` | essay, graded manually |

An item with no key is kept and graded manually rather than discarded. **Preview**
lists anything it could not read.

### An answer key on a separate page

Exam papers usually keep their answers at the end rather than marking them inline,
often on a different page or in a different file. Paste the paper and the key
together and both are read — the key is peeled off first, so it is never mistaken
for exam content:

```
# Part I. Multiple Choice

1. Which of the following is a chemical change?
A. Melting of ice
B. Rusting of iron
C. Dissolving sugar

2. Sound travels faster in water than in air.

ANSWER KEY
1. B
2. TRUE
```

The heading may be `ANSWER KEY`, `ANSWER SHEET`, `KEY` or `ANSWERS`. Entries can be
one per line, several per line (`1. B   2. A   3. C`), or a range with the values
listed after it (`1-5. B A C D A`). Items are matched by their position across the
whole paper.

A key value is read as a choice letter, a true/false, or free text, whichever fits
the item. An inline `*` always wins over a contradicting key sheet, and **Preview**
reports which items the key was applied to.

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

The JSON may use `options` for `choices`, `correct`/`correct_answer` for `answer`,
or an integer answer (a choice index) — all are normalised. It can also be a bare
array of questions, or an object with `questions` at the top level, in which case a
single part is created.

Importing replaces the selected exam's question bank. Attempts already in progress
keep the paper they started with, so an import never invalidates a live exam.

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
  ui.test.js             drives the student pages in jsdom
  teacher-ui.test.js     drives the teacher dashboard in jsdom
tools/
  doc2exam.py            .docx / .pdf / .xlsx / .txt -> importable JSON
```

## Tests

```bash
npm install     # only needed for jsdom
npm test
```

67 tests, all against a real server on a temporary database (~45s).

`tests/exam.test.js` exercises the HTTP API: the 60-minute clock, access-code
rejection, key concealment, per-student shuffling, autosave and grading, section
locking, tab-visibility violation flagging, teacher grading and time extension,
results, CSV export, the importer, and a full-marks paper built by the real shuffle
logic.

`tests/ui.test.js` loads the actual `exam.html` and runs the actual `exam.js` in
jsdom, then clicks: booting and rendering a question, an answer reaching the server,
clipboard blocking/logging, true/false rendering both options, typing an essay, the
progress ring updating, and the entry form validating.

`tests/teacher-ui.test.js` does the same for the dashboard: a live class rendering,
a flagged student called out, the detail drawer with inline grading, the scoreboard
and item analysis, question preview/editing, and exam setup auto-saving across a
fresh dashboard open. `tests/persistence.test.js` starts a real server, changes the
complete setup, sends the same `SIGTERM` used by Render, starts a second process on
the same SQLite file, and verifies every setting is still present.

The two UI layers exist because a syntax check happily passes a page whose click
handler assigns to a `const` — that only throws when a student actually clicks.

## Deploying on Render

This is a **Node.js** app, not a Go app. If your build log says *"Using Go
version …"* / *"Running build command 'go build …'"* and then fails with
*`go: go.mod file not found`*, the service was set up with the wrong runtime.
Node is the runtime this project needs:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Node version:** the `engines.node` (`>=22.5.0`) in `package.json`, or set
  `NODE_VERSION` (e.g. `22`).

The included `render.yaml` declares the service as a Node web service, so
deploying from that blueprint uses the correct settings. If you instead
created the service by hand in the Render dashboard, change the existing
service (Service → Settings → Environment) from **Go** to **Node**, then set
the build/start commands above. The port is injected by Render via `PORT`.

### Keeping your data (and your changed password)

Everything — exams, question banks, student attempts and the **teacher
password** — is stored in `data/exam.sqlite`. Render's default filesystem is
**ephemeral**: every deploy or restart wipes it, which is why a changed teacher
password can appear to "reset" back to the default. To keep the data across
deploys you must attach a **persistent disk** (this requires a paid plan):

1. In the Render dashboard, open your service → **Disks** → **Add disk**.
2. Set the mount path to `/opt/render/project/src/data`.
3. Add `EXAM_DATA_DIR=/opt/render/project/src/data` and
   `EXAM_STORAGE_MODE=persistent` in the service's environment.
4. Redeploy once, then verify that **Persistent storage connected** appears at the
   top of **Exam setup**.

The `render.yaml` Blueprint already declares the Starter plan, 1 GB disk, mount,
and both variables. This declaration only provisions a disk when the service is
created/synced as a Blueprint; it cannot silently attach one to a separately
created free service. If the dashboard instead says **Storage is temporary**, the
service has not been given durable storage and a restart can still recreate the
sample defaults. On Render's free plan there is no persistent disk, so keeping
SQLite data across deploys requires upgrading or moving the database to an
external durable service.

The teacher login is available directly at `/teacher`, without a link on the
student page. Hiding the link does not secure it: set a strong
`EXAM_TEACHER_PASSWORD` before first startup, or change the existing password
in the dashboard. Environment credentials only initialize a new database.

On Render the app refuses to start if persistent storage is not configured, or
if the configured data directory is not a mounted disk. This prevents silently
creating a fresh database on an ephemeral filesystem. For disposable demos
only, set `EXAM_ALLOW_EPHEMERAL=true`; all data can still be lost. Attaching a
disk cannot recover data already lost from the old ephemeral filesystem.

### Teacher accounts

Teachers can create their own accounts at `/teacher`. Each account has its own
exam collection, selected exam, student attempts, results and live roster.
Existing exams and attempts are assigned to the original teacher account on
upgrade. New accounts start with a closed, empty exam; add questions and open it before
sharing its access code. Students can enter that code to load the correct exam details.

Registration is open to anyone who knows the teacher page URL. There is no
email verification, password recovery or administrative approval. Use strong,
unique passwords and protect the original teacher account. Login and signup
have a basic per-process rate limit; use a reverse proxy or edge rate limiter
for stronger protection in public deployments. SQLite and its persistent disk
remain necessary to retain accounts and data.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `EXAM_DATA_DIR` | `./data` | where the database lives (point this at a persistent disk on Render) |
| `EXAM_DB` | `$EXAM_DATA_DIR/exam.sqlite` | database path |
| `EXAM_STORAGE_MODE` | _(local disk)_ | set to `persistent` when the hosted data path is an attached durable disk |
| `EXAM_ALLOW_EPHEMERAL` | _(unset)_ | set to `true` to allow disposable Render deployments without a disk (data can be lost) |
| `EXAM_TEACHER_USER` | `teacher` | teacher username |
| `EXAM_TEACHER_PASSWORD` | `rvm-exam-2026` | teacher password used at first boot only |

## Vercel + Neon: simplified exam app

The Vercel deployment has a separate version of the app. It supports teacher
self-registration, section titles and instructions, multiple-choice, multiple
answer, true/false, short-answer and essay questions, autosaves, manual grading,
text/JSON/CSV question import, optional section locking and timers, and
deterministic per-student question and choice shuffling. Scores with ungraded
answers are provisional.
Existing multiple-choice exams and results use the same `simple_*` tables.

This is **not full parity** with the original app: SQLite data migration and
some proctoring and other settings are not implemented. Each part must contain
a question. The live monitor shows recent heartbeats, searchable and filterable students,
integrity counts, and a polling-based activity feed. Results include a score
distribution, item analysis, and CSV export. Statistics exclude provisional
scores and use assessed, answered items for correctness rates. A
heartbeat is not proof a student is attentive, and connectivity gaps are not
proof of misconduct. Scores are hidden by default. Teachers can release or hide
scores for an exam from Results. Once released, a student can check a submitted,
non-invalidated attempt using the exam code, student number, and the private
result key shown after submission. A released score with pending manual grading
is labeled provisional. Hiding scores cannot undo a result already seen or saved.
Students must save their private key; it is not recoverable without the original
attempt session, so a teacher may need to share the score separately. Older
attempts can obtain a key only if their original session token is still available.
Students cannot resume on another
device or after closing the original tab. An active duplicate join using the same
exam and student number is rejected and logged; students must contact their
teacher if they lose the original tab. Copy/cut/paste are blocked in the exam
page and logged; leaving the exam tab is recorded and shows a warning; same-attempt tabs are detected where BroadcastChannel is
available. Teachers can review logged events in Results. Browser restrictions
and duplicate detection are best effort: different student numbers, browser
profiles, devices, offline failures, or modified clients can bypass them. Events
are capped at 500 per attempt and may be lost if the network is unavailable.

1. Connect this repository to Vercel and connect a Neon PostgreSQL database.
   Set a **pooled** Neon connection string as the sensitive `DATABASE_URL`
   environment variable for the intended deployment environments. Never put
   it in source control. Back up the database before upgrading. The database role needs permission to
   create tables and indexes and alter the `simple_exams` and `simple_attempts`
   tables on upgrade.
2. Deploy this branch after review. Open `/teacher` to create a teacher
   account. Create an exam and share its code with students;
   students open `/` and enter their class and section. Existing attempts made
   before these fields were added display a dash. Closing an exam prevents new joins but does not end
   existing attempts.
   The Questions tab can load and edit the selected exam before any student
   has joined. Once an attempt exists, its bank is locked to protect saved
   answers and results; create a new exam instead. The editor warns about
   concurrent edits rather than silently overwriting them. The Exam setup tab
   supports editing school, subject, term, student instructions and entry notes,
   regenerating an access code, duplicating exams (copies start closed), permanently deleting an
   exam, clearing attempts, and changing the teacher password. Clearing attempts
   removes responses and result keys and hides released scores; back up/export
   first. Regenerating the code invalidates the old code for both exam entry and
   result lookup; share the new code. Password changes sign out other teacher sessions. The monitor can show
   all exams owned by that teacher.
   Integrity auto-submit is optional and off by default. A teacher can set a
   limit of up to 500 events; only saved answers are submitted when it is
   reached. Browser checks may be unreliable, and settings affect future events
   rather than retrospectively submitting attempts. The question bank
   offers a Render-style part and answer preview, inline editors, and saved
   text reload. Pasted text must be previewed before saving. Part timer and
   locking settings are retained when previewed parts keep their names and
   order; review them whenever parts change.
3. Answers save as students make selections or type. Students must keep the same tab
   to resume after a reload; this first version cannot resume on a different
   browser or device. Each timed part starts when entered, continues while
   away, and cannot be answered or revisited after its deadline. Part expiry
   does not automatically advance or submit the exam; the student must move on
   or submit. A part marked as lockable cannot be revisited after moving forward
   if section locking is enabled. The overall deadline still applies. Expired
   attempts are scored on the next student request or when the teacher opens
   results, rather than by a background timer.
   Teachers can add 10 or 30 minutes to an active attempt, submit saved answers,
   invalidate, reopen a submitted attempt, or clear current flags. Actions are
   recorded in the result's history (up to 500 actions per attempt); clearing
   flags preserves integrity-event history. Invalidated attempts are excluded
   from score statistics. Reopening preserves answers and section restrictions,
   clears manual grades, and gives at least one minute overall; it does not
   reset expired part timers. The student must keep the original tab and use
   “Check if reopened.” Added time extends only the overall exam deadline.
4. Test with a small class before relying on it, monitor Neon/Vercel free-tier
   quotas, and make independent database backups. Free services have usage and
   availability limits. Registration is open; there is no email verification or
   password recovery.

The PostgreSQL integration test is opt-in and requires a **disposable** test
database with permission to create and drop schemas:

```sh
TEST_DATABASE_URL='postgresql://...' node --test tests/simple-neon.test.js tests/simple-ui.test.js tests/simple-types.test.js tests/simple-types-ui.test.js tests/simple-migration.test.js tests/simple-navigation.test.js
```

Do not run this test against a production database. Without `TEST_DATABASE_URL`
it is skipped. `npm test` still exercises the existing SQLite application.

### Original-app PostgreSQL port (development only)

`server/neon/exam-repository.js` and `attempt-repository.js` are standalone,
async storage primitives for the original question types and grading engine.
They are **not wired to any HTTP routes or deployment** and must not be treated
as a working replacement for the original app. New attempt snapshots keep the
question bank and settings used at join time, and transaction locks protect
bank replacement, concurrent saves, submission, and grading. Session tokens are
stored hashed. Remaining work includes porting and integrating original student
and teacher APIs, account management, navigation, integrity monitoring, results,
imports, and original UI; migrations and real deployment testing are also needed.

The opt-in `tests/neon-exam-repository.test.js` uses `TEST_DATABASE_URL` for an
isolated temporary schema. Use only a disposable database for this test.
