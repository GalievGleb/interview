"""Voice regression test assets — read cases, transcribe audio files, save reports."""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import BASE_DIR
from app.services.stt.registry import build_whisper_provider

logger = logging.getLogger("voice_tests")

router = APIRouter(prefix="/voice-tests", tags=["voice-tests"])

REPO_ROOT = BASE_DIR.parent.parent
VOICE_TESTS_DIR = REPO_ROOT / "tests" / "voice"
CASES_PATH = VOICE_TESTS_DIR / "cases.json"
AUDIO_DIR = VOICE_TESTS_DIR / "audio"
RESULTS_DIR = VOICE_TESTS_DIR / "results"


def _resolve_audio_path(audio_file: str) -> Path:
    raw = Path(audio_file)
    if raw.is_absolute():
        path = raw
    else:
        normalized = audio_file.replace("\\", "/")
        if normalized.startswith("tests/voice/"):
            path = REPO_ROOT / normalized
        else:
            path = VOICE_TESTS_DIR / normalized
    if not path.exists():
        path = AUDIO_DIR / Path(audio_file).name
    return path.resolve()


class VoiceTestReportPayload(BaseModel):
    report: dict
    filename: str | None = None


@router.get("/cases")
def list_cases() -> dict:
    if not CASES_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail=f"cases.json not found at {CASES_PATH}",
        )
    with CASES_PATH.open(encoding="utf-8") as f:
        cases = json.load(f)
    return {
        "cases": cases,
        "root": str(VOICE_TESTS_DIR),
        "audioDir": str(AUDIO_DIR),
    }


@router.get("/cases/{case_id}/audio-exists")
def audio_exists(case_id: str) -> dict:
    cases = _load_cases()
    case = next((c for c in cases if c.get("id") == case_id), None)
    if not case:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
    path = _resolve_audio_path(case["audioFile"])
    return {"caseId": case_id, "path": str(path), "exists": path.is_file()}


@router.post("/transcribe/{case_id}")
async def transcribe_case(case_id: str) -> dict:
    cases = _load_cases()
    case = next((c for c in cases if c.get("id") == case_id), None)
    if not case:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")

    audio_path = _resolve_audio_path(case["audioFile"])
    if not audio_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Audio file not found: {audio_path}",
        )

    audio_bytes = audio_path.read_bytes()
    provider = build_whisper_provider()
    if not provider.is_available():
        raise HTTPException(
            status_code=502,
            detail="Whisper не установлен (pip install -r requirements-whisper.txt)",
        )
    if not provider.is_model_downloaded():
        raise HTTPException(
            status_code=409,
            detail="Модель Whisper не загружена — откройте Настройки → Распознавание речи",
        )
    try:
        result = await provider.transcribe_audio_file(audio_bytes, language="multi")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "caseId": case_id,
        "transcript": result.text,
        "sttLatencyMs": result.latency_ms,
        "audioPath": str(audio_path),
    }


@router.post("/reports")
def save_report(payload: VoiceTestReportPayload) -> dict:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    filename = payload.filename or f"voice-regression-{ts}.json"
    if not filename.endswith(".json"):
        filename += ".json"
    out_path = RESULTS_DIR / filename
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload.report, f, ensure_ascii=False, indent=2)
    logger.info("Voice test report saved: %s", out_path)
    return {"path": str(out_path), "filename": filename}


def _safe_report_filename(filename: str) -> str:
    name = Path(filename).name
    if not name.startswith("voice-regression-") or not name.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid report filename")
    return name


@router.get("/reports")
def list_reports() -> dict:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        RESULTS_DIR.glob("voice-regression-*.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return {
        "reports": [
            {
                "filename": path.name,
                "path": str(path),
                "modifiedAt": datetime.fromtimestamp(
                    path.stat().st_mtime,
                    tz=UTC,
                ).isoformat(),
            }
            for path in files
        ]
    }


@router.get("/reports/{filename}")
def get_report(filename: str) -> dict:
    safe_name = _safe_report_filename(filename)
    path = RESULTS_DIR / safe_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Report not found: {safe_name}")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _load_cases() -> list[dict]:
    if not CASES_PATH.exists():
        raise HTTPException(status_code=404, detail="cases.json not found")
    with CASES_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    return data.get("cases") or []
