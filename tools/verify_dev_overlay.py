"""Headless end-to-end check of an installed private SkillCue channel.

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

DEFAULT_E2E_CANDIDATE_CONTEXT = (
    "QA Automation Engineer. Основной стек: Python, pytest, Playwright, REST API, "
    "Allure и CI/CD. Поддерживал UI- и API-автотесты, фикстуры pytest, "
    "Page Object и диагностику нестабильных тестов в пайплайне."
)


def _candidate_context() -> str:
    return (
        os.environ.get("SKILLCUE_E2E_CANDIDATE_CONTEXT", "").strip()
        or DEFAULT_E2E_CANDIDATE_CONTEXT
    )


CASES = (
    {
        "name": "test-design",
        "question": "Что такое техники тест-дизайна? Назови несколько примеров и кратко объясни их.",
        "concepts": (
            "эквивалент",
            "граничн",
            "таблиц",
            "попарн",
            "состояни",
            "сценар",
            "use case",
        ),
    },
    {
        "name": "oop-at-work",
        "question": "ООП, который ты используешь на своей работе.",
        "concepts": (
            "page object",
            "локатор",
            "ui",
            "python",
            "basepage",
            "автотест",
            "страниц",
            "класс",
            "инкапсул",
            "композиц",
            "наслед",
            "полиморф",
            "селектор",
            "метод",
            "интерфейс",
            "действ",
        ),
    },
    {
        "name": "resume-experience",
        "question": "Расскажите кратко о вашем опыте автоматизации тестирования.",
        "concepts": (
            "автоматиз",
            "python",
            "pytest",
            "ui",
            "api",
            "тест",
            "page object",
        ),
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
            "тип",
            "python",
            "int",
            "float",
            "str",
            "list",
            "dict",
            "tuple",
            "set",
            "bool",
            "числ",
            "строк",
            "спис",
            "словар",
            "кортеж",
            "множ",
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
            "эквивалент",
            "граничн",
            "значен",
            "диапазон",
            "поле",
            "провер",
            "риск",
            "класс",
            "тест-дизайн",
        ),
        "forbidden": ("полиморф", "наследован", "интерфейс для унификации страниц"),
        "experienced_practical": True,
    },
    {
        "name": "report-garbled-oop-at-work",
        "question": "ОПО, который ты используешь на своей работе.",
        "concepts": (
            "page object",
            "локатор",
            "ui",
            "python",
            "basepage",
            "автотест",
            "страниц",
            "класс",
            "инкапсул",
            "композиц",
            "селектор",
            "метод",
        ),
        "forbidden": (
            "стандарт безопасности",
            "обучение сотрудников",
            "контроль доступа",
        ),
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
        "concepts": (
            "yaml",
            "ci/cd",
            "стад",
            "pytest",
            "docker",
            "артефакт",
            "allure",
            "лог",
        ),
        "forbidden": ("gitlab ci", "jenkins"),
    },
    {
        "name": "resume-cicd-how-it-was-set-up",
        "question": "Расскажи подробно, как у вас был устроен CI/CD для автотестов.",
        "concepts": (
            "ci/cd",
            "pytest",
            "docker",
            "allure",
            "пайплайн",
            "прогон",
            "артефакт",
            "лог",
        ),
        "resume_required": True,
        "forbidden": (
            "нет доступа к вашим внутренним",
            "какой стек технологий вы используете",
        ),
    },
    {
        "name": "report-python-method-kinds",
        "question": (
            "В чём разница между staticmethod, classmethod и обычным методом "
            "экземпляра? Когда каждый из них имеет смысл использовать?"
        ),
        "concepts": (
            "self",
            "cls",
            "staticmethod",
            "classmethod",
            "экземпляр",
            "конструкт",
        ),
    },
    {
        "name": "report-python-collections",
        "question": (
            "Чем отличаются list, tuple, set и dict? Какая у них примерно сложность "
            "поиска и почему set быстрее списка при x in collection?"
        ),
        "concepts": (
            "list",
            "спис",
            "tuple",
            "кортеж",
            "set",
            "множ",
            "dict",
            "словар",
            "o(n)",
            "o(1)",
            "хеш",
        ),
        "forbidden": ("формы, тест-дизайна", "python, pytest, docker, rest api"),
    },
    {
        "name": "report-flaky-api",
        "question": (
            "API-тест иногда получает 500, но при повторном запуске проходит. "
            "Как искать причину и почему не стоит просто добавлять retry?"
        ),
        "concepts": (
            "request",
            "response",
            "лог",
            "correlation",
            "данн",
            "retry",
            "ретра",
        ),
        "forbidden": (
            "stable locator",
            "стабильный локатор",
            "explicit wait",
            "явное ожидание",
        ),
    },
    {
        "name": "report-http-idempotency",
        "question": (
            "В чём разница между GET, POST, PUT, PATCH и DELETE? Какие методы "
            "идемпотентны и что означает идемпотентность?"
        ),
        "concepts": ("get", "post", "put", "patch", "delete", "идемпотент", "состояни"),
        "http_idempotency_contract": True,
    },
    {
        "name": "report-pytest-xdist",
        "question": (
            "500 UI-тестов на pytest идут два часа. Как ускорить прогон через "
            "pytest-xdist и избежать проблем параллельного запуска?"
        ),
        "concepts": ("xdist", "-n auto", "воркер", "паралл", "изоляц", "данн", "общ"),
        "forbidden": ("разбив прогон на 20 минут", "scope=module, а не session"),
        "xdist_contract": True,
    },
    {
        "name": "unseen-async-not-always-faster",
        "question": (
            "Коллега утверждает, что async-версия любой Python-функции всегда "
            "быстрее синхронной. Это так? Когда async помогает, а когда нет?"
        ),
        "concepts": (
            "async",
            "не всегда",
            "не обязательно",
            "i/o",
            "io",
            "ожидан",
            "cpu",
        ),
        "required_groups": (
            ("не всегда", "не обязательно", "не гарант", "нет, это не так"),
            ("i/o", "io", "ожидан"),
            ("cpu", "процессор", "вычисл"),
        ),
    },
    {
        "name": "unseen-workers-not-linear",
        "question": (
            "Если 500 тестов идут 40 минут, четыре воркера гарантированно сократят "
            "прогон до 10 минут? Как это проверить?"
        ),
        "concepts": (
            "не гарант",
            "не обязательно",
            "воркер",
            "ресурс",
            "база",
            "измер",
            "замер",
        ),
        "required_groups": (
            ("не гарант", "не обязательно", "не обязательно в четыре"),
            ("ресурс", "база", "сеть", "конкур", "наклад", "bottleneck", "узк"),
            ("измер", "замер", "сравн", "профилир"),
        ),
    },
    {
        "name": "unseen-sql-null-premise",
        "question": (
            "Правда ли, что NOT IN всегда безопасно исключает найденные строки, "
            "даже если подзапрос может вернуть NULL?"
        ),
        "concepts": ("not in", "null", "unknown", "неизвест", "not exists"),
        "required_groups": (
            ("не всегда", "небезопас", "нет", "не гарант"),
            ("unknown", "неизвест"),
        ),
    },
)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _e2e_channel() -> str:
    channel = os.environ.get("SKILLCUE_E2E_CHANNEL", "dev").strip().lower()
    if channel not in {"dev", "alpha"}:
        raise RuntimeError("SKILLCUE_E2E_CHANNEL must be dev or alpha")
    return channel


def _installed_backend() -> Path:
    override = os.environ.get("SKILLCUE_E2E_BACKEND", "").strip()
    if override:
        return Path(override)
    local = Path(os.environ["LOCALAPPDATA"])
    return (
        local
        / "Programs"
        / f"skillcue-{_e2e_channel()}"
        / "resources"
        / "backend"
        / "skillcue-backend.exe"
    )


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
        "candidate_context": _candidate_context(),
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
        if response.status != 200:
            raise RuntimeError(f"Overlay API returned HTTP {response.status}")
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            if event.get("type") == "error":
                raise RuntimeError(
                    f"Overlay SSE error: {event.get('message', 'unknown error')}"
                )
            if event.get("type") == "chunk":
                if first_chunk_ms is None:
                    first_chunk_ms = round((time.monotonic() - started) * 1000)
                chunks.append(str(event.get("text") or ""))
            if event.get("type") == "done":
                done = event

    if first_chunk_ms is None:
        raise RuntimeError(f"{case['name']}: overlay stream returned no chunks.")
    if first_chunk_ms > 5_000:
        raise RuntimeError(
            f"{case['name']}: first token was too slow: {first_chunk_ms} ms"
        )
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
        "report-python-method-kinds": 4,
        "report-python-collections": 6,
        "report-flaky-api": 3,
        "report-http-idempotency": 6,
        "report-pytest-xdist": 4,
        "unseen-async-not-always-faster": 2,
        "unseen-workers-not-linear": 2,
        "unseen-sql-null-premise": 2,
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
            raise RuntimeError(
                "commented-code: no short spoken plan before the code block."
            )
        code_end = spoken.find("```", code_start + 3) if code_start >= 0 else -1
        code_block = spoken[code_start + 3 : code_end] if code_end > code_start else ""
        code_lines = [line for line in code_block.splitlines() if line.strip()]
        if code_lines and code_lines[0].strip().lower() in {"py", "python"}:
            code_lines = code_lines[1:]
        inline_comments = [
            line
            for line in code_lines
            if "#" in line and not line.lstrip().startswith("#")
        ]
        if len(inline_comments) < 4 or len(inline_comments) < len(code_lines) * 0.8:
            raise RuntimeError(
                "commented-code: meaningful lines are not consistently explained "
                f"({len(inline_comments)}/{len(code_lines)} inline comments)."
            )
        comment_texts = [line.split("#", 1)[1] for line in inline_comments]
        non_russian = [
            comment
            for comment in comment_texts
            if not re.search(r"[А-Яа-яЁё]", comment)
        ]
        if non_russian:
            raise RuntimeError(
                "commented-code: every natural-language inline comment must be Russian "
                f"(non_russian={non_russian})."
            )
    if case["name"] == "report-garbled-python-types" and any(
        phrase in normalized for phrase in ("уточните", "поясните", "не расслышал")
    ):
        raise RuntimeError(
            "report-garbled-python-types: model asked for clarification."
        )
    if case["name"] == "report-spoken-sorted" or case.get("sorting_contract"):
        required_groups = (
            ("sorted",),
            ("list.sort",),
            ("нов",),
            ("мест",),
            ("none", "ничего не возвращ"),
        )
        missing = [
            "/".join(group)
            for group in required_groups
            if not any(term in normalized for term in group)
        ]
        if missing:
            raise RuntimeError(
                f"report-spoken-sorted: verified distinction is incomplete (missing={missing})."
            )
    if case.get("http_idempotency_contract"):
        explicit_idempotent_list = re.search(
            r"идемпотентн\w*(?:\s+метод\w*)?\s+(?:являются|считаются)\s+"
            r"(?:метод\w*\s+)?(.+?)(?:[.;]|,\s*(?:тогда как|в то время))",
            normalized,
        )
        explicit_list_excludes_patch = bool(
            explicit_idempotent_list
            and "patch" not in explicit_idempotent_list.group(1)
            and all(
                method in explicit_idempotent_list.group(1)
                for method in ("get", "put", "delete")
            )
        )
        has_patch_caveat = "patch" in normalized and (
            explicit_list_excludes_patch
            or any(
                phrase in normalized
                for phrase in (
                    "не гарантированно идемпотент",
                    "не гарантирует идемпотентность",
                    "не считаются идемпотентными",
                    "не является идемпотентным по умолчанию",
                    "может быть идемпотентным",
                    "post и patch могут",
                )
            )
            or bool(
                re.search(
                    r"(?:post\s+и\s+)?patch.{0,30}неидемпотент",
                    normalized,
                )
            )
        )
        if not has_patch_caveat:
            raise RuntimeError(
                "report-http-idempotency: PATCH was presented without the required "
                "not-guaranteed caveat."
            )
    if case.get("xdist_contract"):
        conflates_scope_and_per_test_cleanup = (
            "session" in normalized or "module" in normalized
        ) and "после каждого теста" in normalized
        if conflates_scope_and_per_test_cleanup:
            raise RuntimeError(
                "report-pytest-xdist: session/module scope was incorrectly described "
                "as per-test cleanup."
            )
    missing_groups = [
        group
        for group in case.get("required_groups", ())
        if not any(term in normalized for term in group)
    ]
    if missing_groups:
        raise RuntimeError(
            f"{case['name']}: general reasoning contract is incomplete "
            f"(missing_groups={missing_groups})."
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
        "SKILLCUE_BUILD_CHANNEL": _e2e_channel(),
        "SKILLCUE_GATEWAY_URL": "https://skill-cue.ru/v1",
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
        requested_ids = {
            item.strip()
            for item in os.environ.get("SKILLCUE_E2E_CASE_IDS", "").split(",")
            if item.strip()
        }
        selected_cases = tuple(
            case for case in CASES if not requested_ids or case["name"] in requested_ids
        )
        if requested_ids and len(selected_cases) != len(requested_ids):
            known = {case["name"] for case in CASES}
            raise RuntimeError(
                f"Unknown overlay E2E cases: {sorted(requested_ids - known)}"
            )
        for case in selected_cases:
            spoken, done, first_chunk_ms, total_ms = _request_answer(port, token, case)
            print(f"Question: {case['question']}")
            print(f"Spoken answer: {spoken}")
            correction = done.get("correction") or {}
            if case.get("resume_required") and not correction.get(
                "resume_context_used"
            ):
                raise RuntimeError(
                    f"{case['name']}: selected resume context was not used "
                    f"(intent={correction.get('question_intent')})."
                )
            print(
                f"Route: intent={correction.get('question_intent')} "
                f"model={done.get('model')}"
            )
            automatic_model = (
                "google/gemini-3.5-flash"
                if correction.get("question_intent") == "technical_comparison"
                else "qwen/qwen3.5-flash-02-23"
            )
            expected_model = str(
                case.get("expected_model")
                or os.environ.get("SKILLCUE_E2E_MODEL", "").strip()
                or automatic_model
            )
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
