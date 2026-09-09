#!/usr/bin/env python3
"""
Convert an exam document into the JSON that /teacher -> Exam setup imports.

    python3 tools/doc2exam.py exam.docx  > exam.json
    python3 tools/doc2exam.py exam.pdf   --check

Supported input: .docx  .pdf  .xlsx  .csv  .txt  .md

Understood layout
-----------------
    MIDTERM EXAMINATION IN SCIENCE       <- first line becomes the title

    PART I. MULTIPLE CHOICE              <- a part heading
    Choose the letter of the best answer.  <- instructions (text before item 1)

    1. Which planet is closest to the Sun?   [2]
    A. Venus
    B. Mercury
    C. Earth
    D. Mars

    2. Water boils at 100 C at sea level.    <- keyed from the answer sheet

    3. What is the chemical symbol for gold?
    Ans: Au | gold                        <- accepted spellings after |

    4. Explain the water cycle. //        <- essay (graded by hand)

An answer key may live at the end instead of inline:

    ANSWER KEY
    1. B   2. A   3. C   4. TRUE   5. FALSE
    6. Photosynthesis   7. Chloroplast
    1-5. B A C D A                          <- range shorthand also works

A key value is read as a choice letter, a true/false, or free text, whichever
fits the item. Inline "*" markers always win over the key sheet.

Spreadsheet banks (.xlsx / .csv) are read by column:
    section, kind, prompt, choiceA..choiceF, answer, points

Points: a trailing [n] or "(2 pts)" on the item, else --default-points (1).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path

# ------------------------------------------------------------------- patterns

# A separator after the numeral is required. Without it "[ivxlcdm]+" happily
# matches the start of ordinary words: "Mid"term, "L"aws, "Ci"rcuits, "M"y.
PART_HEADING = re.compile(
    r"^\s*(?:#{1,3}\s*)?"
    r"(?:part\s+([ivxlcdm]+|\d+)\s*[.)\-:–—]?\s*"
    r"|([ivxlcdm]+|\d+)\s*[.)\-:–—]\s*)"
    r"([A-Za-z][A-Za-z /&,'’()\-]{2,60})\s*$",
    re.I,
)
SIMPLE_PART = re.compile(r"^\s*(?:#{1,3}\s+)?((?:Part\s+)?[A-Za-z][A-Za-z0-9 /&,'’()\-]{3,60})\s*$")
ITEM = re.compile(r"^\s*(\d{1,3})\s*[.)]\s+(.*)$")
LETTER_CHOICE = re.compile(r"^\s*([A-J])\s*[.)]\s*(.+)$", re.I)
BULLET_CHOICE = re.compile(r"^\s*[-*•]\s+(.+)$")
ANSWER_LINE = re.compile(r"^\s*(?:ans|answer|key)\s*\.?\s*:?\s+(.+)$", re.I)
# Not end-anchored: the documented form is "3. Prompt [3] (multi)", where the
# points marker sits before the multiselect flag rather than at line end.
POINTS_BRACKET = re.compile(r"\[\s*(\d+(?:\.\d+)?)\s*\]")
POINTS_PARENS = re.compile(r"\(\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?)\s*\)", re.I)
KEY_HEADING = re.compile(r"^\s*(answer\s*key|answer\s*sheet|key\s*to\b|answers?)\s*[:\-]?\s*$", re.I)
KEY_ENTRY = re.compile(r"(\d{1,3})\s*[.):\-]\s*")
KEY_RANGE = re.compile(r"^\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*[.):\-]\s*(.*)$")
TRUE_FALSE = re.compile(r"^(true|false|t|f|yes|no|tama|mali)$", re.I)
SECTION_WORDS = (
    "multiple choice", "multiple-choice", "true or false", "true/false", "true or false.",
    "identification", "matching", "essay", "short answer", "fill in", "fill-in",
    "problem solving", "computation", "enumeration", "modified", "analogy",
)


# ---------------------------------------------------------------- extraction

def text_from_docx(path: Path) -> str:
    import docx

    doc = docx.Document(str(path))
    out: list[str] = []
    paragraphs = {p._p: p.text for p in doc.paragraphs}
    tables = {t._tbl: t for t in doc.tables}

    for block in doc.element.body:
        tag = block.tag.split("}")[-1]
        if tag == "p" and block in paragraphs:
            out.append(paragraphs[block])
        elif tag == "tbl" and block in tables:
            for row in tables[block].rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                if any(cells):
                    out.append(" | ".join(cells))
    return "\n".join(out)


def text_from_pdf(path: Path) -> str:
    import pdfplumber

    with pdfplumber.open(str(path)) as pdf:
        return "\n".join((page.extract_text() or "") for page in pdf.pages)


def rows_from_sheet(path: Path) -> list[list[str]]:
    import openpyxl

    wb = openpyxl.load_workbook(str(path), data_only=True)
    rows = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            cells = ["" if c is None else str(c).strip() for c in row]
            if any(cells):
                rows.append(cells)
    return rows


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".docx":
        return text_from_docx(path)
    if ext == ".pdf":
        return text_from_pdf(path)
    return path.read_text(encoding="utf-8", errors="replace")


def is_tabular(path: Path) -> bool:
    return path.suffix.lower() in (".xlsx", ".xlsm", ".csv")


# --------------------------------------------------------------- answer keys

def split_key_block(lines: list[str]) -> tuple[list[str], dict[int, str]]:
    """Peel off a trailing answer key. Returns remaining lines and {item: value}."""
    start = next((i for i, l in enumerate(lines) if KEY_HEADING.match(l)), None)
    if start is None:
        return lines, {}

    key: dict[int, str] = {}
    for line in lines[start + 1:]:
        stripped = line.strip()
        if not stripped or looks_like_part(stripped):
            continue

        # "1-5. B A C D A" — expand the range across the listed values.
        rng = KEY_RANGE.match(stripped)
        if rng:
            lo, hi, rest = int(rng.group(1)), int(rng.group(2)), rng.group(3)
            values = [v for v in re.split(r"[\s,;]+", rest.strip()) if v]
            if values and hi >= lo:
                for offset, value in enumerate(values):
                    if lo + offset <= hi:
                        key[lo + offset] = value.strip(" .,;")
                continue

        entries = list(KEY_ENTRY.finditer(stripped))
        for i, m in enumerate(entries):
            end = entries[i + 1].start() if i + 1 < len(entries) else len(stripped)
            value = stripped[m.end():end].strip().strip(",;")
            if value:
                key[int(m.group(1))] = value

    # Only treat this as a key if it produced a usable mapping.
    if len(key) < 2:
        return lines, {}
    return lines[:start], key


def apply_key(item: dict, value: str) -> bool:
    """Attach a key value to an item. Returns True if it was usable."""
    v = value.strip()
    if not v:
        return False

    if item["choices"]:
        if re.fullmatch(r"[A-J]", v, re.I) and item["starred"]:
            return False  # inline "*" already marked it
        if re.fullmatch(r"[A-J]", v, re.I):
            idx = ord(v.upper()) - 65
            if idx < len(item["choices"]):
                item["starred"] = [idx]
                return True
            return False
        # A key of full text rather than a letter: match it against a choice.
        for i, c in enumerate(item["choices"]):
            if c.strip().lower() == v.lower():
                item["starred"] = [i]
                return True
        return False

    if TRUE_FALSE.match(v):
        item["forced"] = "truefalse_key"
        item["answer_line"] = "TRUE" if v.lower() in ("true", "t", "yes", "tama") else "FALSE"
        return True

    item["answer_line"] = v
    return True


# ------------------------------------------------------------------- parsing

def looks_like_part(line: str) -> str | None:
    m = PART_HEADING.match(line)
    if m:
        label = m.group(3).strip().strip(".:,-")
        if any(w in label.lower() for w in SECTION_WORDS):
            num = (m.group(1) or m.group(2) or "").upper()
            return f"Part {num}. {label.title()}"
    m = SIMPLE_PART.match(line)
    if m:
        label = m.group(1).strip().strip(".:,-")
        if any(w in label.lower() for w in SECTION_WORDS):
            return label
    return None


def strip_points(prompt: str, default: float) -> tuple[str, float]:
    m = POINTS_BRACKET.search(prompt) or POINTS_PARENS.search(prompt)
    if not m:
        return prompt.strip(), default
    return prompt[: m.start()].strip(), float(m.group(1))


def parse(text: str, default_points: float) -> dict:
    lines = [l.replace("\u00a0", " ").replace("\r", "").rstrip() for l in text.split("\n")]
    lines, key = split_key_block(lines)

    sections: list[dict] = []
    section: dict | None = None
    item: dict | None = None
    title = "Imported Exam"

    def new_section(name: str) -> None:
        nonlocal section, item
        section = {"title": name, "instructions": "", "questions": []}
        sections.append(section)
        item = None

    def new_item(prompt: str) -> None:
        nonlocal item
        if section is None:
            new_section(f"Part {len(sections) + 1}")
        prompt, points = strip_points(prompt, default_points)
        forced = None
        if re.search(r"(^|\s)//\s*$", prompt):
            forced = "essay"
            prompt = re.sub(r"//\s*$", "", prompt).strip()
        if re.search(r"\(\s*multi(?:ple)?\s*\)", prompt, re.I):
            forced = "multiselect"
            prompt = re.sub(r"\(\s*multi(?:ple)?\s*\)", "", prompt, flags=re.I).strip()
        item = {"number": len(section["questions"]) + 1, "prompt": prompt, "points": points,
                "choices": [], "starred": [], "answer_line": None, "forced": forced}
        section["questions"].append(item)

    # First non-empty line: use it as the title unless it is a heading or an item.
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        if not line.startswith("#") and not ITEM.match(line) and not looks_like_part(line):
            title = line.strip().lstrip("# ").strip()
            del lines[i]
        break

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        if line.startswith("#") and title == "Imported Exam":
            title = line.lstrip("# ").strip()
            continue

        part = looks_like_part(line)
        if part and not ITEM.match(line):
            new_section(part)
            continue

        m = ITEM.match(line)
        if m and not LETTER_CHOICE.match(line):
            if m.group(2).strip():
                new_item(m.group(2))
            continue

        am = ANSWER_LINE.match(line)
        if am and item is not None:
            item["answer_line"] = am.group(1).strip()
            continue

        if re.fullmatch(r"/{2,}", line) and item is not None:
            item["forced"] = "essay"
            continue

        cm = LETTER_CHOICE.match(line)
        bm = BULLET_CHOICE.match(line)
        if (cm or bm) and item is not None:
            body = (cm.group(2) if cm else bm.group(1)).strip()
            starred = body.endswith("*")
            if starred:
                body = body[:-1].strip()
            item["choices"].append(body)
            if starred:
                item["starred"].append(len(item["choices"]) - 1)
            continue

        if item is None:
            if section is None:
                new_section(f"Part {len(sections) + 1}")
            section["instructions"] = (section["instructions"] + " " + line).strip()
        elif not item["choices"] and not item["answer_line"]:
            item["prompt"] = (item["prompt"] + " " + line).strip()

    # Apply the answer sheet, keyed by each item's own number within the paper.
    global_number = 0
    for sec in sections:
        for q in sec["questions"]:
            global_number += 1
            if global_number in key:
                apply_key(q, key[global_number])

    warnings: list[str] = []
    resolved = []
    for sec in sections:
        qs = [resolve(sec, i + 1, q, warnings) for i, q in enumerate(sec["questions"])]
        if qs:
            resolved.append({"title": sec["title"], "instructions": sec["instructions"],
                             "questions": qs})
    return {"title": title, "sections": resolved, "warnings": warnings,
            "keyApplied": sorted(key)}


def resolve(sec: dict, n: int, q: dict, warnings: list[str]) -> dict:
    where = f"{sec['title']} · item {n}"
    base = {"kind": "mcq", "prompt": q["prompt"], "points": q["points"], "choices": []}

    if q["forced"] == "essay":
        return {**base, "kind": "essay", "answer": None}

    if q["choices"]:
        if not q["starred"]:
            warnings.append(f"{where}: no correct choice marked (use * or an answer key) "
                            "— it will need manual grading.")
            return {**base, "choices": q["choices"], "answer": None}
        multi = q["forced"] == "multiselect" or len(q["starred"]) > 1
        answers = [q["choices"][i] for i in q["starred"]]
        return {**base, "kind": "multiselect" if multi else "mcq",
                "choices": q["choices"], "answer": answers if multi else answers[0]}

    if q["forced"] == "truefalse_key" or q["answer_line"]:
        alts = [a.strip() for a in (q["answer_line"] or "").split("|") if a.strip()]
        if alts and all(TRUE_FALSE.match(a) for a in alts):
            right = alts[0].lower() in ("true", "t", "yes", "tama")
            return {**base, "kind": "truefalse", "choices": ["True", "False"],
                    "answer": "True" if right else "False", "shuffle": False}
        return {**base, "kind": "short",
                "answer": alts[0] if len(alts) == 1 else alts, "shuffle": False}

    warnings.append(f"{where}: no answer key provided — it will be graded manually.")
    return {**base, "kind": "short", "answer": None, "shuffle": False}


# ------------------------------------------------------- spreadsheet banks

def parse_tabular(rows: list[list[str]], default_points: float) -> dict:
    header = [c.strip().lower() for c in rows[0]]
    if "prompt" not in header and "question" not in header:
        raise SystemExit(
            "A spreadsheet needs a header row containing at least 'prompt'. "
            "Expected: section, kind, prompt, choiceA..choiceF, answer, points"
        )

    col = {name: header.index(name) for name in header if name}

    def get(row: list[str], *names: str) -> str:
        for name in names:
            if name in col and col[name] < len(row):
                return row[col[name]].strip()
        return ""

    by_section: dict[str, list[dict]] = {}
    order: list[str] = []
    warnings: list[str] = []

    for row in rows[1:]:
        prompt = get(row, "prompt", "question", "item")
        if not prompt:
            continue
        name = get(row, "section", "part") or "Part 1"
        if name not in by_section:
            by_section[name] = []
            order.append(name)

        kind = get(row, "kind", "type").lower()
        points_s = get(row, "points", "score", "pts")
        points = float(points_s) if re.fullmatch(r"\d+(\.\d+)?", points_s) else default_points
        answer = get(row, "answer", "correct", "key")

        choices = []
        for letter in "abcdef":
            c = get(row, f"choice{letter}", f"choice {letter}", f"option{letter}", letter)
            if c:
                choices.append(c)

        if not kind:
            if choices:
                kind = "mcq"
            elif TRUE_FALSE.match(answer or ""):
                kind = "truefalse"
            else:
                kind = "short"

        if kind == "truefalse":
            by_section[name].append({
                "kind": "truefalse", "prompt": prompt, "points": points,
                "choices": ["True", "False"],
                "answer": "True" if (answer or "").lower() in ("true", "t", "yes") else "False",
                "shuffle": False,
            })
        elif kind in ("mcq", "multiselect"):
            if not answer:
                warnings.append(f"{name} · “{prompt[:48]}…”: no answer given.")
            if kind == "multiselect":
                vals = [a.strip() for a in re.split(r"[|;,]", answer) if a.strip()]
            else:
                vals = answer
            by_section[name].append({
                "kind": kind, "prompt": prompt, "points": points,
                "choices": choices, "answer": vals or None,
            })
        elif kind == "essay":
            by_section[name].append({"kind": "essay", "prompt": prompt,
                                     "points": points, "choices": [], "answer": None})
        else:
            alts = [a.strip() for a in re.split(r"\|", answer) if a.strip()]
            by_section[name].append({
                "kind": "short", "prompt": prompt, "points": points, "choices": [],
                "answer": (alts[0] if len(alts) == 1 else alts) if alts else None,
                "shuffle": False,
            })
            if not alts:
                warnings.append(f"{name} · “{prompt[:48]}…”: no answer given.")

    return {
        "title": "Imported Exam",
        "sections": [{"title": n, "instructions": "", "questions": by_section[n]} for n in order],
        "warnings": warnings,
        "keyApplied": [],
    }


# ---------------------------------------------------------------------- cli

def load_rows(path: Path) -> list[list[str]]:
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        return rows_from_sheet(path)
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return [row for row in csv.reader(io.StringIO(text))]


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--default-points", type=float, default=1.0,
                    help="points per item when the document does not say (default 1)")
    ap.add_argument("--title", help="override the exam title")
    ap.add_argument("--check", action="store_true",
                    help="print a summary to stderr and do not emit JSON")
    args = ap.parse_args()

    if not args.file.exists():
        print(f"no such file: {args.file}", file=sys.stderr)
        return 1

    if is_tabular(args.file):
        result = parse_tabular(load_rows(args.file), args.default_points)
    else:
        result = parse(extract_text(args.file), args.default_points)

    if args.title:
        result["title"] = args.title

    counts = {
        "sections": len(result["sections"]),
        "questions": sum(len(s["questions"]) for s in result["sections"]),
        "points": sum(q["points"] for s in result["sections"] for q in s["questions"]),
    }
    kinds: dict[str, int] = {}
    for s in result["sections"]:
        for q in s["questions"]:
            kinds[q["kind"]] = kinds.get(q["kind"], 0) + 1

    e = sys.stderr
    print(f"file        {args.file}", file=e)
    print(f"title       {result['title']}", file=e)
    print(f"sections    {counts['sections']}", file=e)
    print(f"questions   {counts['questions']}   ({counts['points']:g} points)", file=e)
    print(f"kinds       {kinds}", file=e)
    for s in result["sections"]:
        print(f"  · {s['title']}: {len(s['questions'])} items", file=e)
    if result.get("keyApplied"):
        k = result["keyApplied"]
        print(f"answer key  applied to {len(k)} items ({k[0]}–{k[-1]})", file=e)
    if result["warnings"]:
        print(f"\n{len(result['warnings'])} thing(s) to check:", file=e)
        for w in result["warnings"][:25]:
            print(f"  · {w}", file=e)
        if len(result["warnings"]) > 25:
            print(f"  … and {len(result['warnings']) - 25} more", file=e)

    if args.check:
        return 0

    print(json.dumps({"title": result["title"], "sections": result["sections"]},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
