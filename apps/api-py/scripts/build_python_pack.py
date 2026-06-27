"""Ingestion for the Python Knowledge Pack (yakimka/python_interview_questions).

Parses the source questions.md into structured records and writes index.json /
answers.json / metadata.json. The full markdown is NEVER injected into a prompt —
only the parsed records are, and only the top 1-3 at answer time.

Run:  python scripts/build_python_pack.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

PACK_DIR = Path(__file__).resolve().parent.parent / "app" / "knowledge" / "packs" / "python_interview_questions"
SOURCE = PACK_DIR / "source" / "questions.md"

# Only the Python section is treated as on-topic; everything else (Django, web,
# HTTP, DB, frontend, SDLC, VCS, design-interview…) is low priority for a QA
# Automation / Python interview.
PYTHON_SECTION = "Python"

# High-value topics for QA Automation engineers (substring match, lowercased).
HIGH_FOR_AQA = [
    "последовательност", "list", "tuple", "кортеж", "список",
    "множеств", "set", "dict", "словар", "хеш", "hashab", "хешир",
    "изменяем", "mutable", "значени по умолчанию", "default",
    "args", "kwargs", "аргумент",
    "декоратор", "decorator",
    "итератор", "генератор", "iterator", "generator", "yield",
    "контекстн", "context manager", "with",
    "исключени", "exception", "try", "except",
    "класс", "объект", "oop", "ооп", "наследован", "полиморф", "инкапсул", "абстрак",
    "mro", "staticmethod", "classmethod", "__init__", "__new__",
    "модул", "пакет", "import", "импорт",
    "gil", "поток", "процесс", "thread", "multiprocess", "async", "await", "корутин",
    "comprehension", "lambda", "замыкан", "closure",
]

# Topics that are rare / legacy / out of scope for QA Automation.
LOW_MARKERS = [
    "python 2", "python2", "метаклас", "metaclass", "singleton", "шаблон",
    "design pattern", "паттерн проектирован", "cpython internal", "байткод", "bytecode",
    "garbage collector", "интроспекц", "рефлекс",
]

TAG_KEYWORDS = {
    "list": ["list", "список"],
    "tuple": ["tuple", "кортеж"],
    "dict": ["dict", "словар"],
    "set": ["set", "множеств"],
    "hashing": ["хеш", "hash"],
    "mutable": ["изменяем", "mutable", "значени по умолчанию", "default"],
    "args_kwargs": ["args", "kwargs"],
    "decorator": ["декоратор", "decorator"],
    "generator": ["генератор", "generator", "yield"],
    "iterator": ["итератор", "iterator"],
    "context_manager": ["контекстн", "context manager"],
    "exceptions": ["исключени", "exception"],
    "oop": ["класс", "объект", "ооп", "наследован", "полиморф", "инкапсул"],
    "mro": ["mro"],
    "method_types": ["staticmethod", "classmethod"],
    "dunder": ["__init__", "__new__", "__"],
    "modules": ["модул", "пакет", "import", "импорт"],
    "gil": ["gil"],
    "concurrency": ["поток", "процесс", "thread", "multiprocess", "async", "await", "корутин"],
    "comprehension": ["comprehension"],
}


def slugify(text: str, used: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", text.lower().strip())[:60].strip("-") or "q"
    slug = base
    i = 2
    while slug in used:
        slug = f"{base}-{i}"
        i += 1
    used.add(slug)
    return slug


def parse(md: str) -> list[dict]:
    lines = md.splitlines()
    in_fence = False
    section = ""
    topic = ""
    records: list[dict] = []
    current: dict | None = None
    body: list[str] = []

    def flush() -> None:
        nonlocal current, body
        if current is not None:
            answer = "\n".join(body).strip()
            if answer:
                current["answer"] = answer
                records.append(current)
        current = None
        body = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            if current is not None:
                body.append(line)
            continue
        if in_fence:
            if current is not None:
                body.append(line)
            continue

        m1 = re.match(r"^#\s+(.+)$", line)
        m2 = re.match(r"^##\s+(.+)$", line)
        m3 = re.match(r"^###\s+(.+)$", line)

        if m1:
            flush()
            section = m1.group(1).strip()
            topic = ""
        elif m2:
            # A «##» may be a topic (has ### children) OR a standalone question.
            flush()
            topic = m2.group(1).strip()
            current = {"question": topic, "section": section, "topic": topic, "level": 2}
            body = []
        elif m3:
            flush()
            current = {"question": m3.group(1).strip(), "section": section, "topic": topic, "level": 3}
            body = []
        else:
            if current is not None:
                body.append(line)
    flush()

    # A level-2 record that turned out to be only a container (its body is empty
    # because it had ### children) is dropped by flush() already (no answer).
    return records


def classify(rec: dict) -> tuple[str, list[str]]:
    text = f"{rec['question']} {rec.get('topic', '')}".lower()
    tags = sorted({tag for tag, kws in TAG_KEYWORDS.items() if any(k in text for k in kws)})

    if rec["section"].strip().lower() != PYTHON_SECTION.lower():
        return "low_rare_python_developer", tags
    if any(m in text for m in LOW_MARKERS):
        return "low_rare_python_developer", tags
    if any(h in text for h in HIGH_FOR_AQA):
        return "high_for_aqa", tags
    return "medium", tags


def keywords_for(rec: dict) -> list[str]:
    text = f"{rec['question']} {rec.get('topic', '')}".lower()
    words = re.findall(r"[a-zа-яё_]{3,}|__\w+__", text)
    stop = {"что", "такое", "как", "для", "или", "это", "при", "the", "это", "чем", "вы", "the"}
    return sorted({w for w in words if w not in stop})


def main() -> None:
    md = SOURCE.read_text(encoding="utf-8")
    records = parse(md)

    index: list[dict] = []
    answers: dict[str, dict] = {}
    used: set[str] = set()
    MAX_ANSWER_CHARS = 1600

    for rec in records:
        # Skip empty/structural and overly short non-answers.
        if len(rec.get("answer", "")) < 20:
            continue
        priority, tags = classify(rec)
        rid = slugify(rec["question"], used)
        answer = rec["answer"].strip()
        if len(answer) > MAX_ANSWER_CHARS:
            answer = answer[:MAX_ANSWER_CHARS].rsplit("\n", 1)[0] + "\n…"
        index.append(
            {
                "id": rid,
                "question": rec["question"],
                "section": rec["section"],
                "topic": rec.get("topic", ""),
                "tags": tags,
                "priority": priority,
                "keywords": keywords_for(rec),
            }
        )
        answers[rid] = {
            "id": rid,
            "question": rec["question"],
            "answer": answer,
            "section": rec["section"],
            "topic": rec.get("topic", ""),
            "tags": tags,
            "priority": priority,
        }

    (PACK_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (PACK_DIR / "answers.json").write_text(
        json.dumps(answers, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    by_priority: dict[str, int] = {}
    for item in index:
        by_priority[item["priority"]] = by_priority.get(item["priority"], 0) + 1

    metadata = {
        "sourceName": "yakimka/python_interview_questions",
        "sourceUrl": "https://github.com/yakimka/python_interview_questions",
        "license": "MIT",
        "sourceQuality": "community_unverified",
        "defaultEnabled": True,
        "priority": "medium",
        "useOnlyWhenIntent": "python_question",
        "recordCount": len(index),
        "byPriority": by_priority,
        "note": (
            "Auxiliary reference only. Answers may contain inaccuracies — normalize to "
            "Skillcue format and never override QA Automation context or candidate resume."
        ),
    }
    (PACK_DIR / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"records: {len(index)}  byPriority: {by_priority}")


if __name__ == "__main__":
    main()
