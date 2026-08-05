import json
import logging
import re
import time

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import Answer, ApiUsage
from app.db.session import SessionLocal, get_db
from app.prompts.interview import INTERVIEW_PROMPT
from app.prompts.interview_fast import (
    INTERVIEW_PROMPT_STREAM,
    LEGEND_CONTEXT_LIMIT,
    LIVE_SYSTEM_PROMPT,
    RESUME_CONTEXT_LIMIT,
    RESUME_PLACEHOLDER_NONE,
    VACANCY_CONTEXT_LIMIT,
)
from app.prompts.meeting import build_interview_review_prompt, build_meeting_prompt
from app.prompts.system import SYSTEM_PROMPT
from app.services import model_router, provider_adapter, rag_service
from app.services.candidate_profile import get_profile_block
from app.services.domain_answer_hints import resolve_domain_answer_hints
from app.services.knowledge_pack import build_injection as build_python_pack_injection
from app.services.knowledge_pack import detect_pack
from app.services.preferences import load_preferences
from app.services.question_intent import resolve_answer_strategy
from app.services.sanitize_live_answer import sanitize_live_answer, trim_spoken_answer

router = APIRouter(tags=["chat"])

logger = logging.getLogger("chat")

FAST_CONTEXT_LIMIT = 350


def _clip(text: str, limit: int = FAST_CONTEXT_LIMIT) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


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


class InterviewPayload(BaseModel):
    question: str
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


class ScreenAssistPayload(BaseModel):
    """Vision-подсказка по скриншоту экрана (оверлей, кнопка «Экран»)."""

    image: str  # data URL (data:image/jpeg;base64,...) или голый base64
    question: str = ""
    context: str | None = None  # транскрипт разговора, если идёт live
    mode: str = "general"
    # Язык ответов из настроек: "ru" | "en"; None/пусто — язык содержимого экрана.
    answer_language: str | None = None
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")

    model_config = {"populate_by_name": True}


class MeetingPayload(BaseModel):
    transcript: str
    mode: str = "deep"
    answer_language: str | None = None
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")

    model_config = {"populate_by_name": True}


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
        "spoken by engineers (e.g. deploy, pipeline, merge request)."
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
    correction_meta: dict = {}
    final_question = (payload.question or "").strip()

    try:
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
        # Python Knowledge Pack: only for pure-Python questions (not QA topics),
        # appended as a small auxiliary reference — never the whole source.
        knowledge_meta: dict = {"knowledgePackUsed": False}
        if detect_pack(resolved_q):
            kn_block, knowledge_meta = build_python_pack_injection(resolved_q)
            if kn_block:
                prompt = f"{prompt}\n\n{kn_block}"
        prompt += _weak_topics_block(payload.weak_topics)
        prompt += _answer_language_block(payload.answer_language)
        correction_meta.update(knowledge_meta)
        answer_started_at = time.perf_counter()
        messages = [
            {"role": "system", "content": LIVE_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        async for delta in provider_adapter.stream_chat(
            messages,
            provider,
            model,
            temperature=0.3,
            live_fast=True,
            route_fast=payload.fast_answer,
        ):
            parts.append(delta)
            yield f"data: {json.dumps({'type': 'chunk', 'text': delta}, ensure_ascii=False)}\n\n"
        correction_meta["answerLatencyWithKnowledgeMs"] = int(
            (time.perf_counter() - answer_started_at) * 1000
        )
    except Exception as exc:  # noqa: BLE001
        err_msg = getattr(exc, "message", str(exc))

    spoken = "".join(parts).strip()
    final_spoken = spoken
    if spoken:
        parsed = _parse_fast_response(spoken)
        # Live answers are Say-aloud: sanitize, then enforce the spoken word cap.
        final_spoken = trim_spoken_answer(sanitize_live_answer(parsed.get("spoken") or spoken))

    if err_msg and not final_spoken:
        yield f"data: {json.dumps({'type': 'error', 'message': err_msg}, ensure_ascii=False)}\n\n"
    else:
        answer_id = None
        if db and final_spoken:
            try:
                answer_id = _persist_stream_answer(
                    db,
                    session_id=payload.session_id,
                    question=final_question,
                    spoken=final_spoken,
                    model=model,
                    provider=provider,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to persist stream answer: %s", exc)
        done_payload = {
            "type": "done",
            "id": answer_id,
            "model": model,
            "model_source": source,
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
        messages, provider, model, max_tokens=max_tokens, temperature=temperature
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
        messages, provider, model, max_tokens=600, temperature=0.3
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
    db = SessionLocal()
    try:
        resume = _clip(rag_service.get_context_text(db, "resume"), RESUME_CONTEXT_LIMIT)
        vacancy = _clip(rag_service.get_context_text(db, "vacancy"), VACANCY_CONTEXT_LIMIT)
        legend = _clip(rag_service.get_context_text(db, "legend"), LEGEND_CONTEXT_LIMIT)
        profile_block = get_profile_block(db)
    except Exception:
        db.close()
        raise

    provider, model, source = _resolve_chat(
        "fast",
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

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
                db=db,
            ):
                yield line
        finally:
            db.close()

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
    summary = await provider_adapter.complete(messages, provider, model, max_tokens=900)
    db.add(_chat_usage(provider, prompt, summary))
    db.commit()
    return {"summary": summary, "model": model, "model_source": source}


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
    review = await provider_adapter.complete(messages, provider, model, max_tokens=1400)
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


# Скриншот в base64: ~8 МБ достаточно для FullHD JPEG, больше — защита от абьюза.
MAX_SCREEN_IMAGE_CHARS = 8_000_000

SCREEN_ASSIST_PROMPT = (
    "Ты — ассистент кандидата на техническом собеседовании. Тебе дают скриншот "
    "его экрана и, возможно, транскрипт разговора. На экране почти всегда "
    "ЗАДАНИЕ: SQL-запрос, задача на Python (или другом языке) либо текстовая "
    "формулировка, что нужно сделать. Не пересказывай экран — сразу помогай решить.\n\n"
    "Формат ответа, если это код/задача:\n"
    "1) Сначала 1–3 короткие фразы простыми словами — ЛОГИКА решения, как ты бы "
    "объяснил вслух, что делаешь и почему (чтобы кандидат надиктовал своими словами).\n"
    "2) Потом сразу решение одним блоком кода. К КАЖДОЙ строке добавь короткий "
    "комментарий на языке этого кода (# для Python, -- для SQL), что делает строка — "
    "чтобы можно было читать, писать и диктовать построчно.\n"
    "3) Если на экране не код, а текстовый вопрос/задача — дай прямой готовый ответ "
    "от первого лица, без вступлений.\n\n"
    "НЕ начинай с «На экране…»/«Задание звучит так…» — сразу к делу. Отвечай на "
    "языке содержимого экрана (обычно русский), кратко и по делу."
)


@router.post("/chat/screen/stream")
async def screen_assist_stream(payload: ScreenAssistPayload, db: Session = Depends(get_db)):
    """Vision: скриншот экрана + вопрос → стриминговая подсказка (SSE)."""
    _ensure_quota(db)
    image = payload.image.strip()
    if not image:
        raise AppError("Пустой скриншот", 400, "empty_image")
    if len(image) > MAX_SCREEN_IMAGE_CHARS:
        raise AppError("Скриншот слишком большой", 413, "image_too_large")
    if not image.startswith("data:image/"):
        image = f"data:image/jpeg;base64,{image}"

    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

    user_text = payload.question.strip() or "Что на экране? Помоги с этим."
    if payload.context:
        user_text += f"\n\nТранскрипт разговора (для контекста):\n{_clip(payload.context, 2000)}"
    user_text += _answer_language_block(payload.answer_language)

    messages: list[dict] = [
        {"role": "system", "content": SCREEN_ASSIST_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": image}},
            ],
        },
    ]
    # Изображение стоит дорого (~1–1.5k токенов) — фиксируем расход заранее.
    db.add(_chat_usage(provider, user_text + " " * 4000))
    db.commit()

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


def _parse_fast_response(raw: str) -> dict:
    """Live-режим: plain text / markdown, без обрезки."""
    empty = {"short": "", "spoken": "", "detailed": "", "english": "", "risk": ""}
    text = raw.strip()

    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()

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
