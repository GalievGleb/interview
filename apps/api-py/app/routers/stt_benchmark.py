"""STT benchmark endpoints for the fixed OpenAI Mini engine."""

import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.stt import benchmark
from app.services.stt.registry import resolve_default_provider

router = APIRouter(prefix="/stt/benchmark", tags=["stt-benchmark"])


def _require_dev_tools() -> None:
    if os.getenv("SKILLCUE_DEV_TOOLS") != "1":
        raise HTTPException(status_code=404, detail="Not found")


def _provider_or_503():
    provider = resolve_default_provider()
    if not provider.is_available():
        raise HTTPException(status_code=503, detail="OpenAI Mini STT is unavailable")
    return provider


@router.get("/cases")
def list_cases() -> dict:
    _require_dev_tools()
    return {"cases": benchmark.load_cases(), "root": str(benchmark.BENCH_DIR)}


@router.post("/run/{case_id}")
async def run_case(case_id: str) -> dict:
    _require_dev_tools()
    case = benchmark.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
    return await benchmark.run_case(case, _provider_or_503())


class RunPayload(BaseModel):
    save: bool = True


@router.post("/run")
async def run_all(payload: RunPayload | None = None) -> dict:
    _require_dev_tools()
    report = await benchmark.run_all(_provider_or_503())
    if payload is None or payload.save:
        saved = benchmark.save_report(report)
        report["savedAs"] = saved["filename"]
    return report


@router.get("/reports")
def list_reports() -> dict:
    _require_dev_tools()
    return {"reports": benchmark.list_reports()}


@router.get("/reports/{filename}")
def get_report(filename: str) -> dict:
    _require_dev_tools()
    report = benchmark.get_report(filename)
    if report is None:
        raise HTTPException(status_code=404, detail=f"Report not found: {filename}")
    return report
