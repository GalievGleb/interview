"""Speech recognition API.

Live speech stays on latency-first ``gpt-4o-mini-transcribe``. A completed
mock-interview answer uses the separate accuracy-first ``gpt-transcribe``
upload path. Both routes support a user's OpenAI key or the managed SkillCue
gateway.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import struct
import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.config import get_settings
from app.services.stt import registry as stt_registry
from app.services.stt.openai_mini_stream import run_openai_mini_stream
from app.services.stt.openai_transcribe import ANSWER_MODEL, get_answer_transcriber
from app.services.stt.settings_store import load_stt_settings

logger = logging.getLogger("stt")
router = APIRouter(prefix="/stt", tags=["stt"])

ALLOWED_SAMPLE_RATES = {16000, 44100, 48000}
# 120 s of native-rate mono PCM16 is about 22 MiB at the highest accepted
# 96 kHz rate. Keep the complete answer intact instead of forcing truncation.
MAX_ANSWER_AUDIO_BYTES = 25 * 1024 * 1024
MAX_MOCK_ANSWER_SECONDS = 120
MAX_ANSWER_CONTEXT_CHARS = 1_000
MAX_ANSWER_HINTS = 32
MAX_ANSWER_HINT_CHARS = 64
_active_live_streams = 0


def _validate_answer_wav(audio: bytes) -> float:
    try:
        if len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
            raise ValueError("unsupported WAV")
        declared_end = struct.unpack_from("<I", audio, 4)[0] + 8
        if declared_end != len(audio):
            raise ValueError("incomplete WAV")

        fmt: tuple[int, int, int, int, int, int] | None = None
        frames: bytes | None = None
        offset = 12
        while offset + 8 <= declared_end:
            chunk_id = audio[offset : offset + 4]
            chunk_size = struct.unpack_from("<I", audio, offset + 4)[0]
            payload_start = offset + 8
            payload_end = payload_start + chunk_size
            padded_end = payload_end + (chunk_size % 2)
            if payload_end > declared_end or padded_end > declared_end:
                raise ValueError("truncated WAV chunk")
            if chunk_id == b"fmt ":
                if fmt is not None or chunk_size < 16:
                    raise ValueError("invalid WAV format")
                fmt = struct.unpack_from("<HHIIHH", audio, payload_start)
            elif chunk_id == b"data":
                if frames is not None:
                    raise ValueError("multiple WAV data chunks")
                frames = audio[payload_start:payload_end]
            offset = padded_end

        if offset != declared_end or fmt is None or frames is None:
            raise ValueError("missing WAV chunks")
        audio_format, channels, sample_rate, byte_rate, block_align, bits_per_sample = fmt
        if (
            audio_format != 1
            or channels != 1
            or bits_per_sample != 16
            or block_align != 2
            or byte_rate != sample_rate * 2
            or not 8_000 <= sample_rate <= 96_000
            or not frames
            or len(frames) % block_align != 0
        ):
            raise ValueError("unsupported WAV")
        duration = len(frames) / byte_rate
        if duration <= 0 or duration > MAX_MOCK_ANSWER_SECONDS:
            raise ValueError("unsupported WAV duration")
    except (ValueError, struct.error) as exc:
        raise HTTPException(status_code=400, detail="Некорректная WAV-запись") from exc

    if not any(frames):
        raise HTTPException(status_code=400, detail="Речь не обнаружена в записи")
    return duration


def _parse_answer_hints(raw: str) -> list[str]:
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail="Некорректные подсказки распознавания",
        ) from exc
    if not isinstance(values, list) or len(values) > MAX_ANSWER_HINTS:
        raise HTTPException(status_code=400, detail="Некорректные подсказки распознавания")

    hints: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            raise HTTPException(status_code=400, detail="Некорректные подсказки распознавания")
        hint = value.strip()
        if (
            not hint
            or len(hint) > MAX_ANSWER_HINT_CHARS
            or any(character in hint for character in "<>\r\n")
        ):
            raise HTTPException(status_code=400, detail="Некорректные подсказки распознавания")
        key = hint.casefold()
        if key not in seen:
            seen.add(key)
            hints.append(hint)
    return hints


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


@router.post("/answer")
async def transcribe_mock_answer(
    file: UploadFile = File(...),
    question: str = Form(...),
    hints: str = Form("[]"),
    language: str = Form("ru"),
) -> dict:
    audio = await file.read(MAX_ANSWER_AUDIO_BYTES + 1)
    if len(audio) > MAX_ANSWER_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Запись ответа превышает 25 МБ")
    if len(audio) < 44:
        raise HTTPException(status_code=400, detail="Некорректная WAV-запись")

    compact_question = re.sub(r"\s+", " ", question).strip()
    if not compact_question or len(compact_question) > MAX_ANSWER_CONTEXT_CHARS:
        raise HTTPException(status_code=400, detail="Некорректный контекст вопроса")
    parsed_hints = _parse_answer_hints(hints)
    _validate_answer_wav(audio)

    text = await get_answer_transcriber().transcribe(
        audio,
        question=compact_question,
        hints=parsed_hints,
        language=language,
    )
    return {"text": text.strip(), "model": ANSWER_MODEL}


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
