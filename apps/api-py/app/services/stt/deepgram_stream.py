"""Deepgram Nova-3 live streaming bridge over the existing /stt/stream WebSocket.

True cloud streaming: PCM16 от десктопа проксируется в Deepgram, их события
переводятся в наш протокол (тот же, что у whisper_stream) — десктоп не отличает
движки. Главный выигрыш против локального Whisper: interim-результаты <300 мс и
серверный endpointing вместо нашего 750-мс VAD-ожидания + финального прогона.

Client protocol (unchanged):
    {"type": "ready", ...} / {"type": "speech_started"}
    {"type": "transcript", "text", "is_final", "speech_final"}
    {"type": "utterance_end"} / {"type": "low_quality"} / {"type": "error"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from urllib.parse import urlencode

from app.services import secrets

from .base import (
    PRIVACY_CLOUD,
    BaseTranscriptionProvider,
    ProviderMode,
    SttEngineUnavailable,
)
from .whisper_stream import RECEIVE_POLL_S, quality_gate

logger = logging.getLogger("stt.deepgram")

DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen"
MODEL = "nova-3"
# Пауза, после которой Deepgram считает фразу законченной (мс). Меньше нашего
# локального VAD (750) — облачный endpointing надёжнее энергетического порога.
ENDPOINTING_MS = 400
UTTERANCE_END_MS = 1000
KEEPALIVE_INTERVAL_S = 5.0


def api_key() -> str:
    return secrets.get_secret("deepgram_api_key")


def _dg_language(language: str) -> str:
    """Наш код языка → Deepgram. `multi` — code-switching (ru входит в 10 языков)."""
    lang = (language or "").lower()
    if lang.startswith("ru"):
        return "ru"
    if lang.startswith("en"):
        return "en"
    return "multi"


def build_ws_url(language: str, sample_rate: int) -> str:
    params = {
        "model": MODEL,
        "language": _dg_language(language),
        "encoding": "linear16",
        "sample_rate": str(sample_rate),
        "channels": "1",
        "interim_results": "true",
        "smart_format": "true",
        "vad_events": "true",
        "endpointing": str(ENDPOINTING_MS),
        "utterance_end_ms": str(UTTERANCE_END_MS),
        "punctuate": "true",
    }
    return f"{DEEPGRAM_WS_URL}?{urlencode(params)}"


def parse_deepgram_event(raw: str) -> dict | None:
    """Deepgram JSON → наше сообщение протокола (или None, если событие служебное).

    Выделено в чистую функцию ради юнит-тестов без сети.
    """
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None
    mtype = msg.get("type")
    if mtype == "SpeechStarted":
        return {"type": "speech_started"}
    if mtype == "UtteranceEnd":
        return {"type": "utterance_end"}
    if mtype == "Results":
        alt = (((msg.get("channel") or {}).get("alternatives")) or [{}])[0]
        text = (alt.get("transcript") or "").strip()
        if not text:
            return None
        return {
            "type": "transcript",
            "text": text,
            "is_final": bool(msg.get("is_final")),
            "speech_final": bool(msg.get("speech_final")),
        }
    if mtype == "Error":
        return {"type": "error", "message": str(msg.get("description") or msg)}
    return None


async def run_deepgram_stream(
    client_ws,
    *,
    language: str = "ru",
    sample_rate: int = 16000,
) -> None:
    key = api_key()
    if not key:
        # Нет ключа — не тупик: диспетчер откатится на локальный Whisper.
        raise SttEngineUnavailable("Не задан API-ключ Deepgram")

    try:
        import websockets
    except ImportError as exc:
        raise SttEngineUnavailable("Модуль websockets не установлен") from exc

    url = build_ws_url(language, sample_rate)
    try:
        dg = await websockets.connect(
            url,
            additional_headers={"Authorization": f"Token {key}"},
            max_size=2**22,
        )
    except Exception as exc:  # noqa: BLE001 — ключ/сеть; пользователю нужен текст
        logger.warning("Deepgram connect failed: %s", exc)
        await client_ws.send_json(
            {"type": "error", "message": f"Не удалось подключиться к Deepgram: {exc}"}
        )
        return

    await client_ws.send_json(
        {
            "type": "ready",
            "engine": "deepgram",
            "model": MODEL,
            "partial_model": MODEL,
            "final_model": MODEL,
            "sample_rate": sample_rate,
        }
    )

    last_final = ""
    speech_started_at = 0.0
    first_partial_at = 0.0
    partial_count = 0
    last_audio_at = time.monotonic()

    async def pump_audio() -> None:
        """Клиент → Deepgram. KeepAlive, если десктоп замолчал (пауза live)."""
        nonlocal last_audio_at
        try:
            while True:
                try:
                    data = await asyncio.wait_for(
                        client_ws.receive_bytes(), timeout=RECEIVE_POLL_S
                    )
                    last_audio_at = time.monotonic()
                    await dg.send(data)
                except TimeoutError:
                    if time.monotonic() - last_audio_at > KEEPALIVE_INTERVAL_S:
                        await dg.send(json.dumps({"type": "KeepAlive"}))
                        last_audio_at = time.monotonic()
        finally:
            # Клиент отключился — просим Deepgram дослать финалы и закрыть стрим.
            try:
                await dg.send(json.dumps({"type": "CloseStream"}))
            except Exception:  # noqa: BLE001
                pass

    async def pump_events() -> None:
        nonlocal last_final, speech_started_at, first_partial_at, partial_count
        async for raw in dg:
            if isinstance(raw, bytes):
                continue
            out = parse_deepgram_event(raw)
            if out is None:
                continue
            if out["type"] == "speech_started":
                speech_started_at = time.monotonic()
                first_partial_at = 0.0
                partial_count = 0
                await client_ws.send_json(out)
                continue
            if out["type"] == "transcript" and not out["is_final"]:
                partial_count += 1
                if not first_partial_at:
                    first_partial_at = time.monotonic()
                await client_ws.send_json(out)
                continue
            if out["type"] == "transcript" and out["is_final"]:
                # speech_final=false — промежуточный финал сегмента, копим как partial.
                if not out["speech_final"]:
                    await client_ws.send_json({**out, "is_final": False})
                    continue
                now = time.monotonic()
                timings = {
                    "speechMs": (
                        int((now - speech_started_at) * 1000) if speech_started_at else None
                    ),
                    "firstPartialMs": (
                        int((first_partial_at - speech_started_at) * 1000)
                        if first_partial_at and speech_started_at
                        else None
                    ),
                    # Серверный endpointing: финал приходит почти сразу после паузы.
                    "speechEndToFinalMs": ENDPOINTING_MS,
                    "partialCount": partial_count,
                }
                ok, reason = quality_gate(out["text"], last_final)
                if not ok:
                    await client_ws.send_json(
                        {
                            "type": "low_quality",
                            "text": out["text"],
                            "reason": reason,
                            "timings": timings,
                        }
                    )
                    speech_started_at = 0.0
                    continue
                last_final = out["text"]
                await client_ws.send_json(out)
                await client_ws.send_json({"type": "utterance_end", "timings": timings})
                speech_started_at = 0.0
                continue
            await client_ws.send_json(out)

    try:
        audio_task = asyncio.create_task(pump_audio())
        events_task = asyncio.create_task(pump_events())
        done, pending = await asyncio.wait(
            {audio_task, events_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, asyncio.CancelledError):
                raise exc
    except Exception as exc:  # noqa: BLE001 — дисконнект клиента заканчивает стрим
        logger.debug("Deepgram stream ended: %s", exc)
    finally:
        try:
            await dg.close()
        except Exception:  # noqa: BLE001
            pass


class DeepgramProvider(BaseTranscriptionProvider):
    """Стриминг живёт в run_deepgram_stream; здесь диагностика и батч-режим
    (prerecorded REST) — его использует STT-бенчмарк для сравнения движков."""

    id = "deepgram-nova3"
    display_name = "Deepgram Nova-3 (облако)"
    mode = ProviderMode.CLOUD
    estimated_latency_ms = 300

    def is_available(self) -> bool:
        return bool(api_key())

    def _availability_reason(self) -> str:
        return "available" if self.is_available() else "Нужен API-ключ Deepgram (Настройки)"

    def get_privacy_description(self) -> str:
        return PRIVACY_CLOUD + " Аудио уходит в Deepgram (США)."

    def _active_model(self) -> str:
        return MODEL

    async def _transcribe_file(
        self, audio: bytes, *, language: str | None, sample_rate: int
    ) -> str:
        import httpx

        key = api_key()
        if not key:
            raise RuntimeError("Не задан API-ключ Deepgram (Настройки → Распознавание речи)")
        params = {
            "model": MODEL,
            "language": _dg_language(language or "ru"),
            "smart_format": "true",
            "punctuate": "true",
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen",
                params=params,
                headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
                content=audio,
            )
        if resp.status_code != 200:
            raise RuntimeError(f"Deepgram {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
        channels = ((data.get("results") or {}).get("channels")) or [{}]
        alts = (channels[0].get("alternatives")) or [{}]
        return (alts[0].get("transcript") or "").strip()
