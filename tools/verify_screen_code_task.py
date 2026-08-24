#!/usr/bin/env python3
"""Development-only real /chat/screen/stream check for a Python output task."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zlib
from pathlib import Path

FONT = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
    "s": ("00000", "01111", "10000", "01110", "00001", "11110", "00000"),
    "p": ("00000", "11110", "10001", "11110", "10000", "10000", "10000"),
    "r": ("00000", "10110", "11001", "10000", "10000", "10000", "00000"),
    "i": ("00100", "00000", "01100", "00100", "00100", "00100", "01110"),
    "n": ("00000", "11110", "10001", "10001", "10001", "10001", "00000"),
    "t": ("01000", "01000", "11110", "01000", "01000", "00110", "00000"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "=": ("00000", "11111", "00000", "11111", "00000", "00000", "00000"),
    "(": ("00010", "00100", "01000", "01000", "01000", "00100", "00010"),
    ")": ("01000", "00100", "00010", "00010", "00010", "00100", "01000"),
    "[": ("01110", "01000", "01000", "01000", "01000", "01000", "01110"),
    "]": ("01110", "00010", "00010", "00010", "00010", "00010", "01110"),
    '"': ("01010", "01010", "00000", "00000", "00000", "00000", "00000"),
    " ": ("00000",) * 7,
}

LINES = ('s = "1234567890"', "print(s[6] == 7)", 's[0] = "H"', "print(s)")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body))


def render_code_png() -> bytes:
    width, height, scale = 900, 420, 6
    pixels = bytearray([248, 250, 252] * width * height)

    def fill(x: int, y: int, color: tuple[int, int, int]) -> None:
        if not (0 <= x < width and 0 <= y < height):
            return
        offset = (y * width + x) * 3
        pixels[offset : offset + 3] = bytes(color)

    for line_index, text in enumerate(LINES):
        y0 = 55 + line_index * 78
        for char_index, char in enumerate(text):
            glyph = FONT[char]
            x0 = 55 + char_index * 6 * scale
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "0":
                        continue
                    for dy in range(scale):
                        for dx in range(scale):
                            fill(x0 + gx * scale + dx, y0 + gy * scale + dy, (15, 23, 42))

    raw = b"".join(b"\x00" + pixels[y * width * 3 : (y + 1) * width * 3] for y in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )


def _wait_for_health(port: int) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError("backend health timeout")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-backend", action="store_true")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    api_root = root / "apps" / "api-py"
    installed = (
        Path(os.environ["LOCALAPPDATA"])
        / "Programs"
        / "skillcue-dev"
        / "resources"
        / "backend"
        / "skillcue-backend.exe"
    )
    if not args.source_backend and not installed.exists():
        raise RuntimeError(f"Installed Dev backend not found: {installed}")

    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-screen-{token}.sqlite"
    env = {
        **os.environ,
        "SKILLCUE_PORT": str(port),
        "SKILLCUE_API_TOKEN": token,
        "SKILLCUE_BUILD_CHANNEL": "dev",
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
    }
    command = [str(installed)]
    cwd = None
    if args.source_backend:
        command = [
            str(api_root / ".venv" / "Scripts" / "python.exe"),
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ]
        cwd = api_root

    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        _wait_for_health(port)
        image = base64.b64encode(render_code_png()).decode("ascii")
        body = json.dumps(
            {
                "image": f"data:image/png;base64,{image}",
                "question": "Что выведет этот код?",
                "context": "Интервьюер просит решить видимый Python-код.",
                "mode": "fast",
                "answer_language": "ru",
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/chat/screen/stream",
            data=body,
            headers={"Content-Type": "application/json", "X-SkillCue-Token": token},
            method="POST",
        )
        chunks: list[str] = []
        done = False
        with urllib.request.urlopen(request, timeout=120) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                if event.get("type") == "chunk":
                    chunks.append(str(event.get("text") or ""))
                elif event.get("type") == "done":
                    done = True
                elif event.get("type") == "error":
                    raise RuntimeError(str(event))
        answer = "".join(chunks)
        lowered = answer.lower()
        required = {
            "False": "false" in lowered or "лож" in lowered,
            "TypeError": "typeerror" in lowered,
            "immutability": "неизмен" in lowered or "immutable" in lowered,
        }
        if not done or not all(required.values()):
            raise RuntimeError(f"vision assertions failed: done={done}, required={required}\n{answer}")
        print(answer)
        print(f"VISION PASS: {required}")
        return 0
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        for _ in range(10):
            try:
                db_path.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.2)


if __name__ == "__main__":
    raise SystemExit(main())
