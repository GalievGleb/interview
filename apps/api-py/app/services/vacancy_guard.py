"""Post-processing guardrails for Vacancy Smoke Review answer coaching."""

from __future__ import annotations

import re
from typing import Any

KNOWN_TOOLS = {
    "playwright": "Playwright",
    "selenium": "Selenium",
    "pytest": "pytest",
    "requests": "Requests",
    "httpx": "HTTPX",
    "postman": "Postman",
    "insomnia": "Insomnia",
    "docker": "Docker",
    "jenkins": "Jenkins",
    "gitlab": "GitLab",
    "gitlab ci": "GitLab CI",
    "allure": "Allure",
    "jmeter": "JMeter",
    "cypress": "Cypress",
    "testng": "TestNG",
    "kubernetes": "Kubernetes",
    "k8s": "Kubernetes",
    "kafka": "Kafka",
    "java": "Java",
    "typescript": "TypeScript",
    "pillow": "Pillow",
    "pydantic": "Pydantic",
}

ASR_NOISE_RE = re.compile(
    r"(https?://\S+|www\.\S+|patreon|telegram|подписывай|субтитр|"
    r"ваши вопросы|лайк[аи]?|канал[аеу]?|меня\s+не\s+записыва|"
    r"не\s+записыва(?:ет|лось)|запись\s+не\s+ид[её]т|микрофон\s+не\s+работ|"
    r"не\s+слышно|всем\s+проблем|в\s*ч[её]м\s+проблем)",
    re.IGNORECASE,
)
ASR_LONG_FILLER_RE = re.compile(
    r"(?:^|[\s.,!?;:])(?:м{4,}|э{4,}|е{4,}|m{4,}|uh{3,}|um{3,})(?=$|[\s.,!?;:])",
    re.IGNORECASE,
)
ASR_MIC_CHECK_RE = re.compile(r"^(?:раз|м{3,}|э{3,}|е{3,}|m{3,}|[\s,.\-–—])+$", re.IGNORECASE)

BEHAVIORAL_RULES: tuple[tuple[str, re.Pattern[str], re.Pattern[str]], ...] = (
    (
        "Teamwork",
        re.compile(
            r"teamwork|team|collaboration|manual qa|tester|developer|analyst|команд|тестировщик|manual\s*qa|разработчик|аналитик",
            re.IGNORECASE,
        ),
        re.compile(
            r"manual\s*qa|tester|developer|analyst|команд|тестировщик|тестировщики|разработчик|разработчики|аналитик|аналитиком|вместе|договорил|обсудил",
            re.IGNORECASE,
        ),
    ),
    (
        "Conflict",
        re.compile(
            r"conflict|disagreement|pressure|lack of resources|competing priorities|task/conflict|спор|конфликт|давлен|приоритет|ожидан|ресурс|сложн",
            re.IGNORECASE,
        ),
        re.compile(
            r"спор|конфликт|разноглас|разные\s+ожидания|давлен|не\s+хватал\w*\s+ресурс|приоритет|хотел\w*\s+быстрее|видел\w*\s+риск|сложн",
            re.IGNORECASE,
        ),
    ),
    (
        "Ownership",
        re.compile(
            r"ownership|action|decision|responsibility|analysis|prioriti[sz]ation|implementation|действ|решени|ответствен|анализ|приорит|реализац",
            re.IGNORECASE,
        ),
        re.compile(
            r"взял\w*\s+на\s+себя|предложил|решил|сделал|договорил|проанализировал|анализ\s+паден|"
            r"приоритиз|реализовал|внедрил|отвечал|с\s+нуля|выстраива\w*|разрабатыва\w*|добавля\w*|"
            r"принима\w*\s+решени|выбира\w*|планирова\w*|в\s+моей\s+зоне|designed|implemented|developed|planned",
            re.IGNORECASE,
        ),
    ),
    (
        "Real example",
        re.compile(
            r"real example|specific example|project|scenario|domain|tool|пример|проект|сценар|домен|инструмент",
            re.IGNORECASE,
        ),
        re.compile(
            r"на\s+проекте|в\s+проекте|личн\w*\s+кабинет|релиз|api|smoke|regression|playwright|pytest|allure|gitlab|docker|сценар",
            re.IGNORECASE,
        ),
    ),
    (
        "Result",
        re.compile(
            r"result|outcome|changed|effect|результат|эффект|изменил|что\s+изменилось",
            re.IGNORECASE,
        ),
        re.compile(
            r"в\s+результате|после\s+этого|итог|эффект|стало|изменил|релиз\s+не\s+блок|вынесли\s+в\s+отдельн|снизил|ускорил|стабилизир",
            re.IGNORECASE,
        ),
    ),
)

BEHAVIORAL_WEAK_MESSAGES: dict[str, str] = {
    "teamwork": "Teamwork is present, but should be stated more clearly.",
    "conflict": "Conflict is present, but the candidate should name it directly.",
    "ownership": "Ownership is present, but the candidate should explain their exact action.",
    "real example": "Real example is present, but the result is not clear enough.",
    "result": "Result is present, but should be stated more clearly.",
}

BEHAVIORAL_POINT_RE = re.compile(
    r"teamwork|conflict|ownership|real example|result|behavior|star|команд|конфликт|сложн|ответствен|результат",
    re.IGNORECASE,
)
METRIC_RE = re.compile(
    r"(\b\d+\s*%|\bна\s+\d+[\d\s]*(?:%|процент|секунд|минут|час|раз[аи]?|x)\b)",
    re.IGNORECASE,
)
TEAM_SIZE_RE = re.compile(
    r"\b\d+\s*(?:человек|сотрудник(?:а|ов)?|инженер(?:а|ов)?|qa|aqa|тестировщик(?:а|ов)?)\b",
    re.IGNORECASE,
)
PEOPLE_MGMT_RE = re.compile(
    r"(people\s+management|people\s+manager|руководил[аи]?\s+команд|"
    r"управлял[аи]?\s+команд|ментор(?:ил|инг)?|наставни(?:к|ч)|"
    r"one[-\s]?to[-\s]?one|1:1|нанимал[аи]?|найм|performance\s+review)",
    re.IGNORECASE,
)
CODE_REVIEW_RE = re.compile(r"(code\s+review|код[-\s]?ревью|ревью\s+кода)", re.IGNORECASE)
OWNERSHIP_RE = re.compile(
    r"(владел[аи]?\s+процесс|отвечал[аи]?\s+за\s+релиз|production\s+impact|"
    r"продакшен[-\s]?импакт)",
    re.IGNORECASE,
)


def _norm(text: str) -> str:
    return (text or "").lower().replace("ё", "е")


def _dedupe(items: list[str], limit: int = 10) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        value = str(item).strip()
        if not value:
            continue
        key = _norm(value)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
        if len(out) >= limit:
            break
    return out


def _as_list(value: Any, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    return _dedupe([str(v).strip() for v in value if str(v).strip()], limit)


SEMANTIC_RULES: tuple[tuple[str, re.Pattern[str], re.Pattern[str]], ...] = (
    (
        "waits",
        re.compile(r"\bwaits?\b|ожидан|wait", re.IGNORECASE),
        re.compile(
            r"явн\w*\s+ожидан|auto-?wait|waitfor|жд(у|ать|ал|ала|ем)|ожида|состояни\w+\s+элемент",
            re.IGNORECASE,
        ),
    ),
    (
        "schema/body checks",
        re.compile(
            r"schema|body|схем|модел|тип\w*\s+пол|обязательн\w*\s+пол|response", re.IGNORECASE
        ),
        re.compile(
            r"schema|body|pydantic|pydentic|схем|модел|тип\w*\s+пол|обязательн\w*\s+пол|json|структур",
            re.IGNORECASE,
        ),
    ),
    (
        "auth",
        re.compile(
            r"\bauth\b|authorization|headers?|token|прав\w*\s+доступ|авторизац", re.IGNORECASE
        ),
        re.compile(
            r"headers?|token|jwt|bearer|авторизац|аутентификац|прав\w*\s+доступ|роль|401|403",
            re.IGNORECASE,
        ),
    ),
    (
        "negative cases",
        re.compile(r"negative|негатив|ошибк|валидац|400|401|403|404|409|422|500", re.IGNORECASE),
        re.compile(
            r"negative|негатив|невалид|ошибк\w*\s+валидац|400|401|403|404|409|422|500|bad request|forbidden|unauthorized",
            re.IGNORECASE,
        ),
    ),
    (
        "state verification",
        re.compile(
            r"state|состояни|созданн|удален|после post|после delete|get после", re.IGNORECASE
        ),
        re.compile(
            r"get после|после post|после delete|провер\w*\s+создан|провер\w*\s+удален|состояни|данн\w+\s+сохранил",
            re.IGNORECASE,
        ),
    ),
    (
        "conflict resolution",
        re.compile(r"conflict|конфликт|resolve", re.IGNORECASE),
        re.compile(
            r"мерч-?конфликт|merge conflict|конфликт\w*\s+в\s+файл|ide|консол|resolve|разбирал\w*\s+конфликт",
            re.IGNORECASE,
        ),
    ),
    (
        "merge",
        re.compile(r"\bmerge\b|мерж|объедин", re.IGNORECASE),
        re.compile(r"\bmerge\b|мерж|объедин\w*\s+ветк|merge commit", re.IGNORECASE),
    ),
    (
        "rebase",
        re.compile(r"\brebase\b|ребейз|линейн", re.IGNORECASE),
        re.compile(
            r"\brebase\b|ребейз|поверх\s+(main|develop|актуальн)|линейн\w*\s+истор", re.IGNORECASE
        ),
    ),
    (
        "ci/cd artifacts",
        re.compile(r"artifact|report|allure|лог|отч[её]т|скрин|junit", re.IGNORECASE),
        re.compile(r"artifact|артефакт|allure|лог|отч[её]т|скрин|junit|diff", re.IGNORECASE),
    ),
    (
        "ci/cd triggers",
        re.compile(r"manual|nightly|schedule|trigger|запуск|распис", re.IGNORECASE),
        re.compile(
            r"manual|вручн|nightly|schedule|scheduled|распис|pytest\s+-m|smoke|regression|pipeline",
            re.IGNORECASE,
        ),
    ),
    (
        "ci/cd stages/jobs",
        re.compile(r"stage|job|pipeline|пайплайн", re.IGNORECASE),
        re.compile(r"stage|job|pipeline|пайплайн|gitlab yaml|\.gitlab-ci\.yml", re.IGNORECASE),
    ),
)

SEMANTIC_RULES = SEMANTIC_RULES + BEHAVIORAL_RULES

TECHNICAL_CLAIM_RE = re.compile(
    r"api|httpx|requests?|pydantic|schema|body|pytest|playwright|selenium|allure|gitlab|jenkins|docker|"
    r"merge|rebase|conflict|wait|token|headers?|400|401|403|422|схем|модел|тип\w*\s+пол|ожидан|конфликт|"
    r"pillow|screenshot|скриншот|diff|threshold|canvas|yaml",
    re.IGNORECASE,
)

# Project-experience questions ("расскажи про проект", "твоя роль в проекте"...) get
# their own STAR+Engineering rubric — distinct from generic behavioral/conflict
# questions, which use a different (and, for project questions, FORBIDDEN) opening.
PROJECT_EXPERIENCE_RE = re.compile(
    r"расскаж\w*\s+(?:мне\s+)?(?:про|о|об)\s+проект|самый\s+показательн\w*\s+проект|"
    r"(?:тво\w+|ваш\w*)\s+рол\w+\s+в\s+проект|что\s+делал\w*\s+на\s+(?:последнем|прошлом|текущем)\s+(?:месте|проекте)|"
    r"опиши\s+проект|проект\s+из\s+резюме|участвовал\w*\s+как\s+лидер|"
    r"project\s+experience|tell.*about.*a?\s*project|your\s+role\s+in\s+the\s+project|"
    r"walk\s+me\s+through\s+a\s+project",
    re.IGNORECASE,
)

PROJECT_RULES: tuple[tuple[str, re.Pattern[str], re.Pattern[str]], ...] = (
    (
        "concrete real project",
        re.compile(
            r"concrete\s+real\s+project|real\s+project|конкретн\w*\s+проект|назван\w*\s+проект",
            re.IGNORECASE,
        ),
        re.compile(
            r"домен|отрасл|индустри|компани|продукт|платформ|горнодобыв|[A-ZА-Я][a-zа-яё]{2,}",
            re.UNICODE,
        ),
    ),
    (
        "stack",
        re.compile(r"\bstack\b|tech\s*stack|стек|технологи", re.IGNORECASE),
        TECHNICAL_CLAIM_RE,
    ),
    (
        "ownership",
        re.compile(
            r"ownership|candidate\s+role|роль\s+кандидата|роль|ответственност|владени",
            re.IGNORECASE,
        ),
        re.compile(
            r"с\s+нуля|выстраива\w*|разрабатыва\w*|реализова\w*|внедри\w*|добавля\w*|"
            r"принима\w*\s+решени|выбира\w*|планирова\w*|отвечал\w*\s+за|в\s+моей\s+зоне|"
            r"designed|implemented|developed|planned",
            re.IGNORECASE,
        ),
    ),
)

SEMANTIC_RULES = SEMANTIC_RULES + PROJECT_RULES

PROJECT_WEAK_MESSAGES: dict[str, str] = {
    "concrete real project": "Проект назван, но контекст (домен/продукт) можно раскрыть детальнее.",
    "stack": "Стек назван частично — перечисли инструменты и их роль подробнее.",
    "ownership": "Роль обозначена, но не хватает деталей: что именно ты решал и внедрял.",
}


def _is_project_experience_question(text: str) -> bool:
    return bool(PROJECT_EXPERIENCE_RE.search(text or ""))


def _project_dimension(point: str) -> str | None:
    low = _norm(point)
    for dim in PROJECT_WEAK_MESSAGES:
        if dim in low:
            return dim
    if re.search(r"project|проект|domain|домен|context|контекст", low, re.IGNORECASE):
        return "concrete real project"
    if re.search(r"stack|стек|tool|инструмент|technolog|технолог", low, re.IGNORECASE):
        return "stack"
    if re.search(r"ownership|role|роль|responsibilit|ответствен", low, re.IGNORECASE):
        return "ownership"
    return None


def _replace_project_weak_points(weak: list[str], covered: list[str]) -> list[str]:
    covered_dims = _dedupe([dim for item in covered if (dim := _project_dimension(item))], 3)
    if not covered_dims:
        return weak

    out: list[str] = []
    for item in weak:
        dim = _project_dimension(item)
        if dim in covered_dims and re.search(r"add|missing|нет|добав|уточни", item, re.IGNORECASE):
            continue
        out.append(item)

    for dim in covered_dims:
        message = PROJECT_WEAK_MESSAGES.get(dim)
        if message:
            out.append(message)
    return _dedupe(out, 10)


def _has_named_project(answer: str) -> bool:
    return bool(PROJECT_RULES[0][2].search(answer or ""))


def _has_named_stack(answer: str) -> bool:
    text = answer or ""
    if TECHNICAL_CLAIM_RE.search(text):
        return True
    low = _norm(text)
    return any(marker in low for marker in KNOWN_TOOLS)


def _has_ownership_signal(answer: str) -> bool:
    return bool(PROJECT_RULES[2][2].search(answer or ""))


def _floor_score(out: dict[str, Any], key: str, floor_value: int) -> None:
    """Raise out[key] to at least floor_value; never lowers a genuinely higher score."""
    try:
        current = float(out.get(key, 0) or 0)
    except (TypeError, ValueError):
        current = 0
    out[key] = max(round(current), floor_value)


def _has_result_signal(answer: str) -> bool:
    return bool(
        re.search(
            r"результат|эффект|стало\s+(?:проще|лучше|стабильнее)|упростил|сократил|снизил|ускорил|"
            r"result|outcome|effect|improve",
            answer or "",
            re.IGNORECASE,
        )
    )


def _ready_project_answer(
    question: str,
    topic: str,
    candidate_answer: str,
    *,
    resume_text: str,
    vacancy_text: str,
) -> str:
    text = candidate_answer or ""
    domain = (
        "в горнодобывающей отрасли"
        if re.search(r"горнодобыв|скважин|блок\w*\s+(?:данн|геолог)", text, re.IGNORECASE)
        else "в проекте из моего опыта"
    )
    role = (
        "Моя роль была скорее техническим лидерством в автоматизации — я участвовал в выборе подходов "
        "и развитии тестового фреймворка"
        if _has_ownership_signal(text)
        else "Я отвечал за практическую часть автоматизации на этом проекте"
    )
    stack_tokens = _dedupe(
        [label for marker, label in KNOWN_TOOLS.items() if marker in _norm(text)],
        6,
    )
    stack = (
        f"Из инструментов использовали {', '.join(stack_tokens)}."
        if stack_tokens
        else "Стек подбирали под задачи проекта."
    )
    result = (
        "Точных цифр сейчас не приведу, но эффект был в более понятной поддержке автотестов и "
        "более быстром разборе падений."
        if not _has_result_signal(text)
        else "Это сделало тесты более поддерживаемыми и упростило анализ падений."
    )
    return (
        f"Самый показательный проект для меня — продукт {domain}. "
        f"{role}. {stack} {result} "
        "Полноценным people manager себя не позиционирую — говорю именно про техническую часть."
    )


META_ANSWER_RE = re.compile(
    r"(я\s+бы\s+начал|я\s+отвечаю\s+через\s+практический\s+пример|сначала\s+коротко|коротко\s+называю\s+подход|потом\s+объясняю|затем\s+объясняю|отдельно\s+раскрываю|по\s+теме\s+behavioral\s+questions|потом\s+добавил\s+бы|нужно\s+закрыть|добавьте|расскажите|используйте\s+структуру|можно\s+сказать)",
    re.IGNORECASE,
)

# The behavioral STAR opening is correct for conflict/teamwork questions but
# explicitly WRONG for project_experience_question — forces a rewrite there.
BEHAVIORAL_OPENING_RE = re.compile(r"одна\s+из\s+сложных\s+ситуаций", re.IGNORECASE)


def _semantic_matches(point: str, answer: str) -> bool:
    point_norm = point or ""
    answer_norm = answer or ""
    behavioral_dim = _behavioral_dimension(point_norm)
    if behavioral_dim:
        for label, _signal_re, answer_re in SEMANTIC_RULES:
            if label.lower() == behavioral_dim:
                return bool(answer_re.search(answer_norm))
    for _label, signal_re, answer_re in SEMANTIC_RULES:
        if signal_re.search(point_norm) or _label.lower() in point_norm.lower():
            return bool(answer_re.search(answer_norm))
    return False


def _semantic_covered_points(points: list[str], answer: str) -> list[str]:
    covered: list[str] = []
    for point in points:
        if _semantic_matches(point, answer):
            covered.append(point)
    return _dedupe(covered, 12)


def _behavioral_dimension(point: str) -> str | None:
    low = _norm(point)
    for dim in BEHAVIORAL_WEAK_MESSAGES:
        if dim in low:
            return dim
    if re.search(r"teamwork|team|команд|manual\s*qa|tester|developer|analyst", low, re.IGNORECASE):
        return "teamwork"
    if re.search(r"conflict|спор|конфликт|приоритет|давлен|ожидан|сложн", low, re.IGNORECASE):
        return "conflict"
    if re.search(
        r"ownership|responsibility|action|decision|ответствен|действ|решени|анализ",
        low,
        re.IGNORECASE,
    ):
        return "ownership"
    if re.search(r"real example|project|scenario|пример|проект|сценар", low, re.IGNORECASE):
        return "real example"
    if re.search(r"result|outcome|effect|результат|эффект", low, re.IGNORECASE):
        return "result"
    return None


def _replace_behavioral_weak_points(weak: list[str], covered: list[str]) -> list[str]:
    covered_dims = _dedupe(
        [dim for item in covered if (dim := _behavioral_dimension(item))],
        5,
    )
    if not covered_dims:
        return weak

    out: list[str] = []
    for item in weak:
        dim = _behavioral_dimension(item)
        if dim in covered_dims and re.search(r"add|missing|нет|добав|уточни", item, re.IGNORECASE):
            continue
        out.append(item)

    for dim in covered_dims:
        message = BEHAVIORAL_WEAK_MESSAGES.get(dim)
        if message:
            out.append(message)
    return _dedupe(out, 10)


def _remove_covered_missing(items: list[str], candidate_answer: str) -> tuple[list[str], list[str]]:
    kept: list[str] = []
    covered: list[str] = []
    for item in items:
        if _semantic_matches(item, candidate_answer):
            covered.append(item)
        else:
            kept.append(item)
    return _dedupe(kept, 12), _dedupe(covered, 12)


def _strip_items_containing_covered(items: list[str], covered: list[str]) -> list[str]:
    if not covered:
        return items
    covered_norm = [_norm(c) for c in covered]
    out: list[str] = []
    for item in items:
        item_norm = _norm(item)
        if any(c and c in item_norm for c in covered_norm):
            continue
        out.append(item)
    return _dedupe(out, len(items) or 1)


def _has_technical_claim(candidate_answer: str, lists: list[str]) -> bool:
    if TECHNICAL_CLAIM_RE.search(candidate_answer or ""):
        return True
    return any(TECHNICAL_CLAIM_RE.search(item or "") for item in lists)


def _is_git_question(text: str) -> bool:
    return bool(re.search(r"git|merge|rebase|мерж|ребейз|ветк|конфликт", text or "", re.IGNORECASE))


def _is_api_question(text: str) -> bool:
    return bool(
        re.search(
            r"\bapi\b|апи|status|статус|200|schema|body|контракт|payload", text or "", re.IGNORECASE
        )
    )


def _is_behavioral_question(text: str) -> bool:
    return bool(
        re.search(
            r"behavior|star|teamwork|conflict|ownership|сложн|ситуац|команд|конфликт|спор|приоритет|ответствен|расскаж.*пример",
            text or "",
            re.IGNORECASE,
        )
    )


def _ready_behavioral_answer(candidate_answer: str) -> str:
    text = candidate_answer or ""
    team = (
        "с manual QA, разработчиками и аналитиком"
        if re.search(
            r"manual\s*qa|разработчик|аналитик|tester|developer|analyst", text, re.IGNORECASE
        )
        else "с командой"
    )
    conflict = (
        "был спор по приоритетам и ожиданиям перед релизом"
        if re.search(r"спор|приоритет|ожидан|релиз|conflict|disagreement", text, re.IGNORECASE)
        else "была неоднозначность по ожиданиям и приоритетам"
    )
    action = (
        "я взял на себя анализ, предложил конкретный подход и договорился о следующем шаге"
        if re.search(
            r"взял|предложил|договорил|анализ|решил|prioriti|decid|propos", text, re.IGNORECASE
        )
        else "я разобрал ситуацию, предложил подход и помог согласовать следующий шаг"
    )
    result = (
        "В результате стало понятнее, что делать дальше, и спорные проверки вынесли в отдельный план."
        if re.search(r"в результате|итог|после этого|result|outcome|вынесли", text, re.IGNORECASE)
        else "Точных цифр сейчас не приведу, но эффект был в более понятном плане действий и меньшем количестве спорных решений."
    )
    return (
        f"Одна из сложных ситуаций была на проекте, где я работал {team}. "
        f"Контекст был в том, что {conflict}. "
        f"{action}. "
        f"{result}"
    )


def _ready_answer(
    question: str,
    topic: str,
    candidate_answer: str,
    *,
    resume_text: str = "",
    vacancy_text: str = "",
) -> str:
    text = f"{question}\n{topic}"
    # Project-experience phrasing is checked BEFORE behavioral: "расскажи про
    # проект" must get a finished project story, never the conflict-resolution
    # STAR opening (that opening is explicitly wrong for this question type).
    if _is_project_experience_question(text):
        return _ready_project_answer(
            question, topic, candidate_answer, resume_text=resume_text, vacancy_text=vacancy_text
        )
    if _is_behavioral_question(text):
        return _ready_behavioral_answer(candidate_answer)
    if _is_git_question(text):
        return (
            "Merge и rebase — это два способа синхронизировать ветки. Merge объединяет изменения из одной ветки в другую "
            "и сохраняет историю ветвления, часто через отдельный merge commit. Rebase переносит мои локальные коммиты "
            "поверх актуального состояния main или develop, поэтому история получается более линейной. На практике я чаще "
            "использую rebase в feature-ветке перед merge request. Если возникают конфликты, разбираю их в IDE или через "
            "консоль и после этого прогоняю тесты."
        )
    if _is_api_question(text):
        return (
            "Кроме статус-кода 200 я проверяю контракт ответа: структуру JSON, обязательные поля, типы данных и бизнес-значения. "
            "Отдельно смотрю авторизацию, headers/token, права доступа и негативные кейсы: 400, 401, 403, 404, 409 или ошибки "
            "валидации. Если запрос меняет состояние, проверяю это повторным GET или связанным API-вызовом. В моём контексте "
            "это удобно делать через pytest, HTTPX/Requests, Pydantic-модели и Allure-отчёты."
        )
    if TECHNICAL_CLAIM_RE.search(candidate_answer or ""):
        return (
            "Я строю ответ от задачи и риска: сначала уточняю, что именно нужно проверить, какие сценарии критичны "
            "и где команде нужна быстрая обратная связь. Дальше опираюсь на конкретные проверки, тестовые данные, "
            "логи и отчёты, чтобы было понятно, что сломалось и почему. Точных цифр сейчас не приведу, но эффект был "
            "в более понятной поддержке автотестов, воспроизводимом запуске и быстрее разборе падений."
        )
    return (
        "Если прямого опыта не хватает, я честно обозначаю границу и связываю ответ с понятным инженерным подходом: что проверяю, какими инструментами, "
        "как убеждаюсь в результате и какие ограничения вижу. Без выдуманных цифр и неподтверждённых ролей."
    )


def detect_asr_noise(candidate_answer: str) -> list[str]:
    noise: list[str] = []
    for match in ASR_NOISE_RE.finditer(candidate_answer or ""):
        start = max(0, match.start() - 40)
        end = min(len(candidate_answer), match.end() + 40)
        noise.append(candidate_answer[start:end].strip(" .,;:"))
    for chunk in re.split(r"[.!?\n•·]+", candidate_answer or ""):
        value = chunk.strip()
        if len(value) < 3:
            continue
        if ASR_LONG_FILLER_RE.search(value) or ASR_MIC_CHECK_RE.fullmatch(value):
            noise.append(value[:80].strip(" .,;:"))
    return _dedupe(noise, 6)


def strip_asr_noise_for_evaluation(candidate_answer: str) -> tuple[str, list[str]]:
    text = re.sub(r"\s+", " ", candidate_answer or "").strip()
    if not text:
        return "", []

    noise: list[str] = []
    chunks = re.split(r"(?<=[.!?])\s+", text)
    kept: list[str] = []
    for chunk in chunks:
        value = chunk.strip()
        if not value:
            continue
        cleaned = ASR_LONG_FILLER_RE.sub(" ", value)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if ASR_NOISE_RE.search(value) or ASR_MIC_CHECK_RE.fullmatch(cleaned):
            noise.append(value[:120].strip(" .,;:"))
            continue
        if cleaned:
            kept.append(cleaned)

    return re.sub(r"\s+", " ", " ".join(kept)).strip(), _dedupe(noise, 6)


def _source_corpus(
    *,
    resume_text: str,
    vacancy_text: str,
    candidate_answer: str,
    expected_signals: list[str],
    topic: str,
    question: str = "",
    legend_text: str = "",
) -> str:
    return _norm(
        "\n".join(
            [
                resume_text or "",
                legend_text or "",
                vacancy_text or "",
                candidate_answer or "",
                topic or "",
                question or "",
                " ".join(expected_signals or []),
            ]
        )
    )


def _mentions_supported(pattern: re.Pattern[str], source: str) -> bool:
    return bool(pattern.search(source))


def _unsupported_tools(sentence: str, source: str) -> list[str]:
    low = _norm(sentence)
    missing: list[str] = []
    for marker, label in KNOWN_TOOLS.items():
        if marker in low and marker not in source:
            missing.append(label)
    return _dedupe(missing)


def _split_sentences(text: str) -> list[str]:
    chunks = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def _sanitize_suggested_answer(
    text: str,
    *,
    source: str,
    level: str,
) -> tuple[str, list[str]]:
    guard: list[str] = []
    removed_metric = False
    kept: list[str] = []

    allow_people_mgmt = _mentions_supported(PEOPLE_MGMT_RE, source)
    allow_code_review = _mentions_supported(CODE_REVIEW_RE, source)
    allow_ownership = _mentions_supported(OWNERSHIP_RE, source)
    allow_team_size = bool(TEAM_SIZE_RE.search(source))
    allow_metrics = bool(METRIC_RE.search(source))

    for sentence in _split_sentences(text):
        should_drop = False
        unsupported_tools = _unsupported_tools(sentence, source)
        if unsupported_tools:
            guard.append(f"Без неподтверждённых инструментов: {', '.join(unsupported_tools)}")
            should_drop = True
        if METRIC_RE.search(sentence) and not allow_metrics:
            guard.append("Без выдуманных процентных метрик/точных цифр")
            removed_metric = True
            should_drop = True
        if TEAM_SIZE_RE.search(sentence) and not allow_team_size:
            guard.append("Без выдуманного размера команды")
            should_drop = True
        if PEOPLE_MGMT_RE.search(sentence) and not allow_people_mgmt:
            guard.append("Без people management/менторинга без подтверждения в резюме")
            should_drop = True
        if CODE_REVIEW_RE.search(sentence) and not allow_code_review:
            guard.append("Без code review ownership без подтверждения в резюме")
            should_drop = True
        if OWNERSHIP_RE.search(sentence) and not allow_ownership:
            guard.append("Без неподтверждённого process/production ownership")
            should_drop = True

        if should_drop:
            continue
        kept.append(sentence)

    if level == "lead" and not allow_people_mgmt:
        guard.append(
            "Lead-вопрос: техническое лидерство не равно people management без прямой поддержки в резюме"
        )

    result = " ".join(kept).strip()
    if removed_metric:
        impact_phrase = (
            "Точных цифр сейчас не приведу, но эффект был в более понятной поддержке "
            "автотестов, воспроизводимом запуске и более быстром разборе падений."
        )
        result = f"{result} {impact_phrase}".strip()

    return result or text.strip(), _dedupe(guard, 10)


def harden_vacancy_evaluation(
    data: dict[str, Any],
    *,
    resume_text: str,
    vacancy_text: str,
    candidate_answer: str,
    expected_signals: list[str],
    topic: str,
    level: str,
    question: str = "",
    detected_noise: list[str] | None = None,
    legend_text: str = "",
) -> dict[str, Any]:
    """Make model output obey the grounding contract before returning it."""
    out = dict(data)
    # The legend is part of the grounding corpus: tools/roles the candidate's
    # agreed self-presentation commits to must not be stripped as "unsupported".
    source = _source_corpus(
        resume_text=resume_text,
        vacancy_text=vacancy_text,
        candidate_answer=candidate_answer,
        expected_signals=expected_signals,
        topic=topic,
        question=question,
        legend_text=legend_text,
    )

    noise = _dedupe(
        _as_list(out.get("detectedNoiseOrAsrErrors"), 6)
        + (detected_noise or [])
        + detect_asr_noise(candidate_answer),
        6,
    )
    out["detectedNoiseOrAsrErrors"] = noise

    extracted = _as_list(out.get("extractedValidPoints"), 10)
    good = _as_list(out.get("goodPoints"), 10)
    weak = _as_list(out.get("weakPoints"), 10)
    missing, missing_covered = _remove_covered_missing(
        _as_list(out.get("missingPoints"), 12),
        candidate_answer,
    )
    signal_covered = _semantic_covered_points(expected_signals or [], candidate_answer)
    covered = _dedupe(missing_covered + signal_covered, 12)

    if covered:
        extracted = _dedupe(extracted + [f"Семантически покрыто: {item}" for item in covered], 10)
        good = _dedupe(good + [f"Покрыл по смыслу: {item}" for item in covered], 10)
        weak = _replace_behavioral_weak_points(weak, covered)
        weak = _replace_project_weak_points(weak, covered)
        missing = [m for m in missing if m not in covered]
        out["followUpQuestions"] = _strip_items_containing_covered(
            _as_list(out.get("followUpQuestions"), 8),
            covered,
        )
        next_focus = str(out.get("nextTrainingFocus", "") or "")
        for item in covered:
            next_focus = re.sub(re.escape(item), "", next_focus, flags=re.IGNORECASE)
        out["nextTrainingFocus"] = re.sub(r"\s{2,}", " ", next_focus).strip(" ,;:.")

    # Consistency: do not keep "no structure" when structure is scored high.
    try:
        structure_score = float(out.get("structureScore", out.get("clarityScore", 0)) or 0)
    except (TypeError, ValueError):
        structure_score = 0
    if structure_score > 85:
        weak = [
            item
            for item in weak
            if not re.search(r"нет\s+структур|no\s+structure", item, re.IGNORECASE)
        ]

    out["extractedValidPoints"] = extracted
    out["goodPoints"] = good
    out["weakPoints"] = weak
    out["missingPoints"] = _dedupe(missing, 12)

    if _is_behavioral_question(f"{question}\n{topic}") and not _as_list(
        out.get("betterStructure"), 8
    ):
        out["betterStructure"] = [
            "Situation — what was the context?",
            "Task/Conflict — what was difficult or disputed?",
            "Action — what exactly did the candidate do?",
            "Result — what changed after that?",
        ]

    has_technical_claim = _has_technical_claim(candidate_answer, extracted + good + covered)
    if has_technical_claim:
        # Never score technical accuracy near-zero when the candidate stated any
        # correct technical/project-relevant fact — floor 50, scaling to 75 as
        # more signals are semantically covered.
        semantic_floor = max(50, 35 + min(40, len(covered) * 12))
        for key in ("technicalAccuracyScore", "technicalContentScore"):
            try:
                current = float(out.get(key, 0) or 0)
            except (TypeError, ValueError):
                current = 0
            out[key] = max(round(current), semantic_floor)

    # ownershipScore is the project-experience-rubric sibling of leadershipScore;
    # default it from leadershipScore so older callers/models still populate it.
    if not out.get("ownershipScore"):
        out["ownershipScore"] = out.get("leadershipScore", 0)

    if _is_project_experience_question(f"{question}\n{topic}"):
        has_project = _has_named_project(candidate_answer)
        has_stack = _has_named_stack(candidate_answer)
        has_role = _has_ownership_signal(candidate_answer)
        # Candidate named a real project + a real tool: never treat this as a
        # near-zero answer even if role/CI-CD/result stayed thin. Floors only —
        # this never caps a genuinely strong, well-detailed answer. Score stays
        # below 40 only when there's truly no project/role/tools/action.
        if has_project and has_stack:
            _floor_score(out, "technicalAccuracyScore", 50)
            _floor_score(out, "technicalContentScore", 50)
            _floor_score(out, "specificityScore", 30)
            _floor_score(out, "projectSpecificityScore", 30)
            if has_role:
                _floor_score(out, "ownershipScore", 30)
            _floor_score(out, "score", 45)

    try:
        score = float(out.get("score", 0) or 0)
    except (TypeError, ValueError):
        score = 0
    level_estimate = str(out.get("levelEstimate", "") or "").lower()
    # Senior/Lead is a real claim about depth — require score>=75 to back it up
    # (never below 60 in any case), otherwise it's a contradiction.
    if score < 75 and level_estimate in {"senior", "lead"}:
        out["levelEstimate"] = "middle"
        verdict = str(out.get("verdict", "") or "")
        out["verdict"] = re.sub(
            r"\bSenior\b|senior|Lead|lead", "Middle", verdict, flags=re.IGNORECASE
        )

    sanitized, guard = _sanitize_suggested_answer(
        str(out.get("suggestedBetterAnswer", "")),
        source=source,
        level=(level or "").lower(),
    )
    wrong_frame_for_project = _is_project_experience_question(
        f"{question}\n{topic}"
    ) and BEHAVIORAL_OPENING_RE.search(sanitized)
    if META_ANSWER_RE.search(sanitized) or wrong_frame_for_project:
        sanitized = _ready_answer(
            question, topic, candidate_answer, resume_text=resume_text, vacancy_text=vacancy_text
        )
    out["suggestedBetterAnswer"] = sanitized
    out["hallucinationGuard"] = _dedupe(_as_list(out.get("hallucinationGuard"), 8) + guard, 10)
    return out
