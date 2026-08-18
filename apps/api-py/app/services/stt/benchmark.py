"""STT Benchmark — measures **only** audio -> STT -> transcript.

Deliberately separate from voice regression:
  * No LLM is called.
  * No *answer* keywords are used — only *transcript* keywords.
  * It scores the raw OpenAI Mini transcript without changing its text.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from app.config import BASE_DIR

from .base import BaseTranscriptionProvider

logger = logging.getLogger("stt.benchmark")

REPO_ROOT = BASE_DIR.parent.parent
BENCH_DIR = REPO_ROOT / "tests" / "stt-benchmark"
CASES_PATH = BENCH_DIR / "cases.json"
AUDIO_DIR = BENCH_DIR / "audio"
RESULTS_DIR = BENCH_DIR / "results"


# --- case loading --------------------------------------------------------
def load_cases() -> list[dict]:
    if not CASES_PATH.exists():
        return []
    with CASES_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("cases", [])


def get_case(case_id: str) -> dict | None:
    return next((c for c in load_cases() if c.get("id") == case_id), None)


def resolve_audio_path(audio_file: str) -> Path:
    raw = Path(audio_file)
    if raw.is_absolute():
        resolved = raw.resolve()
    else:
        normalized = audio_file.replace("\\", "/")
        candidate = REPO_ROOT / normalized
        if candidate.exists():
            resolved = candidate.resolve()
        else:
            resolved = (AUDIO_DIR / raw.name).resolve()
    if not str(resolved).startswith(str(REPO_ROOT.resolve())):
        raise ValueError(f"Audio file outside permitted directory: {resolved}")
    return resolved


# --- fuzzy/semantic scoring (no audio, no model) -------------------------
# Exact substring matching is unfairly strict for ASR output: it misses
# inflections ("пайплайне" vs "пайплайн") and phonetic garbles
# ("автотистами" vs "автотесты"). We add fuzzy token/phrase matching so the
# benchmark credits a transcript that is clearly the right word, and we score
# *semantic intent* separately from exact keywords.
FUZZY_THRESHOLD = 0.82
SEMANTIC_THRESHOLD = 0.8


def _norm(text: str) -> str:
    return (text or "").lower()


def _tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", _norm(text), re.UNICODE)


def _ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def _alias_present(alias: str, text_low: str, tokens: list[str], threshold: float) -> bool:
    """True if `alias` appears in the text, exactly or via fuzzy token/phrase match."""
    a = _norm(alias).strip()
    if not a:
        return False
    if a in text_low:  # exact substring (handles verbatim phrases)
        return True
    words = a.split()
    if len(words) == 1:
        if len(a) < 4:  # too short for reliable fuzzy matching
            return False
        return any(len(t) >= 3 and _ratio(a, t) >= threshold for t in tokens)
    n = len(words)
    for i in range(len(tokens) - n + 1):
        if _ratio(a, " ".join(tokens[i : i + n])) >= threshold:
            return True
    return False


def match_keywords(
    transcript: str, keywords: list[dict], threshold: float = FUZZY_THRESHOLD
) -> tuple[float, list[str], list[str]]:
    """Return (score, hit_keys, missed_keys) with fuzzy alias matching."""
    if not keywords:
        return 1.0, [], []
    text_low = _norm(transcript)
    tokens = _tokens(transcript)
    hit, miss = [], []
    for kw in keywords:
        key = kw.get("key", "")
        aliases = kw.get("aliases") or [key]
        if any(_alias_present(a, text_low, tokens, threshold) for a in aliases):
            hit.append(key)
        else:
            miss.append(key)
    return round(len(hit) / len(keywords), 3), hit, miss


def match_terms(
    transcript: str, terms: list[str], threshold: float = SEMANTIC_THRESHOLD
) -> tuple[float, list[str], list[str]]:
    """Fraction of expected meaning terms/phrases present (fuzzy)."""
    if not terms:
        return 1.0, [], []
    text_low = _norm(transcript)
    tokens = _tokens(transcript)
    hit = [t for t in terms if _alias_present(t, text_low, tokens, threshold)]
    miss = [t for t in terms if t not in hit]
    return round(len(hit) / len(terms), 3), hit, miss


# Backwards-compatible thin wrappers (used by older callers/tests).
def keyword_match(transcript: str, keywords: list[dict]) -> float:
    return match_keywords(transcript, keywords)[0]


def intent_match(transcript: str, expected_terms: list[str]) -> float:
    return match_terms(transcript, expected_terms)[0]


def classify_error(raw_transcript: str, best_match: float) -> str:
    if not (raw_transcript or "").strip():
        return "empty"
    if best_match >= 0.8:
        return "ok"
    if best_match >= 0.4:
        return "partial"
    return "low"


def score_case(case: dict, raw_transcript: str, latency_ms: int) -> dict:
    """Score the provider transcript without modifying it."""
    keywords = case.get("transcriptKeywords") or []
    sem_terms = (case.get("expectedTerms") or []) + (case.get("expectedMeaning") or [])
    raw_kw, hit_keys, miss_keys = match_keywords(raw_transcript, keywords)
    raw_sem, sem_hit, sem_miss = match_terms(raw_transcript, sem_terms)
    best = max(raw_kw, raw_sem)
    return {
        "caseId": case.get("id"),
        "title": case.get("title"),
        "raw": {
            "transcript": raw_transcript,
            "latencyMs": latency_ms,
            "keywordMatch": raw_kw,
            "semanticMatch": raw_sem,
            "keywordsHit": hit_keys,
            "keywordsMissed": miss_keys,
            "meaningHit": sem_hit,
            "meaningMissed": sem_miss,
        },
        "intentMatch": raw_sem,
        "falseNegative": raw_sem >= 0.6 and raw_kw < 0.5,
        "errorType": classify_error(raw_transcript, best),
    }


# --- running (needs a provider) ------------------------------------------
async def run_case(case: dict, provider: BaseTranscriptionProvider) -> dict:
    audio_path = resolve_audio_path(case["audioFile"])
    if not audio_path.is_file():
        return {
            "caseId": case.get("id"),
            "title": case.get("title"),
            "errorType": "audio_missing",
            "error": f"Audio not found: {audio_path}",
        }
    audio = audio_path.read_bytes()
    try:
        result = await provider.transcribe_audio_file(audio, language="multi")
    except Exception as exc:  # noqa: BLE001
        logger.warning("STT benchmark case %s failed on %s: %s", case.get("id"), provider.id, exc)
        return {
            "caseId": case.get("id"),
            "title": case.get("title"),
            "engine": provider.id,
            "model": provider._active_model(),
            "errorType": "transcribe_failed",
            "error": str(exc),
        }
    scored = score_case(case, result.text, result.latency_ms)
    scored["engine"] = provider.id
    scored["model"] = provider._active_model()
    return scored


def _aggregate(cases: list[dict], provider: BaseTranscriptionProvider) -> dict:
    scored = [c for c in cases if "raw" in c]
    n = len(scored) or 1

    def avg(key: str, sub: str) -> float:
        return round(sum(c[sub][key] for c in scored) / n, 3) if scored else 0.0

    error_types: dict[str, int] = {}
    for c in cases:
        et = c.get("errorType", "unknown")
        error_types[et] = error_types.get(et, 0) + 1
    avg_raw = avg("keywordMatch", "raw")
    avg_sem_raw = avg("semanticMatch", "raw")
    false_negatives = sum(1 for c in scored if c.get("falseNegative"))
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "engine": provider.id,
        "model": provider._active_model(),
        "caseCount": len(cases),
        "avgLatencyMs": int(sum(c["raw"]["latencyMs"] for c in scored) / n) if scored else 0,
        "avgKeywordMatchRaw": avg_raw,
        "avgSemanticMatchRaw": avg_sem_raw,
        "avgIntentMatch": round(sum(c.get("intentMatch", 0) for c in scored) / n, 3)
        if scored
        else 0.0,
        "falseNegatives": false_negatives,
        "errorTypes": error_types,
        "cases": cases,
    }


async def run_all(provider: BaseTranscriptionProvider) -> dict:
    cases = load_cases()
    results = [await run_case(c, provider) for c in cases]
    return _aggregate(results, provider)


# --- results storage (mirrors voice-tests reports) -----------------------
def save_report(report: dict, filename: str | None = None) -> dict:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    name = filename or f"stt-benchmark-{ts}.json"
    if not name.endswith(".json"):
        name += ".json"
    out = RESULTS_DIR / Path(name).name
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"path": str(out), "filename": out.name}


def list_reports() -> list[dict]:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        RESULTS_DIR.glob("stt-benchmark-*.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return [
        {
            "filename": p.name,
            "modifiedAt": datetime.fromtimestamp(p.stat().st_mtime, tz=UTC).isoformat(),
        }
        for p in files
    ]


def get_report(filename: str) -> dict | None:
    name = Path(filename).name
    if not name.startswith("stt-benchmark-") or not name.endswith(".json"):
        return None
    path = RESULTS_DIR / name
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)
