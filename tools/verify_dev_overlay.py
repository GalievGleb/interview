"""Headless end-to-end check of the installed SkillCue Dev overlay API path.

This intentionally does not launch Electron. It starts the backend shipped in
the installed Dev build, sends the exact SSE request used by OverlayPage, and
validates both transport and answer quality.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from dev_e2e_identity import seed_installed_gateway_identity

QUESTION = "Что такое техники тест-дизайна? Назови несколько примеров и кратко объясни их."
EXPECTED_CONCEPTS = (
    "эквивалент",
    "граничн",
    "таблиц",
    "попарн",
    "состояни",
    "сценар",
    "use case",
)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _installed_backend() -> Path:
    local = Path(os.environ["LOCALAPPDATA"])
    return local / "Programs" / "skillcue-dev" / "resources" / "backend" / "skillcue-backend.exe"


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


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    backend = _installed_backend()
    if not backend.exists():
        raise RuntimeError(f"Installed SkillCue Dev backend was not found: {backend}")

    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-overlay-e2e-{token}.sqlite"
    seed_installed_gateway_identity(db_path)
    env = {
        **os.environ,
        "SKILLCUE_PORT": str(port),
        "SKILLCUE_API_TOKEN": token,
        "SKILLCUE_BUILD_CHANNEL": "dev",
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
    }
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = subprocess.Popen(
        [str(backend)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    try:
        _wait_for_health(port, time.monotonic() + 12)
        payload = {
            "question": QUESTION,
            "raw_question": QUESTION,
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
        done: dict | None = None
        with urllib.request.urlopen(request, timeout=35) as response:
            if response.status != 200:
                raise RuntimeError(f"Overlay API returned HTTP {response.status}")
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                if event.get("type") == "error":
                    raise RuntimeError(f"Overlay SSE error: {event.get('message', 'unknown error')}")
                if event.get("type") == "chunk":
                    if first_chunk_ms is None:
                        first_chunk_ms = round((time.monotonic() - started) * 1000)
                    chunks.append(str(event.get("text") or ""))
                if event.get("type") == "done":
                    done = event

        spoken = str((done or {}).get("spoken") or "").strip()
        normalized = spoken.lower()
        concepts = [term for term in EXPECTED_CONCEPTS if term in normalized]
        if first_chunk_ms is None:
            raise RuntimeError("Overlay stream returned no chunks.")
        if first_chunk_ms > 25_000:
            raise RuntimeError(f"Overlay first token was too slow: {first_chunk_ms} ms")
        if done is None:
            raise RuntimeError("Overlay stream returned no done event.")
        if len(spoken) < 100 or len(concepts) < 2:
            raise RuntimeError(
                "Overlay answer failed semantic validation "
                f"(length={len(spoken)}, concepts={concepts})."
            )

        total_ms = round((time.monotonic() - started) * 1000)
        print(
            f"OK overlay E2E: model={done.get('model')} "
            f"first_chunk={first_chunk_ms}ms total={total_ms}ms concepts={','.join(concepts)}"
        )
        print(f"Question: {QUESTION}")
        print(f"Spoken answer: {spoken}")
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
