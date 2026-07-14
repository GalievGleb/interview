"""STT Benchmark endpoints — audio -> transcript only, no LLM.

``engine`` (query): whisper (дефолт) | deepgram | speechkit — сравнение движков
на одних и тех же записях.
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.stt import benchmark
from app.services.stt.registry import build_whisper_provider

logger = logging.getLogger("stt.benchmark")

router = APIRouter(prefix="/stt/benchmark", tags=["stt-benchmark"])


def _provider_or_503(engine: str = "whisper"):
    if engine == "deepgram":
        from app.services.stt.deepgram_stream import DeepgramProvider

        provider = DeepgramProvider()
        if not provider.is_available():
            raise HTTPException(status_code=409, detail=provider._availability_reason())
        return provider
    if engine == "speechkit":
        from app.services.stt.speechkit_stream import SpeechKitProvider

        provider = SpeechKitProvider()
        if not provider.is_available():
            raise HTTPException(status_code=409, detail=provider._availability_reason())
        return provider
    if engine == "soniox":
        from app.services.stt.soniox_stream import SonioxProvider

        provider = SonioxProvider()
        if not provider.is_available():
            raise HTTPException(status_code=409, detail=provider._availability_reason())
        return provider

    provider = build_whisper_provider()
    if not provider.is_available():
        raise HTTPException(
            status_code=503,
            detail="Whisper не установлен (pip install -r requirements-whisper.txt)",
        )
    if not provider.is_model_downloaded():
        raise HTTPException(
            status_code=409,
            detail="Модель Whisper не загружена — откройте Настройки → Распознавание речи",
        )
    return provider


@router.get("/cases")
def list_cases() -> dict:
    return {"cases": benchmark.load_cases(), "root": str(benchmark.BENCH_DIR)}


@router.post("/run/{case_id}")
async def run_case(case_id: str, engine: str = "whisper") -> dict:
    case = benchmark.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
    provider = _provider_or_503(engine)
    return await benchmark.run_case(case, provider)


class RunPayload(BaseModel):
    save: bool = True
    engine: str = "whisper"


@router.post("/run")
async def run_all(payload: RunPayload | None = None) -> dict:
    engine = payload.engine if payload else "whisper"
    provider = _provider_or_503(engine)
    report = await benchmark.run_all(provider)
    if payload is None or payload.save:
        saved = benchmark.save_report(report)
        report["savedAs"] = saved["filename"]
    return report


@router.get("/reports")
def list_reports() -> dict:
    return {"reports": benchmark.list_reports()}


@router.get("/reports/{filename}")
def get_report(filename: str) -> dict:
    report = benchmark.get_report(filename)
    if report is None:
        raise HTTPException(status_code=404, detail=f"Report not found: {filename}")
    return report
