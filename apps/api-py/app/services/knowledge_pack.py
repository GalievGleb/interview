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

_PACKS_ROOT = Path(__file__).resolve().parent.parent / "knowledge" / "packs"

PACK_DIR = _PACKS_ROOT / "python_interview_questions"
PACK_NAME = "python_interview_questions"

SQL_PACK_DIR = _PACKS_ROOT / "sql_interview_questions"
SQL_PACK_NAME = "sql_interview_questions"

# Topics that belong to QA Automation — for these we use the QA context / domain
# hints, NOT the Python developer pack.
_QA_TOPIC_RE = re.compile(
    r"pytest|playwright|selenium|allure|\bapi\b|ci\s*/?\s*cd|cicd|docker|gitlab|jenkins|"
    r"httpx|requests|page\s*object|\bpom\b|smoke|regression|тест[\s-]?кейс|чек[\s-]?лист|"
    r"баг|flaky|автотест|локатор|селектор|фикстур|\bfixtures?\b|\bfixture_\w+|conftest|тест-дизайн",
    re.IGNORECASE | re.UNICODE,
)

# Git terms such as «hash» overlap with Python vocabulary but must never route
# to the Python community pack.
_GIT_TOPIC_RE = re.compile(
    r"\bgit\b|\bstash\b|\brebase\b|\bcommit\b|коммит|\bfetch\b|\bpull\b|"
    r"\bmerge\b|ветк\w*|репозитор",
    re.IGNORECASE | re.UNICODE,
)

_PY_INSTANCE_EQUALITY_RE = re.compile(
    r"(?:\ba\s*==\s*b\b.{0,120}\bclass\b|\bclass\b.{0,120}\ba\s*==\s*b\b)|"
    r"\b__eq__\b",
    re.IGNORECASE | re.UNICODE,
)

# Signals that the question is about the Python language itself.
_PY_SIGNAL_RE = re.compile(
    r"список|кортеж|\btuple\b|\blist\b|словар|\bdict\b|множеств|\bset\b|"
    r"декоратор|decorator|генератор|generator|итератор|iterator|\byield\b|"
    r"контекстн|context\s*manager|исключени|exception|\bgil\b|поток|процесс|"
    r"thread|multiprocess|async|await|корутин|\bmro\b|staticmethod|classmethod|"
    r"__\w+__|метаклас|замыкан|closure|lambda|comprehension|\bargs\b|\bkwargs\b|"
    r"изменяем|mutable|immutable|hashable|хешир|хеш|импорт|модул|пакет|наследован|полиморфизм|"
    r"инкапсул|абстрак|\bооп\b|\boop\b|магическ|dunder|типизац|аннотац|"
    r"строк|\bstr\b|\brange\b|\bxrange\b|\bzip\b|\bsorted\b|сравнен\w*\s+экземпляр|"
    r"равенств\w*\s+объект|\b__eq__\b|аргумент\w*\s+по\s+умолчанию",
    re.IGNORECASE | re.UNICODE,
)

# Signals that the question is about SQL / databases. Ambiguous words like
# «индекс» or «запрос» only count with a database context nearby.
_SQL_SIGNAL_RE = re.compile(
    r"\bsql\b|\bjoin\b|джойн|джоин|субд|баз\w{0,3}\s+данн|\bselect\b|селект|"
    r"group\s+by|having|order\s+by|primary\s+key|foreign\s+key|первичн\w+\s+ключ|"
    r"внешн\w+\s+ключ|транзакци|\bacid\b|нормализаци|подзапрос|subquery|"
    r"union|truncate|\bdistinct\b|агрегатн|оконн\w+\s+функц|window\s+function|"
    r"уровн\w+\s+изоляц|isolation\s+level|индекс\w*\s+в\s+(?:баз|таблиц|субд)|"
    r"индекс\w*\s+(?:базы|таблицы)|postgres|postgresql|mysql|\bnosql\b|"
    r"дубликат\w*\s+в\s+таблиц|coalesce|\bnull\b.{0,20}(?:sql|баз|таблиц)|"
    r"(?:sql|баз\w{0,3}|таблиц\w{0,3}).{0,20}\bnull\b",
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


_GENERIC_CURATED_KEYWORDS = {
    "python",
    "что",
    "такое",
    "значение",
    "метод",
    "класс",
    "класса",
    "классы",
    "объект",
    "объекта",
    "объекты",
    "отличается",
    "разница",
    "делает",
}


@lru_cache(maxsize=8)
def _load_curated_for(pack_dir: Path) -> tuple[dict, ...]:
    """Verified, Skillcue-normalized answers that OUTRANK the community source."""
    try:
        data = json.loads((pack_dir / "curated.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return ()
    return tuple(data.get("entries", []))


def _match_curated(question: str, pack_dir: Path = PACK_DIR, limit: int = 1) -> list[dict]:
    """Best curated entries for the question (keyword overlap), best first."""
    qwords = set(_WORD_RE.findall(question.lower()))
    if not qwords:
        return []
    scored: list[tuple[int, int, dict]] = []
    for i, entry in enumerate(_load_curated_for(pack_dir)):
        if (
            pack_dir == PACK_DIR
            and entry.get("id") == "python-instance-equality"
            and _PY_INSTANCE_EQUALITY_RE.search(question)
        ):
            scored.append((100, -i, entry))
            continue
        keywords = {str(k).lower() for k in entry.get("keywords", [])}
        matched = qwords & keywords
        distinctive = matched - _GENERIC_CURATED_KEYWORDS
        # One domain-specific term (yield/GIL/range/...) is enough. Generic
        # words such as «object/value/method» need at least two overlaps so an
        # unrelated curated answer cannot outrank the community retrieval.
        if distinctive or len(matched) >= 2:
            scored.append((len(distinctive) * 3 + len(matched), -i, entry))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [entry for _, _, entry in scored[:limit]]


def is_python_question(question: str) -> bool:
    """True only for pure-Python questions. QA-Automation topics return False so
    the QA context / domain hints are used instead."""
    q = (question or "").strip()
    if not q:
        return False
    if _QA_TOPIC_RE.search(q) or _GIT_TOPIC_RE.search(q):
        return False
    return bool(_PY_INSTANCE_EQUALITY_RE.search(q) or _PY_SIGNAL_RE.search(q))


def is_sql_question(question: str) -> bool:
    """True for SQL/database questions. Python signals win on overlap (e.g.
    «запрос к базе через словарь» is a Python question about data structures)."""
    q = (question or "").strip()
    if not q:
        return False
    if is_python_question(q):
        return False
    return bool(_SQL_SIGNAL_RE.search(q))


def detect_pack(question: str) -> str | None:
    """Which knowledge pack (if any) should back this question."""
    if is_python_question(question):
        return "python"
    if is_sql_question(question):
        return "sql"
    return None


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


def _empty_metrics(retrieval_ms: int) -> dict:
    return {
        "knowledgePackUsed": False,
        "knowledgePackName": None,
        "knowledgeSource": "none",
        "knowledgeRetrievalMs": retrieval_ms,
        "retrievedItemsCount": 0,
        "injectedContextTokens": 0,
    }


def _build_sql_injection(question: str) -> tuple[str, dict]:
    """SQL pack is curated-only: up to two verified entries, no community layer."""
    started = time.perf_counter()
    entries = _match_curated(question, pack_dir=SQL_PACK_DIR, limit=2)
    retrieval_ms = int((time.perf_counter() - started) * 1000)
    if not entries:
        return "", _empty_metrics(retrieval_ms)

    body = "\n\n".join(f"Q: {e['question']}\nA: {e['answer']}" for e in entries)
    block_text = (
        "SQL KNOWLEDGE PACK (verified reference — normalize to the Skillcue "
        "say-aloud format, do NOT copy verbatim; the candidate is a QA engineer, "
        "so keep the QA angle when it fits):\n" + body
    )
    return block_text, {
        "knowledgePackUsed": True,
        "knowledgePackName": SQL_PACK_NAME,
        "knowledgeSource": "curated",
        "knowledgeRetrievalMs": retrieval_ms,
        "retrievedItemsCount": len(entries),
        "injectedContextTokens": _estimate_tokens(block_text),
    }


def build_injection(question: str, top_k: int = 3) -> tuple[str, dict]:
    """Retrieve + format a capped reference block plus retrieval metrics.

    Routes to the pack detected for the question. Returns (block_text, metrics);
    block_text is '' when nothing relevant.
    """
    if detect_pack(question) == "sql":
        return _build_sql_injection(question)

    started = time.perf_counter()
    matched = _match_curated(question)
    curated = matched[0] if matched else None
    # A verified curated hit is authoritative and sufficient. Mixing community
    # answers back in reintroduced factual contradictions (notably range and
    # default instance equality), so community is fallback-only.
    community = [] if curated else retrieve(question, top_k=top_k)
    retrieval_ms = int((time.perf_counter() - started) * 1000)

    blocks: list[str] = []
    used_chars = 0
    used_count = 0
    source = "none"

    if curated:
        blocks.append(f"Q: {curated['question']}\nA: {curated['answer']}")
        used_chars += len(blocks[-1])
        used_count += 1
        source = "curated"

    for rec in community:
        formatted = _format_record(rec)
        if used_chars + len(formatted) > MAX_INJECTED_CHARS:
            break
        blocks.append(formatted)
        used_chars += len(formatted)
        used_count += 1
        source = "curated+community" if curated else "community"

    if not blocks:
        return "", _empty_metrics(retrieval_ms)

    body = "\n\n".join(blocks)
    if source == "curated":
        block_text = (
            "PYTHON VERIFIED FACTUAL CONTRACT (non-negotiable): The Q/A below is "
            "authoritative. Follow its result exactly; an answer that contradicts it is "
            "incorrect. Normalize wording but do not change facts:\n" + body
        )
    else:
        block_text = (
            "PYTHON KNOWLEDGE PACK (auxiliary community reference — may contain "
            "inaccuracies; normalize to the Skillcue say-aloud format, do NOT copy "
            "verbatim, and let QA context / resume win on any conflict):\n" + body
        )
    return block_text, {
        "knowledgePackUsed": True,
        "knowledgePackName": PACK_NAME,
        "knowledgeSource": source,
        "knowledgeRetrievalMs": retrieval_ms,
        "retrievedItemsCount": used_count,
        "injectedContextTokens": _estimate_tokens(block_text),
    }
