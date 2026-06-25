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

    if not blocks:
        return _NONE_HINT
    return "\n\n".join(blocks)
