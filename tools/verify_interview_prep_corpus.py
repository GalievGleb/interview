"""Evaluate the installed SkillCue Dev overlay against the interview-prep corpus.

Development/CI tooling only. Starts the backend from the installed Dev app and
sends the same /chat/interview/stream SSE payload as OverlayPage. The compact
rubrics are derived from interview-prep-python-git-pytest-api-ru.md; they test
meaning, not exact wording.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SOURCE = Path(
    r"C:\Users\gleb\Projects\os\interview-prep\interview-prep-python-git-pytest-api-ru.md"
)


@dataclass(frozen=True)
class Case:
    id: str
    category: str
    question: str
    required: tuple[tuple[str, ...], ...]
    min_coverage: float = 0.67
    max_words: int | None = 120


CASES = (
    Case("git-stash", "git", "Что делает команда git stash? Назови основные команды.", (("незакоммич", "изменен"), ("временно", "хранилищ"), ("stash pop", "pop"), ("apply",), ("untracked", "-u"))),
    Case("git-rebase", "git", "Как работает git rebase, что происходит с хешами и как разрешить или отменить конфликт?", (("перенос", "поверх"), ("хеш", "hash"), ("rebase --continue", "--continue"), ("rebase --abort", "--abort"), ("перепис", "общей ветк", "опубликован"))),
    Case("git-fetch-pull", "git", "В чём разница между git pull и git fetch?", (("fetch",), ("не измен", "не объедин", "не выполняя слиян", "не сливает"), ("pull",), ("merge", "rebase", "слияни", "сливает измен", "автоматически объединяет"))),
    Case("oop", "python", "Назови и кратко объясни основные принципы ООП.", (("инкапсул",), ("наслед",), ("полиморф",), ("абстрак",))),
    Case("encapsulation", "python", "Как реализована инкапсуляция в Python? Какие есть уровни доступа и можно ли обратиться к __private снаружи?", (("соглашен", "не строг"), ("_protected", "один подч", "одним подчеркив"), ("__private", "два подч", "двумя подчеркив"), ("name mangling", "_classname", "преобраз"), ("property",)), min_coverage=0.6),
    Case("pytest-fixtures", "pytest", "Что такое фикстуры pytest? Объясни yield, teardown и scope.", (("подгот", "setup"), ("yield",), ("teardown", "очист"), ("function", "функц"), ("module", "модул"), ("session", "сесс"))),
    Case("string-index", "python-code", "Что произойдёт в Python с выражением '1234567890'[6] == 7 и затем с кодом s = 'hello'; s[0] = 'H'?", (("false", "лож"), ("'7'", "строка 7", "символ"), ("typeerror", "нельзя измен", "неизменяем")), max_words=110),
    Case("string-literal-assignment", "python-code", "Что произойдёт при присваивании элементу строки: '1234567890'[6] = 7?", (("syntaxerror", "синтаксическ"), ("нельзя присва", "cannot assign"), ("неизменяем", "immutable")), max_words=90),
    Case("python-types", "python", "Назови основные типы Python и раздели mutable и immutable.", (("int", "целые чис"), ("str", "строк"), ("list", "списк"), ("dict", "словар"), ("set", "множеств"), ("tuple", "кортеж"), ("изменяем", "mutable"), ("неизменяем", "immutable")), min_coverage=0.75),
    Case("argument-passing", "python", "В Python передача по ссылке или по значению? Объясни на mutable объекте и переназначении имени.", (("объект", "присваив"), ("ссыл", "то же"), ("изменяем", "mutable"), ("переназнач", "локальн"))),
    Case("dict-squares", "python-code", "Напиши однострочник: словарь квадратов чисел от 0 до 9.", (("{", "dict"), ("for",), ("range(10)", "range (10)"), ("** 2", "**2", "x*x", "x * x")), max_words=None),
    Case("range-generator", "python", "range в Python 3 — это генератор? Что использовалось в Python 2?", (("не генератор",), ("ленив", "iterable", "итерируем"), ("xrange",), ("список",))),
    Case("zip-dict", "python-code", "Какой результат: dict(zip(('a','b','c','d','e'), (1,2,3,4,5)))? Что делает zip?", (("'a': 1", '"a": 1'), ("'e': 5", '"e": 5'), ("позиц", "пар", "объединяет элемент", "кортеж")), max_words=100),
    Case("zip-shortest", "python", "Что будет, если передать в zip последовательности разной длины?", (("корот",), ("останов", "длина которой равна", "будет равна длине"), ("без ошиб", "не будут учтен", "игнорир", "просто не"))),
    Case("sorted-dict", "python-code", "Дан D={'a':1,'b':2,'c':3,'d':4,'e':5}. Что вернёт sorted([D[s] for s in D]) и меняет ли sorted исходный объект?", (("[1, 2, 3, 4, 5]",), ("нов", "возвращ"), ("не измен",))),
    Case("default-args", "python-code", "Напиши функцию interview(name, company), которая печатает '<name> на собеседовании в <company>', компания по умолчанию Ozon.", (("def interview",), ("company=\"ozon\"", "company='ozon'", "company = \"ozon\"", "company = 'ozon'"), ("print",), ("f\"", "f'")), max_words=None),
    Case("mutable-default", "python", "Почему нельзя использовать список как значение аргумента по умолчанию и как сделать правильно?", (("один раз", "определен"), ("между вызов", "общ", "всеми вызов", "разделяться"), ("none",), ("items = []", "создать новый", "создавать новый"))),
    Case("fixture-order", "pytest-code", "Как определить порядок выполнения pytest-фикстур разных scope, autouse, зависимостей и teardown после yield?", (("session",), ("module",), ("зависим",), ("autouse",), ("yield",), ("обратн", "teardown")), min_coverage=0.75),
    Case(
        "fixture-order-exact",
        "pytest-code",
        "Как определить точный порядок для кода: session_fixture scope=session; module_fixture scope=module; fixture_1 зависит от fixture_3 и fixture_4; autouse_fixture autouse=True; fixture_2 обычная; fixture_4 делает yield, затем append('fixture_4'); test_order запрашивает fixture_1, module_fixture, fixture_2, session_fixture?",
        (("session_fixture",), ("module_fixture",), ("autouse_fixture",), ("fixture_3",), ("fixture_4",), ("fixture_1",), ("fixture_2",), ("teardown", "после тест", "после yield")),
        min_coverage=1.0,
        max_words=180,
    ),
    Case("instance-equality", "python-code", "Что вернёт a == b для a=C(); b=C(), если class C: pass? А для a=b=C()? Как сравнивать по содержимому?", (("false", "лож"), ("разн", "два объект"), ("true", "истин"), ("один объект", "is"), ("__eq__",))),
    Case("inheritance-composition", "python", "Когда использовать наследование, а когда композицию?", (("is-a", "является", "иерархи"), ("has-a", "имеет", "содерж"), ("связан", "жестк"), ("гибк", "замен", "комбинир"))),
    Case("context-manager", "python-code", "Что такое контекстный менеджер и как реализовать свой через класс или contextmanager?", (("__enter__",), ("__exit__",), ("yield",), ("try", "finally"), ("исключ", "гарант")), min_coverage=0.6, max_words=None),
    Case("generator", "python", "Что такое генератор, какие задачи решает и чем отличается от итератора?", (("yield",), ("состояни", "приостан", "управляет состоянием"), ("ленив", "по мере необходимости"), ("__next__", "next"), ("каждый генератор", "не каждый итератор", "вид итератора"))),
    Case("generator-exhaustion", "python", "Что возвращает next(generator), что будет после окончания и можно ли взять элемент по индексу?", (("следующ",), ("stopiteration",), ("нельзя", "невозможно", "typeerror", "не поддерживают доступ по индексу", "не поддерживают индексац"))),
    Case("api-last-order", "api", "Как протестировать GET /client/last_order? Есть client_id, order_id, массив order и order_price. Покрой позитивный сценарий, клиента без заказов, отсутствующего клиента, валидацию, авторизацию и бизнес-правила.", (("200",), ("пуст", "[]"), ("404",), ("400", "422"), ("401",), ("403",), ("схем", "тип"), ("последн", "дат"), ("сумм", "order_price")), min_coverage=0.67, max_words=150),
)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _installed_backend() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "Programs" / "skillcue-dev" / "resources" / "backend" / "skillcue-backend.exe"


def _wait_for_health(port: int, deadline: float) -> None:
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.2)
    raise RuntimeError("The isolated SkillCue Dev backend did not start")


def _stream_case(port: int, token: str, case: Case) -> dict:
    payload = {
        "question": case.question,
        "raw_question": case.question,
        "mode": "fast",
        "fast_answer": True,
        "answer_language": "ru",
    }
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/chat/interview/stream",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", "X-SkillCue-Token": token},
        method="POST",
    )
    started = time.monotonic()
    first_chunk_ms = None
    done = None
    events = []
    with urllib.request.urlopen(req, timeout=45) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            events.append(event.get("type"))
            if event.get("type") == "chunk" and first_chunk_ms is None:
                first_chunk_ms = round((time.monotonic() - started) * 1000)
            if event.get("type") in {"error", "stream_failed"}:
                raise RuntimeError(str(event))
            if event.get("type") == "done":
                done = event
    if not done:
        raise RuntimeError(f"No done event (events={events})")
    return {
        "spoken": str(done.get("spoken") or "").strip(),
        "model": done.get("model"),
        "first_chunk_ms": first_chunk_ms,
        "total_ms": round((time.monotonic() - started) * 1000),
        "correction": done.get("correction") or {},
    }


def _evaluate(case: Case, result: dict) -> dict:
    spoken = result["spoken"]
    normalized = re.sub(r"\s+", " ", spoken.lower().replace("ё", "е"))
    hits = []
    misses = []
    for group in case.required:
        aliases = tuple(alias.lower().replace("ё", "е") for alias in group)
        matched = next((alias for alias in aliases if alias in normalized), None)
        (hits if matched else misses).append(matched or "/".join(group))
    coverage = len(hits) / len(case.required) if case.required else 1.0
    words = len(spoken.split())
    forbidden = any(
        phrase in normalized
        for phrase in ("если хотите, могу", "с радостью отвечу", "важно отметить", "в заключение")
    )
    passed = (
        bool(spoken)
        and result["first_chunk_ms"] is not None
        and result["first_chunk_ms"] <= 25_000
        and coverage >= case.min_coverage
        and not forbidden
        and (case.max_words is None or words <= case.max_words)
    )
    return {
        **result,
        "id": case.id,
        "category": case.category,
        "question": case.question,
        "coverage": round(coverage, 3),
        "hits": hits,
        "misses": misses,
        "word_count": words,
        "forbidden_filler": forbidden,
        "passed": passed,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--source-backend", action="store_true", help="run app.main via uvicorn instead of installed Dev")
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if hasattr(os.sys.stdout, "reconfigure"):
        os.sys.stdout.reconfigure(encoding="utf-8")

    repo_root = Path(__file__).resolve().parent.parent
    backend = _installed_backend()
    api_root = repo_root / "apps" / "api-py"
    if not args.source_backend and not backend.exists():
        raise RuntimeError(f"Installed SkillCue Dev backend not found: {backend}")
    selected = [case for case in CASES if not args.case_ids or case.id in args.case_ids]
    unknown = set(args.case_ids or ()) - {case.id for case in CASES}
    if unknown:
        raise RuntimeError(f"Unknown case ids: {sorted(unknown)}")

    source_hash = None
    if args.source.exists():
        source_hash = hashlib.sha256(args.source.read_bytes()).hexdigest()

    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-corpus-{token}.sqlite"
    env = {
        **os.environ,
        "SKILLCUE_PORT": str(port),
        "SKILLCUE_API_TOKEN": token,
        "SKILLCUE_BUILD_CHANNEL": "dev",
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
    }
    command = [str(backend)]
    process_cwd = None
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
        process_cwd = api_root
    process = subprocess.Popen(
        command,
        cwd=process_cwd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    results = []
    try:
        _wait_for_health(port, time.monotonic() + 12)
        for index, case in enumerate(selected, 1):
            try:
                evaluated = _evaluate(case, _stream_case(port, token, case))
            except Exception as exc:  # noqa: BLE001 - evaluation must continue
                evaluated = {
                    "id": case.id,
                    "category": case.category,
                    "question": case.question,
                    "passed": False,
                    "error": str(exc),
                }
            results.append(evaluated)
            status = "PASS" if evaluated["passed"] else "FAIL"
            details = (
                f"coverage={evaluated.get('coverage')} words={evaluated.get('word_count')} "
                f"first={evaluated.get('first_chunk_ms')}ms"
            )
            print(f"[{index:02d}/{len(selected):02d}] {status} {case.id}: {details}")
            if not evaluated["passed"]:
                print(f"  missing: {evaluated.get('misses')}")
                print(f"  answer: {evaluated.get('spoken') or evaluated.get('error')}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        for _ in range(10):
            try:
                db_path.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.2)

    report = {
        "source": str(args.source),
        "source_sha256": source_hash,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "passed": sum(bool(item["passed"]) for item in results),
        "total": len(results),
        "results": results,
    }
    report_path = args.report or Path(tempfile.gettempdir()) / "skillcue-interview-prep-corpus-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SUMMARY {report['passed']}/{report['total']} passed; report={report_path}")
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
