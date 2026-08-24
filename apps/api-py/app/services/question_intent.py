"""Question intent classification for live interview answers."""

from __future__ import annotations

import re
from typing import Literal, TypedDict

QuestionIntent = Literal[
    "experience",
    "technical_definition",
    "technical_list",
    "technical_comparison",
    "technical_task",
    "api_test_task",
    "practical_usage",
    "behavioral",
    "unclear",
]

ResumeContextLevel = Literal["full", "limited", "none"]


class AnswerStrategy(TypedDict):
    question_intent: QuestionIntent
    answer_strategy: str
    resume_context_used: bool
    resume_context_level: ResumeContextLevel
    resume_context_reason: str
    suggest_unclear_prefix: bool


# Каждый интент матчится по русским И английским формулировкам — движок ответов
# один, а собеседования бывают на обоих языках.
_BEHAVIORAL_RE = re.compile(
    r"(?:почему\s+(?:уш\w*|уход|хот\w*\s+(?:работать|сменить|уйти))|"
    r"конфликт(?:\w*\s+ситуац|\w*\s+(?:в|с)\s+(?:команд|коллег|руковод|работ))|"
    r"сильн\w+\s+сторон|слаб\w+\s+сторон|мотивац|куда\s+видишь\s+себя|"
    r"why\s+(?:did\s+you\s+leave|do\s+you\s+want)|"
    r"conflict\s+(?:with|in\s+(?:a|the)\s+team|at\s+work)|"
    r"strengths?\s+and\s+weakness|greatest\s+(?:strength|weakness)|"
    r"where\s+do\s+you\s+see\s+yourself|motivat)",
    re.IGNORECASE | re.UNICODE,
)
_EXPERIENCE_RE = re.compile(
    r"(?:расскаж\w*\s+(?:про|о)\s+(?:сво\w+\s+)?опыт|(?:ваш|твой|свой)\s+опыт|"
    r"опыт\s+(?:автоматизац|работ|тестир)|на\s+каких\s+проектах|"
    r"чем\s+занимал\w*\s+на\s+(?:проект|работ)|расскаж\w*\s+о\s+(?:сво\w+\s+)?(?:работ|карьер|проект)|"
    # HR / biographical — bio questions get resume context so the answer can pivot.
    r"расскаж\w*\s+(?:о\s+себе|про\s+себя)|подработк|про\s+подработк|"
    r"tell\s+(?:me|us)\s+about\s+(?:yourself|your\s+(?:experience|background|career|projects?))|"
    r"walk\s+me\s+through\s+your|your\s+(?:experience|background)\s+with|"
    r"what\s+projects\s+have\s+you)",
    re.IGNORECASE | re.UNICODE,
)
_PRACTICAL_RE = re.compile(
    r"(?:как\s+ты\s+(?:применял\w*|использовал\w*|настраивал\w*|проверял\w*|запускал\w*|"
    r"работал\w*|делал\w*|писал\w*)|ты\s+сам\w*\s+(?:настраивал\w*|делал\w*|писал\w*|"
    r"использовал\w*)|сам\s+настраивал\w*|как\s+вы\s+(?:применял\w*|использовал\w*|настраивал\w*)|"
    r"в\s+работ\w*|на\s+проект\w*|"
    r"how\s+(?:did|do|have)\s+you\s+(?:use|apply|set\s*up|configure|implement|test|work)|"
    r"have\s+you\s+(?:ever\s+)?(?:used|worked\s+with|built|set\s*up)|in\s+your\s+work|"
    r"on\s+your\s+project)",
    re.IGNORECASE | re.UNICODE,
)
_API_TEST_TASK_RE = re.compile(
    r"(?:(?:как\s+)?(?:протестировать|проверить|покрыть\s+тестами|написать\s+тесты)[^\n]{0,80}"
    r"(?:api|endpoint|эндпоинт|(?:get|post|put|patch|delete)\s+/)|"
    r"(?:test|write\s+tests?|test\s+cases?)[^\n]{0,80}(?:api|endpoint|(?:get|post|put|patch|delete)\s+/))",
    re.IGNORECASE | re.UNICODE,
)
_TASK_RE = re.compile(
    r"(?:напиши(?:те)?|реализуй(?:те)?|реализовать|исправь(?:те)?\s+(?:код|функц)|"
    r"дополни(?:те)?\s+(?:код|функц)|что\s+(?:верн[её]т|выведет|произойд[её]т)|"
    r"какой\s+(?:будет\s+)?результат|дан(?:ы|о)?\s+(?:код|выражени\w*|словар\w*)|"
    r"как\s+определить\s+(?:точн\w*\s+)?порядок(?:\s+выполнения|\s+для\s+кода)?|write\s+(?:code|a\s+function|tests?)|"
    r"implement\s+(?:a\s+)?(?:function|class|test)|fix\s+(?:the\s+)?code|"
    r"what\s+(?:does|will)\s+.+\s+(?:return|print|output))",
    re.IGNORECASE | re.UNICODE,
)
_COMPARISON_RE = re.compile(
    r"(?:чем\s+.+\s+отлича|разниц\w*|в\s+ч(?:е|ё)м\s+разниц|\bvs\.?\b|против\s+|"
    r"difference\s+between|how\s+(?:is|does)\s+.+\s+differ|compare\s+|versus\s+)",
    re.IGNORECASE | re.UNICODE,
)
_LIST_RE = re.compile(
    r"(?:как\s+(?:протестировать|проверить)\s+(?:api|endpoint|эндпоинт|метод\s+api)|"
    r"какие\s+(?:бывают\s+)?|перечисли|назови|какие\s+\w+\s+ты\s+знаешь|"
    r"какие\s+тип\w+|какие\s+вид\w+|какие\s+ошибк\w+|основные\s+\w+\s+(?:групп|тип|вид)|список\s+|"
    r"how\s+(?:would\s+you\s+)?test\s+(?:an?\s+)?(?:api|endpoint)|"
    r"what\s+(?:kinds?|types?)\s+of|list\s+(?:the|all|some)|name\s+(?:the|all|some)|"
    r"which\s+\w+\s+do\s+you\s+know|what\s+are\s+the\s+(?:main|different|common))",
    re.IGNORECASE | re.UNICODE,
)
_DEFINITION_RE = re.compile(
    r"(?:как\s+работает|что\s+такое|что\s+значит|что\s+это\s+за|объясни(?:те)?|"
    r"расскаж\w*\s+что\s+такое|определени\w*|how\s+does\s+.+\s+work|"
    r"what\s+is\s+(?:a|an|the)?\s*\w|what\s+does\s+\w+\s+mean|explain\s+|define\s+|"
    r"can\s+you\s+describe\s+what)",
    re.IGNORECASE | re.UNICODE,
)

_FORMAT = (
    "50–80 words by default (≤90 only if the question is genuinely complex), 3–5 short "
    "sentences, natural first-person spoken style — like a real candidate, not ChatGPT. "
    "First sentence = the direct answer, no intro. Use bullets for 3+ items/steps. No internal "
    "labels (Main answer/Key points), no markdown headers, no closing offers («Если хотите, могу "
    "подробнее рассказать/разложить»), no «Важно отметить»/«В заключение». Connect to real resume "
    "experience only where it genuinely fits — concrete tools and actions, never a resume re-tell."
)

_STRATEGIES: dict[QuestionIntent, AnswerStrategy] = {
    "experience": {
        "question_intent": "experience",
        "answer_strategy": (
            f"Use resume fully. {_FORMAT} Bullets: role, stack, concrete impact. No corporate filler."
        ),
        "resume_context_used": True,
        "resume_context_level": "full",
        "resume_context_reason": "Question asks about candidate experience.",
        "suggest_unclear_prefix": False,
    },
    "practical_usage": {
        "question_intent": "practical_usage",
        "answer_strategy": (
            f"{_FORMAT} Resume only for asked tech: scope, how applied, honest limits. No full resume dump."
        ),
        "resume_context_used": True,
        "resume_context_level": "full",
        "resume_context_reason": "Question asks how the candidate applied or configured a tool at work.",
        "suggest_unclear_prefix": False,
    },
    "technical_definition": {
        "question_intent": "technical_definition",
        "answer_strategy": (
            f"{_FORMAT} Thesis = definition. Bullets = purpose, key details, max one experience line."
        ),
        "resume_context_used": False,
        "resume_context_level": "limited",
        "resume_context_reason": "Theory question — resume only as optional one-sentence example.",
        "suggest_unclear_prefix": False,
    },
    "technical_list": {
        "question_intent": "technical_list",
        "answer_strategy": (
            f"{_FORMAT} Bullets MUST name specific items/anti-patterns by name. "
            "At most one short concrete personal line if it genuinely adds — otherwise none. "
            "Do not start with «Я знаю несколько…»."
        ),
        "resume_context_used": False,
        "resume_context_level": "limited",
        "resume_context_reason": (
            "List/theory question — name the items; optional one concrete personal line."
        ),
        "suggest_unclear_prefix": False,
    },
    "technical_comparison": {
        "question_intent": "technical_comparison",
        "answer_strategy": (
            f"{_FORMAT} Thesis = main difference. Bullets = when to use each, QA example if relevant."
        ),
        "resume_context_used": False,
        "resume_context_level": "limited",
        "resume_context_reason": "Comparison question — experience only if usage is implied.",
        "suggest_unclear_prefix": False,
    },
    "api_test_task": {
        "question_intent": "api_test_task",
        "answer_strategy": (
            "Return 6–8 terse test bullets in at most 130 words. Every row must name scenario, request/data, "
            "explicit expected HTTP status, response body/schema/types, and semantic assertions. "
            "Separate authentication (401) from authorization (403); cover success, empty, "
            "missing, invalid/boundary, and selection/order rules where relevant."
        ),
        "resume_context_used": False,
        "resume_context_level": "none",
        "resume_context_reason": "Concrete API test-design task — no resume context.",
        "suggest_unclear_prefix": False,
    },
    "technical_task": {
        "question_intent": "technical_task",
        "answer_strategy": (
            "Solve the exact task shown. If code is requested, output complete copyable code first, "
            "then 1–2 short explanation sentences. If output/error is requested, state the exact "
            "result or exception first and explain why. If asked to design API/tests, give a "
            "complete concrete test matrix with every scenario, expected status, schema and "
            "business assertion named in the question/hints; never stop at a generic checklist. "
            "Preserve punctuation, types and execution order. Do not use resume experience."
        ),
        "resume_context_used": False,
        "resume_context_level": "none",
        "resume_context_reason": (
            "Concrete code/output task — solve the supplied artifact, no resume context."
        ),
        "suggest_unclear_prefix": False,
    },
    "behavioral": {
        "question_intent": "behavioral",
        "answer_strategy": (
            f"{_FORMAT} Bullets: situation, actions, outcome. Minimal stack/resume dump."
        ),
        "resume_context_used": False,
        "resume_context_level": "none",
        "resume_context_reason": "Behavioral question — no technical resume dump.",
        "suggest_unclear_prefix": False,
    },
    "unclear": {
        "question_intent": "unclear",
        "answer_strategy": (
            f"{_FORMAT} Answer the most likely corrected topic directly. "
            "If truly unknown, cautious generic thesis without «Похоже»."
        ),
        "resume_context_used": False,
        "resume_context_level": "none",
        "resume_context_reason": "Unclear transcript — answer probable topic without diagnostics.",
        "suggest_unclear_prefix": False,
    },
}


def _should_suggest_unclear_prefix(
    *,
    question_intent: QuestionIntent,
    intent_confidence: str | None = None,
    correction_max_confidence: str | None = None,
    ambiguity: str | None = None,
    raw_question: str | None = None,
    glossary_corrected: str | None = None,
    question: str | None = None,
) -> bool:
    if question_intent == "unclear":
        return True
    if intent_confidence == "low":
        return True
    if correction_max_confidence == "low":
        return True
    if ambiguity and ambiguity.strip():
        return True
    raw = (raw_question or "").strip().lower()
    corrected = (glossary_corrected or question or "").strip().lower()
    if raw and corrected and raw != corrected:
        conf = correction_max_confidence or intent_confidence
        return conf == "low"
    return False


def classify_interview_question_intent(
    question: str,
    *,
    raw_question: str | None = None,
    glossary_corrected: str | None = None,
    intent_changed: bool | None = None,
    intent_confidence: str | None = None,
    correction_max_confidence: str | None = None,
    ambiguity: str | None = None,
) -> AnswerStrategy:
    q_text = (question or "").strip()
    q = q_text.lower()
    if not q:
        return _STRATEGIES["unclear"].copy()

    intent: QuestionIntent = "unclear"
    if _API_TEST_TASK_RE.search(q_text):
        intent = "api_test_task"
    elif _TASK_RE.search(q_text):
        intent = "technical_task"
    elif _BEHAVIORAL_RE.search(q_text):
        intent = "behavioral"
    elif _EXPERIENCE_RE.search(q_text):
        intent = "experience"
    elif _PRACTICAL_RE.search(q_text) and not _DEFINITION_RE.search(q_text):
        intent = "practical_usage"
    elif _COMPARISON_RE.search(q_text):
        intent = "technical_comparison"
    elif _LIST_RE.search(q_text):
        intent = "technical_list"
    elif _DEFINITION_RE.search(q_text):
        intent = "technical_definition"
    elif intent_confidence == "low":
        intent = "unclear"

    base = _STRATEGIES[intent].copy()
    base["suggest_unclear_prefix"] = False
    return base


def resolve_answer_strategy(payload) -> AnswerStrategy:
    """Use client-provided strategy or classify on server."""
    if payload.question_intent:
        level: ResumeContextLevel = payload.resume_context_level or "none"
        if level not in ("full", "limited", "none"):
            level = "none"
        return {
            "question_intent": payload.question_intent,
            "answer_strategy": payload.answer_strategy
            or _STRATEGIES.get(payload.question_intent, _STRATEGIES["unclear"])["answer_strategy"],
            "resume_context_used": bool(payload.resume_context_used),
            "resume_context_level": level,
            "resume_context_reason": payload.resume_context_reason or "",
            "suggest_unclear_prefix": bool(payload.suggest_unclear_prefix),
        }
    return classify_interview_question_intent(
        payload.resolved_follow_up_question or payload.question or "",
        raw_question=payload.raw_question,
        intent_changed=bool(payload.used_previous_context),
    )
