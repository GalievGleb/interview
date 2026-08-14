"""Vacancy Smoke Review — LLM-backed analysis + answer evaluation.

The desktop calls these with a deterministic mock fallback, so the feature works
offline; here we add the real, grounded LLM path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.core.errors import AppError
from app.db.session import get_db
from app.prompts.vacancy import (
    VACANCY_ANALYZE_PROMPT,
    VACANCY_COVER_LETTER_PROMPT,
    VACANCY_EVALUATE_FAST_PROMPT,
    VACANCY_REPORT_PROMPT,
    VACANCY_SCREENING_ANSWERS_PROMPT,
)
from app.services import model_router, provider_adapter, rag_service
from app.services.preferences import load_preferences
from app.services.vacancy_guard import detect_asr_noise, harden_vacancy_evaluation

logger = logging.getLogger("vacancy")

router = APIRouter(prefix="/vacancy", tags=["vacancy"])


def _ensure_vacancy_quota(db) -> None:
    """Mock-оценки тоже тратят токены — общий месячный бюджет тарифа."""
    from app.services import quota

    quota.check_token_quota(db)


_SENIORITY = {"intern", "junior", "middle", "senior", "lead", "unknown"}
_IMPORTANCE = {"high", "medium", "low"}
_QUESTION_LEVEL = {"junior", "middle", "senior", "lead"}
_COMPETENCY_LEVEL = {"basic", "practical", "advanced", "lead"}
_RESUME_MATCH = {"strong", "partial", "gap", "unknown"}


def _resolve(mode: str = "general") -> tuple[str, str]:
    prefs = load_preferences()
    available = {m.id for m in prefs.models_cache}
    provider = prefs.provider or "openrouter"
    model, _ = model_router.resolve_model(mode, prefs=prefs, available=available)
    return provider, model


# Быстрый проверенный fallback: тот же движок, что работает в оверлее. Гейтвей
# может не отдавать выбранную модель (403/404 на дорогую) или отвечать слишком
# долго — вместо отката в ЛОКАЛЬНЫЙ разбор (клиент делал это на 502) сначала
# повторяем запрос этой моделью, чтобы разбор/оценка оставались AI.
FALLBACK_MODEL = "openai/gpt-4o-mini"
FEEDBACK_FALLBACK_MODEL = "openai/gpt-4o-mini"
VACANCY_EVALUATE_DEADLINE_SECONDS = 4.5
VACANCY_EVALUATE_MAX_TOKENS = 1200
SCREENING_ANSWERS_MAX_TOKENS = 1600
SCREENING_ANSWERS_DEADLINE_MARGIN_SECONDS = 5.0
# Electron allows 95 seconds for this localhost request. Keep the server's
# configurable wall-clock budget below it so the API always owns the timeout
# and can return a structured provider_timeout response.
SCREENING_ANSWERS_MAX_DEADLINE_SECONDS = 90.0
COVER_LETTER_DEADLINE_SECONDS = 9.0
COVER_LETTER_MAX_TOKENS = 1200

_SCREENING_RESTRICTED_FACT_RE = re.compile(
    r"(?:"
    r"где\s+(?:вы\s+)?(?:жив[её]те|находитесь)|откуда\s+вы|город\w*\s+(?:прожив|нахожд)|"
    r"(?:^|\W)(?:живу|проживаю|нахожусь)(?:\W|$)|"
    r"локаци|местонахожд|\blocation\b|\bcity\b|\bresiden|"
    r"гражданств|право\s+на\s+работ|разрешен\w*\s+на\s+работ|work\s+permit|"
    r"work\s+authori[sz]ation|legal\s+status|"
    r"security\s+clearance|судим|военн|арм(?:ия|ии)|служб\w*\s+в\s+арм|military|"
    r"виз\w*|visa|здоров\w*|health\s+status|"
    r"трудоустр|официальн\w*\s+оформ|оформлен|оформлени|трудов\w*\s+договор|"
    r"самозанят|(?:^|\W)ип(?:\W|$)|(?:^|\W)гпх(?:\W|$)|аутстафф|outstaff|"
    r"формат\w*\s+сотруднич|contract\s+(?:type|terms?)|"
    r"employment\s+(?:status|type|terms?)|self[- ]employed|"
    r"зарплат|з\s*\/?\s*п\b|оклад|доход|компенсац|финансов\w*\s+ожидан|"
    r"salary|compensation|financial\s+expectations?|expected\s+(?:salary|pay|level)|"
    r"релокац|переезд|переех|relocat|"
    r"график|смен\w*\s+(?:работ|дежур)|дата\s+выхода|когда\s+готов\w*\s+(?:выйти|приступ)|"
    r"рабоч\w*\s+час|часов\w*\s+пояс|занятост|пол\w*\s+день|part[- ]time|"
    r"work\s+schedule|shift\s+work|start\s+date|availability|"
    r"возраст|сколько\s+(?:вам|мне)\s+лет|дата\s+рожд|образован|диплом|сертифик|istqb|"
    r"английск|уровень\s+язык|english\s+(?:level|proficiency)|"
    r"командиров|ночн\w*\s+(?:смен|работ)|nda|соглашен\w*\s+о\s+неразглаш|"
    r"семейн\w*\s+положен|женат|замужем|беремен|инвалид|диагноз|\bздоров(?:а|ы)?\b|"
    r"(?:^|\W)(?:дети|здоровье|гендер|пол)(?:\W|$)|"
    r"за\s+последн|полгода|полугод|последн\w*\s+\d+\s+(?:месяц|недел|дн)|"
    r"\b(?:past|last)\s+\d+\s+(?:months?|weeks?|days?)\b|\bcurrently\b|\bcurrent\b|"
    r"(?:^|\W)сейчас(?:\W|$)|текущ\w*\s+(?:статус|место|работ|город|занят)"
    r")",
    re.IGNORECASE,
)
_SCREENING_EXPERIENCE_RE = re.compile(
    r"(?:опыт|работал|работали|использовал|используете|пользуетесь|применял|занимал|"
    r"делали|участвовал|сталкивал|знакомы\s+ли|умеете\s+ли|играл|какие\s+задач\w*\s+решал|"
    r"your\s+experience|have\s+you|did\s+you|worked\s+with|used\s+in\s+your|"
    r"are\s+you\s+familiar|tell\s+us\s+about\s+your)",
    re.IGNORECASE,
)
_SCREENING_DIRECT_EXPERIENCE_PROMPT_RE = re.compile(
    r"коммерческ|опыт|работал|работали|использовал|использовали|применял|применяли|"
    r"experience|worked\s+with|have\s+you\s+(?:worked|used)|did\s+you\s+use",
    re.IGNORECASE,
)
_SCREENING_KNOWLEDGE_RE = re.compile(
    r"(?:что\s+такое|объясните|чем\s+отлича|что\s+(?:бы\s+)?(?:вы\s+)?выбер|"
    r"какой\s+(?:вид|тип|метод)|как\s+(?:бы\s+)?(?:вы\s+)?(?:протестир|провер|реализ|"
    r"организ|поступ|реш)|представьте|сценари\w*|реализуйте|напишите\s+(?:код|функц|тест)|"
    r"test[- ]design|how\s+would\s+you|what\s+would\s+you|which\s+(?:test|method|approach)|"
    r"implement\s+(?:a\s+)?(?:function|test|solution)|write\s+(?:code|a\s+function|tests?))",
    re.IGNORECASE,
)
_SCREENING_BEHAVIORAL_HISTORY_RE = re.compile(
    r"(?:"
    r"(?:как|что)\s+(?:именно\s+)?(?:вы\s+)?(?:решил[иа]|решали|поступил[иа]|поступали|"
    r"действовал[иа]|действовали|сделал[иа]|делали|реализовал[иа]|реализовывали|"
    r"организовал[иа]|организовывали|протестировал[иа]|тестировали|проверил[иа]|"
    r"проверяли|справил(?:ся|ась)|справлялись)|"
    r"расскажите.{0,80}(?:случа|ситуац|пример)|"
    r"(?:на|в)\s+(?:ваш\w*\s+)?(?:прошл\w*|предыдущ\w*|реальн\w*|коммерческ\w*)\s+"
    r"(?:проект|работ|команд|компан|практик)|"
    r"\bhow\s+did\s+you\b|\bwhat\s+did\s+you\b|\btell\s+(?:me|us)\s+about\s+(?:a\s+time|your)\b|"
    r"\b(?:in|on)\s+your\s+(?:past|previous|last|real|commercial)\s+"
    r"(?:project|job|role|team|company)\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_PERSONAL_HISTORY_ANSWER_RE = re.compile(
    r"(?:"
    r"(?:^|[,;.!?]\s*|\bя\s+)(?:лично\s+)?(?:работал|работала|использовал|использовала|применял|"
    r"применяла|решил|решила|сделал|сделала|провел|провела|провёл|участвовал|участвовала|"
    r"руководил|руководила|организовал|организовала|внедрил|внедрила|настроил|настроила|"
    r"разработал|разработала|тестировал|тестировала)|"
    r"(?:в|на)\s+(?:мо[её]м|моей|нашей)\s+(?:практик|проект|работ|команд|компан)|"
    r"\bу\s+меня\b.{0,50}\bопыт\w*\b|\bмо(?:й|я|е|ё|и|его|ей|их)\s+опыт\w*\b|"
    r"\bI\s+(?:worked|used|applied|solved|led|implemented|configured|developed|tested|managed)\b|"
    r"\bI\s+have\b.{0,40}\b(?:years?\s+of\s+)?experience\b|\bmy\s+(?:commercial\s+)?experience\b|"
    r"\b(?:in|on)\s+my\s+(?:experience|practice|project|job|role|team|company)\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_PERSONAL_FACT_ANSWER_RE = re.compile(
    r"(?:"
    r"\bя\s+(?:живу|проживаю|нахожусь|гражданин|гражданка|сертифицирован|"
    r"сертифицирована|владею|говорю|учусь|обучаюсь|готов\w*\s+(?:работать|"
    r"подпис|к\b|на\b|рассмотр))|"
    r"\bмне\s+\d{1,3}\s+(?:лет|год)|\bу\s+меня\b|"
    r"\bмо(?:й|я|е|ё|и|его|ей|их)\s+(?:город|гражданств|образован|диплом|"
    r"сертифик|английск|уровень\s+язык|зарплат|финансов|график|занятост)|"
    r"(?:^|[.!?]\s*)(?:есть|имею)\s+(?:у\s+меня\s+)?(?:коммерческ\w*\s+)?опыт|"
    r"\bмне\s+приходилось\b|\bна\s+прошл\w*\s+работ\w*\b|"
    r"\bI\s+(?:live|reside|am\s+based|am\s+certified|have\s+(?:a\s+)?(?:degree|"
    r"certificate)|am\s+(?:available|willing)\s+to\s+(?:work|travel|relocate))\b|"
    r"\bI\s+am\s+\d{1,3}\b|\bmy\s+(?:city|citizenship|education|degree|"
    r"certification|English|language\s+level|salary|availability|schedule)\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_KNOWLEDGE_PERSONAL_MARKER_RE = re.compile(
    r"(?:"
    r"\b(?:я|мне|мой|моя|мо[её]|мои|у\s+меня|ранее|раньше|опыт)\b|"
    r"\b(?:работаю|работал|работала|отвечал|отвечала|использую|использовал|"
    r"использовала|знаю|владею|имею|обладаю|готов|готова|могу|учился|училась|"
    r"сертифицирован|сертифицирована)\b|"
    r"\b(?:I|my|mine|previously|currently|experienced|experience|worked|used|"
    r"lead|led|managed|willing|available)\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_PROMPT_INJECTION_RE = re.compile(
    r"(?:"
    r"игнорир\w*.{0,40}(?:инструкц|правил|ограничен)|"
    r"(?:ответьте|ответь|напишите|напиши|укажите|укажи).{0,50}(?:что\s+(?:вы|я)|будто\s+(?:вы|я))|"
    r"\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous\s+)?(?:instructions?|rules?|prompts?)\b|"
    r"\b(?:say|write|claim|state)\s+that\s+(?:you|I)\b|\b(?:system|developer)\s+prompt\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_NEGATIVE_EXPERIENCE_RE = re.compile(
    r"(?:"
    r"\bне\s+(?!только\b)(?:\w+\s+){0,2}(?:работал|работала|использовал|использовала|применял|"
    r"применяла|сталкивался|сталкивалась|знаком|знакома|занимался|занималась)|"
    r"\bникогда\s+не\b|\bнет\s+(?:у\s+меня\s+)?(?:коммерческ\w*\s+)?опыт|"
    r"\bопыт\w*.{0,20}(?:нет|отсутств)|\bбез\s+(?:коммерческ\w*\s+)?опыт|"
    r"\b(?:never|have\s+not|haven't|did\s+not|didn't|no)\b.{0,35}"
    r"(?:worked|used|experience|familiar)"
    r")",
    re.IGNORECASE,
)
_SCREENING_PROSPECTIVE_EXPERIENCE_RE = re.compile(
    r"(?:"
    r"\b(?:хочу|планир\w*|собираюсь|намерен\w*|готов\w*)\b.{0,35}"
    r"(?:изуч|осво|попроб|разобра|науч)|"
    r"\b(?:(?:сейчас|пока)\s+)?(?:самостоятельно\s+)?(?:изучаю|осваиваю)\b|"
    r"\b(?:want|plan|intend|willing|ready)\b.{0,35}(?:learn|study|try)|"
    r"\b(?:currently\s+)?learning\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_AFFIRMATIVE_EXPERIENCE_RE = re.compile(
    r"(?:"
    r"^(?:да|yes)\b|\b(?:есть|имею)\s+(?:коммерческ\w*\s+)?опыт|"
    r"\b(?:работал|работала|использовал|использовала|применял|применяла|сталкивался|"
    r"сталкивалась|занимался|занималась)\b|"
    r"\b(?:I\s+have|I\s+worked|I\s+used|experienced\s+with|have\s+experience)\b"
    r")",
    re.IGNORECASE,
)
_SCREENING_EVIDENCE_STOP_WORDS = {
    "ваш", "ваша", "ваши", "вас", "есть", "был", "была", "были", "ли", "опыт",
    "опишите", "какой", "какие", "работали", "работал", "использовали", "использовал",
    "with", "your", "have", "what", "which", "work", "worked", "experience", "describe",
}
_SCREENING_PERSONAL_SUPPORT_STOP_WORDS = _SCREENING_EVIDENCE_STOP_WORDS | {
    "также", "который", "которая", "которые", "этого", "этой", "своей",
    "своего", "через", "после", "перед", "about", "also", "that", "this",
    "then", "with", "from", "into", "using", "worked", "experience",
}
_SCREENING_TECH_EVIDENCE_PATTERNS: dict[str, re.Pattern[str]] = {
    "1c": re.compile(r"(?:^|\W)(?:1c|1с|1c|1с)(?:\W|$)", re.IGNORECASE),
    "allure": re.compile(r"\ballure\b", re.IGNORECASE),
    "ci": re.compile(r"\bci(?:\s*/\s*cd)?\b|пайплайн|pipeline", re.IGNORECASE),
    "aws": re.compile(r"\baws\b|amazon\s+web\s+services", re.IGNORECASE),
    "c++": re.compile(r"(?:^|\W)c\+\+(?:\W|$)", re.IGNORECASE),
    "c#": re.compile(r"(?:^|\W)c#(?:\W|$)|\.net\b", re.IGNORECASE),
    "c": re.compile(r"(?:^|[^a-z0-9+#])c(?:[^a-z0-9+#]|$)", re.IGNORECASE),
    "docker": re.compile(r"\bdocker\b", re.IGNORECASE),
    "edt": re.compile(r"\bedt\b", re.IGNORECASE),
    "git": re.compile(r"\bgit(?:hub|lab)?\b", re.IGNORECASE),
    "go": re.compile(r"\bgo(?:lang)?\b", re.IGNORECASE),
    "java": re.compile(r"\bjava\b", re.IGNORECASE),
    "javascript": re.compile(r"\bjavascript\b|\bjs\b", re.IGNORECASE),
    "jira": re.compile(r"\bjira\b", re.IGNORECASE),
    "kubernetes": re.compile(r"\bkubernetes\b|\bk8s\b", re.IGNORECASE),
    "playwright": re.compile(r"\bplaywright\b", re.IGNORECASE),
    "postman": re.compile(r"\bpostman\b", re.IGNORECASE),
    "pytest": re.compile(r"\bpytest\b", re.IGNORECASE),
    "python": re.compile(r"\bpython\b", re.IGNORECASE),
    "r": re.compile(r"(?:^|[^a-z0-9+#])r(?:[^a-z0-9+#]|$)", re.IGNORECASE),
    "selenium": re.compile(r"\bselenium\b", re.IGNORECASE),
    "sonar": re.compile(r"\bsonar(?:qube)?\b", re.IGNORECASE),
    "sql": re.compile(r"\bsql\b|\bpostgres(?:ql)?\b|\bmysql\b", re.IGNORECASE),
    "swift": re.compile(r"\bswift\b", re.IGNORECASE),
    "ios": re.compile(r"\bios\b", re.IGNORECASE),
    "typescript": re.compile(r"\btypescript\b|\bts\b", re.IGNORECASE),
    "vanessa": re.compile(r"\bvanessa\b|ванесс", re.IGNORECASE),
}
_SCREENING_STRONG_ACTION_EVIDENCE: tuple[tuple[re.Pattern[str], re.Pattern[str]], ...] = (
    (
        re.compile(r"настроил|настроила|настраивал|configured|set\s+up", re.IGNORECASE),
        re.compile(r"настро|конфигур|configured|configuration|set\s+up", re.IGNORECASE),
    ),
    (
        re.compile(r"внедрил|внедрила|implemented|introduced", re.IGNORECASE),
        re.compile(r"внедр|implemented|implementation|introduced", re.IGNORECASE),
    ),
    (
        re.compile(r"создал|создала|разработал|разработала|built|created|developed", re.IGNORECASE),
        re.compile(r"созд|разработ|built|created|developed", re.IGNORECASE),
    ),
    (
        re.compile(r"руководил|руководила|управлял|управляла|led|managed", re.IGNORECASE),
        re.compile(r"руковод|управля|лид\w*\s+команд|led|managed|management", re.IGNORECASE),
    ),
)
_SCREENING_DURATION_RE = re.compile(
    r"\b(\d+(?:[.,]\d+)?)\s*(лет|года?|месяц(?:а|ев)?|недел(?:я|и|ь)?|дн(?:я|ей)|"
    r"years?|months?|weeks?|days?)\b",
    re.IGNORECASE,
)


def _screening_durations(value: str) -> set[tuple[str, str]]:
    categories = {
        "лет": "year", "год": "year", "года": "year",
        "year": "year", "years": "year",
        "месяц": "month", "месяца": "month", "месяцев": "month",
        "month": "month", "months": "month",
        "неделя": "week", "недели": "week", "недель": "week", "неделю": "week",
        "week": "week", "weeks": "week",
        "дня": "day", "дней": "day", "day": "day", "days": "day",
    }
    return {
        (number.replace(",", "."), categories[unit.casefold()])
        for number, unit in _SCREENING_DURATION_RE.findall(value)
    }


def _normalize_screening_text(value: str) -> str:
    normalized = value.casefold().replace("ё", "е")
    return re.sub(r"[^0-9a-zа-я+#.]+", " ", normalized).strip()


def _screening_personal_claim_stems(value: str) -> set[str]:
    return {
        cleaned[:6]
        for token in _normalize_screening_text(value).split()
        if (cleaned := token.strip("."))
        and len(cleaned) >= 4
        and cleaned not in _SCREENING_PERSONAL_SUPPORT_STOP_WORDS
    }


def _screening_exact_confirmed_value(
    question: dict[str, Any],
    answer_text: str,
    selected: list[str],
    confirmed_answers: list[dict[str, Any]],
) -> str | None:
    prompt_key = _normalize_screening_text(str(question.get("prompt", "")))
    for fact in confirmed_answers:
        if _normalize_screening_text(str(fact.get("question", ""))) != prompt_key:
            continue
        confirmed_text = str(fact.get("answer", "")).strip()
        confirmed_options = [str(value).strip() for value in fact.get("selectedOptions", []) if str(value).strip()]
        if question.get("kind") == "text":
            actual = _normalize_screening_text(answer_text)
            candidates = [confirmed_text, *confirmed_options]
            match = next(
                (value for value in candidates if _normalize_screening_text(value) == actual and actual),
                None,
            )
            if match:
                return match
            continue
        actual_options = {_normalize_screening_text(value) for value in selected if value.strip()}
        expected_values = confirmed_options or ([confirmed_text] if confirmed_text else [])
        expected_options = {
            _normalize_screening_text(value)
            for value in expected_values
            if value.strip()
        }
        if actual_options and actual_options == expected_options:
            return ", ".join(selected)
    return None


def _screening_evidence_is_verifiable(
    question: dict[str, Any],
    answer_text: str,
    selected: list[str],
    evidence_quote: str,
    source_text: str,
) -> bool:
    quote = _normalize_screening_text(evidence_quote)
    source = _normalize_screening_text(source_text)
    if len(quote) < 8 or quote not in source:
        return False
    question_tokens = {
        token for token in _normalize_screening_text(str(question.get("prompt", ""))).split()
        if len(token) >= 4 and token not in _SCREENING_EVIDENCE_STOP_WORDS
    }
    quote_tokens = {token for token in quote.split() if len(token) >= 4}
    shares_subject = any(
        left == right or left[:5] == right[:5]
        for left in question_tokens
        for right in quote_tokens
    )
    if question_tokens and not shares_subject:
        return False
    prompt = str(question.get("prompt", ""))
    claim_text = " ".join([answer_text, *selected]).strip()
    selected_negative = any(
        re.match(r"^(?:нет|no)(?:\s|$)", _normalize_screening_text(value))
        for value in selected
    )
    experience_claim = bool(
        _SCREENING_EXPERIENCE_RE.search(prompt)
        or _SCREENING_AFFIRMATIVE_EXPERIENCE_RE.search(claim_text)
    )
    negative_claim = selected_negative or bool(
        _SCREENING_NEGATIVE_EXPERIENCE_RE.search(claim_text)
        or re.match(r"^(?:нет|no)(?:\s|$)", _normalize_screening_text(answer_text))
    )
    negative_evidence = bool(_SCREENING_NEGATIVE_EXPERIENCE_RE.search(evidence_quote))
    # Negative free-text claims are especially easy to bind to the wrong item
    # in a mixed résumé sentence ("worked with Python, not Java"). Only an
    # exact user-confirmed negative is eligible for automatic submission.
    if negative_claim:
        return False
    if experience_claim:
        if negative_evidence:
            return False
        if _SCREENING_PROSPECTIVE_EXPERIENCE_RE.search(evidence_quote):
            return False
        if (
            _SCREENING_DIRECT_EXPERIENCE_PROMPT_RE.search(prompt)
            and not _SCREENING_AFFIRMATIVE_EXPERIENCE_RE.search(evidence_quote)
        ):
            return False
    if experience_claim and negative_claim and not negative_evidence:
        return False
    # A single overlapping word must not authorize a compound résumé claim.
    # Every named tool in the answer and every strong ownership/setup action
    # needs direct support in the quoted evidence.
    unsupported_technologies = [
        name
        for name, pattern in _SCREENING_TECH_EVIDENCE_PATTERNS.items()
        if pattern.search(claim_text) and not pattern.search(evidence_quote)
    ]
    if unsupported_technologies:
        return False
    prompt_technologies = {
        name
        for name, pattern in _SCREENING_TECH_EVIDENCE_PATTERNS.items()
        if pattern.search(prompt)
    }
    # A single Да or one supported tool cannot answer a compound question
    # about several named technologies. Require the answer and its quote to
    # explicitly cover every named subject; otherwise leave the draft for
    # review.
    if prompt_technologies and any(
        not _SCREENING_TECH_EVIDENCE_PATTERNS[name].search(claim_text)
        or not _SCREENING_TECH_EVIDENCE_PATTERNS[name].search(evidence_quote)
        for name in prompt_technologies
    ):
        return False
    for claim_pattern, evidence_pattern in _SCREENING_STRONG_ACTION_EVIDENCE:
        if claim_pattern.search(claim_text) and not evidence_pattern.search(evidence_quote):
            return False
    # Every substantive answer stem must be present in the exact source quote,
    # not merely one overlapping word from the question. This keeps résumé and
    # legend autofill extractive while still allowing light punctuation and
    # morphology changes.
    claim_stems = _screening_personal_claim_stems(claim_text)
    evidence_stems = _screening_personal_claim_stems(evidence_quote)
    if not claim_stems or claim_stems - evidence_stems:
        return False
    named_latin_claims = {
        value.casefold()
        for value in re.findall(r"\b[A-Z][A-Za-z0-9.+#-]{2,}\b", claim_text)
        if value.casefold() not in {"the", "this", "that", "when", "first", "using"}
    }
    normalized_evidence = _normalize_screening_text(evidence_quote)
    if any(name not in normalized_evidence.split() for name in named_latin_claims):
        return False
    if re.search(r"коммерческ|commercial|production|продакш", prompt, re.IGNORECASE):
        if re.search(r"учебн|личн\w*\s+проект|pet[- ]?project|курсов|training", evidence_quote, re.IGNORECASE):
            return False
        if not re.search(
            r"коммерческ|commercial|production|продакш|опыт\s+работ|работал\w*\s+(?:в|на)|"
            r"компан|работодател|должност",
            evidence_quote,
            re.IGNORECASE,
        ):
            return False
    claimed_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", f"{answer_text} {' '.join(selected)}"))
    evidence_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", evidence_quote))
    if not claimed_numbers.issubset(evidence_numbers):
        return False
    claimed_durations = _screening_durations(f"{answer_text} {' '.join(selected)}")
    evidence_durations = _screening_durations(evidence_quote)
    return claimed_durations.issubset(evidence_durations)


def _screening_server_autofill(
    question: dict[str, Any],
    answer_text: str,
    selected: list[str],
    answer_item: dict[str, Any],
    *,
    confirmed_answers: list[dict[str, Any]],
    resume: str,
    legend: str,
    draft_mode: bool,
) -> tuple[bool, str, str]:
    """Validate model provenance before allowing an answer to leave review mode."""
    provenance = str(
        answer_item.get("sourceType", answer_item.get("provenance", "none"))
    ).strip().casefold()
    if provenance not in {"resume", "legend", "confirmed", "knowledge", "none"}:
        provenance = "none"
    evidence_quote = str(
        answer_item.get("evidenceQuote", answer_item.get("evidence", ""))
    ).strip()[:500]
    if draft_mode or answer_item.get("canAutoFill") is not True:
        return False, provenance, evidence_quote

    confirmed_value = _screening_exact_confirmed_value(
        question, answer_text, selected, confirmed_answers
    )
    if confirmed_value:
        return True, "confirmed", confirmed_value[:500]

    # A free-form quote cannot safely bind a model-generated Да/Нет (or one
    # selected option) to every subject in a compound employer question. Exact
    # user-confirmed choices are handled above; all other closed choices remain
    # prepared review suggestions. Deterministic desktop rules keep their
    # explicit, source-backed allowlist.
    if question.get("kind") != "text":
        return False, provenance, evidence_quote

    # Model output is always useful as a prepared draft, but it is not a safe
    # authority for automatic submission.  A finite regex/evidence checker can
    # still miss an invented personal clause, a polarity reversal, or one
    # unsupported part of an arbitrary compound employer question.  Exact
    # user-confirmed values are the only model-path exception above.  Resume
    # facts such as city/salary and allowlisted professional answers are filled
    # deterministically by the desktop client before the model is called.
    return False, provenance, evidence_quote


def _screening_answers_runtime_budget(model: str) -> tuple[float, int, float]:
    """Return provider timeout, attempts and an aligned outer deadline."""
    settings = get_settings()
    requested_timeout = max(0.1, float(settings.screening_answers_provider_timeout_seconds))
    max_attempts = max(1, min(5, int(settings.screening_answers_provider_max_attempts)))
    model_passes = 1 if model == FEEDBACK_FALLBACK_MODEL else 2
    max_provider_budget = (
        SCREENING_ANSWERS_MAX_DEADLINE_SECONDS - SCREENING_ANSWERS_DEADLINE_MARGIN_SECONDS
    ) / model_passes
    minimum_timeout = 0.1
    fixed_retry_overhead = (
        provider_adapter.completion_retry_budget_seconds(minimum_timeout, max_attempts)
        - minimum_timeout * max_attempts
    )
    max_request_timeout = max(
        minimum_timeout,
        (max_provider_budget - fixed_retry_overhead) / max_attempts,
    )
    request_timeout = min(requested_timeout, max_request_timeout)
    provider_budget = provider_adapter.completion_retry_budget_seconds(
        request_timeout,
        max_attempts,
    )
    derived_deadline = (
        provider_budget * model_passes + SCREENING_ANSWERS_DEADLINE_MARGIN_SECONDS
    )
    configured_deadline = settings.screening_answers_deadline_seconds
    deadline = min(
        SCREENING_ANSWERS_MAX_DEADLINE_SECONDS,
        max(
            derived_deadline,
            float(configured_deadline) if configured_deadline is not None else 0.0,
        ),
    )
    return request_timeout, max_attempts, deadline


def _screening_review_fallback(
    question: dict[str, Any],
    *,
    vacancy_title: str = "",
    vacancy_company: str = "",
    reason: str = "",
) -> dict[str, Any]:
    """Build a non-empty last-resort draft that can never be auto-submitted."""
    prompt = str(question.get("prompt", ""))
    kind = str(question.get("kind", "text"))
    options = [str(value).strip() for value in question.get("options", []) if str(value).strip()]
    selected: list[str] = []
    answer = ""
    if kind != "text" and options:
        neutral = next(
            (
                option
                for option in options
                if re.search(
                    r"^(?:по\s+договоренности|готов\w*\s+обсудить|свой\s+вариант|другое|иное|"
                    r"не\s+указан|нет\s+предпочтен|любой|any|other|not\s+specified)",
                    option,
                    re.IGNORECASE,
                )
            ),
            None,
        )
        sensitive = bool(
            re.search(
                r"гражданств|право\s+на\s+работ|разрешен\w*\s+на\s+работ|судим|"
                r"военн|арм(?:ия|ии)|трудоустр|официальн|тк\s*рф|"
                r"трудов\w*\s+(?:договор|опыт)|самозанят|(?:^|\W)ип(?:\W|$)|"
                r"(?:^|\W)гпх(?:\W|$)|зарплат|оклад|компенсац|"
                r"финансов\w*\s+ожидан|релокац|переезд|график|смен|дата\s+выхода|"
                r"за\s+последн|полгода|опыт|работал|использовал|знаком|применял|"
                r"swift|ios|1[сc]|experience|worked\s+with|used|current|currently|"
                r"work\s+(?:permit|authorization|status)|military|criminal",
                prompt,
                re.IGNORECASE,
            )
        )
        if neutral:
            selected = [neutral]
        elif sensitive:
            answer = (
                "Выберите точный вариант после проверки личного статуса или опыта: "
                "SkillCue не будет угадывать ответ «Да» или «Нет»."
            )
        else:
            answer = (
                "Выберите подходящий вариант вручную: SkillCue не будет угадывать "
                "неподтверждённый ответ."
            )
    elif re.search(
        r"зарплат|оклад|компенсац|финансов\w*\s+ожидан|salary|compensation",
        prompt,
        re.IGNORECASE,
    ):
        role = vacancy_title.strip() or "этой позиции"
        answer = (
            f"Ориентируюсь на рыночную компенсацию для позиции «{role}»; "
            "точный диапазон готов согласовать с учётом задач, формата работы и совокупного пакета."
        )
    elif re.search(
        r"где\s+(?:вы\s+)?(?:жив|наход)|"
        r"(?:в\s+)?каком\s+городе.{0,60}(?:жив|прожив|наход)|"
        r"город\w*.{0,60}(?:жив|прожив|нахожд)|"
        r"локаци|местонахожд|location|city|residen",
        prompt,
        re.IGNORECASE,
    ):
        answer = (
            "Актуальный город проживания и доступный формат работы готов подтвердить "
            "перед следующим этапом."
        )
    elif re.search(
        r"гражданств|право\s+на\s+работ|военн|судим|трудоустр|официальн\w*\s+оформ|"
        r"самозанят|график|дата\s+выхода|work\s+(?:permit|authorization|status)|military|criminal",
        prompt,
        re.IGNORECASE,
    ):
        answer = (
            "Актуальный статус по этому пункту готов подтвердить работодателю "
            "перед следующим этапом."
        )
    elif re.search(
        r"почему.*(?:ваканси|позици)|чем.*(?:ваканси|позици).*интерес|мотивац",
        prompt,
        re.IGNORECASE,
    ):
        role = vacancy_title.strip() or "эта позиция"
        company = f" в {vacancy_company.strip()}" if vacancy_company.strip() else ""
        answer = (
            f"Мне интересна позиция «{role}»{company}: она позволяет применять мой профиль "
            "к реальным задачам продукта, развивать качество и давать измеримый результат команде."
        )
    elif re.search(
        r"как\s+(?:бы\s+)?(?:вы\s+)?(?:протестир|провер|реш|поступ|организ)|"
        r"что\s+такое|объясните|чем\s+отлича|how\s+would\s+you|what\s+is",
        prompt,
        re.IGNORECASE,
    ):
        answer = (
            "Сначала уточню требования и критерии успеха, затем выделю критичные и граничные "
            "сценарии, проверю основные риски и зафиксирую воспроизводимый результат."
        )
    elif re.search(
        r"опыт|работал|использовал|знаком|применял|experience|worked\s+with|used",
        prompt,
        re.IGNORECASE,
    ):
        answer = (
            "Подтверждённый релевантный опыт и инструменты перечислены в моём резюме; "
            "готов предметно уточнить глубину опыта по технологиям, важным для этой позиции."
        )
    else:
        answer = (
            "Готов дать предметный ответ с учётом контекста вакансии; перед отправкой уточню "
            "личные факты и оставлю только то, что точно соответствует моему опыту."
        )
    return {
        "id": str(question.get("id", "")),
        "answer": answer,
        "selectedOptions": selected,
        "canAutoFill": False,
        "sourceType": "none",
        "evidenceQuote": "",
        "reason": (
            "Черновик подготовлен локально и требует подтверждения пользователя"
            + (f": {reason.strip()[:180]}" if reason.strip() else ".")
        )[:300],
        "preparationNote": "",
    }


def _screening_fallback_response(
    questions: list[dict[str, Any]],
    *,
    vacancy_title: str = "",
    vacancy_company: str = "",
    reason: str = "",
) -> dict[str, Any]:
    return {
        "answers": [
            _screening_review_fallback(
                question,
                vacancy_title=vacancy_title,
                vacancy_company=vacancy_company,
                reason=reason,
            )
            for question in questions
        ],
        "model": "local-review-fallback",
    }


async def _complete_or_fallback(
    messages: list[dict],
    provider: str,
    model: str,
    *,
    fallback_model: str = FALLBACK_MODEL,
    fallback_kwargs: dict | None = None,
    **kwargs,
) -> tuple[str, str]:
    """(raw, model_used). На ошибке основной модели повторяет запрос быстрым
    fallback-ом — чтобы AI-разбор не падал в детерминированную эвристику."""
    try:
        return await provider_adapter.complete(messages, provider, model, **kwargs), model
    except Exception as exc:  # noqa: BLE001
        # Subscription/quota/auth/input failures are definitive. Retrying them
        # on another model only wastes time and, more importantly, used to hide
        # their structured HTTP status/code behind a generic 502.
        if isinstance(exc, AppError) and exc.status_code not in {
            403,
            404,
            429,
            500,
            502,
            503,
            504,
        }:
            raise
        if model == fallback_model:
            raise
        logger.warning(
            "Vacancy model %s failed (%s) — retrying with %s", model, exc, fallback_model
        )
        raw = await provider_adapter.complete(
            messages, provider, fallback_model, **(fallback_kwargs or kwargs)
        )
        return raw, fallback_model


def _parse_json(raw: str) -> dict:
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip().rstrip("`").strip()
    try:
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    # Salvage the first {...} block.
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    raise HTTPException(status_code=502, detail="Model did not return valid JSON")


def _slug(text: str, used: set[str]) -> str:
    base = re.sub(r"[^a-zа-яё0-9]+", "-", (text or "topic").lower()).strip("-")[:48] or "topic"
    slug = base
    i = 2
    while slug in used:
        slug = f"{base}-{i}"
        i += 1
    used.add(slug)
    return slug


def _as_list(value, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:limit]


class AnalyzePayload(BaseModel):
    vacancyText: str
    targetRole: str | None = None
    language: str = "ru"
    resumeText: str | None = None
    legendText: str | None = None


class ReportTopicPayload(BaseModel):
    title: str
    score: int = 0
    status: str = ""
    missingPoints: list[str] = []


class ReportWeakAnswerPayload(BaseModel):
    question: str
    missing: list[str] = []
    score: int = 0


class ReportPayload(BaseModel):
    targetRole: str = ""
    seniorityLevel: str = "unknown"
    overallScore: int = 0
    topics: list[ReportTopicPayload] = []
    weakAnswers: list[ReportWeakAnswerPayload] = []
    resumeText: str | None = None
    legendText: str | None = None
    vacancyText: str | None = None
    language: str = "ru"


class EvaluatePayload(BaseModel):
    question: str
    answer: str
    topic: str = ""
    level: str = ""
    expectedSignals: list[str] = []
    relatedResumeEvidence: list[str] = []
    resumeText: str | None = None
    vacancyText: str | None = None
    legendText: str | None = None
    language: str = "ru"
    hasResume: bool = False


class ScreeningQuestionPayload(BaseModel):
    id: str
    prompt: str
    kind: str = "text"
    options: list[str] = []
    required: bool = False


class ConfirmedScreeningAnswerPayload(BaseModel):
    question: str = ""
    answer: str = ""
    selectedOptions: list[str] = []


class ExistingScreeningDraftPayload(BaseModel):
    questionId: str = ""
    answer: str = ""


class ScreeningAnswersPayload(BaseModel):
    vacancyTitle: str = ""
    vacancyCompany: str = ""
    vacancyDescription: str = ""
    resumeText: str | None = None
    questions: list[ScreeningQuestionPayload] = []
    confirmedAnswers: list[ConfirmedScreeningAnswerPayload] = []
    draftMode: bool = False
    existingDraft: ExistingScreeningDraftPayload | None = None
    language: str = "ru"


class CoverLetterPayload(BaseModel):
    vacancyTitle: str = ""
    vacancyCompany: str = ""
    vacancyDescription: str = ""
    resumeText: str | None = None
    language: str = "ru"


def _cover_letter_unavailable(reason: str, failure_kind: str = "manual") -> dict:
    return {
        "coverLetter": "",
        "matches": [],
        "canAutoFill": False,
        "reason": reason[:300],
        "failureKind": failure_kind,
    }


@router.post("/cover-letter")
async def cover_letter(payload: CoverLetterPayload, db=Depends(get_db)) -> dict:
    """Write a vacancy-specific letter grounded in the saved résumé and legend."""
    vacancy_description = re.sub(r"\s+", " ", payload.vacancyDescription).strip()[:8_000]
    if len(vacancy_description) < 80:
        return _cover_letter_unavailable(
            "Не удалось прочитать полное описание вакансии — письмо оставлено для ручной проверки."
        )

    supplied_resume = re.sub(r"\s+", " ", payload.resumeText or "").strip()[:8_000]
    resume = supplied_resume or rag_service.get_context_text(db, "resume")[:8_000].strip()
    legend = rag_service.get_context_text(db, "legend")[:3_000].strip()
    if len(resume) < 80:
        return _cover_letter_unavailable(
            "В профиле нет полного резюме, поэтому нельзя безопасно подтвердить опыт для письма."
        )

    _ensure_vacancy_quota(db)
    provider, model = _resolve("vacancy")
    prompt = VACANCY_COVER_LETTER_PROMPT.format(
        vacancy_title=payload.vacancyTitle.strip()[:300] or "(unknown)",
        vacancy_company=payload.vacancyCompany.strip()[:300] or "(unknown)",
        vacancy_description=vacancy_description,
        resume=resume,
        legend=legend or "(none)",
        language="Russian" if payload.language == "ru" else "English",
    )
    try:
        raw, model = await asyncio.wait_for(
            _complete_or_fallback(
                [{"role": "user", "content": prompt}],
                provider,
                model,
                max_tokens=COVER_LETTER_MAX_TOKENS,
                temperature=0.35,
                response_format={"type": "json_object"},
                fallback_model=FALLBACK_MODEL,
            ),
            timeout=COVER_LETTER_DEADLINE_SECONDS,
        )
    except TimeoutError as exc:
        logger.warning(
            "Cover-letter generation exceeded %.1fs deadline",
            COVER_LETTER_DEADLINE_SECONDS,
        )
        raise HTTPException(status_code=504, detail="Cover-letter generation timed out") from exc
    except AppError as exc:
        logger.warning(
            "Cover-letter generation failed (%s, HTTP %s): %s",
            exc.code,
            exc.status_code,
            exc.message,
        )
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cover-letter generation failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)
    letter = str(data.get("coverLetter", "")).replace("\r\n", "\n").strip()[:4_000]
    matches = []
    raw_matches_value: Any = data.get("matches")
    matches_schema_valid = isinstance(raw_matches_value, list)
    raw_matches: list[Any] = raw_matches_value if matches_schema_valid else []
    for item in raw_matches:
        if not isinstance(item, dict):
            continue
        need = str(item.get("vacancyNeed", "")).strip()[:300]
        evidence = str(item.get("resumeEvidence", "")).strip()[:500]
        if need and evidence:
            matches.append({"vacancyNeed": need, "resumeEvidence": evidence})
        if len(matches) >= 5:
            break

    expected_greeting = (
        letter.startswith("Здравствуйте!")
        if payload.language == "ru"
        else bool(re.match(r"^(?:Hello|Dear)\b", letter, re.IGNORECASE))
    )
    has_placeholder = bool(
        re.search(
            r"\{[^{}\n]{1,120}\}|\[[^\[\]\n]{1,120}\]|<(?:your\s+name|name|company|имя|компания)>",
            letter,
            re.I,
        )
    )
    has_formal_signoff = bool(
        re.search(
            r"(?:^|\n)\s*(?:с\s+уважением|уважительно|best\s+regards|kind\s+regards|sincerely|respectfully)(?:\s*[,!.]|\s*$)",
            letter,
            re.I | re.M,
        )
    )
    has_markdown_list = bool(re.search(r"^(?:\s*[-*]\s+|\s*\d+[.)]\s+)", letter, re.M))
    can_auto_fill = (
        bool(data.get("canAutoFill", False))
        and 350 <= len(letter) <= 4_000
        and len(matches) >= 2
        and expected_greeting
        and not has_placeholder
        and not has_formal_signoff
        and not has_markdown_list
    )
    if not can_auto_fill:
        reason = str(data.get("reason", "")).strip()[:300]
        explicit_skill_mismatch = data.get("canAutoFill") is False and matches_schema_valid
        return _cover_letter_unavailable(
            reason
            or "Не удалось получить достаточно конкретное и подтверждённое письмо — автоотклик остановлен.",
            "skill_mismatch" if explicit_skill_mismatch else "manual",
        )
    return {
        "coverLetter": letter,
        "matches": matches,
        "canAutoFill": True,
        "reason": "",
        "model": model,
    }


@router.post("/screening-answers")
async def screening_answers(payload: ScreeningAnswersPayload, db=Depends(get_db)) -> dict:
    """Generate one grounded answer batch for an HH employer-question form."""
    quota_error: AppError | None = None
    try:
        _ensure_vacancy_quota(db)
    except AppError as exc:
        # A spent online-AI allowance must not make the employer-question
        # editor empty. Validation below still runs; after that we return
        # local review-only drafts which do not consume provider tokens.
        quota_error = exc
    questions = payload.questions[:20]
    if not questions:
        raise HTTPException(status_code=400, detail="No screening questions provided")

    normalized_questions: list[dict[str, Any]] = []
    ids: set[str] = set()
    for question_payload in questions:
        question_id = question_payload.id.strip()[:100]
        prompt = question_payload.prompt.strip()[:1200]
        if not question_id or not prompt or question_id in ids:
            raise HTTPException(
                status_code=400,
                detail="Screening question ids and prompts must be unique",
            )
        ids.add(question_id)
        normalized_questions.append(
            {
                "id": question_id,
                "prompt": prompt,
                "kind": question_payload.kind
                if question_payload.kind in {"text", "single", "multiple", "select"}
                else "text",
                "options": _as_list(question_payload.options, 30),
                "required": bool(question_payload.required),
            }
        )

    supplied_resume = re.sub(r"\s+", " ", payload.resumeText or "").strip()[:5_000]
    resume = supplied_resume or rag_service.get_context_text(db, "resume")[:5_000]
    legend = rag_service.get_context_text(db, "legend")[:2_000]
    confirmed_answers: list[dict[str, Any]] = []
    confirmed_answers_chars = 0
    for confirmed_answer in payload.confirmedAnswers[-30:]:
        confirmed_question = re.sub(r"\s+", " ", confirmed_answer.question).strip()[:1_200]
        confirmed_text = confirmed_answer.answer.strip()[:2_000]
        selected_options = _as_list(confirmed_answer.selectedOptions, 30)
        if confirmed_question and (confirmed_text or selected_options):
            item_chars = (
                len(confirmed_question) + len(confirmed_text) + sum(map(len, selected_options))
            )
            if confirmed_answers_chars + item_chars > 12_000:
                continue
            confirmed_answers.append(
                {
                    "question": confirmed_question,
                    "answer": confirmed_text,
                    "selectedOptions": selected_options,
                }
            )
            confirmed_answers_chars += item_chars
    existing_draft: dict[str, str] | None = None
    if payload.existingDraft:
        draft_question_id = payload.existingDraft.questionId.strip()[:200]
        draft_answer = re.sub(r"\s+", " ", payload.existingDraft.answer).strip()[:2_000]
        if draft_question_id in ids and draft_answer:
            existing_draft = {
                "questionId": draft_question_id,
                "answer": draft_answer,
            }

    provider, model = _resolve("feedback")
    answer_mode_rules = (
        """REFINEMENT MODE — rewrite the CURRENT USER DRAFT below instead of inventing a different answer.
- Preserve every concrete fact, limitation, preference, condition, and yes/no position from the user's draft.
- Improve clarity, grammar, structure, confidence, and relevance to the exact employer question.
- Do not add technologies, experience, achievements, dates, metrics, employers, or commitments absent from the draft or authoritative sources.
- Never turn uncertainty into certainty or a limited experience claim into commercial/production ownership.
- Return a finished first-person answer, normally 1-3 concise sentences, with canAutoFill=false because the user reviews it in the editor.
- If the draft is already good, make only minimal edits. Do not replace it with a generic template or unrelated hypothesis."""
        if existing_draft
        else
        """INTERACTIVE DRAFT MODE — the result is shown in an editor and is never submitted without explicit user confirmation.
- Prefer supported résumé facts. Never invent a plausible personal preference, history, game, tool, employer, status, or commitment merely to make a draft sound complete.
- When a personal fact is unknown, return honest review guidance with canAutoFill=false and reason saying exactly what the user needs to verify.
- Do not invent employers, commercial projects, dates, duration, metrics, credentials, legal status, location, salary, work authorization, or contractual commitments.
- Always return a finished non-empty draft for every text question. For an unknown legal, location, compensation, schedule, relocation, or contract fact, answer honestly that the current value must be confirmed. For a closed option question, select an exact option only when a source supports it or the form provides a neutral option; otherwise leave selectedOptions empty and explain that the user must choose.
- Keep a hypothetical draft natural and specific enough to edit; do not use placeholders or coaching instructions inside the answer."""
        if payload.draftMode
        else """AUTOMATIC MODE — every answer may be sent without another review.
- Return a useful finished answer for every text question, even when it cannot be submitted automatically. For a closed option question, select an exact option only from evidence or a neutral choice; an unknown legal/status yes-no question must remain unselected with a clear review reason.
- If a factual answer is not supported by the supplied sources, provide the best conservative review draft, set canAutoFill=false, sourceType=none, and explain what the user must verify. Never label a guessed fact as verified or safe for automatic submission."""
    )
    prompt = VACANCY_SCREENING_ANSWERS_PROMPT.format(
        answer_mode_rules=answer_mode_rules,
        vacancy_title=payload.vacancyTitle.strip()[:300] or "(unknown)",
        vacancy_company=payload.vacancyCompany.strip()[:300] or "(unknown)",
        vacancy_description=payload.vacancyDescription.strip()[:3_500] or "(not provided)",
        resume=resume or "(none — do not make personal experience claims)",
        legend=legend or "(none)",
        confirmed_answers=json.dumps(confirmed_answers, ensure_ascii=False)
        if confirmed_answers
        else "(none)",
        existing_draft=json.dumps(existing_draft, ensure_ascii=False)
        if existing_draft
        else "(none)",
        questions_json=json.dumps(normalized_questions, ensure_ascii=False),
        language="Russian" if payload.language == "ru" else "English",
    )
    if quota_error is not None:
        logger.info(
            "Screening online quota unavailable; returning local review drafts (%s)",
            quota_error.code,
        )
        return _screening_fallback_response(
            normalized_questions,
            vacancy_title=payload.vacancyTitle,
            vacancy_company=payload.vacancyCompany,
            reason=quota_error.message,
        )
    request_timeout, max_attempts, deadline = _screening_answers_runtime_budget(model)
    try:
        raw, model = await asyncio.wait_for(
            _complete_or_fallback(
                [{"role": "user", "content": prompt}],
                provider,
                model,
                max_tokens=SCREENING_ANSWERS_MAX_TOKENS,
                temperature=0.1,
                response_format={"type": "json_object"},
                fallback_model=FEEDBACK_FALLBACK_MODEL,
                request_timeout_seconds=request_timeout,
                max_attempts=max_attempts,
            ),
            timeout=deadline,
        )
    except TimeoutError:
        logger.warning(
            "Screening answer generation exceeded %.1fs deadline",
            deadline,
        )
        return _screening_fallback_response(
            normalized_questions,
            vacancy_title=payload.vacancyTitle,
            vacancy_company=payload.vacancyCompany,
            reason="Провайдер не успел подготовить ответы.",
        )
    except AppError as exc:
        logger.warning(
            "Screening answer generation failed (%s, HTTP %s): %s",
            exc.code,
            exc.status_code,
            exc.message,
        )
        return _screening_fallback_response(
            normalized_questions,
            vacancy_title=payload.vacancyTitle,
            vacancy_company=payload.vacancyCompany,
            reason=exc.message,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Screening answer generation failed: %s", exc)
        return _screening_fallback_response(
            normalized_questions,
            vacancy_title=payload.vacancyTitle,
            vacancy_company=payload.vacancyCompany,
            reason="Онлайн-генератор временно недоступен.",
        )

    try:
        data = _parse_json(raw)
    except HTTPException:
        logger.warning("Screening answer model returned invalid JSON; using local review drafts")
        return _screening_fallback_response(
            normalized_questions,
            vacancy_title=payload.vacancyTitle,
            vacancy_company=payload.vacancyCompany,
            reason="Онлайн-модель вернула повреждённый ответ.",
        )
    raw_answers_value: Any = data.get("answers")
    raw_answers: list[Any] = raw_answers_value if isinstance(raw_answers_value, list) else []
    by_id: dict[str, dict[str, Any]] = {}
    for raw_item in raw_answers:
        if not isinstance(raw_item, dict):
            continue
        raw_id = str(raw_item.get("id", ""))
        if raw_id in ids:
            by_id[raw_id] = raw_item
    answers: list[dict[str, Any]] = []
    for normalized_question in normalized_questions:
        answer_item = by_id.get(normalized_question["id"], {})
        fallback = _screening_review_fallback(
            normalized_question,
            vacancy_title=payload.vacancyTitle,
            vacancy_company=payload.vacancyCompany,
            reason="Онлайн-модель не вернула пригодный ответ.",
        )
        valid_options = {
            option.casefold(): option for option in normalized_question["options"]
        }
        selected: list[str] = []
        for option in _as_list(answer_item.get("selectedOptions"), 30):
            canonical = valid_options.get(option.casefold())
            if canonical and canonical not in selected:
                selected.append(canonical)
        if normalized_question["kind"] in {"single", "select"}:
            selected = selected[:1]
        answer_text = str(answer_item.get("answer", "")).strip()[:2_000]
        if normalized_question["kind"] == "text" and not answer_text:
            answer_text = str(fallback["answer"])
            answer_item = fallback
        elif normalized_question["kind"] != "text" and not selected:
            selected = list(fallback["selectedOptions"])
            answer_text = str(fallback["answer"])
            answer_item = fallback
        can_auto_fill, source_type, evidence_quote = _screening_server_autofill(
            normalized_question,
            answer_text,
            selected,
            answer_item,
            confirmed_answers=confirmed_answers,
            resume=resume,
            legend=legend,
            draft_mode=bool(payload.draftMode),
        )
        if normalized_question["kind"] != "text" and selected and not can_auto_fill:
            neutral_selection = all(
                re.search(
                    r"^(?:по\s+договоренности|готов\w*\s+обсудить|свой\s+вариант|другое|иное|"
                    r"не\s+указан|нет\s+предпочтен|любой|any|other|not\s+specified)",
                    option,
                    re.IGNORECASE,
                )
                for option in selected
            )
            exact_confirmed = bool(
                _screening_exact_confirmed_value(
                    normalized_question,
                    answer_text,
                    selected,
                    confirmed_answers,
                )
            )
            grounded_if_automatic, _, _ = _screening_server_autofill(
                normalized_question,
                answer_text,
                selected,
                answer_item,
                confirmed_answers=confirmed_answers,
                resume=resume,
                legend=legend,
                draft_mode=False,
            )
            if not (neutral_selection or exact_confirmed or grounded_if_automatic):
                # A review-only Да/Нет is still a visible preselection and can
                # be mistaken for a fact. Replace unsupported choices with the
                # same honest, unselected guidance used for provider failures.
                selected = list(fallback["selectedOptions"])
                answer_text = str(fallback["answer"])
                answer_item = fallback
                can_auto_fill = False
                source_type = "none"
                evidence_quote = ""
        if normalized_question["kind"] == "text" and not answer_text:
            can_auto_fill = False
        if normalized_question["kind"] != "text" and not selected:
            can_auto_fill = False
        reason = str(answer_item.get("reason", "")).strip()[:300]
        if (
            not can_auto_fill
            and answer_item.get("canAutoFill") is True
            and (answer_text or selected)
            and not reason
        ):
            reason = (
                "Ответ оставлен на подтверждение: для автозаполнения нет "
                "проверяемого источника в резюме, легенде или точном подтверждённом ответе."
            )
        answers.append(
            {
                "id": normalized_question["id"],
                "answer": answer_text,
                "selectedOptions": selected,
                "canAutoFill": can_auto_fill,
                "reason": reason,
                "preparationNote": str(answer_item.get("preparationNote", "")).strip()[:500],
                "sourceType": source_type,
                "evidenceQuote": evidence_quote,
            }
        )
    return {"answers": answers, "model": model}


@router.post("/analyze")
async def analyze(payload: AnalyzePayload, db=Depends(get_db)) -> dict:
    _ensure_vacancy_quota(db)
    text = (payload.vacancyText or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="Vacancy text is too short")

    provider, model = _resolve("vacancy")
    prompt = VACANCY_ANALYZE_PROMPT.format(
        vacancy=text[:8000],
        resume=(payload.resumeText or "")[:4000] or "(none)",
        legend=(payload.legendText or "")[:2000] or "(none)",
        language="Russian" if payload.language == "ru" else "English",
    )
    try:
        # Полный JSON с темами и компетенциями занимает около 2.5–3k токенов
        # даже для короткой вакансии. При лимите 2200 ответ обрывался посреди
        # массива, _parse_json возвращал 502, а desktop включал эвристику.
        raw, model = await _complete_or_fallback(
            [{"role": "user", "content": prompt}],
            provider,
            model,
            max_tokens=5000,
            temperature=0.3,
        )
    except Exception as exc:  # noqa: BLE001 — surface as 502 so desktop falls back
        logger.warning("Vacancy analyze failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)

    used: set[str] = set()
    topics = []
    for t in data.get("interviewTopics", []) or []:
        if not isinstance(t, dict) or not str(t.get("title", "")).strip():
            continue
        importance = str(t.get("importance", "medium")).lower()
        level = str(t.get("level", "")).lower()
        topics.append(
            {
                "id": _slug(str(t.get("title")), used),
                "title": str(t.get("title")).strip()[:80],
                "category": str(t.get("category", "General")).strip()[:40] or "General",
                "importance": importance if importance in _IMPORTANCE else "medium",
                "level": level if level in _QUESTION_LEVEL else "",
                "expectedKnowledge": str(t.get("expectedKnowledge", "")).strip()[:240],
                "sampleQuestions": _as_list(t.get("sampleQuestions"), 4)
                or ["Расскажи про эту тему."],
                "whyAsked": str(t.get("whyAsked", "")).strip()[:240],
                "expectedAnswerPoints": _as_list(t.get("expectedAnswerPoints"), 3),
                "relatedVacancyTopics": _as_list(t.get("relatedVacancyTopics"), 6),
                "relatedResumeEvidence": _as_list(t.get("relatedResumeEvidence"), 6),
                "vacancyEvidence": str(t.get("vacancyEvidence", "")).strip()[:160],
            }
        )

    competencies = []
    for c in data.get("competencies", []) or []:
        if not isinstance(c, dict) or not str(c.get("name", "")).strip():
            continue
        priority = str(c.get("priority", "medium")).lower()
        expected = str(c.get("expectedLevel", "practical")).lower()
        match = str(c.get("resumeMatch", "gap")).lower()
        competencies.append(
            {
                "name": str(c.get("name")).strip()[:80],
                "priority": priority if priority in _IMPORTANCE else "medium",
                "expectedLevel": expected if expected in _COMPETENCY_LEVEL else "practical",
                "resumeMatch": match if match in _RESUME_MATCH else "gap",
                "note": str(c.get("note", "")).strip()[:200],
            }
        )

    seniority = str(data.get("seniorityLevel", "unknown")).lower()
    target_role = (
        payload.targetRole or str(data.get("targetRole", "")) or "Technical role"
    ).strip()[:80]

    return {
        "targetRole": target_role,
        "seniorityLevel": seniority if seniority in _SENIORITY else "unknown",
        "extractedRequirements": _as_list(data.get("extractedRequirements")),
        "optionalSkills": _as_list(data.get("optionalSkills")),
        "competencies": competencies,
        "interviewTopics": topics,
        "projectQuestions": _as_list(data.get("projectQuestions"), 6),
        "riskAreas": _as_list(data.get("riskAreas"), 6),
        "model": model,
    }


@router.post("/report")
async def report(payload: ReportPayload, db=Depends(get_db)) -> dict:
    """Закрывающий нарратив mock-отчёта: вердикт + приоритетный план тренировки.

    Скоринг остаётся детерминированным на клиенте; модель пишет только «человеческую»
    часть — как коуч после прогона. Клиент молча откатывается на локальный план.
    """
    _ensure_vacancy_quota(db)
    if not payload.topics:
        raise HTTPException(status_code=400, detail="No topic results to summarize")

    provider, model = _resolve("vacancy")
    topics_text = "\n".join(
        f"- {t.title}: {t.score}/100 ({t.status or 'n/a'})"
        + (f"; не хватило: {', '.join(t.missingPoints[:4])}" if t.missingPoints else "")
        for t in payload.topics[:12]
    )
    weak_text = (
        "\n".join(
            f"- «{w.question[:160]}» ({w.score}/100)"
            + (f" → {', '.join(w.missing[:4])}" if w.missing else "")
            for w in payload.weakAnswers[:6]
        )
        or "(none)"
    )
    prompt = VACANCY_REPORT_PROMPT.format(
        target_role=(payload.targetRole or "Technical role")[:80],
        seniority=payload.seniorityLevel or "unknown",
        overall_score=max(0, min(100, payload.overallScore)),
        topics=topics_text,
        weak_answers=weak_text,
        resume=(payload.resumeText or "")[:4000] or "(none)",
        legend=(payload.legendText or "")[:2000] or "(none)",
        vacancy=(payload.vacancyText or "")[:6000] or "(none)",
        language="Russian" if payload.language == "ru" else "English",
    )
    try:
        raw, model = await _complete_or_fallback(
            [{"role": "user", "content": prompt}],
            provider,
            model,
            max_tokens=700,
            temperature=0.3,
        )
    except Exception as exc:  # noqa: BLE001 — surface as 502 so desktop falls back
        logger.warning("Vacancy report failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)
    return {
        "verdict": str(data.get("verdict", "")).strip()[:900],
        "interviewerImpression": str(data.get("interviewerImpression", "")).strip()[:400],
        "nextPracticePlan": _as_list(data.get("nextPracticePlan"), 6),
        "focusTopic": str(data.get("focusTopic", "")).strip()[:80],
        "model": model,
    }


@router.post("/evaluate")
async def evaluate(payload: EvaluatePayload, db=Depends(get_db)) -> dict:
    _ensure_vacancy_quota(db)
    provider, model = _resolve("feedback")
    answer = (payload.answer or "").strip()
    if not answer:
        raise HTTPException(status_code=400, detail="Answer is empty")
    detected_noise = detect_asr_noise(answer)
    prompt = VACANCY_EVALUATE_FAST_PROMPT.format(
        topic=payload.topic or "(unspecified)",
        level=payload.level or "(unspecified)",
        signals=", ".join(payload.expectedSignals) or "(none)",
        resume_evidence=", ".join(payload.relatedResumeEvidence) or "(none)",
        resume=(payload.resumeText or "")[:2500] or "(none)",
        vacancy=(payload.vacancyText or "")[:4000] or "(none)",
        legend=(payload.legendText or "")[:1200] or "(none)",
        question=payload.question[:600],
        answer=answer[:3000],
        has_resume="true" if payload.hasResume else "false",
        language="Russian" if payload.language == "ru" else "English",
    )
    # This path runs after every answer, so latency is part of correctness. A
    # hard server deadline lets the desktop switch to its local deterministic
    # feedback instead of leaving the user staring at a spinner.
    try:
        raw, model = await asyncio.wait_for(
            _complete_or_fallback(
                [{"role": "user", "content": prompt}],
                provider,
                model,
                max_tokens=VACANCY_EVALUATE_MAX_TOKENS,
                temperature=0.1,
                response_format={"type": "json_object"},
                fallback_model=FEEDBACK_FALLBACK_MODEL,
            ),
            timeout=VACANCY_EVALUATE_DEADLINE_SECONDS,
        )
    except TimeoutError as exc:
        logger.warning("Vacancy evaluate exceeded %.1fs deadline", VACANCY_EVALUATE_DEADLINE_SECONDS)
        raise HTTPException(status_code=504, detail="Vacancy evaluation timed out") from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("Vacancy evaluate failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)
    data = harden_vacancy_evaluation(
        data,
        resume_text=payload.resumeText or "",
        vacancy_text=payload.vacancyText or "",
        candidate_answer=answer,
        expected_signals=payload.expectedSignals,
        topic=payload.topic,
        level=payload.level,
        question=payload.question,
        detected_noise=detected_noise,
        legend_text=payload.legendText or "",
    )

    def _score(key: str) -> int:
        try:
            return max(0, min(100, round(float(data.get(key, 0)))))
        except (TypeError, ValueError):
            return 0

    level = str(data.get("levelEstimate", "")).lower()

    return {
        "score": _score("score"),
        "coverageScore": _score("coverageScore"),
        "technicalContentScore": _score("technicalContentScore"),
        "projectSpecificityScore": _score("projectSpecificityScore"),
        "leadershipScore": _score("leadershipScore"),
        "ownershipScore": _score("ownershipScore"),
        "structureScore": _score("structureScore"),
        "speechClarityScore": _score("speechClarityScore"),
        "clarityScore": _score("clarityScore"),
        "technicalAccuracyScore": _score("technicalAccuracyScore"),
        "specificityScore": _score("specificityScore"),
        "confidenceScore": _score("confidenceScore"),
        "levelEstimate": level if level in _QUESTION_LEVEL else "",
        "verdict": str(data.get("verdict", "")).strip()[:200],
        "feedback": str(data.get("feedback", "")).strip()[:800],
        "normalizedAnswerSummary": str(data.get("normalizedAnswerSummary", "")).strip()[:900],
        "detectedNoiseOrAsrErrors": _as_list(data.get("detectedNoiseOrAsrErrors"), 6),
        "extractedValidPoints": _as_list(data.get("extractedValidPoints"), 8),
        "goodPoints": _as_list(data.get("goodPoints"), 6),
        "weakPoints": _as_list(data.get("weakPoints"), 6),
        "missingPoints": _as_list(data.get("missingPoints"), 6),
        "technicalCorrections": _as_list(data.get("technicalCorrections"), 6),
        "hallucinationGuard": _as_list(data.get("hallucinationGuard"), 6),
        "betterStructure": _as_list(data.get("betterStructure"), 8),
        "answerStrategy": str(data.get("answerStrategy", "")).strip()[:500],
        "whyThisAnswerWorks": _as_list(data.get("whyThisAnswerWorks"), 5),
        "deliveryTips": _as_list(data.get("deliveryTips"), 4),
        "suggestedBetterAnswer": str(data.get("suggestedBetterAnswer", "")).strip()[:2600],
        "followUpQuestions": _as_list(data.get("followUpQuestions"), 4),
        "nextTrainingFocus": str(data.get("nextTrainingFocus", "")).strip()[:240],
        "overclaimed": bool(data.get("overclaimed", False)),
        "model": model,
    }
