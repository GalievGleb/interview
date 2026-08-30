"""Low-latency live transcription through the managed SkillCue gateway."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit, urlunsplit

import numpy as np
import websockets
from fastapi import WebSocketDisconnect

from app.config import get_settings
from app.services.provider_adapter import _gateway_license_key, _gateway_root_url

from .openai_mini_stream import (
    MAX_UTTERANCE_MS,
    PREROLL_MS,
    Endpointer,
    quality_gate,
)
from .openai_transcribe import OpenAiMiniTranscribeProvider, strip_live_prompt_echo
from .pcm_audio import pcm16_mono_wav

logger = logging.getLogger("stt.openai_realtime_stream")

REALTIME_SAMPLE_RATE = 24_000
REALTIME_MODEL = "gpt-4o-mini-transcribe"
GATEWAY_READY_TIMEOUT_S = 10.0
REALTIME_SILENCE_HANG_MS = 700
# OpenAI Realtime normally completes in about one second. A rare upstream
# socket can remain open without ever emitting the terminal transcription.
# Hedge only an explicitly requested Ctrl+Enter turn after the normal p95.
FORCED_TURN_TIMEOUT_S = 1.8


class RealtimeUnavailable(RuntimeError):
    """The experimental realtime path failed and the legacy path may take over."""


class Pcm16StreamResampler:
    """Stateful linear PCM16 resampler whose output is invariant to chunking."""

    def __init__(self, source_rate: int, target_rate: int = REALTIME_SAMPLE_RATE) -> None:
        if source_rate <= 0 or target_rate <= 0:
            raise ValueError("sample rates must be positive")
        self.source_rate = source_rate
        self.target_rate = target_rate
        self._samples = np.empty(0, dtype=np.float64)
        self._position = 0.0

    def reset(self) -> None:
        self._samples = np.empty(0, dtype=np.float64)
        self._position = 0.0

    def feed(self, pcm: bytes) -> bytes:
        if not pcm:
            return b""
        if len(pcm) % 2:
            raise ValueError("PCM16 frame has an odd byte count")
        if self.source_rate == self.target_rate:
            return pcm

        incoming = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
        self._samples = np.concatenate((self._samples, incoming))
        if self._samples.size < 2:
            return b""

        step = self.source_rate / self.target_rate
        positions = np.arange(self._position, self._samples.size - 1, step)
        if positions.size == 0:
            return b""
        left = positions.astype(np.int64)
        fraction = positions - left
        values = self._samples[left] * (1.0 - fraction) + self._samples[left + 1] * fraction

        self._position += positions.size * step
        discard = int(self._position)
        if discard:
            self._samples = self._samples[discard:]
            self._position -= discard

        return np.clip(np.rint(values), -32768, 32767).astype("<i2").tobytes()


@dataclass
class _Turn:
    client_turn_id: str
    speech_started_at: float
    speech_ended_at: float
    captured_at_ms: int
    force_request_id: str | None = None
    first_delta_at: float | None = None
    partial_count: int = 0
    pcm: bytes = b""


def _realtime_gateway_url(gateway_url: str, language: str) -> str:
    root = _gateway_root_url(gateway_url)
    parsed = urlsplit(root)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RealtimeUnavailable("SkillCue gateway URL is invalid")
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = f"{parsed.path.rstrip('/')}/gateway/stt/stream"
    return urlunsplit((scheme, parsed.netloc, path, urlencode({"language": language}), ""))


async def run_openai_realtime_stream(
    client_ws,
    *,
    language: str = "ru",
    sample_rate: int = 16_000,
    gateway_url: str | None = None,
    license_key: str | None = None,
    connect_factory=None,
) -> None:
    """Bridge local PCM to OpenAI Realtime while preserving desktop STT events."""

    settings = get_settings()
    gateway_url = (gateway_url if gateway_url is not None else settings.skillcue_gateway_url).strip()
    if not gateway_url:
        raise RealtimeUnavailable("SkillCue gateway is unavailable")
    license_key = license_key if license_key is not None else await _gateway_license_key()
    if not license_key:
        raise RealtimeUnavailable("SkillCue license is unavailable")

    connect = connect_factory or websockets.connect
    url = _realtime_gateway_url(gateway_url, language)
    resampler = Pcm16StreamResampler(sample_rate, REALTIME_SAMPLE_RATE)
    # Natural interview questions often contain a 500–600 ms thinking pause.
    # Keep that as one turn; the legacy upload path retains its proven 500 ms
    # behavior while Realtime avoids head-of-line blocking between fragments.
    endpointer = Endpointer(
        sample_rate=sample_rate,
        silence_hang_ms=REALTIME_SILENCE_HANG_MS,
    )
    turns: dict[str, _Turn] = {}
    turn_order: list[str] = []
    last_final = ""
    manual_pcm = bytearray()
    manual_cap = sample_rate * 2 * MAX_UTTERANCE_MS // 1000
    auto_preroll_bytes = sample_rate * 2 * PREROLL_MS // 1000
    streaming_turn = False
    speech_started_at = 0.0
    fallback_provider: OpenAiMiniTranscribeProvider | None = None
    fallback_tasks: set[asyncio.Task[None]] = set()

    async def send_local(payload: dict) -> None:
        await client_ws.send_json(payload)

    async def open_connection():
        return connect(
            url,
            additional_headers={"Authorization": f"Bearer {license_key}"},
            open_timeout=GATEWAY_READY_TIMEOUT_S,
            ping_interval=20,
            ping_timeout=20,
            max_size=1_048_576,
        )

    # A small wrapper keeps tests able to inject the same async context-manager
    # contract returned by websockets.connect.
    connection = await open_connection()
    try:
        async with connection as gateway_ws:
            try:
                raw_ready = await asyncio.wait_for(
                    gateway_ws.recv(), timeout=GATEWAY_READY_TIMEOUT_S
                )
                ready = json.loads(raw_ready)
                if ready.get("type") != "ready":
                    raise RealtimeUnavailable(str(ready.get("message") or "Realtime STT not ready"))
            except RealtimeUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001
                raise RealtimeUnavailable("Realtime STT handshake failed") from exc

            await send_local(
                {
                    "type": "ready",
                    "engine": "openai-realtime",
                    "model": str(ready.get("model") or "").strip() or REALTIME_MODEL,
                    # Desktop records the original PCM; keep diagnostics/WAV rate exact.
                    "sample_rate": sample_rate,
                }
            )

            async def send_audio(pcm: bytes) -> None:
                converted = resampler.feed(pcm)
                if converted:
                    await gateway_ws.send(converted)

            def remove_turn(turn: _Turn) -> None:
                turns.pop(turn.client_turn_id, None)
                if turn.client_turn_id in turn_order:
                    turn_order.remove(turn.client_turn_id)

            async def run_forced_fallback(turn: _Turn, force_request_id: str) -> None:
                nonlocal fallback_provider, last_final
                await asyncio.sleep(FORCED_TURN_TIMEOUT_S)
                current = turns.get(turn.client_turn_id)
                if current is not turn or current.force_request_id != force_request_id:
                    return
                try:
                    if fallback_provider is None:
                        fallback_provider = OpenAiMiniTranscribeProvider()
                    if not fallback_provider.is_available():
                        raise RuntimeError("Mini STT fallback is unavailable")
                    await fallback_provider.prepare_async()
                    result = await fallback_provider.transcribe_audio_file(
                        pcm16_mono_wav(turn.pcm, sample_rate),
                        language=language,
                        sample_rate=sample_rate,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Realtime forced-turn fallback failed: %s", exc)
                    if turns.get(turn.client_turn_id) is turn:
                        await send_local(
                            {
                                "type": "transcription_error",
                                "message": "Не удалось завершить распознавание этого вопроса.",
                                "force_request_id": force_request_id,
                            }
                        )
                        await send_local(
                            {
                                "type": "force_empty",
                                "force_request_id": force_request_id,
                            }
                        )
                        remove_turn(turn)
                    return

                if turns.get(turn.client_turn_id) is not turn:
                    return
                final_at = time.monotonic()
                text = result.text.strip()
                accepted, reason = quality_gate(text, last_final)
                if text and reason in {"duplicate", "too_few_words"}:
                    accepted, reason = True, "forced"
                speech_end_to_final_ms = max(
                    0, int((final_at - turn.speech_ended_at) * 1000)
                )
                timings = {
                    "speechMs": max(
                        0,
                        int((turn.speech_ended_at - turn.speech_started_at) * 1000),
                    ),
                    "firstPartialMs": None,
                    "queueWaitMs": 0,
                    "queueDepth": 0,
                    "speechEndToFinalMs": speech_end_to_final_ms,
                    "openaiInferenceMs": result.latency_ms,
                    "partialCount": turn.partial_count,
                }
                metadata = {
                    "utterance_id": turn.client_turn_id,
                    "captured_at_ms": turn.captured_at_ms,
                    "queueWaitMs": 0,
                    "queueDepth": 0,
                    "speechEndToFinalMs": speech_end_to_final_ms,
                    "openaiInferenceMs": result.latency_ms,
                }
                if accepted:
                    last_final = text
                    await send_local(
                        {
                            "type": "transcript",
                            "text": text,
                            "is_final": True,
                            "speech_final": True,
                            "final_ms": result.latency_ms,
                            "timings": timings,
                            "force_request_id": force_request_id,
                            **metadata,
                        }
                    )
                    await send_local(
                        {
                            "type": "utterance_end",
                            "timings": timings,
                            "force_request_id": force_request_id,
                            **metadata,
                        }
                    )
                else:
                    await send_local(
                        {
                            "type": "low_quality",
                            "text": text,
                            "reason": reason,
                            "timings": timings,
                            "force_request_id": force_request_id,
                            **metadata,
                        }
                    )
                remove_turn(turn)

            def schedule_forced_fallback(turn: _Turn, force_request_id: str) -> None:
                task = asyncio.create_task(run_forced_fallback(turn, force_request_id))
                fallback_tasks.add(task)
                task.add_done_callback(fallback_tasks.discard)

            async def commit_turn(
                force_request_id: str | None = None,
                pcm: bytes = b"",
            ) -> _Turn:
                nonlocal speech_started_at
                ended_at = time.monotonic()
                turn = _Turn(
                    client_turn_id=uuid.uuid4().hex,
                    speech_started_at=speech_started_at or ended_at,
                    speech_ended_at=ended_at,
                    captured_at_ms=int(time.time() * 1000),
                    force_request_id=force_request_id,
                    pcm=pcm,
                )
                turns[turn.client_turn_id] = turn
                turn_order.append(turn.client_turn_id)
                await gateway_ws.send(
                    json.dumps(
                        {
                            "type": "commit",
                            "client_turn_id": turn.client_turn_id,
                        }
                    )
                )
                speech_started_at = 0.0
                resampler.reset()
                if force_request_id:
                    schedule_forced_fallback(turn, force_request_id)
                return turn

            async def bind_force(force_request_id: str) -> bool:
                for turn_id in reversed(turn_order):
                    turn = turns.get(turn_id)
                    if turn is None:
                        continue
                    if turn.force_request_id and turn.force_request_id != force_request_id:
                        await send_local(
                            {
                                "type": "force_empty",
                                "force_request_id": turn.force_request_id,
                            }
                        )
                    turn.force_request_id = force_request_id
                    await gateway_ws.send(
                        json.dumps(
                            {
                                "type": "bind_force",
                                "client_turn_id": turn.client_turn_id,
                                "force_request_id": force_request_id,
                            }
                        )
                    )
                    schedule_forced_fallback(turn, force_request_id)
                    return True
                return False

            async def client_loop() -> None:
                nonlocal streaming_turn, speech_started_at, manual_pcm
                while True:
                    message = await client_ws.receive()
                    if message.get("type") == "websocket.disconnect":
                        return
                    control = message.get("text")
                    if control:
                        try:
                            event = json.loads(control)
                        except json.JSONDecodeError:
                            continue
                        if event.get("type") != "finalize":
                            continue
                        force_request_id = str(event.get("request_id") or "")
                        if endpointer.has_pending_audio():
                            pending_pcm = endpointer.take_utterance(forced=True)
                            if not streaming_turn:
                                await send_audio(pending_pcm)
                            await commit_turn(force_request_id, pending_pcm)
                            manual_pcm.clear()
                            streaming_turn = False
                        elif not await bind_force(force_request_id):
                            await send_local(
                                {
                                    "type": "force_empty",
                                    "force_request_id": force_request_id,
                                }
                            )
                        continue

                    data = message.get("bytes")
                    if not data:
                        continue
                    manual_pcm.extend(data)
                    if len(manual_pcm) > manual_cap:
                        del manual_pcm[: len(manual_pcm) - manual_cap]

                    before = endpointer.in_speech
                    should_commit = endpointer.feed(data)
                    if endpointer.in_speech and not before:
                        speech_started_at = time.monotonic()
                        # Send only the local preroll, not minutes of idle-room audio.
                        await send_audio(
                            bytes(manual_pcm[-(auto_preroll_bytes + len(data)) :])
                        )
                        streaming_turn = True
                        await send_local({"type": "speech_started"})
                    elif streaming_turn:
                        await send_audio(data)

                    if should_commit:
                        turn_pcm = endpointer.take_utterance()
                        await commit_turn(pcm=turn_pcm)
                        manual_pcm.clear()
                        streaming_turn = False

            async def upstream_loop() -> None:
                nonlocal last_final
                while True:
                    try:
                        raw = await gateway_ws.recv()
                    except Exception as exc:  # noqa: BLE001
                        raise RealtimeUnavailable("Realtime STT connection closed") from exc
                    try:
                        event = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    event_type = event.get("type")
                    if event_type == "error":
                        raise RealtimeUnavailable(
                            str(event.get("message") or "Realtime STT unavailable")
                        )
                    turn = turns.get(str(event.get("client_turn_id") or ""))
                    if turn is None:
                        continue
                    if event_type == "transcript_delta":
                        turn.partial_count += 1
                        turn.first_delta_at = turn.first_delta_at or time.monotonic()
                        continue
                    if event_type != "transcript_completed":
                        continue

                    final_at = time.monotonic()
                    text = strip_live_prompt_echo(str(event.get("transcript") or ""))
                    force_request_id = turn.force_request_id or (
                        str(event.get("force_request_id"))
                        if event.get("force_request_id")
                        else None
                    )
                    accepted, reason = quality_gate(text, last_final)
                    if force_request_id and text and reason in {"duplicate", "too_few_words"}:
                        accepted, reason = True, "forced"
                    speech_end_to_final_ms = max(
                        0, int((final_at - turn.speech_ended_at) * 1000)
                    )
                    timings = {
                        "speechMs": max(
                            0,
                            int((turn.speech_ended_at - turn.speech_started_at) * 1000),
                        ),
                        "firstPartialMs": (
                            max(0, int((turn.first_delta_at - turn.speech_started_at) * 1000))
                            if turn.first_delta_at is not None
                            else None
                        ),
                        "queueWaitMs": 0,
                        "queueDepth": 0,
                        "speechEndToFinalMs": speech_end_to_final_ms,
                        "openaiInferenceMs": speech_end_to_final_ms,
                        "partialCount": turn.partial_count,
                    }
                    metadata = {
                        "utterance_id": turn.client_turn_id,
                        "captured_at_ms": turn.captured_at_ms,
                        "queueWaitMs": 0,
                        "queueDepth": 0,
                        "speechEndToFinalMs": speech_end_to_final_ms,
                        "openaiInferenceMs": speech_end_to_final_ms,
                    }
                    if accepted:
                        last_final = text
                        await send_local(
                            {
                                "type": "transcript",
                                "text": text,
                                "is_final": True,
                                "speech_final": True,
                                "final_ms": speech_end_to_final_ms,
                                "timings": timings,
                                "force_request_id": force_request_id,
                                **metadata,
                            }
                        )
                        await send_local(
                            {
                                "type": "utterance_end",
                                "timings": timings,
                                "force_request_id": force_request_id,
                                **metadata,
                            }
                        )
                        remove_turn(turn)
                    elif force_request_id:
                        # Ctrl+Enter already scheduled a buffered-WAV fallback.
                        # A rare empty/prompt-echo Realtime final must not delete
                        # the turn before that recovery can transcribe its PCM.
                        logger.info(
                            "Realtime returned a rejected forced final; awaiting fallback: %s",
                            reason,
                        )
                    else:
                        await send_local(
                            {
                                "type": "low_quality",
                                "text": text,
                                "reason": reason,
                                "timings": timings,
                                "force_request_id": force_request_id,
                                **metadata,
                            }
                        )
                        remove_turn(turn)

            client_task = asyncio.create_task(client_loop())
            upstream_task = asyncio.create_task(upstream_loop())
            try:
                done, pending = await asyncio.wait(
                    {client_task, upstream_task}, return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if upstream_task in done:
                    error = upstream_task.exception()
                    if error:
                        raise error
                    raise RealtimeUnavailable("Realtime STT connection closed")
                await client_task
            finally:
                for task in tuple(fallback_tasks):
                    task.cancel()
                await asyncio.gather(*fallback_tasks, return_exceptions=True)
                if fallback_provider is not None:
                    await fallback_provider.aclose()
    except (RealtimeUnavailable, WebSocketDisconnect):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("OpenAI Realtime stream failed: %s", exc)
        raise RealtimeUnavailable("Realtime STT unavailable") from exc


__all__ = [
    "Pcm16StreamResampler",
    "RealtimeUnavailable",
    "run_openai_realtime_stream",
]
