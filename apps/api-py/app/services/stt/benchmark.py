"""STT Benchmark — measures **only** audio -> STT -> transcript.

Deliberately separate from voice regression:
  * No LLM is called.
  * No *answer* keywords are used — only *transcript* keywords.
  * It compares Whisper **raw** vs Whisper **corrected** (deterministic glossary)
    plus latency, keyword match, intent match, and an error type.

Deepgram was removed, so there is a single engine (local Whisper); the structure
still supports adding another engine later without changing call sites.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from app.config import BASE_DIR

from . import glossary
from .whisper_local_provider import WhisperLocalProvider

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
        return raw.resolve()
    normalized = audio_file.replace("\\", "/")
    candidate = REPO_ROOT / normalized
    if candidate.exists():
        return candidate.resolve()
    return (AUDIO_DIR / raw.name).resolve()


# --- pure scoring (no audio, no model) -----------------------------------
def _norm(text: str) -> str:
    return (text or "").lower()


def keyword_match(transcript: str, keywords: list[dict]) -> float:
    """Fraction of transcript keywords whose any alias appears in the text."""
    if not keywords:
        return 1.0
    low = _norm(transcript)
    hits = 0
    for kw in keywords:
        aliases = kw.get("aliases") or [kw.get("key", "")]
        if any(a and _norm(a) in low for a in aliases):
            hits += 1
    return round(hits / len(keywords), 3)


def intent_match(transcript: str, expected_terms: list[str]) -> float:
    """Fraction of expected canonical terms present after correction."""
    if not expected_terms:
        return 1.0
    low = _norm(transcript)
    hits = sum(1 for term in expected_terms if _norm(term) in low)
    return round(hits / len(expected_terms), 3)


def classify_error(raw_transcript: str, corrected_match: float) -> str:
    if not (raw_transcript or "").strip():
        return "empty"
    if corrected_match >= 0.8:
        return "ok"
    if corrected_match >= 0.4:
        return "partial"
    return "low"


def score_case(case: dict, raw_transcript: str, latency_ms: int) -> dict:
    """Build a per-case benchmark result from a transcript (engine-agnostic)."""
    keywords = case.get("transcriptKeywords") or []
    expected_terms = case.get("expectedTerms") or []
    corrected, corrections = glossary.correct_transcript(raw_transcript)

    raw_match = keyword_match(raw_transcript, keywords)
    corrected_match = keyword_match(corrected, keywords)
    return {
        "caseId": case.get("id"),
        "title": case.get("title"),
        "raw": {
            "transcript": raw_transcript,
            "latencyMs": latency_ms,
            "keywordMatch": raw_match,
        },
        "corrected": {
            "transcript": corrected,
            "keywordMatch": corrected_match,
            "corrections": [c.as_dict() for c in corrections],
        },
        "keywordGain": round(corrected_match - raw_match, 3),
        "intentMatch": intent_match(corrected, expected_terms),
        "errorType": classify_error(raw_transcript, corrected_match),
    }


# --- running (needs a provider) ------------------------------------------
async def run_case(case: dict, provider: WhisperLocalProvider) -> dict:
    audio_path = resolve_audio_path(case["audioFile"])
    if not audio_path.is_file():
        return {
            "caseId": case.get("id"),
            "title": case.get("title"),
            "errorType": "audio_missing",
            "error": f"Audio not found: {audio_path}",
        }
    audio = audio_path.read_bytes()
    result = await provider.transcribe_audio_file(audio, language="multi")
    scored = score_case(case, result.text, result.latency_ms)
    scored["engine"] = provider.id
    scored["model"] = provider._active_model()
    return scored


def _aggregate(cases: list[dict], provider: WhisperLocalProvider) -> dict:
    scored = [c for c in cases if "raw" in c]
    n = len(scored) or 1

    def avg(key: str, sub: str) -> float:
        return round(sum(c[sub][key] for c in scored) / n, 3) if scored else 0.0

    error_types: dict[str, int] = {}
    for c in cases:
        et = c.get("errorType", "unknown")
        error_types[et] = error_types.get(et, 0) + 1
    avg_raw = avg("keywordMatch", "raw")
    avg_corrected = avg("keywordMatch", "corrected")
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "engine": provider.id,
        "model": provider._active_model(),
        "caseCount": len(cases),
        "avgLatencyMs": int(sum(c["raw"]["latencyMs"] for c in scored) / n) if scored else 0,
        "avgKeywordMatchRaw": avg_raw,
        "avgKeywordMatchCorrected": avg_corrected,
        "correctionGain": round(avg_corrected - avg_raw, 3),
        "avgIntentMatch": round(sum(c.get("intentMatch", 0) for c in scored) / n, 3)
        if scored
        else 0.0,
        "errorTypes": error_types,
        "cases": cases,
    }


async def run_all(provider: WhisperLocalProvider) -> dict:
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
