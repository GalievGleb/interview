"""Local Whisper live streaming over the existing /stt/stream WebSocket.

Whisper is not a native streaming model, so we emulate Deepgram-style UX:
* **Partial** transcripts every ~500 ms while the speaker talks (fast model).
* **Final** transcript after a silence hang (balanced/quality model).

Protocol (unchanged field names for desktop compatibility):

    {"type": "ready", "engine", "model", "partial_model", "sample_rate"}
    {"type": "speech_started"}
    {"type": "transcript", "text", "is_final", "speech_final"}
    {"type": "utterance_end"}
    {"type": "error", "message"}
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .registry import build_whisper_provider
from .settings_store import load_stt_settings
from .whisper_local_provider import WhisperLocalProvider

logger = logging.getLogger("stt.whisper_stream")

SPEECH_RMS_THRESHOLD = 280.0
NOISE_FLOOR_MULT = 2.5
SILENCE_HANG_MS = 750
MIN_SPEECH_MS = 250
MIN_PARTIAL_SPEECH_MS = 400
MAX_UTTERANCE_MS = 14000
PREROLL_MS = 200
PARTIAL_INTERVAL_MS = 500
PARTIAL_INTERVAL_SAME_MODEL_MS = 800
RECEIVE_POLL_S = 0.08


def _rms_int16(pcm: bytes) -> float:
    import numpy as np

    if not pcm:
        return 0.0
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples * samples)))


class Endpointer:
    """Energy-VAD state machine — fed PCM chunks, signals utterance boundaries."""

    def __init__(self, sample_rate: int = 16000) -> None:
        self.bytes_per_ms = max(1, int(sample_rate * 2 / 1000))
        self._speech = bytearray()
        self._preroll = bytearray()
        self._in_speech = False
        self._silence_bytes = 0
        self._noise_floor = 0.0

    def _threshold(self) -> float:
        return max(SPEECH_RMS_THRESHOLD, self._noise_floor * NOISE_FLOOR_MULT)

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    @property
    def speech_ms(self) -> int:
        return len(self._speech) // self.bytes_per_ms

    def _preroll_cap(self) -> int:
        return PREROLL_MS * self.bytes_per_ms

    def feed(self, chunk: bytes) -> bool:
        if not chunk:
            return False
        rms = _rms_int16(chunk)
        is_voice = rms >= self._threshold()
        if not is_voice:
            self._noise_floor = 0.9 * self._noise_floor + 0.1 * rms

        if is_voice:
            if not self._in_speech:
                self._in_speech = True
                self._speech.extend(self._preroll)
                self._preroll.clear()
            self._speech.extend(chunk)
            self._silence_bytes = 0
        else:
            if self._in_speech:
                self._speech.extend(chunk)
                self._silence_bytes += len(chunk)
            else:
                self._preroll.extend(chunk)
                cap = self._preroll_cap()
                if len(self._preroll) > cap:
                    del self._preroll[: len(self._preroll) - cap]

        silence_ms = self._silence_bytes // self.bytes_per_ms
        if self._in_speech and silence_ms >= SILENCE_HANG_MS and self.speech_ms >= MIN_SPEECH_MS:
            return True
        if self._in_speech and self.speech_ms >= MAX_UTTERANCE_MS:
            return True
        return False

    def peek_speech(self) -> bytes:
        return bytes(self._speech)

    def take_utterance(self) -> bytes:
        out = bytes(self._speech)
        self._speech = bytearray()
        self._preroll = bytearray()
        self._in_speech = False
        self._silence_bytes = 0
        return out

    def has_pending_speech(self) -> bool:
        return self._in_speech and self.speech_ms >= MIN_SPEECH_MS


@dataclass
class _StreamState:
    partial_interval_ms: int
    last_partial_at: float = 0.0
    last_partial_text: str = ""
    partial_in_flight: bool = False
    final_in_flight: bool = False
    speech_started_sent: bool = False
    transcribe_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _should_emit_partial(new_text: str, last_text: str) -> bool:
    if not new_text or new_text == last_text:
        return False
    if not last_text:
        return True
    if new_text.startswith(last_text):
        return len(new_text) > len(last_text)
    if last_text.startswith(new_text):
        return False
    return len(new_text) >= max(3, int(len(last_text) * 0.6))


async def _warm_providers(*providers: WhisperLocalProvider) -> None:
    await asyncio.gather(*(asyncio.to_thread(p.prepare) for p in providers))


async def _transcribe_pcm(
    provider: WhisperLocalProvider,
    pcm: bytes,
    *,
    language: str,
    sample_rate: int,
) -> str:
    text = await provider.transcribe_pcm16(pcm, language=language, sample_rate=sample_rate)
    return (text or "").strip()


async def run_whisper_stream(
    client_ws,
    *,
    language: str = "multi",
    sample_rate: int = 16000,
    partial_provider: WhisperLocalProvider | None = None,
    final_provider: WhisperLocalProvider | None = None,
    on_final: Callable[[str], None] | None = None,
) -> None:
    st = load_stt_settings()
    partial_provider = partial_provider or build_whisper_provider(role="partial")
    final_provider = final_provider or build_whisper_provider(role="final")
    same_model = partial_provider.spec.model_id == final_provider.spec.model_id

    for provider in (partial_provider, final_provider):
        if not provider.is_available():
            await client_ws.send_json(
                {
                    "type": "error",
                    "message": (
                        "Локальный движок Whisper не установлен. Установите зависимости: "
                        "pip install -r requirements-whisper.txt"
                    ),
                }
            )
            return
        if not provider.is_model_downloaded():
            await client_ws.send_json(
                {
                    "type": "error",
                    "message": (
                        "Модель распознавания речи не загружена. Откройте "
                        "Настройки → Распознавание речи и скачайте модель."
                    ),
                }
            )
            return

    try:
        await _warm_providers(partial_provider, final_provider)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Whisper model load failed: %s", exc)
        await client_ws.send_json(
            {"type": "error", "message": f"Не удалось загрузить модель Whisper: {exc}"}
        )
        return

    await client_ws.send_json(
        {
            "type": "ready",
            "engine": final_provider.id,
            "model": final_provider._active_model(),
            "partial_model": partial_provider._active_model(),
            "final_model": final_provider._active_model(),
            "sample_rate": sample_rate,
            "partial_model_quality": st.partial_model,
            "final_model_quality": st.final_model,
        }
    )

    endpointer = Endpointer(sample_rate=sample_rate)
    state = _StreamState(
        partial_interval_ms=(
            PARTIAL_INTERVAL_SAME_MODEL_MS if same_model else PARTIAL_INTERVAL_MS
        ),
    )

    async def on_speech_start() -> None:
        if state.speech_started_sent:
            return
        state.speech_started_sent = True
        state.last_partial_text = ""
        state.last_partial_at = 0.0
        await client_ws.send_json({"type": "speech_started"})

    async def maybe_partial() -> None:
        if state.final_in_flight or state.partial_in_flight:
            return
        if not endpointer.in_speech or endpointer.speech_ms < MIN_PARTIAL_SPEECH_MS:
            return
        now = time.monotonic()
        if (now - state.last_partial_at) * 1000 < state.partial_interval_ms:
            return

        pcm = endpointer.peek_speech()
        if not pcm:
            return

        state.partial_in_flight = True
        state.last_partial_at = now
        try:
            async with state.transcribe_lock:
                text = await _transcribe_pcm(
                    partial_provider,
                    pcm,
                    language=language,
                    sample_rate=sample_rate,
                )
            if not _should_emit_partial(text, state.last_partial_text):
                return
            state.last_partial_text = text
            await client_ws.send_json(
                {
                    "type": "transcript",
                    "text": text,
                    "is_final": False,
                    "speech_final": False,
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Partial Whisper transcription failed: %s", exc)
        finally:
            state.partial_in_flight = False

    async def finalize() -> None:
        pcm = endpointer.take_utterance()
        state.speech_started_sent = False
        if not pcm:
            return

        state.final_in_flight = True
        try:
            async with state.transcribe_lock:
                text = await _transcribe_pcm(
                    final_provider,
                    pcm,
                    language=language,
                    sample_rate=sample_rate,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Whisper transcription failed: %s", exc)
            return
        finally:
            state.final_in_flight = False
            state.last_partial_text = ""

        if not text:
            return
        await client_ws.send_json(
            {"type": "transcript", "text": text, "is_final": True, "speech_final": True}
        )
        await client_ws.send_json({"type": "utterance_end"})
        if on_final:
            on_final(text)

    async def process_chunk(data: bytes) -> None:
        before = endpointer.in_speech
        if endpointer.feed(data):
            await finalize()
            return
        if endpointer.in_speech and not before:
            await on_speech_start()
        if endpointer.in_speech:
            await maybe_partial()

    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    client_ws.receive_bytes(),
                    timeout=RECEIVE_POLL_S,
                )
                await process_chunk(data)
            except asyncio.TimeoutError:
                if endpointer.in_speech:
                    await maybe_partial()
    except Exception:  # noqa: BLE001 - disconnect / receive error ends the stream
        pass
    finally:
        if endpointer.has_pending_speech():
            try:
                await finalize()
            except Exception:  # noqa: BLE001
                pass
