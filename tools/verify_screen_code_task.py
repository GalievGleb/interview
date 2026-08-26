#!/usr/bin/env python3
"""Development-only real /chat/screen/stream check for a Python output task."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zlib
from pathlib import Path

from dev_e2e_identity import seed_installed_gateway_identity

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

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

FIXTURE_TRACE = [
    "session_fixture",
    "module_fixture",
    "autouse_fixture",
    "fixture_3",
    "fixture_4",
    "fixture_1",
    "fixture_2",
    "test_order",
    "fixture_4",
]


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


def render_fixture_order_png() -> bytes:
    """Render the real pytest-order regression without adding GUI dependencies."""
    output = Path(tempfile.gettempdir()) / f"skillcue-fixture-{uuid.uuid4().hex}.png"
    escaped_output = str(output).replace("'", "''")
    script = rf"""
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 1600, 1200
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(24, 24, 27))
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$title = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Segoe UI', 20)
$codeFont = New-Object System.Drawing.Font('Consolas', 18)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$cyan = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(103, 232, 249))
$graphics.DrawString('14. Порядок выполнения фикстур', $title, $white, 58, 38)
$graphics.DrawString('Определите точную последовательность setup фикстур, выполнения теста и teardown после yield.', $body, $white, 58, 100)
$code = @'
order = []

@pytest.fixture(scope="session")
def session_fixture(): order.append("session_fixture")

@pytest.fixture(scope="module")
def module_fixture(): order.append("module_fixture")

@pytest.fixture
def fixture_1(fixture_3, fixture_4): order.append("fixture_1")

@pytest.fixture(scope="function")
def fixture_3(): order.append("fixture_3")

@pytest.fixture(autouse=True)
def autouse_fixture(): order.append("autouse_fixture")

@pytest.fixture
def fixture_2(): order.append("fixture_2")

@pytest.fixture
def fixture_4():
    yield
    order.append("fixture_4")

def test_order(fixture_1, module_fixture, fixture_2, session_fixture):
    pass
'@
$y = 150
foreach ($line in ($code -split "`n")) {{
  $graphics.DrawString($line.TrimEnd("`r"), $codeFont, $cyan, 70, $y)
  $y += 33
}}
$bitmap.Save('{escaped_output}', [System.Drawing.Imaging.ImageFormat]::Png)
$cyan.Dispose(); $white.Dispose(); $codeFont.Dispose(); $body.Dispose(); $title.Dispose()
$graphics.Dispose(); $bitmap.Dispose()
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        return output.read_bytes()
    finally:
        output.unlink(missing_ok=True)


def fixture_trace(answer: str) -> list[str]:
    names = "|".join(re.escape(name) for name in dict.fromkeys(FIXTURE_TRACE))
    return re.findall(names, answer.lower())[: len(FIXTURE_TRACE)]


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
    parser.add_argument(
        "--fixture-order",
        action="store_true",
        help="verify the real visible pytest fixture setup/test/teardown task",
    )
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
    seed_installed_gateway_identity(db_path)
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
        image_bytes = render_fixture_order_png() if args.fixture_order else render_code_png()
        image = base64.b64encode(image_bytes).decode("ascii")
        question = "Что выведет этот код?"
        context = "Интервьюер просит решить видимый Python-код."
        mode = "fast"
        if args.fixture_order:
            question = (
                "Реши задание на экране. Перечисли точный порядок setup всех фикстур, "
                "выполнения test_order и teardown после yield."
            )
            context = "Интервьюер просит определить порядок выполнения pytest-фикстур."
            mode = "deep"
        body = json.dumps(
            {
                "image": f"data:image/png;base64,{image}",
                "question": question,
                "context": context,
                "mode": mode,
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
        done: dict | None = None
        with urllib.request.urlopen(request, timeout=120) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                if event.get("type") == "chunk":
                    chunks.append(str(event.get("text") or ""))
                elif event.get("type") == "done":
                    done = event
                elif event.get("type") == "error":
                    raise RuntimeError(str(event))
        answer = "".join(chunks)
        if args.fixture_order:
            trace = fixture_trace(answer)
            rewrote_source = "@pytest.fixture" in answer or "def session_fixture" in answer
            if not done or trace != FIXTURE_TRACE or rewrote_source:
                raise RuntimeError(
                    "fixture-order vision assertions failed: "
                    f"done={done}, trace={trace}, expected={FIXTURE_TRACE}, "
                    f"rewrote_source={rewrote_source}\n{answer}"
                )
            print(answer)
            print(f"VISION FIXTURE PASS: model={done.get('model')} trace={trace}")
            return 0

        lowered = answer.lower()
        required = {
            "False": "false" in lowered or "лож" in lowered,
            "TypeError": "typeerror" in lowered,
            "immutability": "неизмен" in lowered or "immutable" in lowered,
        }
        if not done or not all(required.values()):
            raise RuntimeError(f"vision assertions failed: done={done}, required={required}\n{answer}")
        print(answer)
        print(f"VISION PASS: model={done.get('model')} required={required}")
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
