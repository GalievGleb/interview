"""Installed-Dev soak: keep one interview alive across the Realtime hour boundary.

The verifier sends only short, checked voice fixtures at explicit checkpoints.
Between them it mirrors an open desktop capture with quiet PCM frames, exercises
the same local STT WebSocket and SSE answer endpoint, and emits a privacy-safe
JSON report without credentials, transcripts, answers, or audio.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

try:
    from tools.verify_screen_code_task import (
        _request_screen,
        fixture_trace,
        fixture_trace_is_valid,
        render_code_png,
        render_fixture_order_png,
        render_sql_solution_png,
        sql_code_lines,
    )
except ModuleNotFoundError:  # direct `python tools/verify_long_live_session.py`
    from verify_screen_code_task import (
        _request_screen,
        fixture_trace,
        fixture_trace_is_valid,
        render_code_png,
        render_fixture_order_png,
        render_sql_solution_png,
        sql_code_lines,
    )

try:
    from tools.dev_e2e_identity import seed_installed_gateway_identity
except ModuleNotFoundError:  # direct `python tools/verify_long_live_session.py`
    from dev_e2e_identity import seed_installed_gateway_identity

LIVE_SAMPLE_RATE = 16_000
DEFAULT_DURATION_MINUTES = 95.0
DEFAULT_CHECKPOINTS = "0,30,61,91"
DEFAULT_SCREEN_CHECKPOINTS = "2,62,92"
KEEPALIVE_SECONDS = 5.0
HEARTBEAT_SECONDS = 5 * 60.0
MAX_STT_MS = 6_000
MAX_LLM_FIRST_CHUNK_MS = 5_000
MAX_VOICE_TO_FIRST_CHUNK_MS = 4_000
MAX_SCREEN_TRANSPORT_FIRST_BYTE_MS = 11_000
MAX_SCREEN_FIRST_CHUNK_MS = 30_000
MAX_SCREEN_TOTAL_MS = 60_000
MAX_WORKING_SET_GROWTH_BYTES = 256 * 1024 * 1024
E2E_CANDIDATE_CONTEXT = (
    "QA Automation Engineer. Основной стек: Python, pytest, Playwright, REST API, "
    "Allure и CI/CD. Поддерживал UI- и API-автотесты, фикстуры pytest, "
    "Page Object и диагностику нестабильных тестов в пайплайне."
)
_NULL_KEYRING_BACKEND = "keyring.backends.null.Keyring"
_MANAGED_DEV_GATEWAY_URL = "https://skill-cue.ru/v1"
_STABLE_MODEL_ID = re.compile(
    r"(?:[a-z0-9][a-z0-9._+-]{0,127}|"
    r"[a-z0-9][a-z0-9._-]{0,31}/[a-z0-9][a-z0-9._+-]{0,94}"
    r"(?::[a-z0-9][a-z0-9._-]{0,31})?)",
    re.IGNORECASE,
)
_SECRET_LIKE_MODEL_PREFIXES = ("sk-", "sk_", "bearer-")


class SoakRunFailure(RuntimeError):
    """A verifier failure whose payload is already safe to persist."""

    def __init__(self, report: dict[str, Any]) -> None:
        self.report = report
        codes = report.get("failure_codes") or ["soak_failed"]
        super().__init__(",".join(str(code) for code in codes))


class SttTransportInterrupted(RuntimeError):
    """The one local STT WebSocket stopped before the verifier finished."""


def _safe_numeric_metric(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or not math.isfinite(float(value)):
        return None
    return value


def _safe_model_identifier(value: Any) -> str:
    if (
        isinstance(value, str)
        and not value.casefold().startswith(_SECRET_LIKE_MODEL_PREFIXES)
        and _STABLE_MODEL_ID.fullmatch(value)
    ):
        return value
    return "unknown"


def _count_checkpoint_ready_events(
    current: int,
    checkpoint: dict[str, Any],
) -> int:
    consumed = checkpoint.get("ready_events_during_probe")
    if isinstance(consumed, int) and not isinstance(consumed, bool) and consumed >= 0:
        return current + consumed
    return current


def _stt_connection_report_fields(
    ready_events: int,
    *,
    local_socket_reconnect_count: int = 0,
) -> dict[str, int]:
    safe_ready_events = (
        ready_events
        if isinstance(ready_events, int)
        and not isinstance(ready_events, bool)
        and ready_events >= 0
        else 0
    )
    safe_local_reconnects = (
        local_socket_reconnect_count
        if isinstance(local_socket_reconnect_count, int)
        and not isinstance(local_socket_reconnect_count, bool)
        and local_socket_reconnect_count >= 0
        else 0
    )
    upstream_reconnects = max(0, safe_ready_events - 1)
    return {
        # Backward-compatible aliases remain upstream evidence.
        "ready_events": safe_ready_events,
        "stt_reconnect_count": upstream_reconnects,
        "local_socket_reconnect_count": safe_local_reconnects,
        "upstream_stt_ready_events": safe_ready_events,
        "upstream_stt_reconnect_count": upstream_reconnects,
    }


def _drain_pending_stt_events(
    queue: asyncio.Queue[dict[str, Any]],
    ready_events: int,
) -> tuple[int, list[str]]:
    failures: list[str] = []
    while not queue.empty():
        event = queue.get_nowait()
        event_type = event.get("type")
        if event_type == "ready":
            ready_events += 1
        elif event_type == "transport_closed":
            failures.append("stt_transport_interrupted")
        elif event_type in {"error", "transcription_error"}:
            failures.append("stt_background_failed")
    return ready_events, list(dict.fromkeys(failures))


def stt_continuity_status(*, established: bool, interrupted: bool) -> str:
    if not established:
        return "not_established"
    if interrupted:
        return "interrupted"
    return "continuous_socket"


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


def backend_launch_spec(
    *, source_backend: bool, port: int, root: Path | None = None
) -> tuple[list[str], Path | None]:
    repo_root = root or _repo_root()
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
    return [str(_installed_backend())], None


def build_backend_environment(
    *,
    base_env: dict[str, str],
    port: int,
    token: str,
    database: Path,
    source_backend: bool,
) -> dict[str, str]:
    """Build a hermetic source verifier environment without persisting keys."""
    env = {
        **base_env,
        "SKILLCUE_PORT": str(port),
        "SKILLCUE_API_TOKEN": token,
        "SKILLCUE_BUILD_CHANNEL": "dev",
        "SKILLCUE_GATEWAY_URL": _MANAGED_DEV_GATEWAY_URL,
        "DATABASE_URL": f"sqlite:///{database.as_posix()}",
    }
    if source_backend:
        # The verifier must not silently prefer the owner's keyring BYOK over
        # the managed gateway. An explicitly inherited direct OpenAI key stays
        # in memory for the opt-in screen route and is never written to disk.
        env["OPENROUTER_API_KEY"] = ""
        env["PYTHON_KEYRING_BACKEND"] = _NULL_KEYRING_BACKEND
    return env


def memory_growth_bytes(samples: list[int | None]) -> int | None:
    values = [value for value in samples if value is not None]
    if not values:
        return None
    return max(values) - values[0]


def validate_memory_growth(samples: list[int | None]) -> dict[str, Any]:
    growth = memory_growth_bytes(samples)
    return {
        "passed": growth is not None and growth <= MAX_WORKING_SET_GROWTH_BYTES,
        "growth_bytes": growth,
        "limit_bytes": MAX_WORKING_SET_GROWTH_BYTES,
    }


def evaluate_screen_probe(index: int, answer: str) -> dict[str, Any]:
    """Evaluate one of three distinct generated screens without exact prose matching."""
    lowered = answer.casefold()
    if index == 0:
        explicit_assignment_rejection = any(
            phrase in lowered
            for phrase in (
                "does not support item assignment",
                "не поддерживает присваивание",
                "присваивание элементу str запрещено",
                "присваивание по индексу запрещено",
            )
        )
        cannot_change_string = any(
            stem in lowered for stem in ("строк", "str ")
        ) and any(
            phrase in lowered
            for phrase in (
                "нельзя менять",
                "нельзя изменить",
                "невозможно изменить",
                "immutable",
                "неизменяем",
            )
        )
        checks = {
            "false_result": bool(re.search(r"\bfalse\b", lowered))
            or "ложь" in lowered
            or "ложн" in lowered,
            # Generic "ошибка" is intentionally insufficient: the answer must name
            # the exception or explicitly say that indexed assignment is rejected.
            "type_error": "typeerror" in lowered.replace(" ", "")
            or "исключени" in lowered
            or explicit_assignment_rejection,
            "string_assignment_rejected": explicit_assignment_rejection
            or cannot_change_string,
        }
        matched = [key for key, passed in checks.items() if passed]
        missing = [key for key, passed in checks.items() if not passed]
        return {
            "passed": not missing,
            "checks": checks,
            "matched_keys": matched,
            "missing_keys": missing,
        }
    if index == 1:
        trace = fixture_trace(answer)
        passed = fixture_trace_is_valid(trace) and "@pytest.fixture" not in answer
        checks = {"fixture_order": passed}
        return {
            "passed": passed,
            "checks": checks,
            "matched_keys": ["fixture_order"] if passed else [],
            "missing_keys": [] if passed else ["fixture_order"],
        }
    if index == 2:
        code = "\n".join(sql_code_lines(answer))
        conditions = {
            "select": "select" in code.casefold(),
            "purchases": "from purchases" in code.casefold(),
            "female": "'Female'" in code,
            "short_f": "'F'" in code,
        }
        return {
            "passed": all(conditions.values()),
            "checks": conditions,
            "matched_keys": [key for key, passed in conditions.items() if passed],
            "missing_keys": [key for key, passed in conditions.items() if not passed],
        }
    raise IndexError("unknown generated screen probe")


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
    return json.loads(
        (_repo_root() / "tests" / "voice" / "cases.json").read_text("utf-8")
    )


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


async def _send_pcm(
    ws,
    pcm: bytes,
    sample_rate: int,
    *,
    sleep: Any = asyncio.sleep,
    monotonic: Any = time.monotonic,
) -> None:
    frame_bytes = max(2, sample_rate * 2 // 10)
    started = monotonic()
    sent_bytes = 0
    for offset in range(0, len(pcm), frame_bytes):
        frame = pcm[offset : offset + frame_bytes]
        await ws.send(frame)
        sent_bytes += len(frame)
        deadline = started + sent_bytes / (sample_rate * 2)
        delay = deadline - monotonic()
        if delay > 0:
            await sleep(delay)


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


@dataclass(frozen=True)
class _WindowsProcessIdentity:
    pid: int
    creation_ticks: int


@dataclass(frozen=True)
class _WindowsProcessSnapshot:
    pid: int
    parent_pid: int
    creation_ticks: int
    working_set_bytes: int

    @property
    def identity(self) -> _WindowsProcessIdentity:
        return _WindowsProcessIdentity(self.pid, self.creation_ticks)


def _windows_process_snapshot() -> dict[int, _WindowsProcessSnapshot]:
    if os.name != "nt":
        return {}
    script = """
$items = @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
        pid = [int]$_.ProcessId
        parent_pid = [int]$_.ParentProcessId
        creation_ticks = [long]$_.CreationDate.ToUniversalTime().Ticks
        working_set_bytes = [long]$_.WorkingSetSize
    }
})
ConvertTo-Json -InputObject $items -Compress
""".strip()
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        raw = json.loads(result.stdout)
        items = raw if isinstance(raw, list) else [raw]
        snapshots = (
            _WindowsProcessSnapshot(
                pid=int(item["pid"]),
                parent_pid=int(item["parent_pid"]),
                creation_ticks=int(item["creation_ticks"]),
                working_set_bytes=int(item["working_set_bytes"]),
            )
            for item in items
            if isinstance(item, dict)
        )
        return {item.pid: item for item in snapshots}
    except (
        OSError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        subprocess.SubprocessError,
    ):
        return {}


class OwnedProcessTree:
    """Tracks only descendants of one stable Windows process identity."""

    def __init__(self, root: _WindowsProcessIdentity) -> None:
        self.root = root
        self._known: set[_WindowsProcessIdentity] = {root}

    @classmethod
    def capture(cls, root_pid: int) -> OwnedProcessTree:
        snapshots = _windows_process_snapshot()
        root = snapshots.get(root_pid)
        if root is None:
            raise RuntimeError(f"Backend launcher process {root_pid} was not found")
        return cls(root.identity)

    def current_processes(self) -> list[_WindowsProcessSnapshot]:
        snapshots = _windows_process_snapshot()
        owned: dict[int, _WindowsProcessSnapshot] = {}
        for identity in self._known:
            current = snapshots.get(identity.pid)
            if current is not None and current.identity == identity:
                owned[current.pid] = current

        changed = True
        while changed:
            changed = False
            for candidate in snapshots.values():
                if candidate.pid in owned:
                    continue
                parent = owned.get(candidate.parent_pid)
                if parent is None or candidate.pid == candidate.parent_pid:
                    continue
                if candidate.creation_ticks < parent.creation_ticks:
                    continue
                owned[candidate.pid] = candidate
                self._known.add(candidate.identity)
                changed = True
        return list(owned.values())

    def working_set_bytes(self) -> int | None:
        processes = self.current_processes()
        if not processes:
            return None
        return sum(process.working_set_bytes for process in processes)


def _stop_windows_processes(processes: list[_WindowsProcessSnapshot]) -> None:
    if not processes:
        return
    by_pid = {process.pid: process for process in processes}

    def depth(process: _WindowsProcessSnapshot) -> int:
        result = 0
        current = process
        seen: set[int] = set()
        while current.parent_pid in by_pid and current.parent_pid not in seen:
            seen.add(current.parent_pid)
            current = by_pid[current.parent_pid]
            result += 1
        return result

    ordered = sorted(processes, key=depth, reverse=True)
    targets = ",".join(
        f"@{{pid={process.pid};ticks={process.creation_ticks}}}" for process in ordered
    )
    script = f"""
$targets = @({targets})
foreach ($target in $targets) {{
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $target.pid) -ErrorAction SilentlyContinue
    if ($null -ne $current -and [long]$current.CreationDate.ToUniversalTime().Ticks -eq [long]$target.ticks) {{
        Stop-Process -Id $target.pid -Force -ErrorAction SilentlyContinue
    }}
}}
""".strip()
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _terminate_owned_process_tree(
    process: subprocess.Popen,
    process_tree: OwnedProcessTree | None,
) -> None:
    if os.name == "nt" and process_tree is not None:
        _stop_windows_processes(process_tree.current_processes())
    elif process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _backend_working_set_bytes(
    process_tree: OwnedProcessTree | None,
    launcher_pid: int,
) -> int | None:
    if process_tree is not None:
        return process_tree.working_set_bytes()
    return _working_set_bytes(launcher_pid)


def remove_sqlite_artifacts(path: Path, *, attempts: int = 10) -> None:
    """Remove all temporary SQLite files or raise one stable cleanup failure."""
    targets = (path, Path(f"{path}-wal"), Path(f"{path}-shm"))
    for attempt in range(max(1, attempts)):
        blocked = False
        for target in targets:
            try:
                target.unlink(missing_ok=True)
            except PermissionError:
                blocked = True
        if not blocked:
            return
        if attempt + 1 < attempts:
            time.sleep(min(0.5, 0.05 * (attempt + 1)))
    raise RuntimeError("temporary soak database cleanup failed")


def _cleanup_run_resources(
    process: subprocess.Popen | None,
    process_tree: OwnedProcessTree | None,
    database: Path,
) -> list[str]:
    """Attempt every cleanup and return only stable, privacy-safe failure codes."""
    failures: list[str] = []
    if process is not None:
        try:
            _terminate_owned_process_tree(process, process_tree)
        except Exception:  # noqa: BLE001 - cleanup must not mask the primary result
            failures.append("process_cleanup_failed")
    try:
        remove_sqlite_artifacts(database)
    except Exception:  # noqa: BLE001 - cleanup must not mask the primary result
        failures.append("database_cleanup_failed")
    return failures


def _continuity_screen_view(index: int) -> tuple[str, tuple[str, ...]]:
    if not 0 <= index < 3:
        raise IndexError("continuity screen frame index must be between 0 and 2")
    return (
        (
            "SQL TASK - VIEW 1 / 3",
            (
                "Table Purchases: price DECIMAL, items INT, user_gender TEXT.",
                "Calculate SUM(price * items).",
                "Keep exact user_gender literals 'Female' and 'F'.",
                "Return alias income_from_female.",
            ),
        ),
        (
            "SQL TASK - VIEW 2 / 3",
            (
                "CORRECTION AFTER SCROLL",
                "The items column can be NULL.",
                "Treat NULL items as zero in the calculation.",
                "Keep every constraint from the previous view.",
            ),
        ),
        (
            "SQL TASK - VIEW 3 / 3",
            (
                "FINAL CORRECTION",
                "A new status TEXT column is now visible.",
                "Exclude rows where status = 'refunded'.",
                "Keep the prior calculation, filters and alias.",
            ),
        ),
    )[index]


def render_continuity_screen_frame(index: int) -> bytes:
    """Render one genuinely different sequential view of the synthetic SQL task."""
    title, lines = _continuity_screen_view(index)

    output = Path(tempfile.gettempdir()) / f"skillcue-soak-frame-{uuid.uuid4().hex}.png"
    escaped_output = str(output).replace("'", "''")
    colors = (
        (29, 78, 216),
        (5, 150, 105),
        (124, 58, 237),
    )
    red, green, blue = colors[index]
    escaped_title = title.replace("'", "''")
    escaped_lines = tuple(line.replace("'", "''") for line in lines)
    draw_lines = "\n".join(
        f"$graphics.DrawString('{line}', $body, $dark, 75, {190 + line_index * 105})"
        for line_index, line in enumerate(escaped_lines)
    )
    script = rf"""
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 1400, 820
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb({red}, {green}, {blue}))
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 23, 42))
$title = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Segoe UI', 23)
$graphics.FillRectangle($accent, 0, 0, 1400, 125)
$graphics.DrawString('{escaped_title}', $title, $white, 58, 42)
{draw_lines}
$bitmap.Save('{escaped_output}', [System.Drawing.Imaging.ImageFormat]::Png)
$body.Dispose(); $title.Dispose(); $dark.Dispose(); $white.Dispose(); $accent.Dispose()
$graphics.Dispose(); $bitmap.Dispose()
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    try:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                encoded,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return output.read_bytes()
    finally:
        output.unlink(missing_ok=True)


@dataclass
class ScreenContinuityState:
    """Bounded synthetic screen memory retained only for one verifier process."""

    frames: list[str] = field(default_factory=list)
    prior_solution_summary: str = ""
    current_question: str = ""
    updated_at_ms: int = 0

    def remember(self, image: str, answer: str, question: str) -> None:
        self.frames = [*self.frames, image][-2:]
        self.prior_solution_summary = answer[-8_000:]
        self.current_question = question
        self.updated_at_ms = int(time.time() * 1000)

    def active_task(self) -> dict[str, Any] | None:
        if not self.prior_solution_summary:
            return None
        return {
            "root_question": (
                "Напиши SQL-запрос по условию на синтетическом проверочном экране."
            ),
            "current_question": self.current_question,
            "latest_answer": self.prior_solution_summary,
            "updated_at_ms": self.updated_at_ms,
        }


def evaluate_continuity_screen_probe(index: int, answer: str) -> dict[str, Any]:
    """Require carried SQL facts plus the correction introduced by this view."""
    if not 0 <= index < 3:
        raise IndexError("continuity screen probe index must be between 0 and 2")
    lowered = answer.casefold()
    checks: dict[str, bool] = {
        "purchases_table": bool(
            re.search(r"\bfrom\s+(?:[a-z0-9_]+\.)?purchases\b", lowered)
        ),
        "sum_price_items": (
            bool(re.search(r"\bsum\s*\(", lowered))
            and "price" in lowered
            and "items" in lowered
        ),
        "exact_gender_literals": (
            bool(re.search(r"['\"]Female['\"]", answer))
            and bool(re.search(r"['\"]F['\"]", answer))
        ),
        "income_alias": "income_from_female" in lowered,
    }
    if index >= 1:
        checks["null_items_as_zero"] = bool(
            re.search(r"\bcoalesce\s*\(\s*items\s*,\s*0\s*\)", lowered)
        )
    if index >= 2:
        checks["refunded_excluded"] = bool(
            re.search(r"\bstatus\s*(?:<>|!=)\s*['\"]refunded['\"]", lowered)
        )
    matched = [key for key, passed in checks.items() if passed]
    missing = [key for key, passed in checks.items() if not passed]
    return {
        "passed": not missing,
        "checks": checks,
        "matched_keys": matched,
        "missing_keys": missing,
    }


def _exercise_screen_checkpoint(
    *,
    index: int,
    port: int,
    token: str,
    elapsed_minutes: float,
    request_screen: Any = _request_screen,
    renderers: tuple[Any, ...] | None = None,
    continuity_state: ScreenContinuityState | None = None,
    provider: str | None = None,
    model_override: str | None = None,
) -> dict[str, Any]:
    if continuity_state is None:
        active_renderers = renderers or (
            render_code_png,
            render_fixture_order_png,
            lambda: render_sql_solution_png(exact_gender_literals=True),
        )
        questions = (
            "Что выведет код и почему последняя операция завершается ошибкой?",
            "Назови точный порядок setup, test_order и teardown pytest-фикстур.",
            "Напиши SQL, сохранив точные литералы Female и F с экрана.",
        )
        scorer_index = index
        continuity_probe = False
        case_name = f"generated-screen-{index + 1}"
    else:
        active_renderers = renderers or (
            lambda: render_continuity_screen_frame(0),
            lambda: render_continuity_screen_frame(1),
            lambda: render_continuity_screen_frame(2),
        )
        questions = (
            "Реши SQL-задачу из первого экрана и сохрани все точные ограничения.",
            "Продолжи предыдущий SQL с учётом новой поправки про NULL.",
            "Верни полный итоговый SQL с поправками всех трёх экранов.",
        )
        scorer_index = 2
        continuity_probe = True
        case_name = f"screen-continuity-{index + 1}"
    if not 0 <= index < len(active_renderers):
        raise IndexError("not enough distinct generated screen probes")
    try:
        image = base64.b64encode(active_renderers[index]()).decode("ascii")
        image_url = f"data:image/png;base64,{image}"
        payload: dict[str, Any] = {
            "image": image_url,
            "question": questions[index],
            "context": "Проверочный технический экран непрерывной live-сессии.",
            "mode": "deep",
            "answer_language": "ru",
        }
        if continuity_state is not None:
            if continuity_state.frames:
                payload["previous_images"] = list(continuity_state.frames)
            if continuity_state.prior_solution_summary:
                payload["prior_solution_summary"] = (
                    continuity_state.prior_solution_summary
                )
        if provider:
            payload["provider"] = provider
        if model_override:
            payload["modelOverride"] = model_override
        answer, done = request_screen(
            port,
            token,
            payload,
        )
    except Exception:  # noqa: BLE001 - only a fixed, privacy-safe code is persisted
        empty_score = (
            evaluate_continuity_screen_probe(index, "")
            if continuity_probe
            else evaluate_screen_probe(scorer_index, "")
        )
        return {
            "elapsed_minutes": round(elapsed_minutes, 3),
            "case": case_name,
            "transport_first_byte_ms": None,
            "first_chunk_ms": None,
            "total_ms": None,
            "model": "unknown",
            "semantic_checks": empty_score["checks"],
            "matched_screen_concepts": empty_score["matched_keys"],
            "missing_screen_concepts": empty_score["missing_keys"],
            "failure_codes": ["screen_request_failed"],
        }
    score = (
        evaluate_continuity_screen_probe(index, answer)
        if continuity_probe
        else evaluate_screen_probe(scorer_index, answer)
    )
    transport_ms = _safe_numeric_metric(done.get("_e2e_transport_first_byte_ms"))
    first_chunk_ms = _safe_numeric_metric(done.get("_e2e_first_chunk_ms"))
    total_ms = _safe_numeric_metric(done.get("_e2e_total_ms"))
    failures: list[str] = []
    if not score["passed"]:
        failures.append("screen_semantics")
    for value, limit, code in (
        (
            transport_ms,
            MAX_SCREEN_TRANSPORT_FIRST_BYTE_MS,
            "screen_transport_first_byte_budget",
        ),
        (first_chunk_ms, MAX_SCREEN_FIRST_CHUNK_MS, "screen_first_chunk_budget"),
        (total_ms, MAX_SCREEN_TOTAL_MS, "screen_total_budget"),
    ):
        if not isinstance(value, (int, float)) or value > limit:
            failures.append(code)
    model = _safe_model_identifier(done.get("model"))
    if continuity_state is not None and score["passed"]:
        continuity_state.remember(image_url, answer, questions[index])
    return {
        "elapsed_minutes": round(elapsed_minutes, 3),
        "case": case_name,
        "transport_first_byte_ms": transport_ms,
        "first_chunk_ms": first_chunk_ms,
        "total_ms": total_ms,
        "model": model,
        "semantic_checks": score["checks"],
        "matched_screen_concepts": score["matched_keys"],
        "missing_screen_concepts": score["missing_keys"],
        "failure_codes": failures,
    }


def _ask_overlay(
    port: int,
    token: str,
    question: str,
    case: dict[str, Any],
    *,
    provider: str | None = None,
    model_override: str | None = None,
    session_id: str | None = None,
    active_screen_task: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "question": question,
        "raw_question": question,
        "candidate_context": E2E_CANDIDATE_CONTEXT,
        "mode": "fast",
        "fast_answer": True,
        "answer_language": "ru",
    }
    if provider:
        payload["provider"] = provider
    if model_override:
        payload["modelOverride"] = model_override
    if session_id:
        payload["session_id"] = session_id
    if active_screen_task:
        payload["active_screen_task"] = active_screen_task
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
        "model": _safe_model_identifier(done.get("model")),
        "matched_answer_concepts": matched,
    }


async def _event_reader(ws, queue: asyncio.Queue[dict[str, Any]]) -> None:
    try:
        async for raw in ws:
            await queue.put(json.loads(str(raw)))
    except Exception as exc:  # noqa: BLE001 - surfaced through the verifier queue
        await queue.put({"type": "transport_closed", "message": type(exc).__name__})
    else:
        await queue.put({"type": "transport_closed", "message": "closed"})


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
    provider: str | None = None,
    model_override: str | None = None,
    session_id: str | None = None,
    active_screen_task: dict[str, Any] | None = None,
    ask_overlay: Any = _ask_overlay,
    request_id_factory: Any = None,
    sleep: Any = asyncio.sleep,
) -> dict[str, Any]:
    source_rate, source_pcm = _read_pcm(_repo_root() / str(case["audioFile"]))
    pcm = _resample_pcm16_mono(source_pcm, source_rate, LIVE_SAMPLE_RATE)
    await _send_pcm(ws, pcm, LIVE_SAMPLE_RATE, sleep=sleep)
    await sleep(0.1)
    request_id = (
        request_id_factory()
        if request_id_factory is not None
        else f"soak-{uuid.uuid4().hex}"
    )
    started = time.monotonic()
    await ws.send(json.dumps({"type": "finalize", "request_id": request_id}))
    ready_events = 0
    while True:
        event = await _next_event(queue, deadline=started + 18)
        event_type = event.get("type")
        if event_type == "ready":
            ready_events += 1
            continue
        if event_type == "transport_closed":
            raise SttTransportInterrupted("STT transport closed during checkpoint")
        if event_type in {"error", "transcription_error"}:
            raise RuntimeError(f"STT failed at {elapsed_minutes:.1f} min: {event}")
        if event_type == "low_quality":
            raise RuntimeError(
                f"STT quality gate rejected {case['id']} at {elapsed_minutes:.1f} min"
            )
        if event_type != "transcript":
            continue
        # A natural final from an older utterance can still be queued when the
        # forced Ctrl+Enter final arrives. Only the transcript explicitly bound
        # to this finalize request is allowed to trigger an answer.
        if str(event.get("force_request_id") or "") != request_id:
            continue
        transcript = str(event.get("text") or "").strip()
        matched = _matches(transcript, case["requiredTranscriptKeywords"])
        if len(matched) < 3:
            raise RuntimeError(
                f"Transcript semantic check failed for {case['id']}: matched={matched}"
            )
        stt_ms = round((time.monotonic() - started) * 1000)
        answer = await asyncio.to_thread(
            ask_overlay,
            port,
            token,
            transcript,
            case,
            provider=provider,
            model_override=model_override,
            session_id=session_id,
            active_screen_task=active_screen_task,
        )
        if stt_ms > MAX_STT_MS:
            raise RuntimeError(
                f"STT exceeded {MAX_STT_MS} ms at {elapsed_minutes:.1f} min"
            )
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
            "stt_upstream_ms": _safe_numeric_metric(event.get("openaiInferenceMs")),
            "llm_first_chunk_ms": answer["first_chunk_ms"],
            "llm_total_ms": answer["total_ms"],
            "model": _safe_model_identifier(answer.get("model")),
            "matched_transcript_concepts": matched,
            "matched_answer_concepts": answer["matched_answer_concepts"],
            "ready_events_during_probe": ready_events,
            "active_screen_context_injected": active_screen_task is not None,
        }


async def _run_soak(
    *,
    port: int,
    token: str,
    process: subprocess.Popen,
    process_tree: OwnedProcessTree | None,
    duration_minutes: float,
    checkpoints: tuple[float, ...],
    screen_checkpoints: tuple[float, ...],
    voice_provider: str | None = "openrouter",
    voice_model: str | None = None,
    screen_provider: str | None = None,
    screen_model: str | None = None,
    session_id: str | None = None,
    progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cases = _load_cases()
    if len(cases) < len(checkpoints):
        raise RuntimeError(
            "Not enough distinct voice fixtures for the soak checkpoints"
        )
    query = urllib.parse.urlencode(
        {"language": "ru", "sample_rate": LIVE_SAMPLE_RATE, "token": token}
    )
    url = f"ws://127.0.0.1:{port}/stt/stream?{query}"
    progress = progress if progress is not None else {}
    results: list[dict[str, Any]] = progress.setdefault("checkpoints", [])
    ready_count = 0
    memory_samples: list[dict[str, Any]] = progress.setdefault("memory_samples", [])
    screen_results: list[dict[str, Any]] = progress.setdefault("screen_probes", [])
    screen_checkpoint_index = 0
    stable_session_id = session_id or f"soak-session-{uuid.uuid4().hex}"
    screen_continuity = ScreenContinuityState()
    progress.setdefault("local_socket_reconnect_count", 0)
    progress.setdefault("stt_socket_established", False)
    progress.setdefault("stt_socket_interrupted", False)
    progress["stt_continuity"] = stt_continuity_status(
        established=bool(progress["stt_socket_established"]),
        interrupted=bool(progress["stt_socket_interrupted"]),
    )
    if len(screen_checkpoints) > 3:
        raise RuntimeError("Only three distinct generated screen probes are available")

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
            if startup.get("type") == "transport_closed":
                raise SttTransportInterrupted("STT transport closed before ready")
            if startup.get("type") != "ready":
                raise RuntimeError(f"STT did not become ready: {startup}")
            ready_count = 1
            progress["ready_events"] = ready_count
            progress["stt_socket_established"] = True
            progress["stt_continuity"] = stt_continuity_status(
                established=True,
                interrupted=False,
            )
            started = time.monotonic()
            next_keepalive = started
            next_heartbeat = started + HEARTBEAT_SECONDS
            checkpoint_index = 0
            end_at = started + duration_minutes * 60

            while time.monotonic() < end_at:
                now = time.monotonic()
                elapsed_minutes = (now - started) / 60
                progress["actual_duration_minutes"] = round(elapsed_minutes, 3)
                while (
                    checkpoint_index < len(checkpoints)
                    and elapsed_minutes >= checkpoints[checkpoint_index]
                ):
                    result = await _exercise_checkpoint(
                        ws,
                        queue,
                        case=cases[checkpoint_index],
                        port=port,
                        token=token,
                        elapsed_minutes=elapsed_minutes,
                        provider=voice_provider,
                        model_override=voice_model,
                        session_id=stable_session_id,
                        active_screen_task=(
                            screen_continuity.active_task()
                            if elapsed_minutes >= 60
                            else None
                        ),
                    )
                    ready_count = _count_checkpoint_ready_events(ready_count, result)
                    progress["ready_events"] = ready_count
                    result["working_set_bytes"] = _backend_working_set_bytes(
                        process_tree, process.pid
                    )
                    memory_samples.append(
                        {
                            "elapsed_minutes": result["elapsed_minutes"],
                            "working_set_bytes": result["working_set_bytes"],
                        }
                    )
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

                while (
                    screen_checkpoint_index < len(screen_checkpoints)
                    and elapsed_minutes >= screen_checkpoints[screen_checkpoint_index]
                ):
                    screen_result = await asyncio.to_thread(
                        _exercise_screen_checkpoint,
                        index=screen_checkpoint_index,
                        port=port,
                        token=token,
                        elapsed_minutes=elapsed_minutes,
                        continuity_state=screen_continuity,
                        provider=screen_provider,
                        model_override=screen_model,
                    )
                    working_set = _backend_working_set_bytes(process_tree, process.pid)
                    screen_result["working_set_bytes"] = working_set
                    screen_results.append(screen_result)
                    memory_samples.append(
                        {
                            "elapsed_minutes": screen_result["elapsed_minutes"],
                            "working_set_bytes": working_set,
                        }
                    )
                    ready_count, pending_stt_failures = _drain_pending_stt_events(
                        queue,
                        ready_count,
                    )
                    progress["ready_events"] = ready_count
                    if "stt_transport_interrupted" in pending_stt_failures:
                        progress["stt_socket_interrupted"] = True
                        progress["stt_continuity"] = stt_continuity_status(
                            established=bool(progress["stt_socket_established"]),
                            interrupted=True,
                        )
                    checkpoint_failures = list(
                        dict.fromkeys(
                            [
                                *screen_result["failure_codes"],
                                *pending_stt_failures,
                            ]
                        )
                    )
                    if checkpoint_failures:
                        memory_gate = validate_memory_growth(
                            [sample["working_set_bytes"] for sample in memory_samples]
                        )
                        raise SoakRunFailure(
                            {
                                "ok": False,
                                "requested_duration_minutes": duration_minutes,
                                "actual_duration_minutes": round(
                                    (time.monotonic() - started) / 60, 3
                                ),
                                "checkpoints": results,
                                **_stt_connection_report_fields(
                                    ready_count,
                                    local_socket_reconnect_count=progress[
                                        "local_socket_reconnect_count"
                                    ],
                                ),
                                "stt_continuity": progress["stt_continuity"],
                                "screen_probes": screen_results,
                                "memory_samples": memory_samples,
                                "memory_growth_bytes": memory_gate["growth_bytes"],
                                "memory_growth_limit_bytes": memory_gate["limit_bytes"],
                                "failure_codes": checkpoint_failures,
                            }
                        )
                    print(
                        "SOAK screen probe "
                        f"{screen_checkpoint_index + 1}/{len(screen_checkpoints)} "
                        f"at {elapsed_minutes:.2f}m: first={screen_result['first_chunk_ms']}ms "
                        f"total={screen_result['total_ms']}ms model={screen_result['model']}",
                        flush=True,
                    )
                    screen_checkpoint_index += 1
                    now = time.monotonic()
                    elapsed_minutes = (now - started) / 60

                if now >= next_keepalive:
                    await ws.send(b"\0\0" * (LIVE_SAMPLE_RATE // 10))
                    next_keepalive = now + KEEPALIVE_SECONDS

                ready_count, pending_stt_failures = _drain_pending_stt_events(
                    queue,
                    ready_count,
                )
                progress["ready_events"] = ready_count
                if "stt_transport_interrupted" in pending_stt_failures:
                    raise SttTransportInterrupted("Background STT transport closed")
                if pending_stt_failures:
                    raise RuntimeError("Background STT failure")

                if now >= next_heartbeat:
                    sample = {
                        "elapsed_minutes": round(elapsed_minutes, 3),
                        "working_set_bytes": _backend_working_set_bytes(
                            process_tree, process.pid
                        ),
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
            if screen_checkpoint_index != len(screen_checkpoints):
                raise RuntimeError(
                    f"Only {screen_checkpoint_index}/{len(screen_checkpoints)} screen probes ran"
                )
        except (SttTransportInterrupted, ConnectionClosed):
            progress["stt_socket_interrupted"] = True
            progress["stt_continuity"] = stt_continuity_status(
                established=bool(progress["stt_socket_established"]),
                interrupted=True,
            )
            raise
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    memory_gate = validate_memory_growth(
        [sample["working_set_bytes"] for sample in memory_samples]
    )
    if not memory_gate["passed"]:
        raise RuntimeError(
            f"Working-set growth exceeded the bound: {memory_gate['growth_bytes']}"
        )
    return {
        "ok": True,
        "requested_duration_minutes": duration_minutes,
        "actual_duration_minutes": round((time.monotonic() - started) / 60, 3),
        "checkpoints": results,
        **_stt_connection_report_fields(
            ready_count,
            local_socket_reconnect_count=progress["local_socket_reconnect_count"],
        ),
        "stt_continuity": progress["stt_continuity"],
        "screen_probes": screen_results,
        "memory_samples": memory_samples,
        "memory_growth_bytes": memory_gate["growth_bytes"],
        "memory_growth_limit_bytes": memory_gate["limit_bytes"],
    }


def build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Exercise one long-lived source or installed backend session with real STT, "
            "voice answers, and bounded screen continuity."
        ),
        epilog="""
Supported hybrid source route:
  --source-backend --voice-provider openrouter --screen-provider openai --screen-model openai/gpt-5.6-sol

This verifier checks backend finalize ownership and session continuity.
It does not press or verify the OS/global hotkey; run the Electron shortcut gates separately.
Report note: ready_events/stt_reconnect_count describe upstream STT evidence;
local_socket_reconnect_count describes reconnects of this verifier's one local WebSocket.
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--duration-minutes", type=float, default=DEFAULT_DURATION_MINUTES
    )
    parser.add_argument("--checkpoint-minutes", default=DEFAULT_CHECKPOINTS)
    parser.add_argument(
        "--screen-checkpoint-minutes",
        default=DEFAULT_SCREEN_CHECKPOINTS,
        help="generated screen-probe checkpoints in minutes",
    )
    parser.add_argument(
        "--source-backend",
        action="store_true",
        help="run current workspace FastAPI source instead of the installed backend",
    )
    parser.add_argument(
        "--voice-provider",
        default="openrouter",
        help="voice-answer provider; model stays on product Auto unless overridden",
    )
    parser.add_argument(
        "--voice-model",
        default=None,
        help="optional explicit voice model (diagnostics only; disables product hedging)",
    )
    parser.add_argument(
        "--screen-provider",
        default=None,
        help="optional screen provider override",
    )
    parser.add_argument(
        "--screen-model",
        default=None,
        help="optional screen model override",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=_repo_root() / "output" / "soak" / "long-live-session.json",
    )
    return parser


def _safe_runtime_failure_report(
    *,
    duration_minutes: float,
    stage: str,
    progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    failure_code = {
        "identity": "identity_setup_failed",
        "launch": "backend_launch_failed",
        "health": "backend_health_failed",
        "soak": "soak_failed",
    }.get(stage, "soak_failed")
    progress = progress or {}
    raw_ready_events = progress.get("ready_events")
    ready_events = (
        raw_ready_events
        if isinstance(raw_ready_events, int)
        and not isinstance(raw_ready_events, bool)
        and raw_ready_events >= 0
        else 0
    )
    checkpoints = [dict(record) for record in progress.get("checkpoints") or []]
    for checkpoint in checkpoints:
        checkpoint["model"] = _safe_model_identifier(checkpoint.get("model"))
        checkpoint["stt_upstream_ms"] = _safe_numeric_metric(
            checkpoint.get("stt_upstream_ms")
        )
    screen_probes = [dict(record) for record in progress.get("screen_probes") or []]
    for screen_probe in screen_probes:
        screen_probe["model"] = _safe_model_identifier(screen_probe.get("model"))
    return {
        "ok": False,
        "requested_duration_minutes": duration_minutes,
        "actual_duration_minutes": float(
            progress.get("actual_duration_minutes") or 0.0
        ),
        "checkpoints": checkpoints,
        "screen_probes": screen_probes,
        "memory_samples": list(progress.get("memory_samples") or []),
        **_stt_connection_report_fields(
            ready_events,
            local_socket_reconnect_count=progress.get(
                "local_socket_reconnect_count", 0
            ),
        ),
        "stt_continuity": stt_continuity_status(
            established=bool(progress.get("stt_socket_established")),
            interrupted=bool(progress.get("stt_socket_interrupted")),
        ),
        "failure_codes": [failure_code],
    }


def main() -> int:
    args = build_cli_parser().parse_args()
    checkpoints = parse_checkpoint_minutes(
        args.checkpoint_minutes,
        duration_minutes=args.duration_minutes,
    )
    screen_checkpoints = parse_checkpoint_minutes(
        args.screen_checkpoint_minutes,
        duration_minutes=args.duration_minutes,
    )
    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-long-soak-{token}.sqlite"
    started_at = time.time()
    process: subprocess.Popen | None = None
    process_tree: OwnedProcessTree | None = None
    progress: dict[str, Any] = {
        "checkpoints": [],
        "screen_probes": [],
        "memory_samples": [],
        "ready_events": 0,
        "local_socket_reconnect_count": 0,
        "actual_duration_minutes": 0.0,
        "stt_socket_established": False,
        "stt_socket_interrupted": False,
        "stt_continuity": "not_established",
    }
    stage = "identity"
    exit_code = 1
    cleanup_failure_codes: list[str] = []
    try:
        backend = _installed_backend()
        if not args.source_backend and not backend.exists():
            raise RuntimeError("Installed SkillCue Dev backend was not found")
        seed_installed_gateway_identity(db_path)
        env = build_backend_environment(
            base_env=dict(os.environ),
            port=port,
            token=token,
            database=db_path,
            source_backend=args.source_backend,
        )
        command, cwd = backend_launch_spec(
            source_backend=args.source_backend,
            port=port,
        )
        stage = "launch"
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if os.name == "nt":
            process_tree = OwnedProcessTree.capture(process.pid)
        stage = "health"
        _wait_for_health(port, time.monotonic() + 15)
        stage = "soak"
        try:
            report = asyncio.run(
                _run_soak(
                    port=port,
                    token=token,
                    process=process,
                    process_tree=process_tree,
                    duration_minutes=args.duration_minutes,
                    checkpoints=checkpoints,
                    screen_checkpoints=screen_checkpoints,
                    voice_provider=args.voice_provider,
                    voice_model=args.voice_model,
                    screen_provider=args.screen_provider,
                    screen_model=args.screen_model,
                    progress=progress,
                )
            )
            exit_code = 0
        except SoakRunFailure as exc:
            report = exc.report
            exit_code = 1
        except Exception:  # noqa: BLE001 - report only stable aggregate codes
            report = _safe_runtime_failure_report(
                duration_minutes=args.duration_minutes,
                stage=stage,
                progress=progress,
            )
    except Exception:  # noqa: BLE001 - never persist exception text or local paths
        report = _safe_runtime_failure_report(
            duration_minutes=args.duration_minutes,
            stage=stage,
            progress=progress,
        )
    finally:
        cleanup_failure_codes = _cleanup_run_resources(process, process_tree, db_path)

    if cleanup_failure_codes:
        report["cleanup_failure_codes"] = cleanup_failure_codes
        if exit_code == 0:
            report["ok"] = False
            report["failure_codes"] = [
                *list(report.get("failure_codes") or []),
                "cleanup_failed",
            ]
            exit_code = 1

    report.update(
        {
            "started_at_epoch": round(started_at),
            "finished_at_epoch": round(time.time()),
            "backend_exit_code": process.poll() if process is not None else None,
            "source_backend": args.source_backend,
        }
    )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    outcome = "OK" if exit_code == 0 else "FAIL"
    print(f"{outcome} long live soak: {args.report}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
