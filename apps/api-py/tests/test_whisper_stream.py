"""Tests for the local Whisper live streaming path.

The Endpointer/VAD tests are pure and always run. The end-to-end streaming test
runs only when the small "fast" model is already downloaded (skipped in CI
otherwise), so it can prove real audio -> transcript without a network hit.
"""

import wave
from pathlib import Path

import numpy as np
import pytest

from app.services.stt import whisper_stream
from app.services.stt.whisper_local_provider import WhisperLocalProvider

REPO_ROOT = Path(__file__).resolve().parents[3]
AUDIO = REPO_ROOT / "tests" / "voice" / "audio" / "04_flaky_tests.wav"


def _speech_chunk(ms: int, sample_rate: int = 16000, amp: int = 8000) -> bytes:
    n = int(sample_rate * ms / 1000)
    t = np.arange(n)
    wave_ = (amp * np.sin(2 * np.pi * 180 * t / sample_rate)).astype(np.int16)
    return wave_.tobytes()


def _silence_chunk(ms: int, sample_rate: int = 16000) -> bytes:
    return np.zeros(int(sample_rate * ms / 1000), dtype=np.int16).tobytes()


# --- RMS / VAD -----------------------------------------------------------
def test_rms_of_silence_is_zero():
    assert whisper_stream._rms_int16(_silence_chunk(50)) == 0.0
    assert whisper_stream._rms_int16(b"") == 0.0


def test_rms_of_speech_exceeds_threshold():
    rms = whisper_stream._rms_int16(_speech_chunk(50))
    assert rms > whisper_stream.SPEECH_RMS_THRESHOLD


def test_endpointer_ignores_pure_silence():
    ep = whisper_stream.Endpointer()
    finalized = False
    for _ in range(40):
        finalized = finalized or ep.feed(_silence_chunk(50))
    assert finalized is False
    assert ep.has_pending_speech() is False
    assert ep.take_utterance() == b""


def test_adaptive_threshold_rises_with_background_noise():
    ep = whisper_stream.Endpointer()
    assert ep._threshold() == whisper_stream.SPEECH_RMS_THRESHOLD  # starts at the floor
    # Sustained moderate noise (RMS below the floor) should be learned as noise
    # and raise the effective threshold, without ever entering speech.
    fired = False
    for _ in range(60):
        fired = fired or ep.feed(_speech_chunk(30, amp=200))
    assert fired is False
    assert ep._threshold() > whisper_stream.SPEECH_RMS_THRESHOLD


def test_endpointer_peek_speech_returns_copy_without_reset():
    ep = whisper_stream.Endpointer()
    for _ in range(10):
        ep.feed(_speech_chunk(30))
    peeked = ep.peek_speech()
    assert len(peeked) > 0
    assert ep.in_speech is True
    assert len(ep.peek_speech()) == len(peeked)


def test_should_emit_partial_prefers_longer_prefix():
    assert whisper_stream._should_emit_partial("hello world", "hello") is True
    assert whisper_stream._should_emit_partial("hello", "hello world") is False
    assert whisper_stream._should_emit_partial("hello", "hello") is False


# --- quality gate --------------------------------------------------------
def test_quality_gate_rejects_too_few_words():
    ok, reason = whisper_stream.quality_gate("да нет", "")
    assert ok is False and reason == "too_few_words"


def test_quality_gate_rejects_duplicate():
    prev = "Какие бывают виды тестирования?"
    ok, reason = whisper_stream.quality_gate(prev, prev)
    assert ok is False and reason == "duplicate"


def test_quality_gate_accepts_real_question():
    ok, reason = whisper_stream.quality_gate("Какие бывают виды тестирования?", "")
    assert ok is True and reason == "ok"


def test_meaningful_word_count_ignores_digits_and_punct():
    # "CI", "CD", "ok" are letter-words >= 2 chars; "200" (digits) excluded.
    assert whisper_stream._meaningful_word_count("CI/CD 200 ok!") == 3
    assert whisper_stream._meaningful_word_count("да 5 а") == 1  # only "да"


def test_endpointer_finalizes_after_speech_then_silence():
    ep = whisper_stream.Endpointer()
    fired = False
    # ~600ms of speech in 30ms chunks
    for _ in range(20):
        fired = fired or ep.feed(_speech_chunk(30))
    assert fired is False  # still talking
    # Trailing silence beyond SILENCE_HANG_MS should finalize the utterance.
    silence_chunks = int((whisper_stream.SILENCE_HANG_MS + 300) / 30) + 1
    for _ in range(silence_chunks):
        fired = fired or ep.feed(_silence_chunk(30))
    assert fired is True
    utterance = ep.take_utterance()
    assert len(utterance) > 0


# --- end-to-end streaming ------------------------------------------------
class _FakeWS:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def receive_bytes(self) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        raise RuntimeError("client disconnected")


@pytest.mark.asyncio
async def test_run_whisper_stream_emits_transcript():
    provider = WhisperLocalProvider(quality="fast", device="cpu")
    if not provider.is_available() or not provider.is_model_downloaded():
        pytest.skip("fast Whisper model not downloaded")
    if not AUDIO.is_file():
        pytest.skip("sample audio missing")

    with wave.open(str(AUDIO), "rb") as w:
        sample_rate = w.getframerate()
        pcm = w.readframes(w.getnframes())

    # 30ms chunks of real speech, then ~1s of silence to trigger finalize.
    bytes_per_chunk = int(sample_rate * 2 * 0.03)
    chunks = [pcm[i : i + bytes_per_chunk] for i in range(0, len(pcm), bytes_per_chunk)]
    chunks += [_silence_chunk(30, sample_rate)] * 40

    ws = _FakeWS(chunks)
    await whisper_stream.run_whisper_stream(
        ws,
        language="ru",
        sample_rate=sample_rate,
        partial_provider=provider,
        final_provider=provider,
    )

    types = [m["type"] for m in ws.sent]
    assert "ready" in types
    finals = [m for m in ws.sent if m["type"] == "transcript" and m.get("is_final")]
    assert finals, f"expected a final transcript, got events: {types}"
    assert finals[0]["text"].strip()

    # Latency regression guard: the final must arrive fast after speech ends.
    ends = [m for m in ws.sent if m["type"] == "utterance_end"]
    assert ends, "expected an utterance_end with timings"
    timings = ends[0]["timings"]
    assert timings["finalInferenceMs"] is not None
    assert timings["speechEndToFinalMs"] < 3500, (
        f"speechEnd->final too slow: {timings['speechEndToFinalMs']}ms"
    )
