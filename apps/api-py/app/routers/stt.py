import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.config import get_settings
from app.services.stt import device as stt_device
from app.services.stt import registry as stt_registry
from app.services.stt import whisper_models, whisper_stream
from app.services.stt.download_manager import download_manager
from app.services.stt.settings_store import (
    VALID_MODELS,
    load_stt_settings,
    update_stt_settings,
)

logger = logging.getLogger("stt")

router = APIRouter(prefix="/stt", tags=["stt"])

ALLOWED_SAMPLE_RATES = {16000, 44100, 48000}


@router.get("/providers")
def list_providers() -> dict:
    """Provider availability + privacy/resource disclosure for the UI.

    Powers the onboarding model cards, the Speech-Recognition settings screen,
    and the diagnostics panel. Read-only and side-effect free.
    """
    return {
        **stt_registry.diagnostics(),
        "models": whisper_models.manifest(),
    }


@router.get("/device")
def device_info() -> dict:
    """CPU/GPU/RAM hints for 'Auto choose for my device'. Best-effort."""
    return stt_device.detect_device_info()


@router.get("/diagnostics")
def stt_diagnostics() -> dict:
    """One-stop status for the diagnostics screen: provider, model, device,
    availability, last error, and average latency from the most recent
    benchmark. Microphone status is added client-side."""
    from app.services.stt import benchmark

    diag = stt_registry.diagnostics()
    whisper = next((p for p in diag["providers"] if p["id"] == "whisper-local"), None)

    avg_latency = None
    last_run_at = None
    reports = benchmark.list_reports()
    if reports:
        rep = benchmark.get_report(reports[0]["filename"])
        if rep:
            avg_latency = rep.get("avgLatencyMs")
            last_run_at = rep.get("generatedAt")

    return {
        "provider": diag["default"],
        "localModel": diag["localModel"],
        "model": (whisper or {}).get("model"),
        "device": (whisper or {}).get("device"),
        "available": (whisper or {}).get("available", False),
        "reason": (whisper or {}).get("reason", ""),
        "lastError": (whisper or {}).get("lastError"),
        "privacyDescription": (whisper or {}).get("privacyDescription", ""),
        "resourceUsage": (whisper or {}).get("resourceUsage", ""),
        "avgBenchmarkLatencyMs": avg_latency,
        "lastBenchmarkAt": last_run_at,
    }


def _validate_quality(quality: str) -> str:
    if quality not in VALID_MODELS:
        raise HTTPException(status_code=404, detail=f"Unknown model quality: {quality}")
    return quality


@router.get("/models/{quality}/status")
def model_status(quality: str) -> dict:
    return download_manager.status(_validate_quality(quality))


@router.post("/models/{quality}/download")
def model_download(quality: str) -> dict:
    """Start (or resume) a local model download. Returns immediately."""
    return download_manager.start(_validate_quality(quality))


@router.delete("/models/{quality}")
def model_delete(quality: str) -> dict:
    return download_manager.delete(_validate_quality(quality))


class SttSettingsPayload(BaseModel):
    local_model: str | None = None
    device: str | None = None


@router.get("/settings")
def get_stt_settings() -> dict:
    return load_stt_settings().model_dump()


@router.post("/settings")
def save_stt_settings_endpoint(payload: SttSettingsPayload) -> dict:
    updated = update_stt_settings(
        local_model=payload.local_model,
        device=payload.device,
    )
    return updated.model_dump()


@router.websocket("/stream")
async def stt_stream(ws: WebSocket) -> None:
    """Live transcription over WebSocket — now backed by on-device Whisper.

    The message protocol is unchanged from the previous cloud engine, so the
    desktop live path works without modification. ``engine``/``mode`` query
    params are accepted for backwards compatibility but ignored (the local
    model is chosen in Speech-Recognition settings).
    """
    await ws.accept()
    settings = get_settings()

    if not settings.stt_enabled:
        await ws.send_json({"type": "error", "message": "STT отключён в настройках"})
        await ws.close()
        return

    language = ws.query_params.get("language") or settings.stt_language
    try:
        sample_rate = int(ws.query_params.get("sample_rate", "16000"))
    except ValueError:
        sample_rate = 16000
    if sample_rate not in ALLOWED_SAMPLE_RATES:
        sample_rate = 16000

    try:
        await whisper_stream.run_whisper_stream(
            ws,
            language=language,
            sample_rate=sample_rate,
        )
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("STT stream error")
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
