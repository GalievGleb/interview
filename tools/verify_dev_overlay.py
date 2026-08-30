"""Headless end-to-end check of the installed SkillCue Dev overlay API path.

This intentionally does not launch Electron. It starts the backend shipped in
the installed Dev build, sends the exact SSE request used by OverlayPage, and
validates both transport and answer quality.
"""

from __future__ import annotations

import json
import os
import re
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

CASES = (
    {
        "name": "test-design",
        "question": "Что такое техники тест-дизайна? Назови несколько примеров и кратко объясни их.",
        "concepts": ("эквивалент", "граничн", "таблиц", "попарн", "состояни", "сценар", "use case"),
    },
    {
        "name": "oop-at-work",
        "question": "ООП, который ты используешь на своей работе.",
        "concepts": (
            "page object", "локатор", "ui", "python", "basepage", "автотест",
            "страниц", "класс", "инкапсул", "композиц", "наслед", "полиморф",
            "селектор", "метод", "интерфейс", "действ",
        ),
    },
    {
        "name": "resume-experience",
        "question": "Расскажите кратко о вашем опыте автоматизации тестирования.",
        "concepts": ("автоматиз", "python", "pytest", "ui", "api", "тест", "page object"),
    },
    {
        "name": "commented-code",
        "question": (
            "Напиши декоратор на Python, который принимает функцию с args и kwargs, "
            "замеряет время выполнения и возвращает результат."
        ),
        "concepts": ("def ", "*args", "**kwargs", "time", "return"),
        "code_contract": True,
    },
    {
        "name": "report-garbled-python-types",
        "question": "Каки ти подадна в Питоните знаеш.",
        "concepts": (
            "тип", "python", "int", "float", "str", "list", "dict", "tuple",
            "set", "bool", "числ", "строк", "спис", "словар", "кортеж", "множ",
        ),
    },
    {
        "name": "report-spoken-sorted",
        "question": "Сорт, точка сорт применяется?",
        "concepts": ("sorted", "list.sort", "нов", "спис", "мест", "none"),
    },
    {
        "name": "report-explicit-test-design-at-work",
        "question": "Опиши, пожалуйста, технику тест-дизайна, которую ты используешь на своей работе.",
        "concepts": (
            "эквивалент", "граничн", "значен", "диапазон", "поле", "провер",
            "риск", "класс", "тест-дизайн",
        ),
        "forbidden": ("полиморф", "наследован", "интерфейс для унификации страниц"),
        "experienced_practical": True,
    },
    {
        "name": "report-garbled-oop-at-work",
        "question": "ОПО, который ты используешь на своей работе.",
        "concepts": (
            "page object", "локатор", "ui", "python", "basepage", "автотест",
            "страниц", "класс", "инкапсул", "композиц", "селектор", "метод",
        ),
        "forbidden": ("стандарт безопасности", "обучение сотрудников", "контроль доступа"),
        "experienced_practical": True,
    },
    {
        "name": "report-noisy-commented-code",
        "question": (
            "Можешь сказать, вот... Написать, можешь сказать, вот... Написать, точнее, "
            "мне функцию сейчас, декоратор, который принимает аргсы, кварксы и считает, "
            "сколько времени выполняется сама функция."
        ),
        "concepts": ("def ", "*args", "**kwargs", "time", "return"),
        "code_contract": True,
    },
    {
        "name": "report-sort-vs-sorted",
        "question": "Расскажи, пожалуйста, в чём разница между sort и sorted.",
        "concepts": ("sorted", "list.sort", "нов", "спис", "мест", "none"),
        "sorting_contract": True,
    },
    {
        "name": "report-docker-compose",
        "question": "Что такое Docker Compose?",
        "concepts": ("docker compose", "yaml", "контейнер", "сервис", "сеть", "том"),
    },
    {
        "name": "report-cicd-no-vendor-invention",
        "question": "Как ты настраивал YAML-файл? Как ты настраивал CI/CD у себя на работе?",
        "concepts": ("yaml", "ci/cd", "стад", "pytest", "docker", "артефакт", "allure", "лог"),
        "forbidden": ("gitlab ci", "jenkins"),
    },
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


def _request_answer(port: int, token: str, case: dict) -> tuple[str, dict, int, int]:
    question = str(case["question"])
    payload = {
        "question": question,
        "raw_question": question,
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

    if first_chunk_ms is None:
        raise RuntimeError(f"{case['name']}: overlay stream returned no chunks.")
    if first_chunk_ms > 5_000:
        raise RuntimeError(f"{case['name']}: first token was too slow: {first_chunk_ms} ms")
    if done is None:
        raise RuntimeError(f"{case['name']}: overlay stream returned no done event.")

    spoken = str(done.get("spoken") or "").strip()
    total_ms = round((time.monotonic() - started) * 1000)
    return spoken, done, first_chunk_ms, total_ms


def _validate_answer(case: dict, spoken: str) -> list[str]:
    normalized = spoken.lower()
    concepts = [term for term in case["concepts"] if term in normalized]
    minimum_by_case = {
        "commented-code": 5,
        "report-garbled-python-types": 4,
        "report-spoken-sorted": 4,
        "report-explicit-test-design-at-work": 3,
        "report-garbled-oop-at-work": 3,
        "report-noisy-commented-code": 5,
        "report-sort-vs-sorted": 4,
        "report-docker-compose": 3,
        "report-cicd-no-vendor-invention": 3,
    }
    minimum_length_by_case = {
        # A direct list of built-in types is complete without explanatory filler.
        "report-garbled-python-types": 35,
    }
    minimum = minimum_by_case.get(case["name"], 2)
    minimum_length = minimum_length_by_case.get(case["name"], 80)
    if len(spoken) < minimum_length or len(concepts) < minimum:
        raise RuntimeError(
            f"{case['name']}: semantic validation failed "
            f"(length={len(spoken)}, concepts={concepts})."
        )
    if case["name"] == "oop-at-work":
        oop_groups = (
            ("ui", "автотест", "page object", "тестах", "страниц"),
            ("класс", "инкапсул", "композиц", "наслед", "полиморф"),
            ("локатор", "действ", "селектор", "метод", "basepage", "интерфейс"),
        )
        if not all(any(term in normalized for term in group) for group in oop_groups):
            raise RuntimeError(
                "oop-at-work: answer lacks UI-test context, an OOP mechanism, "
                f"or a concrete implementation detail (concepts={concepts})."
            )
    leaked_labels = (
        "decisive difference",
        "enforced:",
        "convention:",
        "mechanism:",
    )
    leaked = [label for label in leaked_labels if label in normalized]
    if leaked:
        raise RuntimeError(f"{case['name']}: leaked English prompt labels: {leaked}.")
    forbidden = [term for term in case.get("forbidden", ()) if term in normalized]
    if forbidden:
        raise RuntimeError(f"{case['name']}: unsupported claims found: {forbidden}.")
    if case.get("experienced_practical"):
        generic_advice = (
            "используйте ",
            "вам следует ",
            "рекомендуется ",
            "важно учитывать ",
            "такой подход обеспечивает",
        )
        leaked_advice = [phrase for phrase in generic_advice if phrase in normalized]
        if leaked_advice:
            raise RuntimeError(
                f"{case['name']}: answer sounds like generic advice: {leaked_advice}."
            )
    if case.get("code_contract"):
        code_start = spoken.find("```")
        plan = spoken[:code_start].strip() if code_start >= 0 else ""
        if len(plan) < 15:
            raise RuntimeError("commented-code: no short spoken plan before the code block.")
        code_end = spoken.find("```", code_start + 3) if code_start >= 0 else -1
        code_block = spoken[code_start + 3:code_end] if code_end > code_start else ""
        code_lines = [line for line in code_block.splitlines() if line.strip()]
        if code_lines and code_lines[0].strip().lower() in {"py", "python"}:
            code_lines = code_lines[1:]
        inline_comments = [line for line in code_lines if "#" in line and not line.lstrip().startswith("#")]
        if len(inline_comments) < 4 or len(inline_comments) < len(code_lines) * 0.8:
            raise RuntimeError(
                "commented-code: meaningful lines are not consistently explained "
                f"({len(inline_comments)}/{len(code_lines)} inline comments)."
            )
        comment_texts = [line.split("#", 1)[1] for line in inline_comments]
        non_russian = [comment for comment in comment_texts if not re.search(r"[А-Яа-яЁё]", comment)]
        if non_russian:
            raise RuntimeError(
                "commented-code: every natural-language inline comment must be Russian "
                f"(non_russian={non_russian})."
            )
    if case["name"] == "report-garbled-python-types" and any(
        phrase in normalized for phrase in ("уточните", "поясните", "не расслышал")
    ):
        raise RuntimeError("report-garbled-python-types: model asked for clarification.")
    if case["name"] == "report-spoken-sorted" or case.get("sorting_contract"):
        required = ("sorted", "list.sort", "нов", "мест", "none")
        missing = [term for term in required if term not in normalized]
        if missing:
            raise RuntimeError(
                f"report-spoken-sorted: verified distinction is incomplete (missing={missing})."
            )
    return concepts


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
        for case in CASES:
            spoken, done, first_chunk_ms, total_ms = _request_answer(port, token, case)
            print(f"Question: {case['question']}")
            print(f"Spoken answer: {spoken}")
            expected_model = str(case.get("expected_model") or "qwen/qwen3.5-flash-02-23")
            if done.get("model") != expected_model:
                raise RuntimeError(
                    f"{case['name']}: expected model {expected_model}, got {done.get('model')}"
                )
            concepts = _validate_answer(case, spoken)
            print(
                f"OK overlay E2E [{case['name']}]: model={done.get('model')} "
                f"first_chunk={first_chunk_ms}ms total={total_ms}ms concepts={','.join(concepts)}"
            )
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
