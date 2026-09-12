import asyncio
import json
import logging
import os
import re
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import Answer, ApiUsage
from app.db.session import SessionLocal, get_db
from app.prompts.interview import INTERVIEW_PROMPT
from app.prompts.interview_fast import (
    FAST_CORE_SYSTEM_PROMPT,
    INTERVIEW_PROMPT_STREAM,
    LEGEND_CONTEXT_LIMIT,
    LIVE_SYSTEM_PROMPT,
    RESUME_CONTEXT_LIMIT,
    RESUME_PLACEHOLDER_NONE,
    VACANCY_CONTEXT_LIMIT,
    build_fast_core_user_prompt,
)
from app.prompts.meeting import (
    build_interview_outcome_prompt,
    build_interview_review_prompt,
    build_meeting_prompt,
)
from app.prompts.system import SYSTEM_PROMPT
from app.services import model_router, provider_adapter, rag_service
from app.services.candidate_profile import get_pack_content, get_profile_block
from app.services.candidate_profile import pack_status
from app.services.fast_candidate_context import (
    build_candidate_context, build_recent_turns_context, needs_personal_context, is_conversation_followup,
)
from app.services.domain_answer_hints import (
    resolve_domain_answer_hints,
    resolve_fast_domain_answer_hints,
    resolve_fast_question_alias,
    resolve_required_output_contract,
)
from app.services.hedged_stream import select_first_stream, select_hedged_stream
from app.services.knowledge_pack import build_injection as build_python_pack_injection
from app.services.knowledge_pack import detect_pack
from app.services.preferences import load_preferences
from app.services.question_intent import (
    classify_interview_question_intent,
    resolve_answer_strategy,
)
from app.services.sanitize_live_answer import sanitize_live_answer, trim_spoken_answer
from app.services.screen_task_pipeline import (
    ScreenTaskPipelineError,
    run_screen_task_pipeline,
)
from app.services.screen_task_state import MAX_SERIALIZED_STATE_CHARS, ScreenTaskAction

router = APIRouter(tags=["chat"])

logger = logging.getLogger("chat")

FAST_CONTEXT_LIMIT = 350
LIVE_THEORY_HEDGE_AFTER_SECONDS = 0.8
LIVE_UNCLEAR_HEDGE_AFTER_SECONDS = 0.5
LIVE_PRACTICAL_HEDGE_AFTER_SECONDS = 0.8
LIVE_EXPERIENCE_HEDGE_AFTER_SECONDS = 1.25
LIVE_RELIABILITY_BACKUP_MODEL = "openai/gpt-4o-mini"
LIVE_THEORY_HEDGE_INTENTS = frozenset(
    {"technical_definition", "technical_list", "technical_comparison"}
)
SCREEN_STREAM_KEEPALIVE_SECONDS = 10
_SCREEN_STREAM_ERROR_CODES = frozenset(
    {
        "image_too_large",
        "invalid_api_key",
        "insufficient_credits",
        "rate_limited",
        "model_unavailable",
        "unsupported_provider_option",
        "provider_timeout",
        "provider_error",
        "provider_output_truncated",
        "missing_api_key",
        "auth_failed",
        "quota_exceeded",
        "invalid_screen_task_state",
        "invalid_screen_task_action",
        "screen_task_state_expired",
        "invalid_screen_observation",
        "invalid_screen_answer",
        "unsupported_screen_python_profile",
    }
)
_SCREEN_STREAM_ERROR_MESSAGES = {
    "image_too_large": "Снимок экрана оказался слишком большим. SkillCue уменьшит его — повторите запрос.",
    "invalid_api_key": "Неверный API key. Проверьте ключ в настройках.",
    "missing_api_key": "API key не задан. Добавьте его в настройках.",
    "insufficient_credits": "Недостаточно кредитов провайдера. Пополните баланс.",
    "rate_limited": "Превышен лимит запросов. Подождите и повторите.",
    "model_unavailable": "Выбранная модель недоступна. Выберите другую или Auto Select.",
    "unsupported_provider_option": "Провайдер отклонил несовместимый параметр запроса. Повторите запрос.",
    "provider_timeout": "Провайдер не отвечает. Повторите позже.",
    "provider_error": "Провайдер вернул ошибку. Повторите запрос позже.",
    "provider_output_truncated": "Ответ обрезан из-за лимита модели. Это неполное решение — повторите запрос.",
    "auth_failed": "Неверный API key. Проверьте ключ в настройках.",
    "quota_exceeded": "Недостаточно кредитов провайдера. Пополните баланс.",
    "invalid_screen_task_state": "Контекст экранной задачи повреждён. Повторите снимок.",
    "invalid_screen_task_action": (
        "Некорректно указан режим экранной задачи. Начните новую или продолжите текущую."
    ),
    "screen_task_state_expired": "Контекст экранной задачи истёк. Начните новую задачу.",
    "invalid_screen_observation": "Не удалось надёжно прочитать экран. Повторите снимок.",
    "invalid_screen_answer": "Ответ не прошёл проверку точности. Повторите запрос.",
    "unsupported_screen_python_profile": (
        "Строгая проверка пока поддерживает только Python-задачи с одной функцией."
    ),
}
_SCREEN_STREAM_GATEWAY_PUBLIC_ERRORS = {
    "token_quota_exceeded": ("quota_exceeded", 402),
    "invalid_license": ("auth_failed", 401),
    "model_not_allowed": ("model_unavailable", 403),
    "gateway_unconfigured": ("provider_error", 503),
}
_SCREEN_STREAM_MODEL_IDENTIFIER = re.compile(
    r"(?:unknown|[a-z0-9][a-z0-9._+-]{0,127}|"
    r"[a-z0-9][a-z0-9._-]{0,31}/[a-z0-9][a-z0-9._+-]{0,94}"
    r"(?::[a-z0-9][a-z0-9._-]{0,31})?)",
    re.IGNORECASE,
)


def _screen_stream_error_event(exc: Exception, model: str) -> dict[str, object]:
    """Return only the screen stream's stable public diagnostic contract."""
    if isinstance(exc, AppError):
        public_code, fixed_status = _SCREEN_STREAM_GATEWAY_PUBLIC_ERRORS.get(
            exc.code, (exc.code, None)
        )
        if public_code not in _SCREEN_STREAM_ERROR_CODES:
            return {
                "type": "error",
                "message": "Internal server error",
                "code": "internal_error",
                "status": 500,
                "model": model if _SCREEN_STREAM_MODEL_IDENTIFIER.fullmatch(model) else "unknown",
            }
        status = fixed_status or (
            exc.status_code
            if type(exc.status_code) is int and 400 <= exc.status_code <= 599
            else 502
        )
        return {
            "type": "error",
            "message": _SCREEN_STREAM_ERROR_MESSAGES[public_code],
            "code": public_code,
            "status": status,
            "model": model if _SCREEN_STREAM_MODEL_IDENTIFIER.fullmatch(model) else "unknown",
        }
    return {
        "type": "error",
        "message": "Internal server error",
        "code": "internal_error",
        "status": 500,
        "model": model if _SCREEN_STREAM_MODEL_IDENTIFIER.fullmatch(model) else "unknown",
    }


def _clip(text: str, limit: int = FAST_CONTEXT_LIMIT) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _tail_clip_chronological_context(text: str, limit: int) -> str:
    normalized = text.strip()
    if len(normalized) <= limit:
        return normalized
    marker = "… earlier transcript omitted …\n"
    available = max(0, limit - len(marker))
    selected: list[str] = []
    used = 0
    for line in reversed(normalized.splitlines()):
        addition = len(line) + (1 if selected else 0)
        if used + addition > available:
            break
        selected.append(line)
        used += addition
    if not selected:
        return normalized[-limit:]
    return marker + "\n".join(reversed(selected))


def _clip_screen_prior_solution(text: str, limit: int) -> str:
    normalized = text.strip()
    if len(normalized) <= limit:
        return normalized
    code_start = normalized.find("```")
    if code_start < 0:
        return normalized[-limit:]
    marker = "\n… older prose omitted …\n"
    opening_length = max(0, int((limit - len(marker)) * 0.45))
    opening = normalized[code_start : code_start + opening_length]
    newest = normalized[-(limit - len(marker) - len(opening)) :]
    return f"{opening}{marker}{newest}"


class ChatPayload(BaseModel):
    message: str
    mode: str = "general"  # general | coding | fast | deep
    context: str | None = None
    # Язык ответов из настроек: "ru" | "en"; None/пусто — язык сообщения.
    answer_language: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")
    provider: str | None = None
    session_id: str | None = None

    model_config = {"populate_by_name": True}


class ActiveScreenTaskPayload(BaseModel):
    root_question: str = Field(max_length=1800)
    current_question: str = Field(max_length=1800)
    latest_answer: str = Field(max_length=5200)
    updated_at_ms: int = Field(ge=0)


class RecentLiveTurn(BaseModel):
    question: str = Field(min_length=1, max_length=800)
    answer: str = Field(min_length=1, max_length=1800)


class InterviewPayload(BaseModel):
    recent_turns: list[RecentLiveTurn] = Field(default_factory=list, max_length=2)
    question: str
    # Предзагруженное выбранное резюме: используется только для ответов про
    # личный опыт/практику и не попадает в быстрые теоретические запросы.
    candidate_context: str | None = None
    active_screen_task: ActiveScreenTaskPayload | None = None
    raw_question: str | None = None
    glossary_corrected: str | None = None
    intent_corrected: str | None = None
    ambiguity: str | None = None
    corrections: list[dict] | None = None
    intent_corrections: list[dict] | None = None
    intent_confidence: str | None = None
    intent_reason: str | None = None
    needs_llm_correction: bool | None = None
    question_intent: str | None = None
    answer_strategy: str | None = None
    resume_context_used: bool | None = None
    resume_context_level: str | None = None
    resume_context_reason: str | None = None
    suggest_unclear_prefix: bool | None = None
    resolved_follow_up_question: str | None = None
    previous_topic: str | None = None
    used_previous_context: bool | None = None
    is_follow_up: bool | None = None
    follow_up_reason: str | None = None
    current_canonical_topic: str | None = None
    mode: str = "fast"  # fast для live, general для ручного ввода
    # Fast answer: skip the serial LLM transcript-correction pass and ask the
    # provider to route for throughput. On by default for lowest latency.
    fast_answer: bool = True
    # Слабые темы из последнего mock-отчёта — на них ответ должен быть особенно
    # конкретным и структурным (кандидату сложнее импровизировать).
    weak_topics: list[str] | None = None
    # Язык ответов из настроек: "ru" | "en"; None/пусто — язык вопроса.
    answer_language: str | None = None
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")
    session_id: str | None = None

    model_config = {"populate_by_name": True}


# Скриншот в base64: ~8 МБ достаточно для FullHD JPEG, больше — защита от абьюза.
MAX_SCREEN_IMAGE_CHARS = 1_500_000
MAX_PREVIOUS_SCREEN_IMAGES = 2
# Two scrolling frames are supporting context, so reserve less input than the
# authoritative current viewport and reject abuse before it reaches a provider.
MAX_PREVIOUS_SCREEN_IMAGE_CHARS = 600_000
MAX_PRIOR_SOLUTION_SUMMARY_CHARS = 8_000
SCREEN_PRIOR_SOLUTION_CONTEXT_CHARS = 2_800
SCREEN_LATEST_CORRECTION_CONTEXT_CHARS = 1_800


class ScreenAssistPayload(BaseModel):
    """Vision-подсказка по скриншоту экрана (оверлей, кнопка «Экран»)."""

    image: str = Field(max_length=MAX_SCREEN_IMAGE_CHARS)
    previous_images: list[Annotated[str, Field(max_length=MAX_PREVIOUS_SCREEN_IMAGE_CHARS)]] = (
        Field(default_factory=list, max_length=MAX_PREVIOUS_SCREEN_IMAGES)
    )
    prior_solution_summary: str | None = Field(
        default=None, max_length=MAX_PRIOR_SOLUTION_SUMMARY_CHARS
    )
    question: str = ""
    context: str | None = None  # транскрипт разговора, если идёт live
    mode: str = "general"
    # Язык ответов из настроек: "ru" | "en"; None/пусто — язык содержимого экрана.
    answer_language: str | None = None
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")
    structured_screen: bool = Field(default=False, alias="structuredScreen")
    task_action: ScreenTaskAction | None = Field(default=None, alias="taskAction")
    task_state: dict[str, Any] | str | None = Field(default=None, alias="taskState")

    @field_validator("task_state")
    @classmethod
    def bound_task_state(cls, value: dict[str, Any] | str | None):
        if value is None:
            return None
        encoded = (
            value
            if isinstance(value, str)
            else json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        if len(encoded) > MAX_SERIALIZED_STATE_CHARS:
            raise ValueError("task_state is too large")
        return value

    model_config = {"populate_by_name": True}


class MeetingPayload(BaseModel):
    transcript: str
    mode: str = "deep"
    answer_language: str | None = None
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")

    model_config = {"populate_by_name": True}


class InterviewOutcomePayload(MeetingPayload):
    interview_type: str = "other"
    vacancy_title: str = ""
    company_name: str = ""


def _normalize_interview_outcome(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        parsed = {"headline": text[:400]}

    def items(key: str) -> list[str]:
        values = parsed.get(key) if isinstance(parsed, dict) else []
        if not isinstance(values, list):
            return []
        return [str(value).strip()[:300] for value in values if str(value).strip()][:5]

    headline = str(parsed.get("headline", "")).strip()[:400] if isinstance(parsed, dict) else ""
    return {
        "headline": headline or "Итог созвона сохранён.",
        "facts": items("facts"),
        "conditions": items("conditions"),
        "nextSteps": items("nextSteps"),
        "openQuestions": items("openQuestions"),
    }


class AnswerVariantPayload(BaseModel):
    question: str
    answer: str
    variant: str  # short | detailed | english | risk
    answer_id: str | None = None  # если задан — вариант кэшируется в БД
    # Язык ответов из настроек; вариант "english" всегда английский.
    answer_language: str | None = None
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")

    model_config = {"populate_by_name": True}


_VARIANT_PROMPTS: dict[str, str] = {
    "short": (
        "Сократи ответ кандидата до 1–2 предложений (максимум 30 слов), сохранив суть. "
        "Первое предложение — прямой ответ на вопрос. Без вступлений и воды."
    ),
    "detailed": (
        "Разверни ответ кандидата в подробный (120–180 слов): добавь ключевые детали, "
        "примеры и структуру списком, где уместно. Стиль — живая речь кандидата на "
        "интервью, первое лицо, без заголовков и корпоративных клише."
    ),
    "english": (
        "Rewrite the candidate's answer in natural spoken English, as the candidate would "
        "say it at an interview. Keep the same meaning and length, first person, no headers."
    ),
    "risk": (
        "Проанализируй ответ кандидата и перечисли риски: какие уточняющие вопросы может "
        "задать интервьюер, где ответ звучит слабо или неточно, чего в нём НЕ стоит "
        "говорить. 3–5 коротких пунктов списком, по делу."
    ),
}


async def _finalize_question(payload: InterviewPayload) -> tuple[str, str, str, dict]:
    raw = (payload.raw_question or payload.question or "").strip()
    resolved = (payload.resolved_follow_up_question or "").strip()
    final = resolved or raw
    meta: dict = {
        "raw_question": raw,
        "glossary_corrected": raw,
        "intent_corrected": raw,
        "llm_corrected": raw,
        "resolved_follow_up_question": resolved or None,
        "previous_topic": payload.previous_topic,
        "used_previous_context": payload.used_previous_context,
        "is_follow_up": payload.is_follow_up,
        "follow_up_reason": payload.follow_up_reason,
        "current_canonical_topic": payload.current_canonical_topic,
        "ambiguity": payload.ambiguity,
        "corrections": [],
        "intent_corrections": [],
        "intent_confidence": None,
        "intent_reason": None,
        "llm_correction_applied": False,
    }
    return final, raw, raw, meta


def _chat_usage(provider: str, prompt_text: str = "", completion_text: str = "") -> ApiUsage:
    """ApiUsage с реальными токенами провайдера (или оценкой по длине текста).

    Без этого карточка «Активность и расходы» вечно показывала $0 — токены
    просто не записывались.
    """
    usage = provider_adapter.pop_last_usage() or {}
    tokens_in = int(usage.get("prompt_tokens") or 0) or len(prompt_text) // 4
    tokens_out = int(usage.get("completion_tokens") or 0) or len(completion_text) // 4
    return ApiUsage(provider=provider, kind="chat", tokens_in=tokens_in, tokens_out=tokens_out)


def _provider_token_count(usage: dict | None, key: str) -> int | None:
    if not isinstance(usage, dict):
        return None
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return int(value)


@dataclass(slots=True)
class _ScreenUsageAccumulator:
    provider: str
    tokens_in: int = 0
    tokens_out: int = 0
    completed_calls: int = 0

    def record(self, messages: list[dict], completion: str, usage: dict | None) -> None:
        prompt_tokens = _provider_token_count(usage, "prompt_tokens")
        completion_tokens = _provider_token_count(usage, "completion_tokens")
        if prompt_tokens is None:
            try:
                prompt_chars = len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")))
            except (TypeError, ValueError):
                prompt_chars = sum(len(str(message)) for message in messages)
            prompt_tokens = prompt_chars // 4
        if completion_tokens is None:
            completion_tokens = len(completion) // 4
        self.tokens_in += prompt_tokens
        self.tokens_out += completion_tokens
        self.completed_calls += 1


def _ensure_quota(db: Session) -> None:
    """Серверный токен-гейт перед LLM-вызовом (402 при исчерпании бюджета)."""
    from app.services import quota

    quota.check_token_quota(db)


def _weak_topics_block(weak_topics: list[str] | None) -> str:
    """Prompt-блок: слабые темы кандидата из mock-отчёта (подготовка ↔ live)."""
    if not weak_topics:
        return ""
    topics = ", ".join(t.strip() for t in weak_topics[:5] if t and t.strip())
    if not topics:
        return ""
    return (
        "\n\nCANDIDATE'S WEAK TOPICS (from their mock-interview report): "
        f"{topics}. If the current question touches one of these, make the "
        "answer extra concrete and structured (short definition -> example -> "
        "how it's used in practice), avoid advanced tangents the candidate "
        "cannot back up, and do NOT mention that the topic is weak."
    )


_ANSWER_LANGUAGE_NAMES = {"ru": "Russian (русский)", "en": "English"}


def _answer_language_block(lang: str | None) -> str:
    """Инструкция про язык ответа из настроек; пусто — язык вопроса (по умолчанию)."""
    name = _ANSWER_LANGUAGE_NAMES.get((lang or "").strip().lower())
    if not name:
        return ""
    return (
        f"\n\nOUTPUT LANGUAGE: write the answer in {name}, regardless of the "
        "question's language. Keep established technical terms as commonly "
        "spoken by engineers (e.g. deploy, pipeline, merge request). All "
        "natural-language code comments must use the same output language."
    )


def _persist_stream_answer(
    db: Session,
    *,
    session_id: str | None,
    question: str,
    spoken: str,
    model: str,
    provider: str,
) -> str | None:
    if not session_id or not spoken.strip():
        return None
    answer = Answer(
        session_id=session_id,
        question=question,
        answer_short=_first_sentences(spoken, 2),
        answer_spoken=spoken,
        answer_detailed="",
        answer_en="",
        risk_note="",
        model=model,
    )
    db.add(answer)
    db.add(_chat_usage(provider, question, spoken))
    db.commit()
    db.refresh(answer)
    return answer.id


async def _interview_event_stream(
    *,
    provider: str,
    model: str,
    source: str,
    payload: InterviewPayload,
    resume: str,
    vacancy: str,
    legend: str = "(нет)",
    candidate_profile: str = "",
    db: Session | None = None,
):
    parts: list[str] = []
    err_msg: str | None = None
    err_reason = "provider_error"
    correction_meta: dict = {}
    final_question = (payload.question or "").strip()
    answer_model = model
    answer_source = source

    try:
        if not final_question:
            raise AppError("Пустой вопрос", 400, "empty_question")

        if payload.fast_answer:
            # Ctrl+Enter hot path: one compact provider request. No transcript
            # correction or additional model calls. Personal sources are bounded
            # local reads and remain separate from generated conversation history.
            raw_question = final_question
            prompt_question = resolve_fast_question_alias(final_question)
            strategy = classify_interview_question_intent(prompt_question)
            intent = str(strategy["question_intent"])
            if (
                not payload.model
                and not payload.model_override
                and intent == "technical_comparison"
            ):
                model = model_router.FAST_ACCURACY_MODEL
                answer_model = model
                answer_source = "fast_core_accuracy"
            prompt = build_fast_core_user_prompt(
                prompt_question,
                intent,
                _answer_language_block(payload.answer_language),
            )
            enrichment_blocks: list[str] = []
            if payload.active_screen_task:
                active_task = payload.active_screen_task
                enrichment_blocks.append(
                    "ACTIVE SCREEN TASK (bounded non-pixel context from the latest "
                    "completed screen solution):\n"
                    f"ROOT TASK:\n{active_task.root_question.strip()}\n"
                    f"CURRENT TASK/REFINEMENT:\n{active_task.current_question.strip()}\n"
                    f"LATEST COMPLETE ANSWER/CODE:\n{active_task.latest_answer.strip()}\n"
                    "Use this context only when QUESTION is a true follow-up, critique, "
                    "correction, or refinement of that task. If QUESTION introduces an "
                    "explicit new topic or independent task, ignore this entire block. "
                    "Never claim that the context came from the interviewer."
                )
            personal_context = ""
            personal_context_reason = ""
            recent_turns = [turn.model_dump() for turn in payload.recent_turns]
            history_context = build_recent_turns_context(recent_turns) if is_conversation_followup(prompt_question) else ""
            if history_context:
                enrichment_blocks.append(history_context)
            if needs_personal_context(prompt_question, intent, recent_turns):
                legend = rag_service.get_context_text(db, "legend") if db is not None else ""
                # A generated pack cannot prove it matches the renderer's selected HH/local resume.
                profile = get_pack_content(db) if db is not None and pack_status(db)["userEdited"] else ""
                personal_context = build_candidate_context(payload.candidate_context or "", legend, profile)
                if personal_context:
                    personal_context_reason = "fast_core_preloaded_candidate_context"
                if personal_context:
                    enrichment_blocks.append(
                        "CONFIRMED CANDIDATE CONTEXT (authoritative; use only relevant "
                        "facts and never invent missing experience). Preserve the exact "
                        "strength of every fact: supported/used is not implemented/owned. "
                        "If the asked technology is absent, say that it is not confirmed "
                        "instead of borrowing an adjacent stack:\n"
                        f"{personal_context}"
                    )
            domain_hints = resolve_fast_domain_answer_hints(prompt_question)
            if not domain_hints.startswith("(none"):
                enrichment_blocks.append(domain_hints)

            knowledge_meta = {"knowledgePackUsed": False}
            if detect_pack(prompt_question):
                kn_block, knowledge_meta = build_python_pack_injection(
                    prompt_question, verified_only=True
                )
                if kn_block:
                    enrichment_blocks.append(kn_block)

            required_contract = resolve_required_output_contract(prompt_question)
            if required_contract:
                enrichment_blocks.append(required_contract)
            if enrichment_blocks:
                prompt = f"{prompt}\n\n" + "\n\n".join(enrichment_blocks)

            system_prompt = FAST_CORE_SYSTEM_PROMPT
            correction_meta = {
                "question_intent": intent,
                "answer_strategy": "fast_core",
                "resume_context_used": bool(personal_context),
                "resume_context_level": "limited" if personal_context else "none",
                "resume_context_reason": personal_context_reason
                or (
                    "fast_core_local_enrichment" if enrichment_blocks else "fast_core_no_enrichment"
                ),
                "prompt_mode": "fast_core",
                "fast_alias_used": prompt_question != final_question,
                "enrichment_used": bool(enrichment_blocks),
                "prompt_chars": len(system_prompt) + len(prompt),
            }
            correction_meta.update(knowledge_meta)
        else:
            (
                final_question,
                raw_question,
                glossary_corrected,
                correction_meta,
            ) = await _finalize_question(payload)
            strategy = resolve_answer_strategy(payload)
            correction_meta.update(
                {
                    "question_intent": strategy["question_intent"],
                    "answer_strategy": strategy["answer_strategy"],
                    "resume_context_used": strategy["resume_context_used"],
                    "resume_context_level": strategy["resume_context_level"],
                    "resume_context_reason": strategy["resume_context_reason"],
                    "suggest_unclear_prefix": strategy["suggest_unclear_prefix"],
                }
            )
            resume_text = (
                RESUME_PLACEHOLDER_NONE
                if strategy["resume_context_level"] == "none"
                else (resume or "(нет)")
            )
            resolved_q = correction_meta.get("resolved_follow_up_question") or final_question
            domain_hints = resolve_domain_answer_hints(resolved_q)
            prompt = INTERVIEW_PROMPT_STREAM.format(
                resume=resume_text,
                vacancy=vacancy or "(нет)",
                legend=legend or "(нет)",
                candidate_profile=candidate_profile,
                question=final_question,
                raw_question=raw_question,
                glossary_corrected=glossary_corrected,
                ambiguity=correction_meta.get("ambiguity") or "(none)",
                resolved_follow_up_question=resolved_q,
                previous_topic=correction_meta.get("previous_topic") or "(none)",
                question_intent=strategy["question_intent"],
                answer_strategy=strategy["answer_strategy"],
                resume_context_level=strategy["resume_context_level"],
                resume_context_used=str(strategy["resume_context_used"]).lower(),
                resume_context_reason=strategy["resume_context_reason"],
                domain_hints=domain_hints,
            )
            knowledge_meta = {"knowledgePackUsed": False}
            if detect_pack(resolved_q):
                kn_block, knowledge_meta = build_python_pack_injection(resolved_q)
                if kn_block:
                    prompt = f"{prompt}\n\n{kn_block}"
            prompt += _weak_topics_block(payload.weak_topics)
            prompt += _answer_language_block(payload.answer_language)
            required_contract = resolve_required_output_contract(resolved_q)
            if required_contract:
                prompt += f"\n\n{required_contract}"
            correction_meta.update(knowledge_meta)
            system_prompt = LIVE_SYSTEM_PROMPT

        answer_started_at = time.perf_counter()
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]

        def stream_for(selected_model: str):
            return provider_adapter.stream_chat(
                messages,
                provider,
                selected_model,
                temperature=0.0 if payload.fast_answer else 0.3,
                live_fast=True,
                route_fast=payload.fast_answer,
            )

        intent = str(correction_meta.get("question_intent") or "unclear")
        use_latency_hedge = (
            payload.fast_answer
            and not payload.model
            and not payload.model_override
            and model == model_router.FAST_CORE_DEFAULT_MODEL
            and intent in LIVE_THEORY_HEDGE_INTENTS
        )
        use_unclear_latency_hedge = (
            payload.fast_answer
            and not payload.model
            and not payload.model_override
            and model == model_router.FAST_CORE_DEFAULT_MODEL
            and intent == "unclear"
        )
        use_experience_latency_hedge = (
            payload.fast_answer
            and not payload.model
            and not payload.model_override
            and model == model_router.FAST_CORE_DEFAULT_MODEL
            and intent in {"experience", "practical_usage"}
        )
        uses_latency_hedge = (
            use_latency_hedge or use_unclear_latency_hedge or use_experience_latency_hedge
        )
        hedge_primary_model = model
        selected = None
        reliability_fallback = False
        try:
            if use_latency_hedge:
                # Theory and concrete "how I use it" answers are grounded by the
                # local factual packs above, so start the low-latency model first.
                # If it stalls, race the quality-first global default instead.
                selected = await select_hedged_stream(
                    primary_model=hedge_primary_model,
                    fallback_model=LIVE_RELIABILITY_BACKUP_MODEL,
                    stream_factory=stream_for,
                    hedge_after_seconds=LIVE_THEORY_HEDGE_AFTER_SECONDS,
                )
            elif use_unclear_latency_hedge:
                selected = await select_hedged_stream(
                    primary_model=model,
                    fallback_model=LIVE_RELIABILITY_BACKUP_MODEL,
                    stream_factory=stream_for,
                    hedge_after_seconds=LIVE_UNCLEAR_HEDGE_AFTER_SECONDS,
                )
            elif use_experience_latency_hedge:
                # Practical questions have a shorter live-answer budget than a
                # personal experience story. Keep the same quality-first model
                # and only start its reliability backup sooner for practical use.
                hedge_after_seconds = (
                    LIVE_PRACTICAL_HEDGE_AFTER_SECONDS
                    if intent == "practical_usage"
                    else LIVE_EXPERIENCE_HEDGE_AFTER_SECONDS
                )
                selected = await select_hedged_stream(
                    primary_model=model,
                    fallback_model=LIVE_RELIABILITY_BACKUP_MODEL,
                    stream_factory=stream_for,
                    hedge_after_seconds=hedge_after_seconds,
                )
            else:
                selected = await select_first_stream(model=model, stream_factory=stream_for)
        except Exception:
            can_rescue = (
                payload.fast_answer
                and not payload.model
                and not payload.model_override
                and model != LIVE_RELIABILITY_BACKUP_MODEL
            )
            if not can_rescue:
                raise
            reliability_fallback = True
            correction_meta["reliabilityFallbackStarted"] = True
            selected = await select_first_stream(
                model=LIVE_RELIABILITY_BACKUP_MODEL,
                stream_factory=stream_for,
            )

        if selected.primary_failed:
            reliability_fallback = True
            correction_meta["reliabilityFallbackStarted"] = True

        answer_model = selected.model
        if reliability_fallback:
            answer_source = "fast_core_reliability_fallback"
        elif uses_latency_hedge and selected.model != model:
            answer_source = "fast_core_latency_hedge"
        correction_meta["hedgeStarted"] = (
            selected.hedge_started if uses_latency_hedge and not reliability_fallback else False
        )
        if uses_latency_hedge and not reliability_fallback:
            correction_meta["hedgeWinner"] = (
                "primary" if selected.model == hedge_primary_model else "fallback"
            )

        parts.append(selected.first_chunk)
        yield f"data: {json.dumps({'type': 'chunk', 'text': selected.first_chunk}, ensure_ascii=False)}\n\n"
        async for delta in selected.remainder:
            parts.append(delta)
            yield f"data: {json.dumps({'type': 'chunk', 'text': delta}, ensure_ascii=False)}\n\n"
        correction_meta["answerModel"] = answer_model
        correction_meta["answerLatencyMs"] = int((time.perf_counter() - answer_started_at) * 1000)
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, AppError):
            err_msg = exc.message
            err_reason = exc.code
        else:
            err_msg = "Модели временно недоступны. Повторите вопрос."
        logger.warning("Live answer stream failed after fallbacks: %s", type(exc).__name__)

    spoken = "".join(parts).strip()
    final_spoken = spoken
    if spoken:
        final_spoken = _finalize_live_spoken(
            spoken,
            str(correction_meta.get("question_intent") or "unclear"),
            spoken_cap=70 if payload.fast_answer else 90,
        )

    if err_msg:
        # Never persist or publish a partial answer as successful. Keep provider
        # details server-side and expose only a stable client-facing reason.
        yield f"data: {json.dumps({'type': 'stream_failed', 'reason': err_reason, 'message': err_msg}, ensure_ascii=False)}\n\n"
    else:
        answer_id = None
        if db and final_spoken:
            try:
                answer_id = _persist_stream_answer(
                    db,
                    session_id=payload.session_id,
                    question=final_question,
                    spoken=final_spoken,
                    model=answer_model,
                    provider=provider,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to persist stream answer: %s", exc)
        done_payload = {
            "type": "done",
            "id": answer_id,
            "model": answer_model,
            "model_source": answer_source,
            "spoken": final_spoken,
            "correction": correction_meta,
        }
        yield f"data: {json.dumps(done_payload, ensure_ascii=False)}\n\n"


def _resolve_chat(
    mode: str,
    *,
    provider: str | None = None,
    model: str | None = None,
    model_override: str | None = None,
) -> tuple[str, str, str]:
    # Local Ollama: use the caller's model name directly (the model router only
    # knows the cloud catalog). Offline review/summary only — never the live path.
    if provider == "ollama":
        return "ollama", (model_override or model or "llama3.1"), "ollama"

    prefs = load_preferences()
    available = {m.id for m in prefs.models_cache}
    resolved_provider = provider or prefs.provider or "openrouter"
    override = model_override or model
    resolved_model, _source = model_router.resolve_model(
        mode,
        model_override=override,
        prefs=prefs,
        available=available,
    )
    return resolved_provider, resolved_model, _source


@router.post("/chat")
async def chat(payload: ChatPayload, db: Session = Depends(get_db)):
    """Стриминговый ответ (SSE). Подмешивает RAG-контекст."""
    _ensure_quota(db)
    is_fast = payload.mode == "fast"
    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model_override=payload.model_override,
    )

    # A complete typed question in the overlay must start streaming immediately.
    # Fast mode deliberately skips the extra embeddings request; explicitly
    # supplied transcript context remains available below.
    context_chunks = [] if is_fast else await rag_service.search(db, payload.message, top_k=5)
    context = payload.context or "\n\n".join(c["text"] for c in context_chunks)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if context:
        messages.append({"role": "system", "content": f"User context (retrieved):\n{context}"})
    messages.append(
        {
            "role": "user",
            "content": payload.message + _answer_language_block(payload.answer_language),
        }
    )

    async def event_stream():
        try:
            async for delta in provider_adapter.stream_chat(
                messages,
                provider,
                model,
                max_tokens=450 if is_fast else 800,
                temperature=0.3 if is_fast else 0.4,
                route_fast=is_fast,
            ):
                yield f"data: {json.dumps({'type': 'chunk', 'text': delta})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'model': model})}\n\n"
        except Exception as exc:
            msg = getattr(exc, "message", str(exc))
            yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"

    db.add(_chat_usage(provider, payload.message))
    db.commit()
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/chat/interview")
async def interview(payload: InterviewPayload, db: Session = Depends(get_db)) -> dict:
    _ensure_quota(db)
    """Возвращает структурированный ответ интервью (short/spoken/detailed/en/risk)."""
    is_fast = payload.mode == "fast"
    provider, model, source = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

    resume = _clip(rag_service.get_context_text(db, "resume"), RESUME_CONTEXT_LIMIT)
    vacancy = _clip(rag_service.get_context_text(db, "vacancy"), VACANCY_CONTEXT_LIMIT)
    legend = _clip(rag_service.get_context_text(db, "legend"), LEGEND_CONTEXT_LIMIT)
    final_question, raw_question, glossary_corrected, correction_meta = await _finalize_question(
        payload
    )

    if is_fast:
        strategy = resolve_answer_strategy(payload)
        correction_meta.update(
            {
                "question_intent": strategy["question_intent"],
                "answer_strategy": strategy["answer_strategy"],
                "resume_context_used": strategy["resume_context_used"],
                "resume_context_level": strategy["resume_context_level"],
                "resume_context_reason": strategy["resume_context_reason"],
                "suggest_unclear_prefix": strategy["suggest_unclear_prefix"],
            }
        )
        resume_text = (
            RESUME_PLACEHOLDER_NONE
            if strategy["resume_context_level"] == "none"
            else (resume or "(нет)")
        )
        resolved_q = correction_meta.get("resolved_follow_up_question") or final_question
        prompt = INTERVIEW_PROMPT_STREAM.format(
            resume=resume_text,
            vacancy=vacancy or "(нет)",
            legend=legend or "(нет)",
            candidate_profile=get_profile_block(db),
            question=final_question,
            raw_question=raw_question,
            glossary_corrected=glossary_corrected,
            ambiguity=correction_meta.get("ambiguity") or "(none)",
            resolved_follow_up_question=resolved_q,
            previous_topic=correction_meta.get("previous_topic") or "(none)",
            question_intent=strategy["question_intent"],
            answer_strategy=strategy["answer_strategy"],
            resume_context_level=strategy["resume_context_level"],
            resume_context_used=str(strategy["resume_context_used"]).lower(),
            resume_context_reason=strategy["resume_context_reason"],
            domain_hints=resolve_domain_answer_hints(resolved_q),
        )
        prompt += _weak_topics_block(payload.weak_topics)
        required_contract = resolve_required_output_contract(resolved_q)
        if required_contract:
            prompt += f"\n\n{required_contract}"
        max_tokens = 450
        temperature = 0.3
        notes = ""
    else:
        notes_chunks = await rag_service.search(
            db, payload.question, kinds=["notes", "qa", "company", "legend"], top_k=4
        )
        notes = "\n\n".join(c["text"] for c in notes_chunks)
        prompt = INTERVIEW_PROMPT.format(
            resume=resume or "(no resume provided)",
            vacancy=vacancy or "(no vacancy provided)",
            notes=notes or "(no extra notes)",
            question=payload.question,
        )
        # Same Python Knowledge Pack as the live path: only for pure-Python
        # questions, appended as a capped auxiliary reference.
        if detect_pack(payload.question):
            kn_block, _ = build_python_pack_injection(payload.question)
            if kn_block:
                prompt = f"{prompt}\n\n{kn_block}"
        prompt += _weak_topics_block(payload.weak_topics)
        max_tokens = 900
        temperature = 0.4

    prompt += _answer_language_block(payload.answer_language)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    raw = await provider_adapter.complete(
        messages,
        provider,
        model,
        max_tokens=max_tokens,
        temperature=temperature,
        request_timeout_seconds=75,
        max_attempts=2,
    )
    parsed = _parse_fast_response(raw) if is_fast else _safe_json(raw)

    answer = Answer(
        session_id=payload.session_id,
        question=final_question,
        answer_short=parsed.get("short"),
        answer_spoken=parsed.get("spoken"),
        answer_detailed=parsed.get("detailed"),
        answer_en=parsed.get("english"),
        risk_note=parsed.get("risk"),
        model=model,
    )
    db.add(answer)
    db.add(_chat_usage(provider, prompt, raw))
    db.commit()

    return {
        "id": answer.id,
        "model": model,
        "model_source": source,
        "correction": correction_meta,
        **parsed,
    }


# Колонка Answer, в которой живёт каждый вариант, — для кэша между заходами.
_VARIANT_COLUMNS: dict[str, str] = {
    "short": "answer_short",
    "detailed": "answer_detailed",
    "english": "answer_en",
    "risk": "risk_note",
}


@router.post("/chat/answer-variant")
async def answer_variant(payload: AnswerVariantPayload, db: Session = Depends(get_db)) -> dict:
    _ensure_quota(db)
    """Ленивая генерация варианта ответа (short/detailed/english/risk) по клику на таб."""
    instruction = _VARIANT_PROMPTS.get(payload.variant)
    if not instruction:
        raise AppError(
            "variant must be one of: short, detailed, english, risk", 400, "invalid_variant"
        )

    column = _VARIANT_COLUMNS[payload.variant]
    answer_row = (
        db.query(Answer).filter(Answer.id == payload.answer_id).first()
        if payload.answer_id
        else None
    )
    if answer_row is not None:
        cached = (getattr(answer_row, column) or "").strip()
        if cached:
            return {"text": cached, "variant": payload.variant, "cached": True}

    provider, model, source = _resolve_chat(
        "fast",
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    prompt = (
        f"Вопрос интервьюера:\n{payload.question}\n\n"
        f"Ответ кандидата:\n{payload.answer}\n\n"
        f"ЗАДАЧА: {instruction}\n"
        "Верни ТОЛЬКО текст результата, без пояснений и меток."
    )
    if payload.variant != "english":
        prompt += _answer_language_block(payload.answer_language)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    text = await provider_adapter.complete(
        messages,
        provider,
        model,
        max_tokens=600,
        temperature=0.3,
        request_timeout_seconds=60,
        max_attempts=2,
    )
    result = text.strip()
    if answer_row is not None and result:
        setattr(answer_row, column, result)
    db.add(_chat_usage(provider, payload.answer, result))
    db.commit()
    return {"text": result, "model": model, "model_source": source, "variant": payload.variant}


@router.post("/chat/interview/stream")
async def interview_stream(payload: InterviewPayload, db: Session = Depends(get_db)):
    _ensure_quota(db)
    """SSE-стрим live-подсказки — первые токены сразу."""
    provider, model, source = _resolve_chat(
        "fast",
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    if payload.fast_answer and not payload.model and not payload.model_override:
        # The no-RAG core relies on model knowledge instead of factual patches.
        # Keep one globally benchmarked quality/latency model; explicit API
        # overrides remain available for diagnostics and controlled rollouts.
        model = model_router.FAST_CORE_DEFAULT_MODEL
        source = "fast_core_default"

    # We use a separate session for the streaming event to keep the Depends()
    # session free for the caller. Resolve the provider before opening it so
    # failures cannot leak a session before StreamingResponse is created.
    stream_db = SessionLocal()
    resume = vacancy = legend = profile_block = ""
    if not payload.fast_answer:
        try:
            resume = _clip(rag_service.get_context_text(stream_db, "resume"), RESUME_CONTEXT_LIMIT)
            vacancy = _clip(
                rag_service.get_context_text(stream_db, "vacancy"), VACANCY_CONTEXT_LIMIT
            )
            legend = _clip(rag_service.get_context_text(stream_db, "legend"), LEGEND_CONTEXT_LIMIT)
            profile_block = get_profile_block(stream_db)
        except Exception:
            stream_db.close()
            raise

    async def event_stream():
        try:
            async for line in _interview_event_stream(
                provider=provider,
                model=model,
                source=source,
                payload=payload,
                resume=resume or "(нет)",
                vacancy=vacancy or "(нет)",
                legend=legend or "(нет)",
                candidate_profile=profile_block,
                db=stream_db,
            ):
                yield line
        finally:
            stream_db.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/meeting-summary")
async def meeting_summary(payload: MeetingPayload, db: Session = Depends(get_db)) -> dict:
    _ensure_quota(db)
    provider, model, source = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

    prompt = build_meeting_prompt(payload.transcript, payload.answer_language)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    summary = await provider_adapter.complete(
        messages,
        provider,
        model,
        max_tokens=900,
        request_timeout_seconds=75,
        max_attempts=2,
    )
    db.add(_chat_usage(provider, prompt, summary))
    db.commit()
    return {"summary": summary, "model": model, "model_source": source}


@router.post("/chat/interview-outcome")
async def interview_outcome(
    payload: InterviewOutcomePayload, db: Session = Depends(get_db)
) -> dict:
    """Compact structured notes attached to a scheduled HR/technical calendar event."""
    _ensure_quota(db)
    provider, model, source = _resolve_chat(
        "fast",
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    prompt = build_interview_outcome_prompt(
        payload.transcript,
        payload.interview_type,
        payload.vacancy_title,
        payload.company_name,
        payload.answer_language,
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    raw = await provider_adapter.complete(
        messages,
        provider,
        model,
        max_tokens=650,
        temperature=0.15,
        response_format={"type": "json_object"},
        request_timeout_seconds=60,
        max_attempts=2,
    )
    outcome = _normalize_interview_outcome(raw)
    db.add(_chat_usage(provider, prompt, raw))
    db.commit()
    return {**outcome, "model": model, "modelSource": source}


@router.post("/chat/interview-review")
async def interview_review(payload: MeetingPayload, db: Session = Depends(get_db)) -> dict:
    _ensure_quota(db)
    """Разбор записи интервью: находит слабые/проблемные ответы кандидата."""
    provider, model, source = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

    prompt = build_interview_review_prompt(payload.transcript, payload.answer_language)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    review = await provider_adapter.complete(
        messages,
        provider,
        model,
        max_tokens=1400,
        request_timeout_seconds=75,
        max_attempts=2,
    )
    db.add(_chat_usage(provider, prompt, review))
    db.commit()
    return {"review": review, "model": model, "model_source": source}


@router.post("/chat/interview-review/stream")
async def interview_review_stream(payload: MeetingPayload, db: Session = Depends(get_db)):
    _ensure_quota(db)
    """Streaming (SSE) interview review — renders progressively in the UI."""
    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    prompt = build_interview_review_prompt(payload.transcript, payload.answer_language)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    async def event_stream():
        try:
            async for delta in provider_adapter.stream_chat(
                messages, provider, model, max_tokens=1400, temperature=0.3
            ):
                yield f"data: {json.dumps({'type': 'chunk', 'text': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'model': model})}\n\n"
        except Exception as exc:  # noqa: BLE001
            msg = getattr(exc, "message", str(exc))
            yield f"data: {json.dumps({'type': 'error', 'message': msg}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/meeting-summary/stream")
async def meeting_summary_stream(payload: MeetingPayload, db: Session = Depends(get_db)):
    _ensure_quota(db)
    """Streaming (SSE) meeting summary — renders progressively in the UI."""
    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    prompt = build_meeting_prompt(payload.transcript, payload.answer_language)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    async def event_stream():
        try:
            async for delta in provider_adapter.stream_chat(
                messages, provider, model, max_tokens=900, temperature=0.3
            ):
                yield f"data: {json.dumps({'type': 'chunk', 'text': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'model': model})}\n\n"
        except Exception as exc:  # noqa: BLE001
            msg = getattr(exc, "message", str(exc))
            yield f"data: {json.dumps({'type': 'error', 'message': msg}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


_SCREEN_OUTPUT_TASK_RE = re.compile(
    r"что\s+(?:выведет|верн[её]т|произойд[её]т)|какой\s+(?:будет\s+)?результат|"
    r"what\s+(?:will|does)\s+.+\s+(?:print|output|return)",
    re.IGNORECASE | re.UNICODE,
)

_SCREEN_TESTING_TASK_RE = re.compile(
    r"состав(?:ить|ьте)\b[^.\n]{0,120}\b(?:кейс|чек[- ]?лист)|"
    r"(?:протестир\w*|тестиров\w*)[^.\n]{0,100}(?:api|endpoint|эндпоинт|функционал)|"
    r"(?:write|create|prepare)\s+(?:test\s+cases|a\s+checklist)|"
    r"test(?:ing)?\s+(?:an?\s+)?(?:api|endpoint|feature)",
    re.IGNORECASE | re.UNICODE,
)

_SCREEN_MULTI_VIEWPORT_ANALYSIS_RE = re.compile(
    r"\b(?:анализ\w*|проанализ\w*|найд\w*|перечисл\w*|список\w*|"
    r"дефект\w*|ошиб\w*|проблем\w*|недостат\w*)\b|"
    r"\b(?:analy[sz]\w*|review\w*|find\w*|list\w*|identify\w*|"
    r"defect\w*|issue\w*|problem\w*)\b",
    re.IGNORECASE | re.UNICODE,
)

_SCREEN_EXPLICIT_REWORK_RE = re.compile(
    r"\b(?:упрост\w*|переработ\w*|передел\w*|перепиш\w*|сократ\w*)\b|"
    r"\b(?:сдела\w*|давай\w*|нужн\w*)\b[^.!?\n]{0,80}\bпроще\b|"
    r"\bслишком\s+сложн\w*\b[\s\S]{0,120}\b(?:остав\w*|нужн\w*|убер\w*|упрост\w*)\b|"
    r"\bубер\w*\s+лишн\w*\b|"
    r"\b(?:simplif\w*|rewrite\w*|rework\w*|redo\w*)\b|"
    r"\b(?:too|overly)\s+(?:complex|complicated)\b[\s\S]{0,120}"
    r"\b(?:keep|remove|simplif\w*|rewrite\w*|rework\w*|redo\w*)\b|"
    r"\bmake\s+(?:it|the\s+(?:solution|implementation))\s+simpler\b",
    re.IGNORECASE | re.UNICODE,
)

SCREEN_TASK_REQUEST = (
    "Сначала прочитай точную формулировку задания на скриншоте, включая текст "
    "над и под кодом. Определи, какое действие от кандидата требуется, и выполни "
    "именно его. Если просят определить порядок, последовательность, результат, "
    "ошибку или объяснить поведение существующего кода, вычисли это и дай прямой "
    "ответ — не переписывай исходный код. Новый полный код давай только если на "
    "экране явно просят написать, реализовать, исправить или дополнить программу."
)

SCREEN_ASSIST_PROMPT = (
    "Ты — ассистент кандидата на техническом собеседовании. Тебе дают скриншот "
    "его экрана и, возможно, транскрипт разговора. На экране почти всегда "
    "ЗАДАНИЕ: SQL-запрос, задача на Python (или другом языке) либо текстовая "
    "формулировка, что нужно сделать. Не пересказывай экран — сразу помогай решить.\n\n"
    "Выбирай самое маленькое стандартное решение, которое соответствует всем видимым требованиям. "
    "Простота не разрешает пропускать обязательное условие. Не выдумывай таблицы, поля, JOIN, CTE, "
    "JSON-агрегацию, классы, зависимости, проверки или архитектуру, если этого не требует видимый "
    "контракт или последнее исправление интервьюера. Если данных не хватает, назови одно короткое "
    "допущение вместо выдуманной схемы или интерфейса.\n\n"
    "Сохраняй точные видимые имена, литералы, сигнатуры, схему и форму результата. Последнее "
    "исправление интервьюера имеет приоритет: измени только то, что запросили последним, сохрани "
    "остальные интерфейсы и поведение и верни полное обновлённое решение, а не diff. Если последнее "
    "уточнение просит сделать решение проще, упрости всё решение целиком: не сохраняй ненужные обёртки "
    "и служебные слои из прошлого ответа, которых не требует видимый контракт.\n\n"
    "При таком упрощении сохрани только публичный интерфейс и обязательную семантику результата. "
    "Предыдущее решение — контекст, а не шаблон для копирования: заново выведи минимальную реализацию "
    "из видимых требований и последнего уточнения. Удали все вспомогательные слои и детали реализации, "
    "которые видимый контракт прямо не требует.\n\n"
    "Лимит слов режима относится только к устной сводке. Он не сокращает код, чек-листы, "
    "комментарии, fenced-блоки и обязательные части ответа.\n\n"
    "Если в редакторе видна только короткая фраза, заголовок, строка в кавычках или комментарий "
    "(например, «Декоратор с args и kwargs»), считай это темой задачи, но это не означает автоматически, "
    "что нужно писать новый код. По видимому условию и контексту определи, нужно ли объяснить, вычислить "
    "порядок или написать полный рабочий пример на языке, выбранном в редакторе. Для явной задачи на код "
    "ответ должен быть готов копироваться вместо содержимого редактора. "
    "Не объясняй, как пользоваться сайтом или визуализатором.\n\n"
    "Сначала прочитай формулировку вокруг кода и определи тип задания. Видимое условие важнее "
    "общих инструкций режима. Если спрашивают про порядок или последовательность выполнения "
    "(в том числе setup, зависимости и teardown фикстур), перечисли точный trace и кратко объясни "
    "его, не копируя и не переписывая код. Если спрашивают «что выведет/вернёт/произойдёт» или про ошибку, "
    "НЕ переписывай и НЕ исправляй код: укажи точный stdout/результат либо класс исключения первой "
    "строкой, затем кратко объясни порядок выполнения. Обязательно перечисли весь stdout, который "
    "успел появиться ДО исключения; не заменяй его только названием ошибки. После первого "
    "необработанного исключения следующие строки не исполняются. Сохраняй точные видимые типы и значения; "
    "не подменяй их похожими примерами из памяти.\n\n"
    "ЖЁСТКОЕ ПРАВИЛО ДЛЯ ЗАДАНИЙ «напиши/реализуй/исправь/дополни»: ответ без полного "
    "исполняемого блока кода неправильный. Не ограничивайся планом или псевдокодом. Даже если "
    "формулировка короткая, сделай разумное допущение и выдай рабочий пример с корректными "
    "отступами. После короткой устной сводки код всегда оформляй одним fenced "
    "Markdown-блоком с указанием языка. "
    "После КАЖДОЙ непустой содержательной строки кода поставь короткий комментарий на русском "
    "ОТДЕЛЬНОЙ СТРОКОЙ сразу под ней, с тем же отступом (# Python, -- SQL, // JS/Java). "
    "Никогда не ставь пояснение справа в конце строки кода. Оформляй код без пустых строк между "
    "парой «код → комментарий»: он должен читаться сверху вниз как сценарий ответа. "
    "Для изменения предыдущей задачи верни полное обновлённое решение, а не diff.\n\n"
    "Формат ответа:\n"
    "1) Для написания/исправления — СНАЧАЛА короткая устная сводка: дай готовую реплику, "
    "что сказать интервьюеру перед написанием кода. В 1–3 коротких предложениях по-человечески "
    "объясни подход, основные шаги и важное условие; без кода, заголовка и лишней теории.\n"
    "2) ЗАТЕМ решение одним блоком кода. К каждой существенной "
    "строке добавь короткий комментарий отдельной строкой сразу под строкой кода "
    "(# для Python, -- для SQL). Никогда не ставь пояснение справа от кода.\n"
    "3) Для результата/ошибки — точный результат или исключение сначала, без нового решения.\n"
    "4) После кода — максимум 1–2 короткие фразы только о важном допущении.\n"
    "5) Если на экране не код, а текстовый вопрос/задача — дай прямой готовый ответ "
    "от первого лица, без вступлений.\n\n"
    "Перед выдачей решения молча проверь его по скриншоту. Сохрани точные имена, регистр "
    "строковых литералов, операторы, таблицы, поля и требуемый alias; не заменяй точные "
    "значения своими вариантами.\n\n"
    "НЕ начинай с «На экране…»/«Задание звучит так…» — сразу к делу. Отвечай на "
    "языке содержимого экрана (обычно русский), кратко и по делу."
)

SCREEN_CODE_OUTPUT_CONTRACT = (
    "ЕСЛИ НУЖНО НАПИСАТЬ, ИСПРАВИТЬ ИЛИ ДОПОЛНИТЬ КОД: сначала дай 1–3 коротких "
    "предложения — готовую человеческую реплику, которую кандидат скажет интервьюеру перед "
    "написанием кода: подход, основные шаги и важное условие. Без заголовка и кода. Затем "
    "покажи один fenced Markdown-блок с языком. КАЖДАЯ непустая содержательная строка обязана иметь короткий "
    "комментарий на русском ОТДЕЛЬНОЙ СТРОКОЙ сразу под строкой кода, объясняющий, что "
    "делаем и зачем. Сохрани тот же отступ; не ставь комментарий справа от кода. Не делай "
    "пустых строк внутри пары «код → комментарий». Для продолжения старого задания покажи полное обновлённое "
    "решение, а не diff. После блока — максимум две короткие фразы."
)

SCREEN_MULTI_VIEWPORT_SYNTHESIS_CONTRACT = (
    "MULTI-VIEWPORT SYNTHESIS CONTRACT: When the task spans scrolled or multiple "
    "viewports, retain and synthesize every non-conflicting finding from all previous "
    "viewport frames and the prior solution context. Never drop a valid earlier finding "
    "only because it is absent from the current viewport. The current viewport overrides "
    "prior context only where an actual conflict exists. The latest interviewer correction "
    "remains authoritative."
)

SCREEN_REFINEMENT_PRIORITY_CONTRACT = (
    "REFINEMENT PRIORITY CONTRACT: The prior solution is EVIDENCE ONLY, never a copy "
    "template. If the latest correction asks to simplify or rework the solution, it overrides "
    "generic preservation instructions from the transcript or context. При упрощении сохрани "
    "только публичный интерфейс и обязательную семантику результата; заново выведи минимальную "
    "реализацию и удали неподтверждённые вспомогательные слои."
)

SCREEN_FINAL_DECISION_CONTRACT = (
    "FINAL SCREEN DECISION: Before answering, build a silent evidence ledger for every "
    "retained viewport frame. Consolidate every non-conflicting finding; newer visual "
    "evidence overrides an earlier frame only on an actual direct conflict. The prior "
    "answer is diagnostic evidence only, never required behavior or a copy template. "
    "Preserve only the public interface and output semantics that are visible or explicitly "
    "requested. Apply the exact latest correction below as the final decision rule."
)

SCREEN_MULTI_VIEWPORT_ANALYSIS_FINAL_CONTRACT = (
    "MULTI-VIEWPORT ANALYSIS/LIST/FIND-DEFECT TASK: A response containing only the "
    "current/new delta is invalid. Explicitly restate at least one supported finding "
    "from EACH retained previous frame and at least one supported finding from the current "
    "frame, then return one unified list."
)

SCREEN_EXPLICIT_REWORK_FINAL_CONTRACT = (
    "EXPLICIT REWORK OVERRIDE: The latest correction requests simplification or rework. "
    "It overrides any generic request to preserve working parts. Re-derive the smallest "
    "solution from the retained visual evidence and latest correction; do not reconstruct "
    "implementation choices from the omitted prior answer."
)


async def _structured_screen_event_stream(
    *,
    payload: ScreenAssistPayload,
    image: str,
    previous_images: list[str],
    provider: str,
    model: str,
    model_source: str,
    max_tokens: int,
    reasoning: dict | None,
    db: Session,
):
    """Poll the bounded complete-task while preserving the SSE idle contract."""

    usage_accumulator = _ScreenUsageAccumulator(provider=provider)

    async def complete_with_usage(messages, *args, **kwargs):
        # Clear any copied ContextVar value before every child-task call. Each
        # successful completion is consumed immediately so calls cannot leak
        # usage into each other or into a concurrent pipeline.
        provider_adapter.pop_last_usage()
        try:
            completion = await provider_adapter.complete(messages, *args, **kwargs)
        except BaseException:
            provider_adapter.pop_last_usage()
            raise
        usage_accumulator.record(
            messages,
            completion,
            provider_adapter.pop_last_usage(),
        )
        return completion

    task = asyncio.create_task(
        run_screen_task_pipeline(
            previous_images=tuple(previous_images),
            current_image=image,
            latest_correction=payload.question.strip()[:SCREEN_LATEST_CORRECTION_CONTEXT_CHARS],
            context=payload.context or "",
            prior_solution_summary=payload.prior_solution_summary,
            task_action=payload.task_action,
            task_state=payload.task_state,
            provider=provider,
            model=model,
            max_tokens=max_tokens,
            reasoning=reasoning,
            complete=complete_with_usage,
        )
    )
    try:
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=SCREEN_STREAM_KEEPALIVE_SECONDS)
            if not done:
                yield ": keepalive\n\n"
        result = task.result()
        yield (
            "data: "
            + json.dumps(
                {"type": "chunk", "text": result.answer},
                ensure_ascii=False,
            )
            + "\n\n"
        )
        yield (
            "data: "
            + json.dumps(
                {
                    "type": "done",
                    "model": model,
                    "model_source": model_source,
                    "task_state": result.serialized_task_state,
                },
                ensure_ascii=False,
            )
            + "\n\n"
        )
    except ScreenTaskPipelineError as exc:
        event = _screen_stream_error_event(
            AppError(exc.public_message, 422, exc.code),
            model,
        )
        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    except Exception as exc:  # noqa: BLE001
        event = _screen_stream_error_event(exc, model)
        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        if usage_accumulator.completed_calls:
            try:
                db.add(
                    ApiUsage(
                        provider=usage_accumulator.provider,
                        kind="chat",
                        tokens_in=usage_accumulator.tokens_in,
                        tokens_out=usage_accumulator.tokens_out,
                    )
                )
                db.commit()
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.warning("Failed to persist structured screen usage: %s", type(exc).__name__)


@router.post("/chat/screen/stream")
async def screen_assist_stream(payload: ScreenAssistPayload, db: Session = Depends(get_db)):
    """Vision: скриншот экрана + вопрос → стриминговая подсказка (SSE)."""
    _ensure_quota(db)
    image = payload.image.strip()
    if not image:
        raise AppError("Пустой скриншот", 400, "empty_image")
    if not image.startswith("data:image/"):
        image = f"data:image/jpeg;base64,{image}"
    if len(image) > MAX_SCREEN_IMAGE_CHARS:
        raise AppError("Скриншот слишком большой", 413, "image_too_large")
    previous_images = [frame.strip() for frame in payload.previous_images if frame.strip()]
    if len(previous_images) > MAX_PREVIOUS_SCREEN_IMAGES:
        raise AppError("Слишком много предыдущих скриншотов", 400, "too_many_previous_images")
    previous_images = [
        frame if frame.startswith("data:image/") else f"data:image/jpeg;base64,{frame}"
        for frame in previous_images
    ]
    if sum(len(frame) for frame in previous_images) > MAX_PREVIOUS_SCREEN_IMAGE_CHARS:
        raise AppError("Предыдущие скриншоты слишком большие", 413, "previous_images_too_large")

    provider, model, model_source = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    latest_correction = payload.question.strip()[:SCREEN_LATEST_CORRECTION_CONTEXT_CHARS]
    screen_task_context = f"{payload.question}\n{payload.context or ''}"
    is_screen_testing_task = bool(_SCREEN_TESTING_TASK_RE.search(screen_task_context))
    analysis_request_text = latest_correction or _tail_clip_chronological_context(
        payload.context or "", SCREEN_LATEST_CORRECTION_CONTEXT_CHARS
    )
    is_multiview_analysis_task = bool(
        previous_images and _SCREEN_MULTI_VIEWPORT_ANALYSIS_RE.search(analysis_request_text)
    )
    is_explicit_rework = bool(_SCREEN_EXPLICIT_REWORK_RE.search(latest_correction))
    # Screen assist is not just OCR: every visual task must preserve exact
    # literals and reason through the requested solution. Keep the fast Qwen
    # route for voice only; the user can read the task while screen reasoning
    # finishes. Preserve every explicit user/configured model; strengthen Auto.
    if model_source == "auto":
        model = model_router.SCREEN_DEFAULT_MODEL

    structured_screen_enabled = (
        payload.structured_screen
        and os.environ.get("SKILLCUE_BUILD_CHANNEL", "").strip().lower() == "alpha"
    )
    if structured_screen_enabled:
        # The opt-in path extracts typed evidence first.  The legacy stream
        # below remains byte-for-byte compatible for existing desktop builds.
        screen_max_tokens, screen_reasoning = provider_adapter.screen_stream_options(model)
        return StreamingResponse(
            _structured_screen_event_stream(
                payload=payload,
                image=image,
                previous_images=previous_images,
                provider=provider,
                model=model,
                model_source=model_source,
                max_tokens=screen_max_tokens,
                reasoning=screen_reasoning,
                db=db,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    user_text = SCREEN_TASK_REQUEST
    if latest_correction:
        user_text += (
            "\n\nДополнительная просьба пользователя / LATEST INTERVIEWER CORRECTION "
            "(authoritative; не заменяет видимое условие / does not replace the visible task):\n"
            f"{latest_correction}"
        )
    if (
        payload.prior_solution_summary
        and payload.prior_solution_summary.strip()
        and not is_explicit_rework
    ):
        user_text += (
            "\n\nPRIOR SOLUTION SUMMARY (EVIDENCE ONLY; never a copy template; the latest "
            "correction decides what remains):\n"
            f"{_clip_screen_prior_solution(payload.prior_solution_summary, SCREEN_PRIOR_SOLUTION_CONTEXT_CHARS)}"
        )
    elif payload.prior_solution_summary and payload.prior_solution_summary.strip():
        user_text += (
            "\n\nPRIOR SOLUTION SUMMARY OMITTED BY REFINEMENT POLICY: the latest correction "
            "requests simplification or rework. Do not reconstruct implementation choices "
            "from the omitted answer."
        )
    if previous_images:
        user_text += f"\n\n{SCREEN_MULTI_VIEWPORT_SYNTHESIS_CONTRACT}"
    if payload.context:
        user_text += (
            "\n\nТранскрипт и контекст прошлой экранной задачи:\n"
            f"{_tail_clip_chronological_context(payload.context, 5000)}"
        )
    if payload.prior_solution_summary and latest_correction:
        # Place this after transcript context so a generic request to preserve
        # working parts cannot outrank the latest explicit simplification.
        user_text += f"\n\n{SCREEN_REFINEMENT_PRIORITY_CONTRACT}"
    if is_screen_testing_task:
        user_text += (
            "\n\nЭТО ЗАДАНИЕ НА ТЕСТИРОВАНИЕ: не реализуй endpoint и не пиши SQL или код, "
            "если интервьюер прямо этого не просил. Используй скриншот как входные данные "
            "и дай проверки, негативные сценарии, граничные значения и важные уточняющие вопросы."
        )
    if _SCREEN_OUTPUT_TASK_RE.search(user_text):
        user_text += (
            "\n\nФИНАЛЬНАЯ ПРОВЕРКА РЕЗУЛЬТАТА: анализируй именно видимый код, не "
            "исправляй его. Сначала перечисли точный stdout до ошибки, затем назови первое "
            "необработанное исключение; не пропускай уже выполненные print и не исполняй строки "
            "после ошибки. Применяй семантику именно видимого языка и сохраняй точные типы и "
            "значения; не переноси вывод из другого примера."
        )
    user_text += _answer_language_block(payload.answer_language)
    user_text += f"\n\n{SCREEN_CODE_OUTPUT_CONTRACT}"

    vision_content: list[dict] = [{"type": "text", "text": user_text}]
    for index, previous_image in enumerate(previous_images, start=1):
        vision_content.extend(
            [
                {"type": "text", "text": f"PREVIOUS VIEWPORT FRAME {index} (supporting context):"},
                {"type": "image_url", "image_url": {"url": previous_image, "detail": "high"}},
            ]
        )
    final_decision_text = SCREEN_FINAL_DECISION_CONTRACT
    if is_multiview_analysis_task:
        final_decision_text += f"\n\n{SCREEN_MULTI_VIEWPORT_ANALYSIS_FINAL_CONTRACT}"
    if is_explicit_rework:
        final_decision_text += f"\n\n{SCREEN_EXPLICIT_REWORK_FINAL_CONTRACT}"
    final_decision_text += (
        "\n\nEXACT LATEST CORRECTION (highest priority when present):\n"
        f"{latest_correction or '[none — follow the exact visible task]'}"
    )
    vision_content.extend(
        [
            {
                "type": "text",
                "text": (
                    "CURRENT VIEWPORT (new evidence; authoritative only on an actual "
                    "direct conflict):"
                ),
            },
            {"type": "image_url", "image_url": {"url": image, "detail": "high"}},
            {
                "type": "text",
                "text": final_decision_text,
            },
        ]
    )
    messages: list[dict] = [
        {"role": "system", "content": SCREEN_ASSIST_PROMPT},
        {
            "role": "user",
            "content": vision_content,
        },
    ]
    # Изображение стоит дорого (~1–1.5k токенов) — фиксируем расход заранее.
    db.add(_chat_usage(provider, user_text + " " * 4000))
    db.commit()
    screen_max_tokens, screen_reasoning = provider_adapter.screen_stream_options(model)

    async def event_stream():
        next_delta: asyncio.Task[str] | None = None
        try:
            stream = provider_adapter.stream_chat(
                messages,
                provider,
                model,
                max_tokens=screen_max_tokens,
                temperature=0.0,
                reasoning=screen_reasoning,
                require_complete=True,
            )
            next_delta = asyncio.create_task(anext(stream))
            while next_delta:
                done, _ = await asyncio.wait({next_delta}, timeout=SCREEN_STREAM_KEEPALIVE_SECONDS)
                if not done:
                    # SSE comments are transport-only: they reset the desktop
                    # byte-idle watchdog without becoming answer text.
                    yield ": keepalive\n\n"
                    continue
                try:
                    delta = next_delta.result()
                except StopAsyncIteration:
                    break
                yield f"data: {json.dumps({'type': 'chunk', 'text': delta}, ensure_ascii=False)}\n\n"
                next_delta = asyncio.create_task(anext(stream))
            yield f"data: {json.dumps({'type': 'done', 'model': model, 'model_source': model_source})}\n\n"
        except Exception as exc:  # noqa: BLE001
            event = _screen_stream_error_event(exc, model)
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if next_delta and not next_delta.done():
                next_delta.cancel()
                with suppress(asyncio.CancelledError):
                    await next_delta

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _sanitize_live_task_answer(text: str) -> str:
    """Sanitize prose without destroying indentation inside fenced code."""
    parts = re.split(r"(```[\s\S]*?```)", text.strip())
    cleaned: list[str] = []
    for part in parts:
        if not part.strip():
            continue
        if part.lstrip().startswith("```"):
            cleaned.append(part.strip())
        else:
            prose = sanitize_live_answer(part)
            if prose:
                cleaned.append(prose)
    return "\n\n".join(cleaned).strip()


_CYRILLIC_OUTPUT_RE = re.compile(r"[А-Яа-яЁё]")
_RUSSIAN_PROMPT_LABELS = (
    (re.compile(r"\bDecisive\s+difference:\s*", re.IGNORECASE), "Главное отличие: "),
    (re.compile(r"\bEnforced:\s*", re.IGNORECASE), ""),
    (re.compile(r"\bConvention:\s*", re.IGNORECASE), "Обычно "),
    (re.compile(r"\bMechanism:\s*", re.IGNORECASE), "Механизм: "),
)


def _localize_leaked_prompt_labels(text: str) -> str:
    """Убирает английские служебные метки, если основной ответ уже на русском."""
    if not _CYRILLIC_OUTPUT_RE.search(text):
        return text
    localized = text
    for pattern, replacement in _RUSSIAN_PROMPT_LABELS:
        localized = pattern.sub(replacement, localized)
    return localized


def _finalize_live_spoken(raw: str, question_intent: str, *, spoken_cap: int = 90) -> str:
    """Sanitize live output and preserve complete concrete-task code blocks."""
    parsed = _parse_fast_response(raw)
    spoken = _localize_leaked_prompt_labels(parsed.get("spoken") or raw)
    if question_intent in {"technical_task", "api_test_task"} or "```" in spoken:
        # Cutting at 90 words can leave code incomplete; normal sanitization also
        # collapses indentation and can remove Python # comments. Preserve every
        # fenced block even when a theory answer includes a small code example.
        return _sanitize_live_task_answer(spoken)
    return trim_spoken_answer(sanitize_live_answer(spoken), spoken_cap)


def _parse_fast_response(raw: str) -> dict:
    """Live-режим: plain text / markdown, без обрезки."""
    empty = {"short": "", "spoken": "", "detailed": "", "english": "", "risk": ""}
    text = raw.strip()

    # Only unwrap an explicit JSON fence. A Python/SQL fence is user-visible
    # answer content and its indentation must survive task finalization.
    if text.lower().startswith("```json"):
        text = text[7:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    # Только если явный JSON-объект
    if text.startswith("{") and '"short"' in text[:120]:
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                spoken = str(data.get("spoken") or data.get("short") or "").strip()
                if spoken:
                    return {**empty, "short": _first_sentences(spoken, 2), "spoken": spoken}
        except json.JSONDecodeError:
            extracted = _extract_json_fields(text)
            spoken = (extracted.get("spoken") or extracted.get("short") or "").strip()
            if spoken:
                return {**empty, "short": _first_sentences(spoken, 2), "spoken": spoken}

    if not text:
        return {**empty, "spoken": "Не удалось получить ответ. Повторите вопрос."}

    return {**empty, "short": _first_sentences(text, 2), "spoken": text}


def _first_sentences(text: str, count: int = 2) -> str:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:count]).strip() or text[:200]


def _safe_json(raw: str) -> dict:
    empty = {
        "short": "",
        "spoken": "",
        "detailed": "",
        "english": "",
        "risk": "",
    }
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()

    try:
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return {**empty, **{k: str(v) for k, v in data.items() if k in empty and v}}
    except json.JSONDecodeError:
        pass

    extracted = _extract_json_fields(cleaned)
    if extracted.get("short") or extracted.get("spoken"):
        return {**empty, **extracted}

    fallback = extracted.get("spoken") or extracted.get("short") or _strip_json_noise(cleaned)
    return {
        **empty,
        "short": _first_sentences(fallback, 2),
        "spoken": fallback,
        "risk": "Model did not return valid JSON.",
    }


def _strip_json_noise(text: str) -> str:
    t = text.strip()
    t = re.sub(r'^\s*\{\s*"short"\s*:\s*"', "", t)
    t = re.sub(r'"\s*,?\s*"spoken"\s*:\s*"', " ", t)
    return t.rstrip('"}').strip() or text[:500]


def _extract_json_fields(raw: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for key in ("short", "spoken", "detailed", "english", "risk"):
        match = re.search(rf'"{key}"\s*:\s*"((?:[^"\\]|\\.)*)"', raw, re.DOTALL)
        if match:
            fields[key] = match.group(1).replace("\\n", "\n").replace('\\"', '"')
    return fields
