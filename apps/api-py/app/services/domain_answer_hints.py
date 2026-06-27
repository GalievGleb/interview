"""Domain-specific hints injected into interview prompts when the question topic matches."""

from __future__ import annotations

import re

_POM_RE = re.compile(
    r"page\s*object|\bpom\b|page\s*object\s*model",
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

_POM_HINT = """TOPIC HINT — Page Object / POM (weave naturally into bullets, do NOT dump as a keyword list):
Name typical mistakes when relevant: god object; business logic inside page object; assertions inside page object;
duplicated locators; sleep instead of explicit/auto waits; unclear method names like clickButton1().
Sound like interview speech, not a checklist."""

_API_HINT = """TOPIC HINT — API testing (concise say-aloud, max 4 bullets, ~50–80 words):
Weave naturally, do NOT dump as a keyword list. Mention when relevant:
- status code;
- response body;
- JSON schema / schema validation;
- headers;
- auth / token;
- negative cases;
- field/business validation;
- response time / latency.
Say «не только status code» if contrasting — that is a GOOD answer. Do NOT answer with «проверяю только статус-код»."""

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

_PYTEST_HINT = """TOPIC HINT — pytest / fixtures (concise say-aloud, max 4 bullets, ~50–80 words):
- fixtures = setup/teardown, test data prep, shared code reuse;
- scopes: function, class, module, session;
- yield = cleanup after test;
- conftest.py = shared fixtures without imports in every file;
- optional inline example only: API client, auth, test data.
Do NOT write a long Geomix/Sber story. Do NOT list every scope in a separate essay sentence."""

_FLAKY_HINT = """TOPIC HINT — flaky tests / CI/CD stability (weave naturally into bullets, do NOT dump as a keyword list):
Mention when relevant: logs; Allure; screenshots/artifacts; explicit waits; stable locators;
retries only as temporary workaround; remove sleep; isolate test data between runs."""

_AUTOMATION_TYPES_HINT = """TOPIC HINT — виды/типы автоматизации (concise say-aloud, ~50–90 words):
Talk about WHAT gets automated, not «ручная автоматизация» (that is wrong/contradictory).
Cover by meaning: UI-автотесты (пользовательские сценарии через интерфейс), API (backend-контракты),
интеграционные (взаимодействие компонентов), regression/smoke (запуск в CI/CD).
Optional one personal line: «В моём опыте фокус был на UI и API — Playwright, HTTPX/pytest, Allure».
Never say automation is done «вручную»."""

_TESTING_TYPES_HINT = """TOPIC HINT — виды/типы тестирования (concise say-aloud, list OK):
Group by axes: по уровню (модульное, интеграционное, системное, приёмочное);
по цели (функциональное / нефункциональное — производительность, безопасность, удобство, совместимость);
по способу (ручное и автоматизированное). Optional one personal line on what you actually did."""

_CICD_HINT = """TOPIC HINT — CI/CD (concise say-aloud, ~50–90 words, weave naturally):
Cover by meaning, not as a keyword dump: stages/jobs; Docker / одинаковое окружение; запуск тестов (pytest);
artifacts/reports; Allure; logs; variables/secrets (carefully); GitLab CI or Jenkins by context.
Personal framing if experience question: smoke и regression раздельными pipeline-запусками, артефакты для разбора падений."""

_DOCKER_HINT = """TOPIC HINT — Docker (concise say-aloud, ~50–80 words):
Docker = контейнеризация: одинаковое окружение локально и в CI/CD, изоляция зависимостей, воспроизводимые прогоны тестов.
Mention when relevant: образ/Dockerfile, контейнер, запуск автотестов внутри, в связке с CI/CD. Optional one personal line."""

_SMOKE_REGRESSION_HINT = """TOPIC HINT — smoke vs regression (thesis + «Отличие:» + 2 points):
smoke = быстрый прогон ключевых/критичных сценариев после сборки, рано даёт сигнал «жив ли билд».
regression = более полная проверка, что изменения не сломали существующий функционал. Often: smoke в CI на каждый build, regression реже/отдельно."""

_STATIC_DYNAMIC_HINT = """TOPIC HINT — static vs dynamic testing (thesis + «Отличие:» + 2 points):
static = проверка без запуска кода (review, линтеры, анализ требований/документации).
dynamic = проверка с запуском приложения (функциональные, API, UI-тесты). Both complement each other."""

_NONE_HINT = "(none — answer naturally; do not force unrelated QA terms or stack keywords)"


def resolve_domain_answer_hints(question: str) -> str:
    """Return prompt block with domain hints matched from the resolved question."""
    q = (question or "").strip()
    if not q:
        return _NONE_HINT

    blocks: list[str] = []
    if _POM_RE.search(q):
        blocks.append(_POM_HINT)
    if _API_RE.search(q):
        blocks.append(_API_HINT)
    if _TEST_CASE_RE.search(q):
        blocks.append(_TEST_CASE_HINT)
    if _CHECKLIST_RE.search(q):
        blocks.append(_CHECKLIST_HINT)
    if _BUG_REPORT_RE.search(q):
        blocks.append(_BUG_REPORT_HINT)
    if _PYTEST_FIXTURES_RE.search(q):
        blocks.append(_PYTEST_HINT)
    if _FLAKY_RE.search(q):
        blocks.append(_FLAKY_HINT)
    if _AUTOMATION_TYPES_RE.search(q):
        blocks.append(_AUTOMATION_TYPES_HINT)
    if _TESTING_TYPES_RE.search(q):
        blocks.append(_TESTING_TYPES_HINT)
    if _SMOKE_REGRESSION_RE.search(q):
        blocks.append(_SMOKE_REGRESSION_HINT)
    elif _STATIC_DYNAMIC_RE.search(q):
        blocks.append(_STATIC_DYNAMIC_HINT)
    elif _DOCKER_RE.search(q):
        blocks.append(_DOCKER_HINT)
    elif _CICD_RE.search(q):
        blocks.append(_CICD_HINT)

    if not blocks:
        return _NONE_HINT
    return "\n\n".join(blocks)
