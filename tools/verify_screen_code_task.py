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


def render_sql_solution_png(*, exact_gender_literals: bool = False) -> bytes:
    """Render a realistic SQL interview task that requires copyable code."""
    output = Path(tempfile.gettempdir()) / f"skillcue-sql-{uuid.uuid4().hex}.png"
    escaped_output = str(output).replace("'", "''")
    gender_rule = (
        "user_gender хранится только как 'Female' или 'F' — сохрани регистр литералов."
        if exact_gender_literals
        else "Сравнение пола должно быть без учёта регистра."
    ).replace("'", "''")
    script = rf"""
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 1400, 820
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$title = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Segoe UI', 22)
$codeFont = New-Object System.Drawing.Font('Consolas', 22)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 23, 42))
$blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(29, 78, 216))
$graphics.DrawString('SQL: доход от покупок женщин', $title, $dark, 58, 45)
$graphics.DrawString('Таблица Purchases:', $body, $dark, 58, 125)
$graphics.DrawString('price DECIMAL, items INT, user_gender TEXT', $codeFont, $blue, 80, 185)
$graphics.DrawString('Напишите запрос, который считает суммарный доход:', $body, $dark, 58, 285)
$graphics.DrawString('price * items только для user_gender = female', $codeFont, $blue, 80, 345)
$graphics.DrawString('{gender_rule}', $body, $dark, 58, 435)
$graphics.DrawString('Назовите результат income_from_female.', $body, $dark, 58, 500)
$bitmap.Save('{escaped_output}', [System.Drawing.Imaging.ImageFormat]::Png)
$blue.Dispose(); $dark.Dispose(); $codeFont.Dispose(); $body.Dispose(); $title.Dispose()
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


def sql_code_lines(answer: str) -> list[str]:
    match = re.search(r"```(?:sql)?\s*\n?(.*?)```", answer, re.IGNORECASE | re.DOTALL)
    if not match:
        return []
    return [line.strip() for line in match.group(1).splitlines() if line.strip()]


def has_short_spoken_summary_before_code(answer: str) -> bool:
    fence_index = answer.find("```")
    if fence_index <= 0:
        return False
    summary = answer[:fence_index].strip()
    if not summary or len(summary) > 500:
        return False
    sentences = [part for part in re.split(r"(?<=[.!?])\s+|\n+", summary) if part.strip()]
    return 1 <= len(sentences) <= 3


def every_code_line_has_following_comment(lines: list[str], marker: str) -> bool:
    """Require code/comment pairs without accepting wide inline comments."""
    if not lines:
        return False
    code_indexes = [index for index, line in enumerate(lines) if not line.lstrip().startswith(marker)]
    if not code_indexes:
        return False
    for index in code_indexes:
        if index + 1 >= len(lines):
            return False
        comment = lines[index + 1].lstrip()
        if not comment.startswith(marker) or not re.search(r"[а-яё]", comment, re.IGNORECASE):
            return False
    return True


def fixture_trace(answer: str) -> list[str]:
    unique_names = list(dict.fromkeys(FIXTURE_TRACE))
    numbered_trace: list[str] = []
    for line in answer.lower().splitlines():
        if not re.match(r"^\s*\d+[.)]\s+", line):
            continue
        matches = [
            (match.start(), name)
            for name in unique_names
            if (match := re.search(rf"\b{re.escape(name)}\b", line))
        ]
        if matches:
            numbered_trace.append(min(matches)[1])
    if numbered_trace:
        return numbered_trace

    names = "|".join(re.escape(name) for name in unique_names)
    raw_trace = re.findall(names, answer.lower())
    collapsed_trace: list[str] = []
    for name in raw_trace:
        if not collapsed_trace or collapsed_trace[-1] != name:
            collapsed_trace.append(name)
    return collapsed_trace


def fixture_trace_is_valid(trace: list[str]) -> bool:
    setup_and_test = FIXTURE_TRACE[:-1]
    return (
        trace[: len(setup_and_test)] == setup_and_test
        and FIXTURE_TRACE[-1] in trace[len(setup_and_test) :]
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


def _request_screen(port: int, token: str, payload: dict) -> tuple[str, dict]:
    started = time.monotonic()
    first_chunk_ms: int | None = None
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
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
                if first_chunk_ms is None:
                    first_chunk_ms = round((time.monotonic() - started) * 1000)
                chunks.append(str(event.get("text") or ""))
            elif event.get("type") == "done":
                done = event
            elif event.get("type") == "error":
                raise RuntimeError(str(event))
    if done is None:
        raise RuntimeError("screen stream returned no done event")
    done["_e2e_first_chunk_ms"] = first_chunk_ms
    done["_e2e_total_ms"] = round((time.monotonic() - started) * 1000)
    return "".join(chunks), done


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-backend", action="store_true")
    parser.add_argument("--model", help="explicit screen model override for comparison")
    scenario = parser.add_mutually_exclusive_group()
    scenario.add_argument(
        "--fixture-order",
        action="store_true",
        help="verify the real visible pytest fixture setup/test/teardown task",
    )
    scenario.add_argument(
        "--sql-format",
        action="store_true",
        help="verify fenced SQL with a short Russian explanation on every code line",
    )
    scenario.add_argument(
        "--sql-exact-literals",
        action="store_true",
        help="verify exact case-sensitive Female/F literals from a visible SQL task",
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
        if args.fixture_order:
            image_bytes = render_fixture_order_png()
        elif args.sql_format:
            image_bytes = render_sql_solution_png()
        elif args.sql_exact_literals:
            image_bytes = render_sql_solution_png(exact_gender_literals=True)
        else:
            image_bytes = render_code_png()
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
        elif args.sql_format:
            question = (
                "Реши SQL-задачу на экране. Дай готовый запрос: один блок кода без пустых строк, "
                "а напротив каждой строки добавь короткий комментарий на русском, что она делает."
            )
            context = "Интервьюер просит написать SQL и вслух объяснить каждую строку."
            mode = "deep"
        elif args.sql_exact_literals:
            question = (
                "Реши SQL-задачу на экране. Сохрани точные имена, операторы и регистр "
                "строковых литералов из условия."
            )
            context = "Интервьюер проверяет точность SQL-условия по видимым данным."
            mode = "deep"
        payload = {
            "image": f"data:image/png;base64,{image}",
            "question": question,
            "context": context,
            "mode": mode,
            "answer_language": "ru",
        }
        if args.model:
            payload["modelOverride"] = args.model
        answer, done = _request_screen(port, token, payload)
        if args.sql_exact_literals:
            code_lines = sql_code_lines(answer)
            code = "\n".join(code_lines)
            required = {
                "full_query": all(term in code.lower() for term in ("select", "from purchases", "where")),
                "exact_female": "'Female'" in code,
                "exact_short_literal": "'F'" in code,
                "both_literals": bool(
                    re.search(r"\bIN\s*\(\s*'Female'\s*,\s*'F'\s*\)", code)
                    or (
                        re.search(r"=\s*'Female'", code)
                        and re.search(r"=\s*'F'", code)
                        and re.search(r"\bOR\b", code, re.IGNORECASE)
                    )
                ),
                "no_lowercase_substitution": "'female'" not in code and "'f'" not in code,
            }
            if not all(required.values()):
                raise RuntimeError(
                    f"sql exact-literal assertions failed: done={done}, required={required}\n{answer}"
                )
            print(answer)
            print(
                "VISION SQL EXACT LITERALS PASS: "
                f"model={done.get('model')} first={done.get('_e2e_first_chunk_ms')}ms "
                f"total={done.get('_e2e_total_ms')}ms required={required}"
            )
            return 0
        if args.sql_format:
            code_lines = sql_code_lines(answer)
            lowered_code = "\n".join(code_lines).lower()
            every_line_explained = every_code_line_has_following_comment(code_lines, "--")
            required = {
                "spoken_summary_before_code": has_short_spoken_summary_before_code(answer),
                "fenced_code": len(code_lines) >= 3,
                "select_sum": "select" in lowered_code and "sum" in lowered_code,
                "from_purchases": "from purchases" in lowered_code,
                "case_insensitive_filter": "lower" in lowered_code and "female" in lowered_code,
                "russian_comment_every_line": every_line_explained,
            }
            if not done or not all(required.values()):
                raise RuntimeError(
                    f"sql-format vision assertions failed: done={done}, required={required}\n{answer}"
                )
            print(answer)
            print(f"VISION SQL FORMAT PASS: model={done.get('model')} required={required}")

            follow_up_question = (
                "Теперь доработай предыдущий SQL: не удаляй фильтр по полу и добавь условие "
                "items > 0. Верни полный обновлённый запрос с русским комментарием на каждой строке."
            )
            follow_up_context = (
                "[ПРЕДЫДУЩАЯ ЗАДАЧА НА ЭКРАНЕ]\n"
                f"Вопрос: {question}\n"
                f"Последний ответ SkillCue:\n{answer}\n"
                "[ТЕКУЩЕЕ УТОЧНЕНИЕ]\n"
                f"{follow_up_question}"
            )
            follow_up_answer, follow_up_done = _request_screen(
                port,
                token,
                {**payload, "question": follow_up_question, "context": follow_up_context},
            )
            follow_up_lines = sql_code_lines(follow_up_answer)
            follow_up_code = "\n".join(follow_up_lines).lower()
            follow_up_required = {
                "spoken_summary_before_code": has_short_spoken_summary_before_code(
                    follow_up_answer
                ),
                "full_query": all(term in follow_up_code for term in ("select", "from purchases", "where")),
                "preserved_gender_filter": "lower" in follow_up_code and "female" in follow_up_code,
                "added_items_filter": bool(re.search(r"items\s*>\s*0", follow_up_code)),
                "russian_comment_every_line": every_code_line_has_following_comment(
                    follow_up_lines, "--"
                ),
            }
            if not follow_up_done or not all(follow_up_required.values()):
                raise RuntimeError(
                    "sql follow-up assertions failed: "
                    f"done={follow_up_done}, required={follow_up_required}\n{follow_up_answer}"
                )
            print(follow_up_answer)
            print(
                "VISION SQL FOLLOW-UP PASS: "
                f"model={follow_up_done.get('model')} required={follow_up_required}"
            )
            return 0
        if args.fixture_order:
            trace = fixture_trace(answer)
            rewrote_source = "@pytest.fixture" in answer or "def session_fixture" in answer
            if not done or not fixture_trace_is_valid(trace) or rewrote_source:
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
