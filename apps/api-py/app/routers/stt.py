import asyncio
import logging
import time

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

# Сколько live-сокетов открыто сейчас (mic+system = 2 на одну сессию).
_active_live_streams = 0


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


@router.post("/warmup")
async def warmup_stt() -> dict:
    """Load and warm the live STT models before the first utterance.

    Cold start is the reason the first question of a session felt slow/skipped:
    pressing Start, the model still had to load and (on GPU) compile CUDA kernels
    on the first inference. The desktop calls this when the live screen opens, so
    by the time the user speaks the model is hot. Idempotent and cheap once warm.
    """
    import asyncio
    import time

    import numpy as np

    from app.services.stt.registry import get_cached_whisper_provider

    started = time.perf_counter()
    warmed: dict[str, str] = {}
    # ~0.4s of near-silence: enough to trigger model load + kernel compilation
    # without producing a transcript we care about.
    dummy = np.zeros(6400, dtype=np.float32)

    for role in ("partial", "final"):
        provider = get_cached_whisper_provider(role=role)
        if not (provider.is_available() and provider.is_model_downloaded()):
            warmed[role] = "unavailable"
            continue
        try:
            await asyncio.to_thread(provider.prepare)
            # Run one throwaway inference so the first real utterance is fast.
            await asyncio.to_thread(provider._transcribe_sync, dummy, language="ru")
            warmed[role] = provider._active_model()
        except Exception as exc:  # noqa: BLE001 - warmup is best-effort
            logger.warning("STT warmup failed for %s: %s", role, exc)
            warmed[role] = "error"

    return {"warmed": warmed, "ms": int((time.perf_counter() - started) * 1000)}


class SttSettingsPayload(BaseModel):
    local_model: str | None = None
    partial_model: str | None = None
    final_model: str | None = None
    device: str | None = None
    engine: str | None = None  # whisper | deepgram | speechkit
    speechkit_model: str | None = None  # general | general:rc


@router.get("/settings")
def get_stt_settings() -> dict:
    return load_stt_settings().model_dump()


@router.post("/settings")
def save_stt_settings_endpoint(payload: SttSettingsPayload) -> dict:
    updated = update_stt_settings(
        local_model=payload.local_model,
        partial_model=payload.partial_model,
        final_model=payload.final_model,
        device=payload.device,
        engine=payload.engine,
        speechkit_model=payload.speechkit_model,
    )
    # Model/device may have changed — drop cached providers and loaded models so
    # the next transcription reloads with the new configuration.
    stt_registry.reset_cached_providers()
    return updated.model_dump()


@router.websocket("/stream")
async def stt_stream(ws: WebSocket) -> None:
    """Live transcription over WebSocket.

    Движок выбирается в настройках STT (``engine``): локальный Whisper (по
    умолчанию), Deepgram Nova-3 или Яндекс SpeechKit v3. Протокол сообщений
    одинаковый для всех движков, десктоп ничего не знает о разнице. Query-параметр
    ``engine`` может переопределить настройку на одну сессию (Test Lab).
    """
    await ws.accept()

    # Локальная аутентификация: WebSocket не умеет заголовки из браузера,
    # поэтому токен приходит query-параметром (см. core/local_auth).
    from app.core import local_auth

    if local_auth.enabled() and not local_auth.token_ok(
        ws.query_params.get(local_auth.WS_QUERY_PARAM)
    ):
        await ws.send_json({"type": "error", "message": "unauthorized"})
        await ws.close()
        return

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

    # --- Монетизация: live по тарифу; trial — 15 минут суммарно (сервер). ---
    from app.db.session import SessionLocal
    from app.services import quota

    with SessionLocal() as _db:
        ent = quota.current_entitlements(_db)
    if not ent["live_allowed"]:
        reason = (
            "Тариф basic не включает live-режим — обновитесь до max."
            if ent["plan"] == "basic"
            else "Пробные 15 минут live закончились. Активируйте лицензию в Настройках."
        )
        await ws.send_json({"type": "error", "message": reason})
        await ws.close()
        return

    # mic+system открывают два сокета — минуты копит только первый (primary),
    # иначе trial сгорал бы вдвое быстрее реального времени.
    global _active_live_streams
    is_primary = _active_live_streams == 0
    _active_live_streams += 1
    started_at = time.monotonic()

    # Trial-сессия не может пережить остаток минут — режем и посреди сессии.
    watchdog: asyncio.Task | None = None
    live_left = ent["live_seconds_left"]
    if live_left is not None:

        async def _cut_off() -> None:
            await asyncio.sleep(max(5, int(live_left)))
            try:
                await ws.send_json(
                    {"type": "error", "message": "Пробные 15 минут live закончились."}
                )
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

        watchdog = asyncio.create_task(_cut_off())

    # Диспетчеризация движка: настройка STT либо query-переопределение на сессию.
    from app.services.stt.settings_store import VALID_ENGINES

    engine = ws.query_params.get("engine") or load_stt_settings().engine
    if engine not in VALID_ENGINES:
        engine = "whisper"

    from app.services.stt.base import SttEngineUnavailable

    try:
        try:
            if engine == "deepgram":
                from app.services.stt import deepgram_stream

                await deepgram_stream.run_deepgram_stream(
                    ws, language=language, sample_rate=sample_rate
                )
            elif engine == "speechkit":
                from app.services.stt import speechkit_stream

                await speechkit_stream.run_speechkit_stream(
                    ws, language=language, sample_rate=sample_rate
                )
            else:
                await whisper_stream.run_whisper_stream(
                    ws,
                    language=language,
                    sample_rate=sample_rate,
                )
        except SttEngineUnavailable as exc:
            # Облачный движок не стартовал (нет ключа/гейтвея/зависимостей) —
            # прозрачно продолжаем на локальном Whisper, чтобы выбор Яндекса/
            # Deepgram без ключа не «ломал» распознавание, а просто работал.
            logger.info("STT engine %s unavailable (%s) — falling back to Whisper", engine, exc)
            await whisper_stream.run_whisper_stream(
                ws, language=language, sample_rate=sample_rate
            )
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("STT stream error")
    finally:
        if watchdog is not None:
            watchdog.cancel()
        _active_live_streams = max(0, _active_live_streams - 1)
        # Минуты trial копятся на сервере — фронт их не контролирует.
        if is_primary and live_left is not None:
            try:
                with SessionLocal() as _db:
                    quota.add_live_seconds(_db, time.monotonic() - started_at)
            except Exception:  # noqa: BLE001
                logger.exception("failed to record trial live seconds")
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
