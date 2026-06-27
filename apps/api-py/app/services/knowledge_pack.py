"""Python Knowledge Pack retrieval (yakimka/python_interview_questions).

An AUXILIARY reference, used only when the current question is a pure-Python
question (not a QA-Automation one). It never overrides QA context or the
candidate resume, and the full source markdown is never injected — only the top
1-3 matched records, capped to a small token budget.
"""

from __future__ import annotations

import json
import re
import time
from functools import lru_cache
from pathlib import Path

PACK_DIR = (
    Path(__file__).resolve().parent.parent
    / "knowledge"
    / "packs"
    / "python_interview_questions"
)

PACK_NAME = "python_interview_questions"

# Topics that belong to QA Automation — for these we use the QA context / domain
# hints, NOT the Python developer pack.
_QA_TOPIC_RE = re.compile(
    r"pytest|playwright|selenium|allure|\bapi\b|ci\s*/?\s*cd|cicd|docker|gitlab|jenkins|"
    r"httpx|requests|page\s*object|\bpom\b|smoke|regression|тест[\s-]?кейс|чек[\s-]?лист|"
    r"баг|flaky|автотест|локатор|селектор|фикстур|conftest|тест-дизайн",
    re.IGNORECASE | re.UNICODE,
)

# Signals that the question is about the Python language itself.
_PY_SIGNAL_RE = re.compile(
    r"список|кортеж|\btuple\b|\blist\b|словар|\bdict\b|множеств|\bset\b|"
    r"декоратор|decorator|генератор|generator|итератор|iterator|\byield\b|"
    r"контекстн|context\s*manager|исключени|exception|\bgil\b|поток|процесс|"
    r"thread|multiprocess|async|await|корутин|\bmro\b|staticmethod|classmethod|"
    r"__\w+__|метаклас|замыкан|closure|lambda|comprehension|\bargs\b|\bkwargs\b|"
    r"изменяем|mutable|hashable|хешир|хеш|импорт|модул|пакет|наследован|полиморфизм|"
    r"инкапсул|абстрак|\bооп\b|\boop\b|магическ|dunder|типизац|аннотац",
    re.IGNORECASE | re.UNICODE,
)

_WORD_RE = re.compile(r"[a-zа-яё_]{3,}|__\w+__", re.IGNORECASE | re.UNICODE)
_PRIORITY_WEIGHT = {"high_for_aqa": 2.0, "medium": 1.0, "low_rare_python_developer": 0.3}

# Keep the injected block small (target ≈ 800–1200 tokens).
MAX_INJECTED_CHARS = 3200
MAX_RECORD_CHARS = 1100


@lru_cache(maxsize=1)
def _load() -> tuple[list[dict], dict[str, dict], dict]:
    try:
        index = json.loads((PACK_DIR / "index.json").read_text(encoding="utf-8"))
        answers = json.loads((PACK_DIR / "answers.json").read_text(encoding="utf-8"))
        metadata = json.loads((PACK_DIR / "metadata.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [], {}, {}
    return index, answers, metadata


def is_python_question(question: str) -> bool:
    """True only for pure-Python questions. QA-Automation topics return False so
    the QA context / domain hints are used instead."""
    q = (question or "").strip()
    if not q:
        return False
    if _QA_TOPIC_RE.search(q):
        return False
    return bool(_PY_SIGNAL_RE.search(q))


def _estimate_tokens(text: str) -> int:
    # Rough heuristic good enough for budgeting (~4 chars/token).
    return max(1, round(len(text) / 4))


def retrieve(question: str, top_k: int = 3) -> list[dict]:
    """Return up to top_k matched pack records (answers), best first."""
    index, answers, _ = _load()
    if not index:
        return []
    qwords = set(_WORD_RE.findall(question.lower()))
    if not qwords:
        return []
    scored: list[tuple[float, dict]] = []
    for rec in index:
        overlap = len(qwords & set(rec.get("keywords", [])))
        if overlap == 0:
            continue
        score = overlap * _PRIORITY_WEIGHT.get(rec.get("priority", "medium"), 1.0)
        scored.append((score, rec))
    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict] = []
    for _, rec in scored[:top_k]:
        ans = answers.get(rec["id"])
        if ans:
            out.append(ans)
    return out


def _format_record(rec: dict) -> str:
    answer = rec["answer"]
    if len(answer) > MAX_RECORD_CHARS:
        answer = answer[:MAX_RECORD_CHARS].rsplit("\n", 1)[0] + " …"
    return f"Q: {rec['question']}\nA: {answer}"


def build_injection(question: str, top_k: int = 3) -> tuple[str, dict]:
    """Retrieve + format a capped reference block plus retrieval metrics.

    Returns (block_text, metrics). block_text is '' when nothing relevant.
    """
    started = time.perf_counter()
    records = retrieve(question, top_k=top_k)
    retrieval_ms = int((time.perf_counter() - started) * 1000)

    blocks: list[str] = []
    used_chars = 0
    used_count = 0
    for rec in records:
        formatted = _format_record(rec)
        if used_chars + len(formatted) > MAX_INJECTED_CHARS:
            break
        blocks.append(formatted)
        used_chars += len(formatted)
        used_count += 1

    if not blocks:
        return "", {
            "knowledgePackUsed": False,
            "knowledgePackName": None,
            "knowledgeRetrievalMs": retrieval_ms,
            "retrievedItemsCount": 0,
            "injectedContextTokens": 0,
        }

    body = "\n\n".join(blocks)
    block_text = (
        "PYTHON KNOWLEDGE PACK (auxiliary reference — may contain inaccuracies; "
        "normalize to the Skillcue say-aloud format, do NOT copy verbatim, and let "
        "QA context / resume win on any conflict):\n" + body
    )
    return block_text, {
        "knowledgePackUsed": True,
        "knowledgePackName": PACK_NAME,
        "knowledgeRetrievalMs": retrieval_ms,
        "retrievedItemsCount": used_count,
        "injectedContextTokens": _estimate_tokens(block_text),
    }
