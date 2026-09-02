"""Domain-specific hints injected into interview prompts when the question topic matches."""

from __future__ import annotations

import re

_POM_RE = re.compile(
    r"page\s*object|\bpom\b|page\s*object\s*model",
    re.IGNORECASE | re.UNICODE,
)
_LAST_ORDER_RE = re.compile(
    r"last[_\s-]?order|последн\w*\s+заказ",
    re.IGNORECASE | re.UNICODE,
)
_API_RE = re.compile(
    r"\bapi\b|rest\s*api|http[\s-]*api|endpoint|swagger|graphql",
    re.IGNORECASE | re.UNICODE,
)
_PYTEST_FIXTURES_RE = re.compile(
    r"fixtures?|фикстур|conftest|\bpytest\b",
    re.IGNORECASE | re.UNICODE,
)
_GIT_REBASE_RE = re.compile(r"\bgit\b.{0,40}\brebase\b|\brebase\b", re.IGNORECASE | re.UNICODE)
_FLAKY_RE = re.compile(
    r"flaky|нестабильн|флейки|"
    r"(?:ci\s*/?\s*cd|cicd|pipeline|пайплайн).{0,50}(?:тест|test|автотест)|"
    r"(?:тест|test|автотест).{0,50}(?:ci\s*/?\s*cd|cicd|pipeline|пайплайн|нестабиль|flaky)",
    re.IGNORECASE | re.UNICODE,
)

_TEST_CASE_RE = re.compile(
    r"test[\s-]?case|тест[\s-]?кейс|тесткейс",
    re.IGNORECASE | re.UNICODE,
)
_CHECKLIST_RE = re.compile(
    r"check[\s-]?list|чек[\s-]?лист|чеклист",
    re.IGNORECASE | re.UNICODE,
)
_BUG_REPORT_RE = re.compile(
    r"bug[\s-]?report|баг[\s-]?репорт|багрепорт|bag report|back report|bakr report|"
    r"что\s+должн\w*\s+быть\s+в\s+(?:bug|баг)",
    re.IGNORECASE | re.UNICODE,
)
_AUTOMATION_TYPES_RE = re.compile(
    r"(?:вид\w*|тип\w*)\s+автоматизац",
    re.IGNORECASE | re.UNICODE,
)
_TESTING_TYPES_RE = re.compile(
    r"(?:вид\w*|тип\w*)\s+тестировани",
    re.IGNORECASE | re.UNICODE,
)
_CICD_RE = re.compile(
    r"ci\s*/?\s*cd|cicd|пайплайн|pipeline|настраивал\w*\s+(?:ci|пайплайн)",
    re.IGNORECASE | re.UNICODE,
)
_DOCKER_RE = re.compile(r"\bdocker\b|докер", re.IGNORECASE | re.UNICODE)
_SMOKE_REGRESSION_RE = re.compile(
    r"smoke.{0,30}regression|regression.{0,30}smoke|смоук.{0,30}регресс|регресс.{0,30}смоук",
    re.IGNORECASE | re.UNICODE,
)
_STATIC_DYNAMIC_RE = re.compile(
    r"статическ\w*.{0,30}динамическ\w*|динамическ\w*.{0,30}статическ\w*|static.{0,20}dynamic",
    re.IGNORECASE | re.UNICODE,
)
_SORTED_LIST_SORT_RE = re.compile(
    r"\bsorted\s*\([^)]*\).{0,100}\blist\s*\.\s*sort\s*\(|"
    r"\blist\s*\.\s*sort\s*\([^)]*\).{0,100}\bsorted\s*\(",
    re.IGNORECASE | re.UNICODE,
)
_SQL_NOT_IN_NULL_RE = re.compile(
    r"\bnot\s+in\b.{0,160}\bnull\b|\bnull\b.{0,160}\bnot\s+in\b",
    re.IGNORECASE | re.UNICODE,
)
_PYTHON_DATA_TYPES_ASR_RE = re.compile(
    r"\bкаки\w*.{0,35}(?:подад\w*|данн\w*|тип\w*).{0,45}"
    r"(?:питон\w*|python).{0,35}зна\w*",
    re.IGNORECASE | re.UNICODE,
)
_SPOKEN_SORTED_LIST_SORT_RE = re.compile(
    r"\b(?:сорт(?:ед)?|sorted)\b[\s,.;:—-]{0,12}\bточк\w*\s+(?:сорт|sort)\b",
    re.IGNORECASE | re.UNICODE,
)
_SORT_AND_SORTED_ASR_RE = re.compile(
    r"\b(?:sort|сорт)\b.{0,45}\b(?:sorted|сортед)\b|"
    r"\b(?:sorted|сортед)\b.{0,45}\b(?:sort|сорт)\b",
    re.IGNORECASE | re.UNICODE,
)
_OOP_ASR_NEAR_MISS_RE = re.compile(
    r"\b(?:опо|по[оo]|[оo]п[oо]|oп[оo])\b",
    re.IGNORECASE | re.UNICODE,
)
_OOP_SOFTWARE_CONTEXT_RE = re.compile(
    r"использ\w*|примен\w*|принцип\w*|автотест\w*|ui|python|питон\w*|"
    r"(?:на|в)\s+(?:сво\w+\s+)?работ\w*",
    re.IGNORECASE | re.UNICODE,
)
_OOP_INDUSTRIAL_CONTEXT_RE = re.compile(
    r"опасн\w*|производствен\w*|промышлен\w*|объект\w*",
    re.IGNORECASE | re.UNICODE,
)
_TEST_DESIGN_RE = re.compile(
    r"тест[\s-]*дизайн|test[\s-]*design|класс\w*\s+эквивалент|граничн\w*\s+значен",
    re.IGNORECASE | re.UNICODE,
)
_TIMING_DECORATOR_ASR_RE = re.compile(
    r"\bдекоратор\w*.{0,180}(?:\bargs\b|аргс\w*).{0,90}"
    r"(?:\bkwargs\b|кваркс\w*).{0,120}\bврем\w*",
    re.IGNORECASE | re.UNICODE,
)
_OOP_PRACTICAL_RE = re.compile(
    r"(?:(?:\boop\b|ооп|объектно[\s-]*ориентирован\w*).{0,90}"
    r"(?:использ\w*|примен\w*|в\s+работ\w*|на\s+(?:сво\w+\s+)?работ\w*)|"
    r"(?:использ\w*|примен\w*).{0,90}(?:\boop\b|ооп|объектно[\s-]*ориентирован\w*))",
    re.IGNORECASE | re.UNICODE,
)

_POM_HINT = """TOPIC HINT — Page Object / POM (weave naturally into bullets, do NOT dump as a keyword list):
Name typical mistakes when relevant: god object; business logic inside page object; assertions inside page object;
duplicated locators; sleep instead of explicit/auto waits; unclear method names like clickButton1().
Sound like interview speech, not a checklist."""

_API_HINT = """TOPIC HINT — API testing:
For a broad theory question stay concise. For a concrete endpoint task use 6–9 compact bullets and up to 180 words so every requested scenario and assertion is present:
Weave naturally, do NOT dump as a keyword list. Mention when relevant:
- status code;
- response body;
- JSON schema / schema validation;
- headers;
- auth / token;
- negative cases;
- field/business validation;
- response time / latency.
Say «не только status code» if contrasting — that is a GOOD answer. Do NOT answer with «проверяю только статус-код».
If a concrete endpoint/schema is supplied, solve THAT contract rather than giving a generic checklist. REQUIRED for a last-order endpoint — explicitly name all of these in the answer: 200 + response schema/field types + order_price total calculation; existing client without orders (typically 200 + [] if the contract says so); missing client 404; invalid id 400/422; no authentication 401 versus insufficient permission 403; verify the returned order is truly latest by business date. Keep exact field names. Say statuses are typical and must be confirmed by Swagger when the contract does not prescribe them."""

_TEST_CASE_HINT = """TOPIC HINT — test case / тест-кейс (~3–6 sentences, list OK):
Answer about test case in general — NOT the previous interview topic.
Тест-кейс = конкретная проверка: что сделать, с какими данными, какой результат ожидается.
Mention: название; предусловия; шаги; тестовые данные; ожидаемый результат.
Example: «Проверить вход с корректным логином и паролем»."""

_CHECKLIST_HINT = """TOPIC HINT — checklist / чек-лист (~3–6 sentences, list OK):
Чек-лист = список проверок без детальных шагов; быстрее test case, меньше детализации.
Mention practical use: exploratory testing, smoke/sanity, release checklist, быстрые ad-hoc проверки.
Example: «Проверить login, logout, создание заказа, оплату»."""

_BUG_REPORT_HINT = """TOPIC HINT — bug report / баг-репорт (~3–6 sentences, list OK):
Mention: title/summary; steps to reproduce; actual vs expected result; severity; priority;
environment; attachments (screenshots, logs, video).
Do NOT say you do not know the term — this IS a standard QA artifact."""

_GIT_REBASE_HINT = """TOPIC HINT — git rebase (concise but complete):
rebase replays current-branch commits on top of the target base; replayed commits get new hashes because history is rewritten. Conflict flow: edit → git add → git rebase --continue; cancel with git rebase --abort. Warn not to rebase a shared published branch other people already use. Do not route Git hashes to Python knowledge."""

_PYTEST_EXACT_ORDER_HINT = """VERIFIED EXACT FIXTURE ORDER for the named example — answer with the complete sequence, do not stop at generic rules:
session_fixture → module_fixture → autouse_fixture → fixture_3 → fixture_4 setup (up to yield) → fixture_1 → fixture_2 → test_order → fixture_4 teardown (after yield).
Mention that dependencies force fixture_3/fixture_4 before fixture_1 and same-scope order must otherwise follow the dependency graph."""

_PYTEST_HINT = """TOPIC HINT — pytest / fixtures (concise say-aloud, max 4 bullets, ~50–80 words):
- fixtures = setup/teardown, test data prep, shared code reuse;
- scopes: function, class, module, session;
- yield = cleanup after test;
- conftest.py = shared fixtures without imports in every file;
- optional inline example only: API client, auth, test data.
Do NOT write a long Geomix/Sber story. Do NOT list every scope in a separate essay sentence."""

_FLAKY_HINT = """TOPIC HINT — flaky tests / CI/CD stability (weave naturally, do NOT dump as a keyword list):
Start from evidence: reproduce and compare logs/artifacts, then separate a product defect from test-data, environment, timing and concurrency problems. Isolate data and dependencies between runs. A retry is only a temporary diagnostic or resilience measure; it must not hide the root cause."""

_AUTOMATION_TYPES_HINT = """TOPIC HINT — виды/типы автоматизации (concise say-aloud, ~50–90 words):
Talk about WHAT gets automated, not «ручная автоматизация» (that is wrong/contradictory).
Cover by meaning: UI-автотесты (пользовательские сценарии через интерфейс), API (backend-контракты),
интеграционные (взаимодействие компонентов), regression/smoke (запуск в CI/CD).
Never say automation is done «вручную»."""
_AUTOMATION_TYPES_PERSONAL_HINT = (
    "Optional one personal line: «В моём опыте фокус был на UI и API — "
    "Playwright, HTTPX/pytest, Allure»."
)

_TESTING_TYPES_HINT = """TOPIC HINT — виды/типы тестирования (concise say-aloud, list OK):
Group by axes: по уровню (модульное, интеграционное, системное, приёмочное);
по цели (функциональное / нефункциональное — производительность, безопасность, удобство, совместимость);
по способу (ручное и автоматизированное)."""
_TESTING_TYPES_PERSONAL_HINT = "Optional one personal line on what you actually did."

_CICD_HINT = """TOPIC HINT — CI/CD (concise say-aloud, ~50–90 words, weave naturally):
Cover by meaning, not as a keyword dump: stages/jobs; Docker / одинаковое окружение; запуск тестов (pytest);
artifacts/reports; Allure; logs; variables/secrets (carefully). Do not name a CI vendor unless it is present in the question or supplied context."""
_CICD_PERSONAL_HINT = (
    "Personal framing if experience question: smoke и regression раздельными "
    "pipeline-запусками, артефакты для разбора падений."
)

_DOCKER_HINT = """TOPIC HINT — Docker (concise say-aloud, ~50–80 words):
Docker = контейнеризация: одинаковое окружение локально и в CI/CD, изоляция зависимостей, воспроизводимые прогоны тестов.
Mention when relevant: образ/Dockerfile, контейнер, запуск автотестов внутри, в связке с CI/CD."""
_DOCKER_PERSONAL_HINT = "Optional one personal line."

_SMOKE_REGRESSION_HINT = """TOPIC HINT — smoke vs regression (thesis + «Отличие:» + 2 points):
smoke = быстрый прогон ключевых/критичных сценариев после сборки, рано даёт сигнал «жив ли билд».
regression = более полная проверка, что изменения не сломали существующий функционал. Often: smoke в CI на каждый build, regression реже/отдельно."""

_STATIC_DYNAMIC_HINT = """TOPIC HINT — static vs dynamic testing (thesis + «Отличие:» + 2 points):
static = проверка без запуска кода (review, линтеры, анализ требований/документации).
dynamic = проверка с запуском приложения (функциональные, API, UI-тесты). Both complement each other."""

_SORTED_LIST_SORT_HINT = """VERIFIED PYTHON SORTING FACTS (use exactly; do not describe this as full vs partial/local sorting):
sorted(iterable) returns a new list; list.sort() mutates that list in place and returns None."""

_SQL_NOT_IN_NULL_HINT = """VERIFIED SQL THREE-VALUED LOGIC FACTS:
Answer in at least two sentences. First answer the yes/no premise directly with «Нет»: NOT IN is not safe when the subquery can return NULL. Then explain that the comparison becomes UNKNOWN and can filter out every candidate row; prefer NOT EXISTS, or explicitly exclude NULL from the subquery when that matches the intended contract."""

_OOP_PRACTICAL_HINT = """TOPIC HINT — practical OOP in Python UI test automation (answer as a concrete work-use example, without invented company facts or metrics):
In Python UI autotests, Page Object classes инкапсулируют локаторы and page actions; tests call readable business actions instead of working with selectors directly. Common behavior belongs in a small BasePage or reusable composition, while one shared interface lets page/client implementations be replaced without rewriting the test flow. Не своди ответ к перечислению шаблонов проектирования."""

_TEST_DESIGN_HINT = """TOPIC HINT — test design (answer the exact angle, not an adjacent programming-design topic):
For a practical question, give one concrete example: equivalence partitioning reduces a large input set to representative valid/invalid classes, then boundary-value analysis checks min/max and just outside the boundary. Explain the action and the defect risk it targets. If asked which techniques the candidate knows or uses, name at least three: add a decision table, state-transition testing or pairwise testing. Never replace test-design techniques with OOP principles or design patterns."""

_NONE_HINT = "(none — answer naturally; do not force unrelated QA terms or stack keywords)"


def resolve_fast_question_alias(question: str) -> str:
    """Точечно восстанавливает подтверждённые ASR-искажения без второго запроса к модели."""
    normalized = (question or "").strip()
    if _PYTHON_DATA_TYPES_ASR_RE.search(normalized):
        return "Какие типы данных в Python ты знаешь?"
    if _TIMING_DECORATOR_ASR_RE.search(normalized):
        return (
            "Напиши декоратор на Python, который принимает функцию с args и kwargs, "
            "замеряет время выполнения и возвращает результат."
        )
    if (
        _OOP_ASR_NEAR_MISS_RE.search(normalized)
        and _OOP_SOFTWARE_CONTEXT_RE.search(normalized)
        and not _OOP_INDUSTRIAL_CONTEXT_RE.search(normalized)
    ):
        return _OOP_ASR_NEAR_MISS_RE.sub("ООП", normalized)
    if (
        _SPOKEN_SORTED_LIST_SORT_RE.search(normalized) or _SORT_AND_SORTED_ASR_RE.search(normalized)
    ) and not _SORTED_LIST_SORT_RE.search(normalized):
        return "В чём разница между sorted() и list.sort()?"
    return normalized


def _resolve_domain_answer_hints(question: str, *, include_personal_templates: bool) -> str:
    q = (question or "").strip()
    if not q:
        return _NONE_HINT

    blocks: list[str] = []
    if _POM_RE.search(q):
        blocks.append(_POM_HINT)
    if _API_RE.search(q):
        blocks.append(_API_HINT)
    if _GIT_REBASE_RE.search(q):
        blocks.append(_GIT_REBASE_HINT)
    if _TEST_CASE_RE.search(q):
        blocks.append(_TEST_CASE_HINT)
    if _CHECKLIST_RE.search(q):
        blocks.append(_CHECKLIST_HINT)
    if _BUG_REPORT_RE.search(q):
        blocks.append(_BUG_REPORT_HINT)
    if _SORTED_LIST_SORT_RE.search(q):
        blocks.append(_SORTED_LIST_SORT_HINT)
    if _SQL_NOT_IN_NULL_RE.search(q):
        blocks.append(_SQL_NOT_IN_NULL_HINT)
    if _OOP_PRACTICAL_RE.search(q):
        blocks.append(_OOP_PRACTICAL_HINT)
    if _TEST_DESIGN_RE.search(q):
        blocks.append(_TEST_DESIGN_HINT)
    if _PYTEST_FIXTURES_RE.search(q):
        blocks.append(_PYTEST_HINT)
        if "fixture_1" in q.lower() and "session_fixture" in q.lower():
            blocks.append(_PYTEST_EXACT_ORDER_HINT)
    if _FLAKY_RE.search(q):
        blocks.append(_FLAKY_HINT)
    if _AUTOMATION_TYPES_RE.search(q):
        blocks.append(_AUTOMATION_TYPES_HINT)
        if include_personal_templates:
            blocks.append(_AUTOMATION_TYPES_PERSONAL_HINT)
    if _TESTING_TYPES_RE.search(q):
        blocks.append(_TESTING_TYPES_HINT)
        if include_personal_templates:
            blocks.append(_TESTING_TYPES_PERSONAL_HINT)
    if _SMOKE_REGRESSION_RE.search(q):
        blocks.append(_SMOKE_REGRESSION_HINT)
    elif _STATIC_DYNAMIC_RE.search(q):
        blocks.append(_STATIC_DYNAMIC_HINT)
    elif _DOCKER_RE.search(q):
        blocks.append(_DOCKER_HINT)
        if include_personal_templates:
            blocks.append(_DOCKER_PERSONAL_HINT)
    elif _CICD_RE.search(q):
        blocks.append(_CICD_HINT)
        if include_personal_templates:
            blocks.append(_CICD_PERSONAL_HINT)

    if not blocks:
        return _NONE_HINT
    return "\n\n".join(blocks)


def resolve_domain_answer_hints(question: str) -> str:
    """Return full domain hints for the context-grounded interview path."""
    return _resolve_domain_answer_hints(question, include_personal_templates=True)


def resolve_fast_domain_answer_hints(question: str) -> str:
    """Return objective local facts only; never prompt fast mode to invent experience."""
    resolved_question = resolve_fast_question_alias(question)
    return _resolve_domain_answer_hints(resolved_question, include_personal_templates=False)


def resolve_required_output_contract(question: str) -> str:
    """Return a short final recency constraint for exact high-density tasks."""
    if not _LAST_ORDER_RE.search(question or ""):
        return ""
    return """
FINAL REQUIRED OUTPUT CONTRACT — last_order (non-negotiable):
The answer is incomplete unless it literally includes: 200; `schema/types: client_id, order_id and item_qty are integer, order is array, item_price/order_price are number`; order_price sum; 200 + empty order for an existing client with no orders (if Swagger specifies it); 404 for a missing client; 400/422 validation; 401 unauthenticated and 403 forbidden; and verification that the order is the latest by business date. Put schema/types in the positive bullet. Use enough bullets to include ALL of them; do not replace these checks with a generic summary.
""".strip()
