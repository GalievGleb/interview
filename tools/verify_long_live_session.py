"""Installed-Dev soak: keep one interview alive across the Realtime hour boundary.

The verifier sends only short, checked voice fixtures at explicit checkpoints.
Between them it mirrors an open desktop capture with quiet PCM frames, exercises
the same local STT WebSocket and SSE answer endpoint, and emits a privacy-safe
JSON report without credentials, transcripts, answers, or audio.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
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
from typing import Any

import websockets

try:
    from tools.dev_e2e_identity import seed_installed_gateway_identity
except ModuleNotFoundError:  # direct `python tools/verify_long_live_session.py`
    from dev_e2e_identity import seed_installed_gateway_identity

LIVE_SAMPLE_RATE = 16_000
DEFAULT_DURATION_MINUTES = 95.0
DEFAULT_CHECKPOINTS = "0,30,61,91"
KEEPALIVE_SECONDS = 5.0
HEARTBEAT_SECONDS = 5 * 60.0
MAX_STT_MS = 6_000
MAX_LLM_FIRST_CHUNK_MS = 5_000
MAX_VOICE_TO_FIRST_CHUNK_MS = 4_000
E2E_CANDIDATE_CONTEXT = (
    "QA Automation Engineer. Основной стек: Python, pytest, Playwright, REST API, "
    "Allure и CI/CD. Поддерживал UI- и API-автотесты, фикстуры pytest, "
    "Page Object и диагностику нестабильных тестов в пайплайне."
)


def parse_checkpoint_minutes(raw: str, *, duration_minutes: float) -> tuple[float, ...]:
    if not raw.strip() or not (duration_minutes > 0):
        raise ValueError("Soak duration and checkpoints must be positive")
    try:
        values = tuple(float(part.strip()) for part in raw.split(","))
    except ValueError as exc:
        raise ValueError("Checkpoint minutes must be numbers") from exc
    if (
        not values
        or any(value < 0 or value > duration_minutes for value in values)
        or len(set(values)) != len(values)
        or tuple(sorted(values)) != values
    ):
        raise ValueError("Checkpoints must be unique, sorted, and inside the soak")
    return values


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _installed_backend() -> Path:
    return (
        Path(os.environ["LOCALAPPDATA"])
        / "Programs"
        / "skillcue-dev"
        / "resources"
        / "backend"
        / "skillcue-backend.exe"
    )


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
    raise RuntimeError("The isolated installed-Dev backend did not start")


def _load_cases() -> list[dict[str, Any]]:
    return json.loads((_repo_root() / "tests" / "voice" / "cases.json").read_text("utf-8"))


def _read_pcm(path: Path) -> tuple[int, bytes]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise RuntimeError(f"Voice fixture is not mono PCM16: {path.name}")
        return audio.getframerate(), audio.readframes(audio.getnframes())


def _resample_pcm16_mono(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate:
        return pcm
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    ratio = from_rate / to_rate
    output = array("h")
    for index in range(max(1, round(len(samples) / ratio))):
        position = index * ratio
        left = int(position)
        right = min(left + 1, len(samples) - 1)
        fraction = position - left
        value = round(samples[left] * (1 - fraction) + samples[right] * fraction)
        output.append(max(-32_768, min(32_767, value)))
    if sys.byteorder != "little":
        output.byteswap()
    return output.tobytes()


def _matches(text: str, groups: list[dict[str, Any]]) -> list[str]:
    normalized = text.casefold()
    return [
        str(group["key"])
        for group in groups
        if any(str(alias).casefold() in normalized for alias in group["aliases"])
    ]


async def _send_pcm(ws, pcm: bytes, sample_rate: int) -> None:
    frame_bytes = max(2, sample_rate * 2 // 10)
    for offset in range(0, len(pcm), frame_bytes):
        await ws.send(pcm[offset : offset + frame_bytes])
        await asyncio.sleep(0)


def _working_set_bytes(pid: int) -> int | None:
    if os.name != "nt":
        return None
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"(Get-Process -Id {pid} -ErrorAction Stop).WorkingSet64",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return int(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _ask_overlay(port: int, token: str, question: str, case: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "question": question,
        "raw_question": question,
        "candidate_context": E2E_CANDIDATE_CONTEXT,
        "mode": "fast",
        "fast_answer": True,
        "answer_language": "ru",
    }
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
    done: dict[str, Any] | None = None
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
            elif event.get("type") == "done":
                done = event
    answer = str((done or {}).get("spoken") or "".join(chunks)).strip()
    if first_chunk_ms is None or done is None:
        raise RuntimeError("Overlay answer stream was incomplete")
    matched = _matches(answer, case["requiredAnswerKeywords"])
    if len(matched) < 3:
        raise RuntimeError(
            f"Answer semantic check failed for {case['id']}: matched={matched}"
        )
    return {
        "first_chunk_ms": first_chunk_ms,
        "total_ms": round((time.monotonic() - started) * 1000),
        "model": done.get("model"),
        "matched_answer_concepts": matched,
    }


async def _event_reader(ws, queue: asyncio.Queue[dict[str, Any]]) -> None:
    try:
        async for raw in ws:
            await queue.put(json.loads(str(raw)))
    except Exception as exc:  # noqa: BLE001 - surfaced through the verifier queue
        await queue.put({"type": "transport_closed", "message": type(exc).__name__})


async def _next_event(
    queue: asyncio.Queue[dict[str, Any]],
    *,
    deadline: float,
) -> dict[str, Any]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Timed out waiting for STT")
    return await asyncio.wait_for(queue.get(), timeout=remaining)


async def _exercise_checkpoint(
    ws,
    queue: asyncio.Queue[dict[str, Any]],
    *,
    case: dict[str, Any],
    port: int,
    token: str,
    elapsed_minutes: float,
) -> dict[str, Any]:
    source_rate, source_pcm = _read_pcm(_repo_root() / str(case["audioFile"]))
    pcm = _resample_pcm16_mono(source_pcm, source_rate, LIVE_SAMPLE_RATE)
    await _send_pcm(ws, pcm, LIVE_SAMPLE_RATE)
    await asyncio.sleep(0.1)
    request_id = f"soak-{uuid.uuid4().hex}"
    started = time.monotonic()
    await ws.send(json.dumps({"type": "finalize", "request_id": request_id}))
    ready_events = 0
    while True:
        event = await _next_event(queue, deadline=started + 18)
        event_type = event.get("type")
        if event_type == "ready":
            ready_events += 1
            continue
        if event_type in {"error", "transport_closed", "transcription_error"}:
            raise RuntimeError(f"STT failed at {elapsed_minutes:.1f} min: {event}")
        if event_type == "low_quality":
            raise RuntimeError(
                f"STT quality gate rejected {case['id']} at {elapsed_minutes:.1f} min"
            )
        if event_type != "transcript":
            continue
        transcript = str(event.get("text") or "").strip()
        matched = _matches(transcript, case["requiredTranscriptKeywords"])
        if len(matched) < 3:
            raise RuntimeError(
                f"Transcript semantic check failed for {case['id']}: matched={matched}"
            )
        stt_ms = round((time.monotonic() - started) * 1000)
        answer = await asyncio.to_thread(_ask_overlay, port, token, transcript, case)
        if stt_ms > MAX_STT_MS:
            raise RuntimeError(f"STT exceeded {MAX_STT_MS} ms at {elapsed_minutes:.1f} min")
        if answer["first_chunk_ms"] > MAX_LLM_FIRST_CHUNK_MS:
            raise RuntimeError(
                f"LLM first chunk exceeded {MAX_LLM_FIRST_CHUNK_MS} ms at "
                f"{elapsed_minutes:.1f} min"
            )
        if stt_ms + answer["first_chunk_ms"] > MAX_VOICE_TO_FIRST_CHUNK_MS:
            raise RuntimeError(
                f"Voice-to-first-chunk exceeded {MAX_VOICE_TO_FIRST_CHUNK_MS} ms at "
                f"{elapsed_minutes:.1f} min"
            )
        return {
            "elapsed_minutes": round(elapsed_minutes, 3),
            "case": case["id"],
            "stt_ms": stt_ms,
            "stt_upstream_ms": event.get("openaiInferenceMs"),
            "llm_first_chunk_ms": answer["first_chunk_ms"],
            "llm_total_ms": answer["total_ms"],
            "model": answer["model"],
            "matched_transcript_concepts": matched,
            "matched_answer_concepts": answer["matched_answer_concepts"],
            "ready_events_during_probe": ready_events,
        }


async def _run_soak(
    *,
    port: int,
    token: str,
    process: subprocess.Popen,
    duration_minutes: float,
    checkpoints: tuple[float, ...],
) -> dict[str, Any]:
    cases = _load_cases()
    if len(cases) < len(checkpoints):
        raise RuntimeError("Not enough distinct voice fixtures for the soak checkpoints")
    query = urllib.parse.urlencode(
        {"language": "ru", "sample_rate": LIVE_SAMPLE_RATE, "token": token}
    )
    url = f"ws://127.0.0.1:{port}/stt/stream?{query}"
    results: list[dict[str, Any]] = []
    ready_count = 0
    memory_samples: list[dict[str, Any]] = []

    async with websockets.connect(
        url,
        open_timeout=12,
        close_timeout=3,
        ping_interval=20,
        ping_timeout=20,
        max_size=1_048_576,
    ) as ws:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        reader = asyncio.create_task(_event_reader(ws, queue))
        try:
            startup = await _next_event(queue, deadline=time.monotonic() + 15)
            if startup.get("type") != "ready":
                raise RuntimeError(f"STT did not become ready: {startup}")
            ready_count = 1
            started = time.monotonic()
            next_keepalive = started
            next_heartbeat = started + HEARTBEAT_SECONDS
            checkpoint_index = 0
            end_at = started + duration_minutes * 60

            while time.monotonic() < end_at:
                now = time.monotonic()
                elapsed_minutes = (now - started) / 60
                while checkpoint_index < len(checkpoints) and elapsed_minutes >= checkpoints[checkpoint_index]:
                    result = await _exercise_checkpoint(
                        ws,
                        queue,
                        case=cases[checkpoint_index],
                        port=port,
                        token=token,
                        elapsed_minutes=elapsed_minutes,
                    )
                    result["working_set_bytes"] = _working_set_bytes(process.pid)
                    results.append(result)
                    print(
                        "SOAK checkpoint "
                        f"{checkpoint_index + 1}/{len(checkpoints)} "
                        f"at {elapsed_minutes:.2f}m: stt={result['stt_ms']}ms "
                        f"first={result['llm_first_chunk_ms']}ms "
                        f"model={result['model']}",
                        flush=True,
                    )
                    checkpoint_index += 1
                    now = time.monotonic()
                    elapsed_minutes = (now - started) / 60

                if now >= next_keepalive:
                    await ws.send(b"\0\0" * (LIVE_SAMPLE_RATE // 10))
                    next_keepalive = now + KEEPALIVE_SECONDS

                while not queue.empty():
                    event = queue.get_nowait()
                    if event.get("type") == "ready":
                        ready_count += 1
                    elif event.get("type") in {"error", "transport_closed"}:
                        raise RuntimeError(f"Background STT failure: {event}")

                if now >= next_heartbeat:
                    sample = {
                        "elapsed_minutes": round(elapsed_minutes, 3),
                        "working_set_bytes": _working_set_bytes(process.pid),
                    }
                    memory_samples.append(sample)
                    print(
                        f"SOAK alive at {elapsed_minutes:.1f}m; "
                        f"ready_events={ready_count}; working_set={sample['working_set_bytes']}",
                        flush=True,
                    )
                    next_heartbeat = now + HEARTBEAT_SECONDS
                await asyncio.sleep(min(0.5, max(0.05, end_at - now)))

            if checkpoint_index != len(checkpoints):
                raise RuntimeError(
                    f"Only {checkpoint_index}/{len(checkpoints)} checkpoints ran"
                )
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    return {
        "ok": True,
        "requested_duration_minutes": duration_minutes,
        "actual_duration_minutes": round((time.monotonic() - started) / 60, 3),
        "checkpoints": results,
        "ready_events": ready_count,
        "memory_samples": memory_samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-minutes", type=float, default=DEFAULT_DURATION_MINUTES)
    parser.add_argument("--checkpoint-minutes", default=DEFAULT_CHECKPOINTS)
    parser.add_argument(
        "--report",
        type=Path,
        default=_repo_root() / "output" / "soak" / "long-live-session.json",
    )
    args = parser.parse_args()
    checkpoints = parse_checkpoint_minutes(
        args.checkpoint_minutes,
        duration_minutes=args.duration_minutes,
    )
    backend = _installed_backend()
    if not backend.exists():
        raise RuntimeError(f"Installed SkillCue Dev backend was not found: {backend}")

    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-long-soak-{token}.sqlite"
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
    started_at = time.time()
    try:
        _wait_for_health(port, time.monotonic() + 15)
        report = asyncio.run(
            _run_soak(
                port=port,
                token=token,
                process=process,
                duration_minutes=args.duration_minutes,
                checkpoints=checkpoints,
            )
        )
        report.update(
            {
                "started_at_epoch": round(started_at),
                "finished_at_epoch": round(time.time()),
                "backend_exit_code": process.poll(),
            }
        )
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
        print(f"OK long live soak: {args.report}", flush=True)
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
