"""Installed-dev voice E2E: noisy turn -> STT -> Ctrl+Enter question -> LLM."""

from __future__ import annotations

import asyncio
import json
import math
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from array import array
from pathlib import Path

import websockets

from dev_e2e_identity import seed_installed_gateway_identity

CASE_ID = os.environ.get("SKILLCUE_E2E_CASE_ID", "06_ctrl_enter_before_final").strip()
MAX_STT_MS = 6_000
MAX_LLM_FIRST_CHUNK_MS = 5_000
MAX_VOICE_TO_FIRST_CHUNK_MS = 4_000
MAX_END_TO_END_MS = 10_000
ACTIVE_JOB_SETTLE_S = 0.1
LIVE_SAMPLE_RATE = 16_000
REQUIRE_IDLESS_RACE = CASE_ID == "06_ctrl_enter_before_final"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _installed_backend() -> Path:
    local = Path(os.environ["LOCALAPPDATA"])
    return local / "Programs" / "skillcue-dev" / "resources" / "backend" / "skillcue-backend.exe"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_health(port: int, deadline: float) -> None:
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.2)
    raise RuntimeError("The isolated SkillCue Dev backend did not start.")


def _load_case() -> dict:
    cases = json.loads((_repo_root() / "tests" / "voice" / "cases.json").read_text("utf-8"))
    return next(case for case in cases if case["id"] == CASE_ID)


def _matches(text: str, groups: list[dict]) -> list[str]:
    normalized = text.casefold()
    return [
        str(group["key"])
        for group in groups
        if any(str(alias).casefold() in normalized for alias in group["aliases"])
    ]


def _tone_pcm(sample_rate: int) -> bytes:
    frames = int(sample_rate * 0.35)
    tone = bytearray()
    for index in range(frames):
        value = int(2_000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        tone.extend(struct.pack("<h", value))
    tone.extend(b"\0\0" * int(sample_rate * 0.65))
    return bytes(tone)


def _read_pcm(path: Path) -> tuple[int, bytes]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise RuntimeError("Voice fixture must be mono PCM16 WAV.")
        return audio.getframerate(), audio.readframes(audio.getnframes())


def _resample_pcm16_mono(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    """Mirror the desktop's linear 16 kHz resampler for external WAV fixtures."""
    if from_rate == to_rate:
        return pcm
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return b""
    ratio = from_rate / to_rate
    output_length = max(1, round(len(samples) / ratio))
    output = array("h")
    for index in range(output_length):
        position = index * ratio
        left = int(position)
        right = min(left + 1, len(samples) - 1)
        fraction = position - left
        value = round(samples[left] * (1 - fraction) + samples[right] * fraction)
        output.append(max(-32_768, min(32_767, value)))
    if sys.byteorder != "little":
        output.byteswap()
    return output.tobytes()


async def _send_pcm(ws, pcm: bytes, sample_rate: int) -> None:
    frame_bytes = max(2, sample_rate * 2 // 10)
    for offset in range(0, len(pcm), frame_bytes):
        await ws.send(pcm[offset : offset + frame_bytes])
        await asyncio.sleep(0)


async def _next_event(ws, deadline: float) -> dict:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Timed out waiting for STT event.")
    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
    return json.loads(str(raw))


async def _wait_for_terminal_noise(ws, deadline: float) -> None:
    while True:
        event = await _next_event(ws, deadline)
        if event.get("type") == "error":
            raise RuntimeError(f"STT startup error: {event.get('message')}")
        if event.get("type") in {"low_quality", "transcript", "transcription_error"}:
            return


async def _transcribe(port: int, token: str, case: dict) -> tuple[str, int, dict]:
    fixture = _repo_root() / str(case["audioFile"])
    source_rate, source_pcm = _read_pcm(fixture)
    sample_rate = LIVE_SAMPLE_RATE
    pcm = _resample_pcm16_mono(source_pcm, source_rate, sample_rate)
    query = urllib.parse.urlencode(
        {"language": "ru", "sample_rate": sample_rate, "token": token}
    )
    url = f"ws://127.0.0.1:{port}/stt/stream?{query}"

    async with websockets.connect(url, open_timeout=10, close_timeout=2) as ws:
        startup_deadline = time.monotonic() + 12
        while True:
            event = await _next_event(ws, startup_deadline)
            if event.get("type") == "error":
                raise RuntimeError(f"STT startup error: {event.get('message')}")
            if event.get("type") == "ready":
                break

        # Reproduce the reported failure: one rejected/noisy turn immediately
        # precedes the real question. A stale 6.2 s client pacer makes the real
        # transcript miss the latency budget even when the gateway is healthy.
        await _send_pcm(ws, _tone_pcm(sample_rate), sample_rate)
        await _wait_for_terminal_noise(ws, time.monotonic() + 12)

        await _send_pcm(ws, pcm, sample_rate)
        # Match the real Ctrl+Enter race: the endpointer has already handed the
        # utterance to an active automatic STT job, but its final has not arrived.
        await asyncio.sleep(ACTIVE_JOB_SETTLE_S)
        request_id = f"voice-e2e-{uuid.uuid4().hex}"
        force_started = time.monotonic()
        await ws.send(json.dumps({"type": "finalize", "request_id": request_id}))
        deadline = force_started + 15
        saw_force_empty = False
        while True:
            event = await _next_event(ws, deadline)
            if event.get("type") == "error":
                raise RuntimeError(f"STT error: {event.get('message')}")
            if (
                event.get("type") == "force_empty"
                and event.get("force_request_id") == request_id
            ):
                saw_force_empty = True
                continue
            if event.get("type") == "transcription_error":
                raise RuntimeError(
                    f"Voice STT provider failed: {event.get('message', 'unknown error')}"
                )
            if event.get("type") == "low_quality":
                raise RuntimeError(
                    "Voice STT rejected the user fixture: "
                    f"reason={event.get('reason')}; text={event.get('text')}"
                )
            if event.get("type") != "transcript":
                continue
            text = str(event.get("text") or "").strip()
            matched = _matches(text, case["requiredTranscriptKeywords"])
            if len(matched) < 3:
                raise RuntimeError(
                    "Voice transcript semantic validation failed: "
                    f"matched={matched}; text={text}"
                )
            if REQUIRE_IDLESS_RACE and not saw_force_empty:
                raise RuntimeError(
                    "Voice regression route was not reproduced: missing force_empty before final."
                )
            if REQUIRE_IDLESS_RACE and event.get("force_request_id"):
                raise RuntimeError(
                    "Voice regression route was not reproduced: final unexpectedly retained a request id."
                )
            elapsed_ms = round((time.monotonic() - force_started) * 1000)
            return text, elapsed_ms, event


def _ask_overlay(port: int, token: str, question: str, case: dict) -> tuple[str, int, int, dict]:
    payload = {
        "question": question,
        "raw_question": question,
        "mode": "fast",
        "fast_answer": True,
        "answer_language": "ru",
    }
    model_override = os.environ.get("SKILLCUE_E2E_MODEL", "").strip()
    if model_override:
        payload["model"] = model_override
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/chat/interview/stream",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-SkillCue-Token": token,
        },
        method="POST",
    )
    started = time.monotonic()
    first_chunk_ms: int | None = None
    chunks: list[str] = []
    done: dict | None = None
    with urllib.request.urlopen(request, timeout=35) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            if event.get("type") == "error":
                raise RuntimeError(f"Overlay SSE error: {event.get('message')}")
            if event.get("type") == "chunk":
                if first_chunk_ms is None:
                    first_chunk_ms = round((time.monotonic() - started) * 1000)
                chunks.append(str(event.get("text") or ""))
            if event.get("type") == "done":
                done = event

    answer = str((done or {}).get("spoken") or "".join(chunks)).strip()
    if first_chunk_ms is None or done is None:
        raise RuntimeError("Overlay stream did not produce a complete streamed answer.")
    matched = _matches(answer, case["requiredAnswerKeywords"])
    if len(matched) < 3:
        elapsed_ms = round((time.monotonic() - started) * 1000)
        raise RuntimeError(
            "Answer semantic validation failed: "
            f"matched={matched}; first_chunk={first_chunk_ms}ms; total={elapsed_ms}ms; "
            f"answer={answer}"
        )
    total_ms = round((time.monotonic() - started) * 1000)
    return answer, first_chunk_ms, total_ms, done


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    backend = _installed_backend()
    if not backend.exists():
        raise RuntimeError(f"Installed SkillCue Dev backend was not found: {backend}")

    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-voice-e2e-{token}.sqlite"
    seed_installed_gateway_identity(db_path)
    env = {
        **os.environ,
        "SKILLCUE_PORT": str(port),
        "SKILLCUE_API_TOKEN": token,
        "SKILLCUE_BUILD_CHANNEL": "dev",
        "SKILLCUE_GATEWAY_URL": "https://skill-cue.ru/v1",
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
    }
    process = subprocess.Popen(
        [str(backend)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        _wait_for_health(port, time.monotonic() + 12)
        case = _load_case()
        transcript, stt_ms, stt_event = asyncio.run(_transcribe(port, token, case))
        answer, first_chunk_ms, llm_total_ms, done = _ask_overlay(
            port, token, transcript, case
        )
        voice_to_first_chunk_ms = stt_ms + first_chunk_ms
        end_to_end_ms = stt_ms + llm_total_ms

        if stt_ms > MAX_STT_MS:
            raise RuntimeError(f"Voice STT was too slow: {stt_ms} ms > {MAX_STT_MS} ms")
        if first_chunk_ms > MAX_LLM_FIRST_CHUNK_MS:
            raise RuntimeError(
                "Overlay first token was too slow: "
                f"{first_chunk_ms} ms > {MAX_LLM_FIRST_CHUNK_MS} ms "
                f"(model={done.get('model')}, "
                f"hedge={done.get('correction', {}).get('hedgeStarted')}, "
                f"winner={done.get('correction', {}).get('hedgeWinner')})"
            )
        if voice_to_first_chunk_ms > MAX_VOICE_TO_FIRST_CHUNK_MS:
            raise RuntimeError(
                "Voice-to-first-answer was too slow: "
                f"{voice_to_first_chunk_ms} ms > {MAX_VOICE_TO_FIRST_CHUNK_MS} ms "
                f"(stt={stt_ms} ms, first_chunk={first_chunk_ms} ms, "
                f"model={done.get('model')}, "
                f"hedge={done.get('correction', {}).get('hedgeStarted')}, "
                f"winner={done.get('correction', {}).get('hedgeWinner')})"
            )
        if end_to_end_ms > MAX_END_TO_END_MS:
            raise RuntimeError(
                f"Voice-to-answer path was too slow: {end_to_end_ms} ms > {MAX_END_TO_END_MS} ms"
            )

        print(
            "OK voice overlay E2E: "
            f"stt={stt_ms}ms upstream={stt_event.get('openaiInferenceMs')}ms "
            f"first_chunk={first_chunk_ms}ms llm_total={llm_total_ms}ms "
            f"voice_to_first_chunk={voice_to_first_chunk_ms}ms "
            f"end_to_end={end_to_end_ms}ms model={done.get('model')} "
            f"hedge={done.get('correction', {}).get('hedgeStarted')} "
            f"winner={done.get('correction', {}).get('hedgeWinner')}"
        )
        print(f"Transcript: {transcript}")
        print(f"Answer: {answer}")
        return 0
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        db_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
