"""Local Whisper live streaming over the existing /stt/stream WebSocket.

Whisper is not a streaming model, so we buffer incoming PCM16, detect utterance
boundaries with a lightweight energy VAD, and transcribe each utterance when the
speaker pauses. We emit the **same WebSocket protocol the desktop already
expects** from the old Deepgram proxy:

    {"type": "ready", "engine", "model", "sample_rate"}
    {"type": "transcript", "text", "is_final", "speech_final"}
    {"type": "utterance_end"}
    {"type": "error", "message"}

Keeping the protocol identical means the desktop live path works unchanged —
only the engine behind it changed (cloud Deepgram -> on-device Whisper).

Nothing here is asynchronous-LLM or Ollama: the transcript is produced purely by
Whisper and returned immediately.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from .registry import build_whisper_provider
from .whisper_local_provider import WhisperLocalProvider

logger = logging.getLogger("stt.whisper_stream")

# Endpointing / VAD tuning (energy-based, dependency-free).
SPEECH_RMS_THRESHOLD = 280.0  # absolute int16 RMS floor for "speech"
NOISE_FLOOR_MULT = 2.5  # in noisy rooms, require this × the learned noise floor
# Trailing silence that finalizes an utterance. Calibrated against real RU QA
# speech: 700ms over-fragments one question into 4-5 turns; 1100ms keeps a
# question coherent (and matches the old Deepgram utterance_end). Desktop-side
# utterance merging smooths any remaining multi-sentence splits.
SILENCE_HANG_MS = 1100
MIN_SPEECH_MS = 250  # ignore sub-blip noises
MAX_UTTERANCE_MS = 14000  # force-finalize very long turns
PREROLL_MS = 200  # keep a little audio before onset so we don't clip


def _rms_int16(pcm: bytes) -> float:
    """Root-mean-square amplitude of little-endian PCM16 bytes (0 if empty)."""
    import numpy as np

    if not pcm:
        return 0.0
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples * samples)))


class Endpointer:
    """Pure VAD state machine — fed raw PCM chunks, says when to finalize.

    Separated from the WebSocket loop so it can be unit-tested without audio
    hardware or a running model.
    """

    def __init__(self, sample_rate: int = 16000) -> None:
        self.bytes_per_ms = max(1, int(sample_rate * 2 / 1000))
        self._speech = bytearray()
        self._preroll = bytearray()
        self._in_speech = False
        self._silence_bytes = 0
        self._noise_floor = 0.0  # learned from quiet frames (EMA)

    def _threshold(self) -> float:
        """Effective speech threshold: the absolute floor, raised in noisy rooms."""
        return max(SPEECH_RMS_THRESHOLD, self._noise_floor * NOISE_FLOOR_MULT)

    @property
    def speech_ms(self) -> int:
        return len(self._speech) // self.bytes_per_ms

    def _preroll_cap(self) -> int:
        return PREROLL_MS * self.bytes_per_ms

    def feed(self, chunk: bytes) -> bool:
        """Append a chunk; return True when an utterance is ready to finalize."""
        if not chunk:
            return False
        rms = _rms_int16(chunk)
        is_voice = rms >= self._threshold()
        if not is_voice:
            # Adapt the noise floor from quiet frames (slow EMA).
            self._noise_floor = 0.9 * self._noise_floor + 0.1 * rms

        if is_voice:
            if not self._in_speech:
                self._in_speech = True
                # Prepend preroll so the word onset isn't clipped.
                self._speech.extend(self._preroll)
                self._preroll.clear()
            self._speech.extend(chunk)
            self._silence_bytes = 0
        else:
            if self._in_speech:
                self._speech.extend(chunk)
                self._silence_bytes += len(chunk)
            else:
                # Rolling preroll buffer of recent near-silence.
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

    def take_utterance(self) -> bytes:
        """Return the accumulated speech bytes and reset for the next turn."""
        out = bytes(self._speech)
        self._speech = bytearray()
        self._preroll = bytearray()
        self._in_speech = False
        self._silence_bytes = 0
        return out

    def has_pending_speech(self) -> bool:
        return self._in_speech and self.speech_ms >= MIN_SPEECH_MS


async def run_whisper_stream(
    client_ws,
    *,
    language: str = "multi",
    sample_rate: int = 16000,
    provider: WhisperLocalProvider | None = None,
    on_final: Callable[[str], None] | None = None,
) -> None:
    provider = provider or build_whisper_provider()

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

    # Warm up (and, if needed, load) the model before the first utterance.
    try:
        import asyncio

        await asyncio.to_thread(provider.prepare)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Whisper model load failed: %s", exc)
        await client_ws.send_json(
            {"type": "error", "message": f"Не удалось загрузить модель Whisper: {exc}"}
        )
        return

    await client_ws.send_json(
        {
            "type": "ready",
            "engine": provider.id,
            "model": provider._active_model(),
            "sample_rate": sample_rate,
        }
    )

    endpointer = Endpointer(sample_rate=sample_rate)

    async def finalize() -> None:
        pcm = endpointer.take_utterance()
        if not pcm:
            return
        try:
            text = await provider.transcribe_pcm16(pcm, language=language, sample_rate=sample_rate)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Whisper transcription failed: %s", exc)
            return
        text = (text or "").strip()
        if not text:
            return
        await client_ws.send_json(
            {"type": "transcript", "text": text, "is_final": True, "speech_final": True}
        )
        await client_ws.send_json({"type": "utterance_end"})
        if on_final:
            on_final(text)

    try:
        while True:
            data = await client_ws.receive_bytes()
            if endpointer.feed(data):
                await finalize()
    except Exception:  # noqa: BLE001 - disconnect / receive error ends the stream
        pass
    finally:
        if endpointer.has_pending_speech():
            try:
                await finalize()
            except Exception:  # noqa: BLE001
                pass
