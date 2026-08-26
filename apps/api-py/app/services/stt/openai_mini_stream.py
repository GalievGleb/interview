"""Utterance buffering for the single OpenAI Mini live STT path."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass

from .openai_transcribe import OpenAiMiniTranscribeProvider
from .pcm_audio import pcm16_mono_wav

logger = logging.getLogger("stt.openai_mini_stream")

SPEECH_RMS_THRESHOLD = 280.0
MANUAL_RMS_THRESHOLD = 50.0
NOISE_FLOOR_MULT = 2.5
SILENCE_HANG_MS = 500
MIN_SPEECH_MS = 250
MAX_UTTERANCE_MS = 30000
PREROLL_MS = 180
RECEIVE_POLL_S = 0.08
MIN_FINAL_WORDS = 3
MANUAL_SIGNAL_FRAME_MS = 50
COALESCE_SILENCE_MS = 100


def _rms_int16(pcm: bytes) -> float:
    import numpy as np

    if not pcm:
        return 0.0
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples * samples)))


def _has_sustained_signal(pcm: bytes, sample_rate: int) -> bool:
    """Detect quiet speech without averaging it together with a long pause."""
    frame_bytes = max(2, int(sample_rate * 2 * MANUAL_SIGNAL_FRAME_MS / 1000))
    required_frames = max(1, MIN_SPEECH_MS // MANUAL_SIGNAL_FRAME_MS)
    consecutive_frames = 0
    for offset in range(0, len(pcm), frame_bytes):
        frame = pcm[offset : offset + frame_bytes]
        if len(frame) < frame_bytes:
            break
        if _rms_int16(frame) >= MANUAL_RMS_THRESHOLD:
            consecutive_frames += 1
            if consecutive_frames >= required_frames:
                return True
        else:
            consecutive_frames = 0
    return False


class Endpointer:
    def __init__(self, sample_rate: int = 16000) -> None:
        self.sample_rate = sample_rate
        self.bytes_per_ms = max(1, int(sample_rate * 2 / 1000))
        self._speech = bytearray()
        self._preroll = bytearray()
        self._manual = bytearray()
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

    def feed(self, chunk: bytes) -> bool:
        if not chunk:
            return False
        self._manual.extend(chunk)
        manual_cap = MAX_UTTERANCE_MS * self.bytes_per_ms
        if len(self._manual) > manual_cap:
            del self._manual[: len(self._manual) - manual_cap]
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
        elif self._in_speech:
            self._speech.extend(chunk)
            self._silence_bytes += len(chunk)
        else:
            self._preroll.extend(chunk)
            cap = PREROLL_MS * self.bytes_per_ms
            if len(self._preroll) > cap:
                del self._preroll[: len(self._preroll) - cap]

        silence_ms = self._silence_bytes // self.bytes_per_ms
        return (
            self._in_speech
            and self.speech_ms >= MIN_SPEECH_MS
            and (silence_ms >= SILENCE_HANG_MS or self.speech_ms >= MAX_UTTERANCE_MS)
        )

    def take_utterance(self, *, forced: bool = False) -> bytes:
        result = bytes(self._manual) if forced else bytes(self._speech)
        self._speech.clear()
        self._preroll.clear()
        self._manual.clear()
        self._in_speech = False
        self._silence_bytes = 0
        return result

    def has_pending_speech(self) -> bool:
        return self._in_speech and self.speech_ms >= MIN_SPEECH_MS

    def has_pending_audio(self) -> bool:
        return len(self._manual) >= MIN_SPEECH_MS * self.bytes_per_ms and _has_sustained_signal(
            bytes(self._manual), self.sample_rate
        )


@dataclass
class _FinalizationJob:
    pcm: bytearray
    speech_started_at: float
    speech_ended_at: float
    utterance_id: str
    captured_at_ms: int
    queued_at: float
    queue_depth: int = 0
    forced: bool = False
    force_request_id: str | None = None


def _meaningful_word_count(text: str) -> int:
    return len(
        [word for word in re.findall(r"[^\W\d_]+", text or "", re.UNICODE) if len(word) >= 2]
    )


def quality_gate(text: str, last_final: str) -> tuple[bool, str]:
    value = (text or "").strip()
    if _meaningful_word_count(value) < MIN_FINAL_WORDS:
        return False, "too_few_words"
    if last_final and value.casefold() == last_final.strip().casefold():
        return False, "duplicate"
    return True, "ok"


async def run_openai_mini_stream(
    client_ws,
    *,
    language: str = "ru",
    sample_rate: int = 16000,
    provider: OpenAiMiniTranscribeProvider | None = None,
) -> None:
    provider = provider or OpenAiMiniTranscribeProvider()
    if not provider.is_available():
        await client_ws.send_json(
            {"type": "error", "message": "Облачное распознавание SkillCue недоступно"}
        )
        return
    try:
        await provider.prepare_async()
    except Exception as exc:  # noqa: BLE001
        logger.warning("OpenAI Mini warmup failed: %s", exc)
        await client_ws.send_json(
            {"type": "error", "message": "Облачное распознавание SkillCue недоступно"}
        )
        return

    await client_ws.send_json(
        {
            "type": "ready",
            "engine": "openai-mini",
            "model": provider._active_model(),
            "sample_rate": sample_rate,
        }
    )
    endpointer = Endpointer(sample_rate=sample_rate)
    speech_started_at = 0.0
    last_final = ""
    closed = False
    active_job: _FinalizationJob | None = None
    pending_job: _FinalizationJob | None = None
    pending_ready = asyncio.Event()
    max_pending_pcm_bytes = sample_rate * 2 * MAX_UTTERANCE_MS // 1000
    coalesce_separator = b"\0\0" * int(sample_rate * COALESCE_SILENCE_MS / 1000)

    async def send_event(payload: dict) -> None:
        if not closed:
            await client_ws.send_json(payload)

    async def transcribe_job(job: _FinalizationJob) -> None:
        nonlocal last_final
        request_started = time.monotonic()
        try:
            result = await provider.transcribe_audio_file(
                pcm16_mono_wav(bytes(job.pcm), sample_rate),
                language=language,
                sample_rate=sample_rate,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI Mini transcription failed: %s", exc)
            await send_event(
                {
                    "type": "transcription_error",
                    "message": (
                        "Не удалось распознать этот фрагмент. Продолжаю слушать — повторите фразу."
                    ),
                    "force_request_id": job.force_request_id,
                }
            )
            if job.force_request_id:
                await send_event(
                    {
                        "type": "force_empty",
                        "force_request_id": job.force_request_id,
                    }
                )
            return

        final_done_at = time.monotonic()
        queue_wait_ms = max(0, int((request_started - job.queued_at) * 1000))
        speech_end_to_final_ms = max(0, int((final_done_at - job.speech_ended_at) * 1000))
        openai_inference_ms = max(0, int((final_done_at - request_started) * 1000))
        timings = {
            "speechMs": int(
                (job.speech_ended_at - (job.speech_started_at or job.speech_ended_at)) * 1000
            ),
            "firstPartialMs": None,
            "queueWaitMs": queue_wait_ms,
            "queueDepth": job.queue_depth,
            "speechEndToFinalMs": speech_end_to_final_ms,
            "openaiInferenceMs": openai_inference_ms,
            "partialCount": 0,
        }
        metadata = {
            "utterance_id": job.utterance_id,
            "captured_at_ms": job.captured_at_ms,
            "queueWaitMs": queue_wait_ms,
            "queueDepth": job.queue_depth,
            "speechEndToFinalMs": speech_end_to_final_ms,
            "openaiInferenceMs": openai_inference_ms,
        }
        text = result.text.strip()
        accepted, reason = quality_gate(text, last_final)
        # Ctrl+Enter is an explicit user action. Short questions such as
        # "Какие виды?" are valid here even though the automatic stream
        # keeps rejecting tiny fragments to avoid accidental answers.
        if job.forced and text and reason in {"duplicate", "too_few_words"}:
            accepted, reason = True, "forced"
        if not accepted:
            await send_event(
                {
                    "type": "low_quality",
                    "text": text,
                    "reason": reason,
                    "timings": timings,
                    "force_request_id": job.force_request_id,
                    **metadata,
                }
            )
            return

        last_final = text
        await send_event(
            {
                "type": "transcript",
                "text": text,
                "is_final": True,
                "speech_final": True,
                "final_ms": result.latency_ms,
                "timings": timings,
                "force_request_id": job.force_request_id,
                **metadata,
            }
        )
        await send_event(
            {
                "type": "utterance_end",
                "timings": timings,
                "force_request_id": job.force_request_id,
                **metadata,
            }
        )

    async def transcription_worker() -> None:
        nonlocal active_job, pending_job
        while True:
            await pending_ready.wait()
            if closed:
                return
            job = pending_job
            pending_job = None
            pending_ready.clear()
            if job is None:
                continue
            active_job = job
            try:
                await transcribe_job(job)
            finally:
                active_job = None

    def merge_job(target: _FinalizationJob, incoming: _FinalizationJob) -> None:
        target.pcm.extend(coalesce_separator)
        target.pcm.extend(incoming.pcm)
        overflow = len(target.pcm) - max_pending_pcm_bytes
        if overflow > 0:
            del target.pcm[:overflow]
        if incoming.speech_started_at:
            target.speech_started_at = min(
                started
                for started in (target.speech_started_at, incoming.speech_started_at)
                if started
            )
        target.speech_ended_at = incoming.speech_ended_at
        target.utterance_id = incoming.utterance_id
        target.captured_at_ms = min(target.captured_at_ms, incoming.captured_at_ms)

    def enqueue_job(job: _FinalizationJob) -> list[str]:
        nonlocal pending_job
        if closed:
            return []
        superseded_force_ids: list[str] = []
        if not job.forced:
            if pending_job is None:
                job.queue_depth = int(active_job is not None)
                pending_job = job
            elif pending_job.forced:
                if pending_job.force_request_id:
                    superseded_force_ids.append(pending_job.force_request_id)
                job.queue_depth = int(active_job is not None)
                pending_job = job
            else:
                merge_job(pending_job, job)
                pending_job.queue_depth = int(active_job is not None)
            return superseded_force_ids

        if pending_job is None:
            target = job
        else:
            target = pending_job
            if target.forced and target.force_request_id:
                if target.force_request_id != job.force_request_id:
                    superseded_force_ids.append(target.force_request_id)
            merge_job(target, job)
        target.forced = True
        target.force_request_id = job.force_request_id
        target.queue_depth = int(active_job is not None)
        pending_job = target
        return superseded_force_ids

    async def complete_superseded(force_request_ids: list[str]) -> None:
        for force_request_id in force_request_ids:
            await send_event(
                {
                    "type": "force_empty",
                    "force_request_id": force_request_id,
                }
            )

    async def start_finalize(
        *,
        forced: bool = False,
        force_request_id: str | None = None,
    ) -> bool:
        nonlocal speech_started_at
        speech_ended_at = time.monotonic()
        pcm = endpointer.take_utterance(forced=forced)
        if not pcm:
            return False
        job = _FinalizationJob(
            pcm=bytearray(pcm[-max_pending_pcm_bytes:]),
            speech_started_at=speech_started_at,
            speech_ended_at=speech_ended_at,
            utterance_id=uuid.uuid4().hex,
            captured_at_ms=int(time.time() * 1000),
            queued_at=speech_ended_at,
            forced=forced,
            force_request_id=force_request_id,
        )
        speech_started_at = 0.0
        superseded_force_ids = enqueue_job(job)
        await complete_superseded(superseded_force_ids)
        pending_ready.set()
        return True

    async def bind_force_to_pending(force_request_id: str) -> bool:
        if pending_job is None:
            return False
        superseded_force_ids: list[str] = []
        if pending_job.forced and pending_job.force_request_id:
            if pending_job.force_request_id != force_request_id:
                superseded_force_ids.append(pending_job.force_request_id)
        pending_job.forced = True
        pending_job.force_request_id = force_request_id
        pending_job.queue_depth = int(active_job is not None)
        await complete_superseded(superseded_force_ids)
        pending_ready.set()
        return True

    worker_task = asyncio.create_task(transcription_worker())
    try:
        while True:
            try:
                message = await asyncio.wait_for(
                    client_ws.receive(),
                    timeout=RECEIVE_POLL_S,
                )
            except TimeoutError:
                continue
            if message.get("type") == "websocket.disconnect":
                closed = True
                break
            control = message.get("text")
            if control:
                try:
                    event = json.loads(control)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "finalize":
                    force_request_id = str(event.get("request_id") or "")
                    if endpointer.has_pending_audio():
                        await start_finalize(
                            forced=True,
                            force_request_id=force_request_id,
                        )
                    elif not await bind_force_to_pending(force_request_id):
                        await client_ws.send_json(
                            {
                                "type": "force_empty",
                                "force_request_id": force_request_id,
                            }
                        )
                continue
            data = message.get("bytes")
            if not data:
                continue
            before = endpointer.in_speech
            if endpointer.feed(data):
                await start_finalize()
            elif endpointer.in_speech and not before:
                speech_started_at = time.monotonic()
                await client_ws.send_json({"type": "speech_started"})
    except Exception:  # disconnect ends the stream
        pass
    finally:
        closed = True
        pending_job = None
        pending_ready.set()
        endpointer.take_utterance(forced=True)
        worker_task.cancel()
        await asyncio.gather(worker_task, return_exceptions=True)


__all__ = ["Endpointer", "quality_gate", "run_openai_mini_stream"]
