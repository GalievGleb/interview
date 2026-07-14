"""Soniox stt-rt live streaming bridge over the existing /stt/stream WebSocket.

Самый дешёвый ($0.12/час) мультиязычный реалтайм на рынке (60+ языков, включая
русский) с автоопределением языка и code-switching ru+en — идеально под
интервью, где русская речь перемешана с английскими терминами. События Soniox
переводятся в наш протокол (тот же, что у whisper_stream) — десктоп не отличает
движки.

Протокол Soniox (проверен по официальному SDK soniox/speech-to-text-web):
* wss://stt-rt.soniox.com/transcribe-websocket, первое сообщение — JSON-конфиг
  с api_key; дальше — бинарные PCM-фреймы.
* Ответы: {"tokens": [{"text", "is_final", ...}], "finished"?, "error_code"?}.
  Финальные токены приходят ровно один раз; нефинальные каждый раз присылаются
  целиком заново (хвост).
* Токен с text == "<end>" — серверный endpoint (конец фразы).
* Служебные текстовые сообщения: {"type": "keepalive"}, {"type": "finalize"};
  пустое сообщение — конец аудио (сервер дошлёт финалы и "finished").

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

from app.services import secrets

from .base import (
    PRIVACY_CLOUD,
    BaseTranscriptionProvider,
    ProviderMode,
    SttEngineUnavailable,
)
from .whisper_stream import RECEIVE_POLL_S, quality_gate

logger = logging.getLogger("stt.soniox")

SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
MODEL = "stt-rt-v5"
END_TOKEN = "<end>"
# Насколько долго Soniox ждёт паузу перед endpoint (мс). Дефолт 2000 — вяло для
# интервью; 1000 отвечает темпу диалога (допустимый диапазон 500–3000).
MAX_ENDPOINT_DELAY_MS = 1000
KEEPALIVE_INTERVAL_S = 5.0


def api_key() -> str:
    return secrets.get_secret("soniox_api_key")


def _language_hints(language: str) -> list[str]:
    """Наш код языка → language_hints Soniox.

    Даже для «чисто русского» интервью добавляем en: технические термины
    (Playwright, CI/CD, fixture) — половина словаря кандидата.
    """
    lang = (language or "").lower()
    if lang.startswith("en"):
        return ["en"]
    return ["ru", "en"]


def build_config(*, language: str, sample_rate: int, key: str) -> dict:
    return {
        "api_key": key,
        "model": MODEL,
        "audio_format": "s16le",
        "sample_rate": sample_rate,
        "num_channels": 1,
        "language_hints": _language_hints(language),
        "enable_language_identification": True,
        "enable_endpoint_detection": True,
        "max_endpoint_delay_ms": MAX_ENDPOINT_DELAY_MS,
    }


def parse_soniox_message(raw: str) -> dict | None:
    """Soniox JSON → разобранное событие (или None для мусора).

    Возвращает {"error": str} | {"finals": [str], "tail": str, "saw_end": bool,
    "finished": bool}. Чистая функция ради юнит-тестов без сети.
    """
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if msg.get("error_code"):
        return {"error": f"Soniox {msg.get('error_code')}: {msg.get('error_message') or ''}"}

    finals: list[str] = []
    tail_parts: list[str] = []
    saw_end = False
    for tok in msg.get("tokens") or []:
        text = tok.get("text") or ""
        if text == END_TOKEN:
            saw_end = True
            continue
        if tok.get("is_final"):
            finals.append(text)
        else:
            tail_parts.append(text)
    return {
        "finals": finals,
        "tail": "".join(tail_parts),
        "saw_end": saw_end,
        "finished": bool(msg.get("finished")),
    }


async def run_soniox_stream(
    client_ws,
    *,
    language: str = "ru",
    sample_rate: int = 16000,
) -> None:
    key = api_key()
    if not key:
        # Нет ключа — не тупик: диспетчер откатится на локальный Whisper.
        raise SttEngineUnavailable("Не задан API-ключ Soniox")

    try:
        import websockets
    except ImportError as exc:
        raise SttEngineUnavailable("Модуль websockets не установлен") from exc

    try:
        sx = await websockets.connect(SONIOX_WS_URL, max_size=2**22)
        await sx.send(json.dumps(build_config(language=language, sample_rate=sample_rate, key=key)))
    except Exception as exc:  # noqa: BLE001 — ключ/сеть; пользователю нужен текст
        logger.warning("Soniox connect failed: %s", exc)
        await client_ws.send_json(
            {"type": "error", "message": f"Не удалось подключиться к Soniox: {exc}"}
        )
        return

    await client_ws.send_json(
        {
            "type": "ready",
            "engine": "soniox",
            "model": MODEL,
            "partial_model": MODEL,
            "final_model": MODEL,
            "sample_rate": sample_rate,
        }
    )

    # Текущая фраза: финальные токены копятся, нефинальный хвост заменяется.
    utterance: list[str] = []
    tail = ""
    last_partial = ""
    last_final = ""
    speech_started_sent = False
    speech_started_at = 0.0
    first_partial_at = 0.0
    partial_count = 0
    last_audio_at = time.monotonic()

    async def pump_audio() -> None:
        """Клиент → Soniox. Keepalive, если десктоп замолчал (пауза live)."""
        nonlocal last_audio_at
        try:
            while True:
                try:
                    data = await asyncio.wait_for(client_ws.receive_bytes(), timeout=RECEIVE_POLL_S)
                    last_audio_at = time.monotonic()
                    await sx.send(data)
                except TimeoutError:
                    if time.monotonic() - last_audio_at > KEEPALIVE_INTERVAL_S:
                        await sx.send(json.dumps({"type": "keepalive"}))
                        last_audio_at = time.monotonic()
        finally:
            # Клиент отключился — пустое сообщение просит дослать финалы и закрыть.
            try:
                await sx.send("")
            except Exception:  # noqa: BLE001
                pass

    async def emit_final() -> None:
        nonlocal tail, last_final, speech_started_sent, speech_started_at
        nonlocal first_partial_at, partial_count, last_partial
        text = ("".join(utterance) + tail).strip()
        utterance.clear()
        tail = ""
        last_partial = ""
        speech_started_sent = False
        if not text:
            speech_started_at = 0.0
            return
        now = time.monotonic()
        timings = {
            "speechMs": int((now - speech_started_at) * 1000) if speech_started_at else None,
            "firstPartialMs": (
                int((first_partial_at - speech_started_at) * 1000)
                if first_partial_at and speech_started_at
                else None
            ),
            # Серверный endpoint — паузу меряет Soniox (max_endpoint_delay_ms).
            "speechEndToFinalMs": None,
            "partialCount": partial_count,
        }
        speech_started_at = 0.0
        first_partial_at = 0.0
        partial_count = 0
        ok, reason = quality_gate(text, last_final)
        if not ok:
            await client_ws.send_json(
                {"type": "low_quality", "text": text, "reason": reason, "timings": timings}
            )
            return
        last_final = text
        await client_ws.send_json(
            {"type": "transcript", "text": text, "is_final": True, "speech_final": True}
        )
        await client_ws.send_json({"type": "utterance_end", "timings": timings})

    async def pump_events() -> None:
        nonlocal tail, last_partial, speech_started_sent, speech_started_at
        nonlocal first_partial_at, partial_count
        async for raw in sx:
            if isinstance(raw, bytes):
                continue
            parsed = parse_soniox_message(raw)
            if parsed is None:
                continue
            if "error" in parsed:
                await client_ws.send_json({"type": "error", "message": parsed["error"]})
                return

            utterance.extend(parsed["finals"])
            tail = parsed["tail"]
            current = ("".join(utterance) + tail).strip()

            if current and not speech_started_sent:
                speech_started_sent = True
                speech_started_at = time.monotonic()
                await client_ws.send_json({"type": "speech_started"})

            if parsed["saw_end"]:
                await emit_final()
            elif current and current != last_partial:
                last_partial = current
                partial_count += 1
                if not first_partial_at:
                    first_partial_at = time.monotonic()
                await client_ws.send_json(
                    {
                        "type": "transcript",
                        "text": current,
                        "is_final": False,
                        "speech_final": False,
                    }
                )

            if parsed["finished"]:
                # Стрим закрывается — дофинализируем то, что осталось без <end>.
                await emit_final()
                return

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
        logger.debug("Soniox stream ended: %s", exc)
    finally:
        try:
            await sx.close()
        except Exception:  # noqa: BLE001
            pass


class SonioxProvider(BaseTranscriptionProvider):
    """Стриминг живёт в run_soniox_stream; здесь диагностика и батч-режим
    (файл прогоняется через тот же WebSocket) — его использует STT-бенчмарк."""

    id = "soniox-stt-rt"
    display_name = "Soniox stt-rt (облако)"
    mode = ProviderMode.CLOUD
    estimated_latency_ms = 300

    def is_available(self) -> bool:
        return bool(api_key())

    def _availability_reason(self) -> str:
        return "available" if self.is_available() else "Нужен API-ключ Soniox (Настройки)"

    def get_privacy_description(self) -> str:
        return PRIVACY_CLOUD + " Аудио уходит в Soniox (США/ЕС)."

    def _active_model(self) -> str:
        return MODEL

    async def _transcribe_file(
        self, audio: bytes, *, language: str | None, sample_rate: int
    ) -> str:
        import websockets

        key = api_key()
        if not key:
            raise RuntimeError("Не задан API-ключ Soniox (Настройки → Распознавание речи)")
        config = {
            "api_key": key,
            "model": MODEL,
            # Бенчмарк-клипы — WAV с заголовком: пусть Soniox сам разберёт контейнер.
            "audio_format": "auto",
            "language_hints": _language_hints(language or "ru"),
            "enable_language_identification": True,
        }
        parts: list[str] = []
        async with websockets.connect(SONIOX_WS_URL, max_size=2**22) as ws:
            await ws.send(json.dumps(config))
            for i in range(0, len(audio), 65536):
                await ws.send(audio[i : i + 65536])
            await ws.send("")  # конец аудио — сервер дошлёт финалы и finished
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                parsed = parse_soniox_message(raw)
                if parsed is None:
                    continue
                if "error" in parsed:
                    raise RuntimeError(parsed["error"])
                parts.extend(parsed["finals"])
                if parsed["finished"]:
                    break
        return "".join(parts).strip()
