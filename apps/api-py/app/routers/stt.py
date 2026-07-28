"""Speech recognition API.

There is intentionally one engine and one model:
OpenAI ``gpt-4o-mini-transcribe``. Audio capture remains local in the desktop;
the finalized utterance is sent either with the user's OpenAI key or through
the managed SkillCue gateway.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.config import get_settings
from app.services.stt import registry as stt_registry
from app.services.stt.openai_mini_stream import run_openai_mini_stream
from app.services.stt.settings_store import load_stt_settings

logger = logging.getLogger("stt")
router = APIRouter(prefix="/stt", tags=["stt"])

ALLOWED_SAMPLE_RATES = {16000, 44100, 48000}
_active_live_streams = 0


@router.get("/providers")
def list_providers() -> dict:
    return stt_registry.diagnostics()


@router.get("/diagnostics")
def stt_diagnostics() -> dict:
    diagnostics = stt_registry.diagnostics()
    provider = diagnostics["providers"][0]
    return {
        "provider": diagnostics["default"],
        "engine": diagnostics["engine"],
        "model": diagnostics["model"],
        "available": provider.get("available", False),
        "reason": provider.get("reason", ""),
        "lastError": provider.get("lastError"),
        "privacyDescription": provider.get("privacyDescription", ""),
    }


@router.post("/warmup")
async def warmup_stt() -> dict:
    started = time.monotonic()
    await stt_registry.resolve_default_provider().prewarm_model_async()
    return {
        "warmed": {"final": "gpt-4o-mini-transcribe"},
        "ms": int((time.monotonic() - started) * 1000),
    }


class SttSettingsPayload(BaseModel):
    engine: str | None = None
    model: str | None = None


@router.get("/settings")
def get_stt_settings() -> dict:
    return load_stt_settings().model_dump()


@router.post("/settings")
def save_stt_settings_endpoint(_payload: SttSettingsPayload) -> dict:
    return load_stt_settings().model_dump()


async def _authorize_local_socket(ws: WebSocket) -> bool:
    from app.core import local_auth

    if local_auth.enabled() and not local_auth.token_ok(
        ws.query_params.get(local_auth.WS_QUERY_PARAM)
    ):
        await ws.send_json({"type": "error", "message": "unauthorized"})
        await ws.close()
        return False
    return True


async def _load_entitlements(ws: WebSocket) -> dict | None:
    from app.db.session import SessionLocal
    from app.services import quota

    with SessionLocal() as db:
        entitlements = quota.current_entitlements(db)
    if entitlements["live_allowed"]:
        return entitlements

    message = (
        "Тариф basic не включает live-режим — обновитесь до max."
        if entitlements["plan"] == "basic"
        else "Пробные 15 минут live закончились. Активируйте лицензию в настройках."
    )
    await ws.send_json({"type": "error", "message": message})
    await ws.close()
    return None


@router.websocket("/stream")
async def stt_stream(ws: WebSocket) -> None:
    await ws.accept()
    if not await _authorize_local_socket(ws):
        return

    settings = get_settings()
    if not settings.stt_enabled:
        await ws.send_json(
            {"type": "error", "message": "Распознавание речи отключено"}
        )
        await ws.close()
        return

    language = ws.query_params.get("language") or settings.stt_language or "ru"
    try:
        sample_rate = int(ws.query_params.get("sample_rate", "16000"))
    except ValueError:
        sample_rate = 16000
    if sample_rate not in ALLOWED_SAMPLE_RATES:
        sample_rate = 16000

    entitlements = await _load_entitlements(ws)
    if entitlements is None:
        return

    from app.db.session import SessionLocal
    from app.services import quota

    global _active_live_streams
    is_primary = _active_live_streams == 0
    _active_live_streams += 1
    started_at = time.monotonic()
    live_left = entitlements["live_seconds_left"]

    watchdog: asyncio.Task | None = None
    if live_left is not None:

        async def cut_off_trial() -> None:
            await asyncio.sleep(max(5, int(live_left)))
            try:
                await ws.send_json(
                    {
                        "type": "error",
                        "message": "Пробные 15 минут live закончились.",
                    }
                )
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

        watchdog = asyncio.create_task(cut_off_trial())

    try:
        await run_openai_mini_stream(
            ws,
            language=language,
            sample_rate=sample_rate,
        )
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("STT stream error")
    finally:
        if watchdog is not None:
            watchdog.cancel()
        _active_live_streams = max(0, _active_live_streams - 1)
        if is_primary and live_left is not None:
            try:
                with SessionLocal() as db:
                    quota.add_live_seconds(db, time.monotonic() - started_at)
            except Exception:  # noqa: BLE001
                logger.exception("failed to record trial live seconds")
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
