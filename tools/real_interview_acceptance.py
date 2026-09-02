#!/usr/bin/env python3
"""Privacy-safe acceptance runner for real SkillCue interview excerpts.

The runner uses the installed SkillCue Dev backend. Private media, transcripts,
answers, and absolute paths are deliberately excluded from persisted reports.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import os
import re
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
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Self

import websockets

try:
    from dev_e2e_identity import seed_installed_gateway_identity
except ModuleNotFoundError:  # imported as tools.real_interview_acceptance in pytest
    from tools.dev_e2e_identity import seed_installed_gateway_identity


class ManifestError(ValueError):
    """Raised when a private acceptance manifest is unsafe or incomplete."""


class AcceptanceRuntimeError(RuntimeError):
    """A stable, privacy-safe execution failure."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        super().__init__(detail or code)


LIVE_SAMPLE_RATE = 16_000
DEFAULT_EVENT_TIMEOUT_S = 20.0
_NULL_KEYRING_BACKEND = "keyring.backends.null.Keyring"
_MANAGED_DEV_GATEWAY_URL = "https://skill-cue.ru/v1"
_MAX_REPORT_SEQUENCE_ITEMS = 64
_MAX_MANIFEST_CASES = 64
_MAX_CASE_REPETITIONS = 10
_MAX_REPORT_ATTEMPTS = 256

_SAFE_MODEL_IDS = frozenset(
    {
        "unknown",
        "gpt-4o-mini-transcribe",
        "openai-gpt-4o-mini-transcribe",
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "openai/gpt-4.1",
        "openai/gpt-4.1-mini",
        "openai/gpt-4.1-nano",
        "openai/gpt-5.6-sol",
        "qwen/qwen3.5-flash-02-23",
        "qwen/qwen3.8-flash",
        "google/gemini-2.0-flash-001",
        "google/gemini-3.5-flash",
    }
)
_SOURCE_HASH = re.compile(r"sha256:[0-9a-f]{6,64}", re.IGNORECASE)
_HASHED_IDENTIFIER = re.compile(r"sha256:[0-9a-f]{16}", re.IGNORECASE)
_SAFE_QUESTION_INTENTS = frozenset(
    {
        "experience",
        "technical_definition",
        "technical_list",
        "technical_comparison",
        "technical_task",
        "api_test_task",
        "practical_usage",
        "behavioral",
        "unclear",
    }
)
_SAFE_ANSWER_SOURCES = frozenset(
    {
        "auto",
        "manual",
        "fast_core_accuracy",
        "fast_core_default",
        "fast_core_latency_hedge",
        "fast_core_reliability_fallback",
    }
)
_SAFE_HEDGE_WINNERS = frozenset({"primary", "fallback"})
_SAFE_STT_EVENT_TYPES = frozenset(
    {
        "speech_started",
        "transcript",
        "utterance_end",
        "force_empty",
        "low_quality",
        "transcription_error",
        "error",
        "ready",
    }
)
_SAFE_FAILURE_CODES = frozenset(
    {
        "transcript_semantics",
        "empty_terminal_answer",
        "answer_semantics",
        "stt_budget",
        "first_chunk_budget",
        "trigger_to_first_answer_budget",
        "total_budget",
        "backend_health_timeout",
        "installed_backend_missing",
        "localappdata_missing",
        "model_first_chunk_missing",
        "model_http_error",
        "model_network_error",
        "model_stream_error",
        "model_stream_incomplete",
        "screen_fixture_format",
        "stt_empty_transcript",
        "stt_finalize_timeout",
        "stt_low_quality",
        "stt_ready_timeout",
        "stt_startup_error",
        "stt_transcription_error",
        "stt_error",
        "stt_socket_closed",
        "voice_fixture_channel_count",
        "voice_fixture_empty",
        "voice_fixture_invalid_wav",
        "voice_fixture_not_pcm16",
        "unexpected_runtime_error",
    }
)


_LATENCY_FIELDS = (
    "sttMs",
    "firstChunkMs",
    "triggerToFirstAnswerMs",
    "totalMs",
)


def nearest_rank_percentile(
    values: Sequence[int | float], percentile: int
) -> int | float:
    """Return the nearest-rank percentile used by the acceptance gate."""
    if not values:
        raise ValueError("Percentile requires at least one value")
    if not 0 < percentile <= 100:
        raise ValueError("Percentile must be in the interval (0, 100]")
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile / 100 * len(ordered)))
    return ordered[rank - 1]


def _require_non_empty_string(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ManifestError(f"{label} must be a non-empty string")
    return text


def _normalize_concepts(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise ManifestError(f"{label} must contain at least one concept")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ManifestError(f"{label}[{index}] must be an object")
        key = _require_non_empty_string(raw.get("key"), f"{label}[{index}].key")
        aliases = raw.get("aliases")
        if not isinstance(aliases, list) or not aliases:
            raise ManifestError(f"{label}[{index}].aliases must not be empty")
        normalized.append(
            {
                "key": key,
                "aliases": [
                    _require_non_empty_string(alias, f"{label}[{index}].aliases")
                    for alias in aliases
                ],
            }
        )
    return normalized


def _resolve_source(raw_source: Any, manifest_dir: Path, case_id: str) -> Path:
    source_text = _require_non_empty_string(raw_source, f"case {case_id} source")
    source = Path(source_text).expanduser()
    if not source.is_absolute():
        source = manifest_dir / source
    source = source.resolve()
    if not source.is_file():
        raise ManifestError(f"Media for case {case_id} does not exist")
    return source


def validate_manifest(data: Any, manifest_dir: Path) -> dict[str, Any]:
    """Validate a local manifest and resolve media paths for in-memory use only."""
    if not isinstance(data, dict):
        raise ManifestError("Manifest must be an object")
    if data.get("version") != 1:
        raise ManifestError("Manifest version must be 1")
    raw_cases = data.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ManifestError("Manifest must contain at least one case")
    if len(raw_cases) > _MAX_MANIFEST_CASES:
        raise ManifestError(
            f"Manifest must contain at most {_MAX_MANIFEST_CASES} cases"
        )

    seen_ids: set[str] = set()
    cases: list[dict[str, Any]] = []
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict):
            raise ManifestError(f"cases[{index}] must be an object")
        case_id = _require_non_empty_string(raw_case.get("id"), f"cases[{index}].id")
        if case_id in seen_ids:
            raise ManifestError(f"Duplicate case id: {case_id}")
        seen_ids.add(case_id)

        kind = _require_non_empty_string(raw_case.get("kind"), f"case {case_id} kind")
        if kind not in {"voice", "screen"}:
            raise ManifestError(f"Unsupported case kind for {case_id}: {kind}")
        source = _resolve_source(raw_case.get("source"), manifest_dir, case_id)
        expected_answer = _normalize_concepts(
            raw_case.get("expectedAnswer"), f"case {case_id}.expectedAnswer"
        )
        expected_transcript: list[dict[str, Any]] = []
        if kind == "voice":
            expected_transcript = _normalize_concepts(
                raw_case.get("expectedTranscript"),
                f"case {case_id}.expectedTranscript",
            )

        budgets = raw_case.get("budgets")
        if not isinstance(budgets, dict):
            raise ManifestError(f"case {case_id}.budgets must be an object")
        required_budget_fields = {"firstChunkMs", "totalMs"}
        if kind == "voice":
            required_budget_fields.update({"sttMs", "triggerToFirstAnswerMs"})
        normalized_budgets: dict[str, int] = {}
        for field in required_budget_fields:
            value = budgets.get(field)
            if not isinstance(value, int) or value <= 0:
                raise ManifestError(f"case {case_id}.budgets.{field} must be positive")
            normalized_budgets[field] = value

        min_answer_matches = int(raw_case.get("minAnswerMatches", 1))
        min_transcript_matches = int(raw_case.get("minTranscriptMatches", 1))
        if not 1 <= min_answer_matches <= len(expected_answer):
            raise ManifestError(f"case {case_id}.minAnswerMatches is out of range")
        if kind == "voice" and not 1 <= min_transcript_matches <= len(
            expected_transcript
        ):
            raise ManifestError(f"case {case_id}.minTranscriptMatches is out of range")

        normalized = dict(raw_case)
        normalized.update(
            {
                "id": case_id,
                "kind": kind,
                "source": source,
                "expectedAnswer": expected_answer,
                "expectedTranscript": expected_transcript,
                "minAnswerMatches": min_answer_matches,
                "minTranscriptMatches": min_transcript_matches,
                "budgets": normalized_budgets,
                "repetitions": int(
                    raw_case.get("repetitions", data.get("repetitions", 1))
                ),
            }
        )
        if normalized["repetitions"] <= 0:
            raise ManifestError(f"case {case_id}.repetitions must be positive")
        if normalized["repetitions"] > _MAX_CASE_REPETITIONS:
            raise ManifestError(
                f"case {case_id} must use at most {_MAX_CASE_REPETITIONS} repetitions"
            )
        if kind == "screen":
            normalized["question"] = _require_non_empty_string(
                raw_case.get("question"), f"case {case_id}.question"
            )
            normalized["context"] = str(raw_case.get("context") or "").strip()
        cases.append(normalized)

    return {
        "version": 1,
        "suite": str(data.get("suite") or "real-interview-acceptance").strip(),
        "cases": cases,
    }


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise ManifestError("Manifest does not exist") from exc
    except json.JSONDecodeError as exc:
        raise ManifestError("Manifest is not valid JSON") from exc
    return validate_manifest(data, path.parent.resolve())


def match_concepts(text: str, concepts: Iterable[dict[str, Any]]) -> list[str]:
    normalized = text.casefold()
    return [
        str(group["key"])
        for group in concepts
        if any(str(alias).casefold() in normalized for alias in group["aliases"])
    ]


def pcm_frames(pcm: bytes, sample_rate: int, *, frame_ms: int = 100) -> Iterable[bytes]:
    """Split mono PCM16 into the same fixed-duration chunks sent by desktop capture."""
    if sample_rate <= 0 or frame_ms <= 0:
        raise ValueError("sample_rate and frame_ms must be positive")
    frame_bytes = max(2, sample_rate * 2 * frame_ms // 1000)
    for offset in range(0, len(pcm), frame_bytes):
        yield pcm[offset : offset + frame_bytes]


def pcm_duration_seconds(pcm: bytes, sample_rate: int) -> float:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    return len(pcm) / (sample_rate * 2)


def silence_pcm(duration_ms: int, *, sample_rate: int) -> bytes:
    if duration_ms < 0 or sample_rate <= 0:
        raise ValueError(
            "duration_ms must be non-negative and sample_rate must be positive"
        )
    return b"\0\0" * (sample_rate * duration_ms // 1000)


def _fragment_tokens(text: str) -> list[str]:
    return re.findall(r"[\w+-]+", text.casefold(), flags=re.UNICODE)


def merge_transcript_fragments(fragments: Iterable[str]) -> str:
    """Merge pause-split finals while replacing partial-prefix refinements."""
    merged = ""
    merged_tokens: list[str] = []
    for raw_fragment in fragments:
        fragment = str(raw_fragment or "").strip()
        if not fragment:
            continue
        fragment_tokens = _fragment_tokens(fragment)
        if not fragment_tokens:
            continue
        if not merged:
            merged = fragment
            merged_tokens = fragment_tokens
            continue
        if fragment_tokens == merged_tokens or (
            len(fragment_tokens) <= len(merged_tokens)
            and merged_tokens[-len(fragment_tokens) :] == fragment_tokens
        ):
            continue
        if (
            len(merged_tokens) <= len(fragment_tokens)
            and fragment_tokens[: len(merged_tokens)] == merged_tokens
        ):
            merged = fragment
            merged_tokens = fragment_tokens
            continue

        overlap = 0
        for width in range(min(len(merged_tokens), len(fragment_tokens)), 0, -1):
            if merged_tokens[-width:] == fragment_tokens[:width]:
                overlap = width
                break
        if overlap:
            fragment_words = fragment.split()
            suffix = " ".join(fragment_words[overlap:]).strip()
            if suffix:
                merged = f"{merged.rstrip(' ,;:.!?')} {suffix}"
            merged_tokens.extend(fragment_tokens[overlap:])
            continue
        merged = f"{merged.rstrip()} {fragment}"
        merged_tokens.extend(fragment_tokens)
    return merged.strip()


def voice_timings(
    *, stt_ms: int, first_chunk_ms: int, llm_total_ms: int
) -> dict[str, int]:
    """Measure response budgets from the explicit Ctrl+Enter trigger."""
    return {
        "sttMs": stt_ms,
        "firstChunkMs": first_chunk_ms,
        "triggerToFirstAnswerMs": stt_ms + first_chunk_ms,
        "totalMs": stt_ms + llm_total_ms,
    }


def finalize_request_complete(
    events: Sequence[dict[str, Any]], request_id: str
) -> bool:
    """Mirror the Ctrl+Enter race: force_empty may precede an active id-less final."""
    tagged_terminal = any(
        event.get("force_request_id") == request_id
        and event.get("type") in {"transcript", "low_quality", "transcription_error"}
        for event in events
    )
    if tagged_terminal:
        return True
    force_empty_index = next(
        (
            index
            for index, event in enumerate(events)
            if event.get("type") == "force_empty"
            and event.get("force_request_id") == request_id
        ),
        None,
    )
    if force_empty_index is None:
        return False
    pending_speech = 0
    for event in events:
        if event.get("type") == "speech_started":
            pending_speech += 1
        elif event.get("type") in {"transcript", "low_quality", "transcription_error"}:
            pending_speech = max(0, pending_speech - 1)
    return pending_speech == 0


def evaluate_attempt(
    case: dict[str, Any],
    *,
    transcript: str,
    answer: str,
    timings: dict[str, int],
    model: str,
    repetition: int = 1,
) -> dict[str, Any]:
    """Evaluate one raw run. Raw content is kept in memory and stripped on report write."""
    failures: list[str] = []
    matched_transcript = match_concepts(transcript, case.get("expectedTranscript", []))
    matched_answer = match_concepts(answer, case["expectedAnswer"])
    if (
        case["kind"] == "voice"
        and len(matched_transcript) < case["minTranscriptMatches"]
    ):
        failures.append("transcript_semantics")
    if not answer.strip():
        failures.append("empty_terminal_answer")
    elif len(matched_answer) < case["minAnswerMatches"]:
        failures.append("answer_semantics")

    budget_failures = {
        "sttMs": "stt_budget",
        "firstChunkMs": "first_chunk_budget",
        "triggerToFirstAnswerMs": "trigger_to_first_answer_budget",
        "totalMs": "total_budget",
    }
    for field, budget in case["budgets"].items():
        value = timings.get(field)
        if value is None or value > budget:
            failures.append(budget_failures[field])

    return {
        "caseId": case["id"],
        "kind": case["kind"],
        "repetition": repetition,
        "passed": not failures,
        "source": str(case["source"]),
        "sourceHash": source_hash(case["source"]),
        "transcript": transcript,
        "answer": answer,
        "matchedTranscriptKeys": matched_transcript,
        "matchedAnswerKeys": matched_answer,
        **timings,
        "model": model,
        "failures": failures,
    }


def source_hash(path: Path) -> str:
    """Return a stable content identity without exposing the media path."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _installed_backend_path() -> Path:
    override = os.environ.get("SKILLCUE_ACCEPTANCE_BACKEND", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if not local_app_data:
        raise AcceptanceRuntimeError("localappdata_missing")
    return (
        Path(local_app_data)
        / "Programs"
        / "skillcue-dev"
        / "resources"
        / "backend"
        / "skillcue-backend.exe"
    )


def backend_launch_spec(
    *, source_backend: bool, port: int, root: Path | None = None
) -> tuple[list[str], Path | None]:
    """Select the current source API or the installed executable without starting it."""
    repo_root = root or Path(__file__).resolve().parents[1]
    if source_backend:
        api_root = repo_root / "apps" / "api-py"
        return (
            [
                str(api_root / ".venv" / "Scripts" / "python.exe"),
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            api_root,
        )
    return [str(_installed_backend_path())], None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_health(port: int, timeout_s: float = 15.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health", timeout=1
            ) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.15)
    raise AcceptanceRuntimeError("backend_health_timeout")


@dataclass
class InstalledBackendSession:
    """Isolated installed backend process using the installed Dev gateway identity."""

    port: int = 0
    token: str = ""
    process: subprocess.Popen[bytes] | None = None
    db_path: Path | None = None
    source_backend: bool = False

    def __enter__(self) -> Self:
        if not self.source_backend and not _installed_backend_path().is_file():
            raise AcceptanceRuntimeError("installed_backend_missing")
        self.port = _free_port()
        self.token = uuid.uuid4().hex
        self.db_path = (
            Path(tempfile.gettempdir()) / f"skillcue-real-interview-{self.token}.sqlite"
        )
        seed_installed_gateway_identity(self.db_path)
        env = {
            **os.environ,
            "SKILLCUE_PORT": str(self.port),
            "SKILLCUE_API_TOKEN": self.token,
            "SKILLCUE_BUILD_CHANNEL": "dev",
            "SKILLCUE_GATEWAY_URL": _MANAGED_DEV_GATEWAY_URL,
            "DATABASE_URL": f"sqlite:///{self.db_path.as_posix()}",
        }
        if self.source_backend:
            env.update(
                {
                    "OPENAI_API_KEY": "",
                    "OPENROUTER_API_KEY": "",
                    "PYTHON_KEYRING_BACKEND": _NULL_KEYRING_BACKEND,
                    "SKILLCUE_GATEWAY_URL": _MANAGED_DEV_GATEWAY_URL,
                }
            )
        command, cwd = backend_launch_spec(
            source_backend=self.source_backend,
            port=self.port,
        )
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            _wait_for_health(self.port)
        except Exception:
            self.close()
            raise
        return self

    def close(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None
        if self.db_path is not None:
            for _ in range(10):
                try:
                    self.db_path.unlink(missing_ok=True)
                    break
                except PermissionError:
                    time.sleep(0.2)
        self.db_path = None

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


def _read_pcm16(path: Path) -> tuple[int, bytes]:
    try:
        with wave.open(str(path), "rb") as audio:
            if audio.getsampwidth() != 2 or audio.getcomptype() != "NONE":
                raise AcceptanceRuntimeError("voice_fixture_not_pcm16")
            channels = audio.getnchannels()
            if channels not in {1, 2}:
                raise AcceptanceRuntimeError("voice_fixture_channel_count")
            sample_rate = audio.getframerate()
            pcm = audio.readframes(audio.getnframes())
    except (EOFError, wave.Error) as exc:
        raise AcceptanceRuntimeError("voice_fixture_invalid_wav") from exc
    if channels == 1:
        return sample_rate, pcm
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    mono = array("h")
    for offset in range(0, len(samples) - 1, 2):
        mono.append(round((samples[offset] + samples[offset + 1]) / 2))
    if sys.byteorder != "little":
        mono.byteswap()
    return sample_rate, mono.tobytes()


def _resample_pcm16_mono(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    """Mirror the desktop's linear 16 kHz resampler."""
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


async def _receive_stt_events(
    ws: Any, events: list[dict[str, Any]], changed: asyncio.Event
) -> None:
    try:
        while True:
            raw = await ws.recv()
            event = json.loads(str(raw))
            event["_receivedAt"] = time.monotonic()
            events.append(event)
            changed.set()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - receiver converts transport closure to state
        events.append(
            {
                "type": "runner_socket_closed",
                "_receivedAt": time.monotonic(),
                "_exception": type(exc).__name__,
            }
        )
        changed.set()


async def _wait_for_stt_ready(ws: Any) -> dict[str, Any]:
    deadline = time.monotonic() + 15
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AcceptanceRuntimeError("stt_ready_timeout")
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except TimeoutError as exc:
            raise AcceptanceRuntimeError("stt_ready_timeout") from exc
        event = json.loads(str(raw))
        if event.get("type") == "error":
            raise AcceptanceRuntimeError("stt_startup_error")
        if event.get("type") == "ready":
            return event


def _stt_transport_failure(events: Sequence[dict[str, Any]]) -> str | None:
    if any(event.get("type") == "error" for event in events):
        return "stt_error"
    if any(event.get("type") == "runner_socket_closed" for event in events):
        return "stt_socket_closed"
    return None


async def replay_voice_transcript(
    port: int,
    token: str,
    case: dict[str, Any],
) -> tuple[str, int, dict[str, Any]]:
    """Replay a private WAV at 1x through the installed STT WebSocket."""
    source_rate, source_pcm = _read_pcm16(case["source"])
    pcm = _resample_pcm16_mono(source_pcm, source_rate, LIVE_SAMPLE_RATE)
    if not pcm:
        raise AcceptanceRuntimeError("voice_fixture_empty")
    query = urllib.parse.urlencode(
        {
            "language": str(case.get("language") or "ru"),
            "sample_rate": LIVE_SAMPLE_RATE,
            "token": token,
        }
    )
    url = f"ws://127.0.0.1:{port}/stt/stream?{query}"
    events: list[dict[str, Any]] = []
    changed = asyncio.Event()

    async with websockets.connect(url, open_timeout=10, close_timeout=2) as ws:
        ready = await _wait_for_stt_ready(ws)
        receiver = asyncio.create_task(_receive_stt_events(ws, events, changed))
        try:
            for frame in pcm_frames(pcm, LIVE_SAMPLE_RATE, frame_ms=100):
                await ws.send(frame)
                await asyncio.sleep(pcm_duration_seconds(frame, LIVE_SAMPLE_RATE))

            finalize_delay_ms = int(case.get("finalizeDelayMs", 100))
            if finalize_delay_ms > 0:
                post_roll = silence_pcm(finalize_delay_ms, sample_rate=LIVE_SAMPLE_RATE)
                for frame in pcm_frames(post_roll, LIVE_SAMPLE_RATE, frame_ms=100):
                    await ws.send(frame)
                    await asyncio.sleep(pcm_duration_seconds(frame, LIVE_SAMPLE_RATE))
            request_id = f"acceptance-{uuid.uuid4().hex}"
            trigger_started = time.monotonic()
            await ws.send(json.dumps({"type": "finalize", "request_id": request_id}))
            timeout_s = max(
                DEFAULT_EVENT_TIMEOUT_S,
                case["budgets"].get("sttMs", 0) / 1000 + 10,
            )
            deadline = trigger_started + timeout_s

            while not finalize_request_complete(events, request_id):
                failure = _stt_transport_failure(events)
                if failure:
                    raise AcceptanceRuntimeError(failure)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AcceptanceRuntimeError("stt_finalize_timeout")
                changed.clear()
                if finalize_request_complete(events, request_id):
                    break
                try:
                    await asyncio.wait_for(changed.wait(), timeout=remaining)
                except TimeoutError as exc:
                    raise AcceptanceRuntimeError("stt_finalize_timeout") from exc

            transcript_events = [
                event
                for event in events
                if event.get("type") == "transcript"
                and str(event.get("text") or "").strip()
            ]
            if not transcript_events:
                if any(event.get("type") == "transcription_error" for event in events):
                    raise AcceptanceRuntimeError("stt_transcription_error")
                if any(event.get("type") == "low_quality" for event in events):
                    raise AcceptanceRuntimeError("stt_low_quality")
                raise AcceptanceRuntimeError("stt_empty_transcript")
            transcript = merge_transcript_fragments(
                str(event["text"]) for event in transcript_events
            )
            last_transcript_at = max(
                float(event.get("_receivedAt") or trigger_started)
                for event in transcript_events
            )
            stt_ms = max(0, round((last_transcript_at - trigger_started) * 1000))
            metadata = {
                "engine": ready.get("engine"),
                "model": ready.get("model"),
                "openaiInferenceMs": transcript_events[-1].get("openaiInferenceMs"),
                "fragmentCount": len(transcript_events),
                "fragmentArrivalMs": [
                    round(
                        (
                            float(event.get("_receivedAt") or trigger_started)
                            - trigger_started
                        )
                        * 1000
                    )
                    for event in transcript_events
                ],
                "fragmentForced": [
                    bool(event.get("force_request_id")) for event in transcript_events
                ],
                "eventTimeline": [
                    {
                        "type": str(event.get("type") or "unknown"),
                        "arrivalMs": round(
                            (
                                float(event.get("_receivedAt") or trigger_started)
                                - trigger_started
                            )
                            * 1000
                        ),
                        "forced": bool(event.get("force_request_id")),
                        **(
                            {"reason": str(event.get("reason"))}
                            if event.get("reason")
                            else {}
                        ),
                    }
                    for event in events
                    if event.get("type") != "runner_socket_closed"
                ],
            }
            return transcript, stt_ms, metadata
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)


def complete_sse_events(
    events: Sequence[dict[str, Any]], total_ms: int
) -> tuple[str, int, int, dict[str, Any]]:
    if any(event.get("type") == "error" for event in events):
        raise AcceptanceRuntimeError("model_stream_error")
    done = next(
        (event for event in reversed(events) if event.get("type") == "done"),
        None,
    )
    if done is None:
        raise AcceptanceRuntimeError("model_stream_incomplete", "stream did not finish")
    chunks = [
        str(event.get("text") or "") for event in events if event.get("type") == "chunk"
    ]
    answer = str(done.get("spoken") or "".join(chunks)).strip()
    first_chunk_ms = next(
        (
            int(event.get("_elapsedMs") or 0)
            for event in events
            if event.get("type") == "chunk" and str(event.get("text") or "")
        ),
        None,
    )
    if first_chunk_ms is None:
        if answer:
            raise AcceptanceRuntimeError("model_first_chunk_missing")
        first_chunk_ms = total_ms
    return answer, first_chunk_ms, total_ms, done


def _stream_sse(
    request: urllib.request.Request, *, timeout_s: float
) -> tuple[str, int, int, dict[str, Any]]:
    started = time.monotonic()
    events: list[dict[str, Any]] = []
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                event["_elapsedMs"] = round((time.monotonic() - started) * 1000)
                events.append(event)
    except urllib.error.HTTPError as exc:
        raise AcceptanceRuntimeError("model_http_error") from exc
    except urllib.error.URLError as exc:
        raise AcceptanceRuntimeError("model_network_error") from exc
    total_ms = round((time.monotonic() - started) * 1000)
    return complete_sse_events(events, total_ms)


def ask_interview(
    port: int,
    token: str,
    question: str,
    case: dict[str, Any],
) -> tuple[str, int, int, dict[str, Any]]:
    payload: dict[str, Any] = {
        "question": question,
        "raw_question": question,
        "mode": str(case.get("mode") or "fast"),
        "fast_answer": case.get("mode", "fast") == "fast",
        "answer_language": str(case.get("answerLanguage") or "ru"),
        "provider": "openrouter",
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
    return _stream_sse(request, timeout_s=45)


def run_voice_attempt(
    session: InstalledBackendSession,
    case: dict[str, Any],
    repetition: int,
) -> dict[str, Any]:
    transcript, stt_ms, stt_metadata = asyncio.run(
        replay_voice_transcript(session.port, session.token, case)
    )
    answer, first_chunk_ms, llm_total_ms, done = ask_interview(
        session.port, session.token, transcript, case
    )
    attempt = evaluate_attempt(
        case,
        transcript=transcript,
        answer=answer,
        timings=voice_timings(
            stt_ms=stt_ms,
            first_chunk_ms=first_chunk_ms,
            llm_total_ms=llm_total_ms,
        ),
        model=str(done.get("model") or "unknown"),
        repetition=repetition,
    )
    correction = (
        done.get("correction") if isinstance(done.get("correction"), dict) else {}
    )
    attempt.update(
        {
            "sttModel": stt_metadata.get("model"),
            "sttInferenceMs": stt_metadata.get("openaiInferenceMs"),
            "fragmentCount": stt_metadata.get("fragmentCount"),
            "fragmentArrivalMs": stt_metadata.get("fragmentArrivalMs"),
            "fragmentForced": stt_metadata.get("fragmentForced"),
            "sttEventTimeline": stt_metadata.get("eventTimeline"),
            "questionIntent": correction.get("question_intent"),
            "answerSource": done.get("model_source"),
            "answerLatencyMs": correction.get("answerLatencyMs"),
            "hedgeStarted": correction.get("hedgeStarted"),
            "hedgeWinner": correction.get("hedgeWinner"),
        }
    )
    return attempt


def ask_screen(
    port: int,
    token: str,
    case: dict[str, Any],
) -> tuple[str, int, int, dict[str, Any]]:
    source: Path = case["source"]
    mime_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
    mime_type = mime_types.get(source.suffix.casefold())
    if mime_type is None:
        raise AcceptanceRuntimeError("screen_fixture_format")
    image = base64.b64encode(source.read_bytes()).decode("ascii")
    payload: dict[str, Any] = {
        "image": f"data:{mime_type};base64,{image}",
        "question": case["question"],
        "context": case.get("context", ""),
        "mode": str(case.get("mode") or "fast"),
        "answer_language": str(case.get("answerLanguage") or "ru"),
    }
    model = str(case.get("model") or "").strip()
    if model:
        payload["model"] = model
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/chat/screen/stream",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-SkillCue-Token": token,
        },
        method="POST",
    )
    return _stream_sse(request, timeout_s=120)


def run_screen_attempt(
    session: InstalledBackendSession,
    case: dict[str, Any],
    repetition: int,
) -> dict[str, Any]:
    answer, first_chunk_ms, total_ms, done = ask_screen(
        session.port, session.token, case
    )
    attempt = evaluate_attempt(
        case,
        transcript="",
        answer=answer,
        timings={"firstChunkMs": first_chunk_ms, "totalMs": total_ms},
        model=str(done.get("model") or "unknown"),
        repetition=repetition,
    )
    correction = (
        done.get("correction") if isinstance(done.get("correction"), dict) else {}
    )
    attempt.update(
        {
            "questionIntent": correction.get("question_intent"),
            "answerSource": done.get("model_source"),
            "answerLatencyMs": correction.get("answerLatencyMs"),
            "hedgeStarted": correction.get("hedgeStarted"),
            "hedgeWinner": correction.get("hedgeWinner"),
        }
    )
    return attempt


def _runtime_failure_attempt(
    case: dict[str, Any], repetition: int, code: str
) -> dict[str, Any]:
    return {
        "caseId": case["id"],
        "kind": case["kind"],
        "repetition": repetition,
        "passed": False,
        "sourceHash": source_hash(case["source"]),
        "matchedTranscriptKeys": [],
        "matchedAnswerKeys": [],
        "model": "unknown",
        "failures": [code],
    }


def run_acceptance_suite(
    manifest: dict[str, Any],
    *,
    case_ids: set[str] | None = None,
    repetitions_override: int | None = None,
    source_backend: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if (
        repetitions_override is not None
        and not 1 <= repetitions_override <= _MAX_CASE_REPETITIONS
    ):
        raise ManifestError(
            f"Acceptance run must use at most {_MAX_CASE_REPETITIONS} repetitions"
        )
    selected = [
        case for case in manifest["cases"] if case_ids is None or case["id"] in case_ids
    ]
    if not selected:
        raise ManifestError("No selected cases")
    attempts: list[dict[str, Any]] = []
    with InstalledBackendSession(source_backend=source_backend) as session:
        for case in selected:
            repetitions = repetitions_override or case["repetitions"]
            for repetition in range(1, repetitions + 1):
                print(
                    f"RUN {case['id']} [{case['kind']}] "
                    f"repetition {repetition}/{repetitions}",
                    flush=True,
                )
                try:
                    if case["kind"] == "voice":
                        attempt = run_voice_attempt(session, case, repetition)
                    else:
                        attempt = run_screen_attempt(session, case, repetition)
                except AcceptanceRuntimeError as exc:
                    attempt = _runtime_failure_attempt(case, repetition, exc.code)
                except Exception:  # noqa: BLE001 - convert unknown failures to privacy-safe status
                    attempt = _runtime_failure_attempt(
                        case, repetition, "unexpected_runtime_error"
                    )
                attempts.append(attempt)
                latency = attempt.get(
                    "triggerToFirstAnswerMs", attempt.get("firstChunkMs", "-")
                )
                status = "PASS" if attempt["passed"] else "FAIL"
                print(
                    f"{status} {case['id']} repetition={repetition} "
                    f"firstAnswerMs={latency} failures={attempt['failures']}",
                    flush=True,
                )
    return attempts, build_privacy_safe_report(manifest["suite"], attempts)


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay private real-interview cases through installed SkillCue Dev."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--repetitions", type=int)
    parser.add_argument(
        "--source-backend",
        action="store_true",
        help="run the current workspace FastAPI source instead of an installed build",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = _parse_args(argv)
    if args.repetitions is not None and args.repetitions <= 0:
        raise ManifestError("--repetitions must be positive")
    manifest_path = args.manifest.expanduser().resolve()
    manifest = load_manifest(manifest_path)
    attempts, report = run_acceptance_suite(
        manifest,
        case_ids=set(args.case_ids) if args.case_ids else None,
        repetitions_override=args.repetitions,
        source_backend=args.source_backend,
    )
    report_path = (
        args.report.expanduser().resolve()
        if args.report
        else manifest_path.with_name("acceptance-report.json")
    )
    _write_report(report_path, report)
    print(
        f"SUITE {'PASS' if report['summary']['passed'] else 'FAIL'} "
        f"attempts={len(attempts)} failed={report['summary']['failedAttempts']} "
        f"report={report_path}",
        flush=True,
    )
    return 0 if report["summary"]["passed"] else 1


def _latency_summary(
    attempts: Sequence[dict[str, Any]], field: str
) -> dict[str, Any] | None:
    values = [
        attempt[field]
        for attempt in attempts
        if isinstance(attempt.get(field), (int, float))
    ]
    if not values:
        return None
    return {
        "min": min(values),
        "p50": nearest_rank_percentile(values, 50),
        "p95": nearest_rank_percentile(values, 95),
        "max": max(values),
    }


def summarize_attempts(attempts: Sequence[dict[str, Any]]) -> dict[str, Any]:
    failed = [attempt for attempt in attempts if not attempt.get("passed")]
    latency: dict[str, Any] = {}
    for field in _LATENCY_FIELDS:
        summary = _latency_summary(attempts, field)
        if summary is not None:
            label = (
                "triggerToFirstAnswer"
                if field == "triggerToFirstAnswerMs"
                else field[:-2]
            )
            latency[label] = summary
    return {
        "passed": bool(attempts) and not failed,
        "attempts": len(attempts),
        "failedAttempts": len(failed),
        "latencyMs": latency,
    }


def _safe_numeric_metric(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or not math.isfinite(float(value)):
        return None
    return value


def _safe_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _hashed_identifier(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return "unknown"
    if _HASHED_IDENTIFIER.fullmatch(value):
        return value.casefold()
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()
    return f"sha256:{digest[:16]}"


def _safe_model_identifier(value: Any) -> str:
    if isinstance(value, str) and value in _SAFE_MODEL_IDS:
        return value
    return _hashed_identifier(value)


def _safe_enum(value: Any, allowed: frozenset[str]) -> str:
    return value if isinstance(value, str) and value in allowed else "unknown"


def _safe_identifier_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        hashed
        for item in value[:_MAX_REPORT_SEQUENCE_ITEMS]
        if (hashed := _hashed_identifier(item)) != "unknown"
    ]


def _safe_numeric_list(value: Any) -> list[int | float | None]:
    if not isinstance(value, list):
        return []
    return [_safe_numeric_metric(item) for item in value[:_MAX_REPORT_SEQUENCE_ITEMS]]


def _safe_boolean_list(value: Any) -> list[bool]:
    if not isinstance(value, list):
        return []
    return [
        item if isinstance(item, bool) else False
        for item in value[:_MAX_REPORT_SEQUENCE_ITEMS]
    ]


def _safe_stt_event_timeline(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    timeline: list[dict[str, Any]] = []
    for event in value:
        if len(timeline) >= _MAX_REPORT_SEQUENCE_ITEMS:
            break
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if not isinstance(event_type, str) or event_type not in _SAFE_STT_EVENT_TYPES:
            continue
        timeline.append(
            {
                "type": event_type,
                "arrivalMs": _safe_numeric_metric(event.get("arrivalMs")),
                "forced": event.get("forced")
                if isinstance(event.get("forced"), bool)
                else False,
            }
        )
    return timeline


def _safe_attempt(attempt: dict[str, Any]) -> dict[str, Any]:
    kind = attempt.get("kind")
    failures = attempt.get("failures")
    safe: dict[str, Any] = {
        "caseId": _hashed_identifier(attempt.get("caseId")),
        "kind": kind
        if isinstance(kind, str) and kind in {"voice", "screen"}
        else "unknown",
        "repetition": _safe_non_negative_int(attempt.get("repetition")),
        "passed": attempt.get("passed") is True,
        "sourceHash": (
            attempt["sourceHash"]
            if isinstance(attempt.get("sourceHash"), str)
            and _SOURCE_HASH.fullmatch(attempt["sourceHash"])
            else "unknown"
        ),
        "matchedTranscriptKeys": _safe_identifier_list(
            attempt.get("matchedTranscriptKeys")
        ),
        "matchedAnswerKeys": _safe_identifier_list(attempt.get("matchedAnswerKeys")),
        "model": _safe_model_identifier(attempt.get("model")),
        # The backend-reported model is diagnostic metadata, not proof of the
        # managed gateway's actual upstream route.
        "modelVerified": False,
        "failures": [
            code
            for code in failures[:_MAX_REPORT_SEQUENCE_ITEMS]
            if isinstance(code, str) and code in _SAFE_FAILURE_CODES
        ]
        if isinstance(failures, list)
        else ["unexpected_runtime_error"],
    }
    for field in (*_LATENCY_FIELDS, "sttInferenceMs", "answerLatencyMs"):
        if field in attempt:
            safe[field] = _safe_numeric_metric(attempt.get(field))
    if "sttModel" in attempt:
        safe["sttModel"] = _safe_model_identifier(attempt.get("sttModel"))
    if "fragmentCount" in attempt:
        safe["fragmentCount"] = _safe_non_negative_int(attempt.get("fragmentCount"))
    if "fragmentArrivalMs" in attempt:
        safe["fragmentArrivalMs"] = _safe_numeric_list(attempt.get("fragmentArrivalMs"))
    if "fragmentForced" in attempt:
        safe["fragmentForced"] = _safe_boolean_list(attempt.get("fragmentForced"))
    if "sttEventTimeline" in attempt:
        safe["sttEventTimeline"] = _safe_stt_event_timeline(
            attempt.get("sttEventTimeline")
        )
    if "questionIntent" in attempt:
        value = attempt.get("questionIntent")
        safe["questionIntent"] = (
            None if value is None else _safe_enum(value, _SAFE_QUESTION_INTENTS)
        )
    if "answerSource" in attempt:
        value = attempt.get("answerSource")
        safe["answerSource"] = (
            None if value is None else _safe_enum(value, _SAFE_ANSWER_SOURCES)
        )
    if "hedgeWinner" in attempt:
        value = attempt.get("hedgeWinner")
        safe["hedgeWinner"] = (
            None if value is None else _safe_enum(value, _SAFE_HEDGE_WINNERS)
        )
    if "hedgeStarted" in attempt:
        value = attempt.get("hedgeStarted")
        safe["hedgeStarted"] = value if isinstance(value, bool) else None
    return safe


def build_privacy_safe_report(
    suite: str, attempts: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    """Persist only allow-listed metadata; never raw interview/model content."""
    all_safe_attempts = [_safe_attempt(dict(attempt)) for attempt in attempts]
    safe_attempts = all_safe_attempts[:_MAX_REPORT_ATTEMPTS]
    summary = summarize_attempts(all_safe_attempts)
    summary.update(
        {
            "reportedAttempts": len(safe_attempts),
            "omittedAttempts": len(all_safe_attempts) - len(safe_attempts),
        }
    )
    return {
        "schemaVersion": 1,
        "suite": _hashed_identifier(suite),
        "createdAt": datetime.now(UTC).isoformat(),
        "summary": summary,
        "attempts": safe_attempts,
    }


if __name__ == "__main__":
    raise SystemExit(main())
