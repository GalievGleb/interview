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
from app.prompts.meeting import INTERVIEW_REVIEW_PROMPT, MEETING_PROMPT
from app.prompts.system import SYSTEM_PROMPT
from app.services import model_router, provider_adapter, rag_service, transcript_correction
from app.services.domain_answer_hints import resolve_domain_answer_hints
from app.services.knowledge_pack import build_injection as build_python_pack_injection
from app.services.knowledge_pack import is_python_question
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
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")
    session_id: str | None = None

    model_config = {"populate_by_name": True}


class MeetingPayload(BaseModel):
    transcript: str
    mode: str = "deep"
    provider: str | None = None
    model: str | None = None
    model_override: str | None = Field(default=None, alias="modelOverride")

    model_config = {"populate_by_name": True}


class AnswerVariantPayload(BaseModel):
    question: str
    answer: str
    variant: str  # short | detailed | english | risk
    answer_id: str | None = None  # если задан — вариант кэшируется в БД
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
    glossary = (payload.glossary_corrected or payload.question or raw).strip()
    intent = (payload.intent_corrected or payload.question or glossary).strip()
    resolved = (payload.resolved_follow_up_question or "").strip()
    meta: dict = {
        "raw_question": raw,
        "glossary_corrected": glossary,
        "intent_corrected": intent,
        "llm_corrected": intent,
        "resolved_follow_up_question": resolved or None,
        "previous_topic": payload.previous_topic,
        "used_previous_context": payload.used_previous_context,
        "is_follow_up": payload.is_follow_up,
        "follow_up_reason": payload.follow_up_reason,
        "current_canonical_topic": payload.current_canonical_topic,
        "ambiguity": payload.ambiguity,
        "corrections": payload.corrections or [],
        "intent_corrections": payload.intent_corrections or [],
        "intent_confidence": payload.intent_confidence,
        "intent_reason": payload.intent_reason,
        "llm_correction_applied": False,
    }

    final = resolved if payload.used_previous_context and resolved else intent
    # Fast mode (default): skip the serial LLM correction round-trip and rely on
    # the deterministic glossary. Turn it off for the slower, more robust pass.
    if not payload.fast_answer and transcript_correction.should_llm_correct(
        raw_question=raw,
        glossary_corrected=glossary,
        corrections=payload.corrections,
        needs_llm_correction=payload.needs_llm_correction,
    ):
        llm_result = await transcript_correction.llm_correct_transcript(raw, intent)
        corrected = str(llm_result.get("corrected") or intent).strip()
        if corrected:
            final = corrected
            meta["llm_corrected"] = corrected
            meta["llm_correction_applied"] = True
            meta["llm_confidence"] = llm_result.get("confidence")
            meta["llm_reason"] = llm_result.get("reason")

    return final, raw, glossary, meta


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
    db.add(ApiUsage(provider=provider, kind="chat"))
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
        if is_python_question(resolved_q):
            kn_block, knowledge_meta = build_python_pack_injection(resolved_q)
            if kn_block:
                prompt = f"{prompt}\n\n{kn_block}"
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
    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model_override=payload.model_override,
    )

    context_chunks = await rag_service.search(db, payload.message, top_k=5)
    context = payload.context or "\n\n".join(c["text"] for c in context_chunks)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if context:
        messages.append({"role": "system", "content": f"User context (retrieved):\n{context}"})
    messages.append({"role": "user", "content": payload.message})

    async def event_stream():
        try:
            async for delta in provider_adapter.stream_chat(messages, provider, model):
                yield f"data: {json.dumps({'type': 'chunk', 'text': delta})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'model': model})}\n\n"
        except Exception as exc:
            msg = getattr(exc, "message", str(exc))
            yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"

    db.add(ApiUsage(provider=provider, kind="chat"))
    db.commit()
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/chat/interview")
async def interview(payload: InterviewPayload, db: Session = Depends(get_db)) -> dict:
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
        if is_python_question(payload.question):
            kn_block, _ = build_python_pack_injection(payload.question)
            if kn_block:
                prompt = f"{prompt}\n\n{kn_block}"
        max_tokens = 900
        temperature = 0.4

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
    db.add(ApiUsage(provider=provider, kind="chat"))
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
    """Ленивая генерация варианта ответа (short/detailed/english/risk) по клику на таб."""
    instruction = _VARIANT_PROMPTS.get(payload.variant)
    if not instruction:
        raise AppError("variant must be one of: short, detailed, english, risk", 400, "invalid_variant")

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
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    text = await provider_adapter.complete(messages, provider, model, max_tokens=600, temperature=0.3)
    result = text.strip()
    if answer_row is not None and result:
        setattr(answer_row, column, result)
    db.add(ApiUsage(provider=provider, kind="chat"))
    db.commit()
    return {"text": result, "model": model, "model_source": source, "variant": payload.variant}


@router.post("/chat/interview/stream")
async def interview_stream(payload: InterviewPayload):
    """SSE-стрим live-подсказки — первые токены сразу."""
    db = SessionLocal()
    try:
        resume = _clip(rag_service.get_context_text(db, "resume"), RESUME_CONTEXT_LIMIT)
        vacancy = _clip(rag_service.get_context_text(db, "vacancy"), VACANCY_CONTEXT_LIMIT)
        legend = _clip(rag_service.get_context_text(db, "legend"), LEGEND_CONTEXT_LIMIT)
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
    provider, model, source = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

    prompt = MEETING_PROMPT.format(transcript=payload.transcript)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    summary = await provider_adapter.complete(messages, provider, model, max_tokens=900)
    db.add(ApiUsage(provider=provider, kind="chat"))
    db.commit()
    return {"summary": summary, "model": model, "model_source": source}


@router.post("/chat/interview-review")
async def interview_review(payload: MeetingPayload, db: Session = Depends(get_db)) -> dict:
    """Разбор записи интервью: находит слабые/проблемные ответы кандидата."""
    provider, model, source = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )

    prompt = INTERVIEW_REVIEW_PROMPT.format(transcript=payload.transcript)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    review = await provider_adapter.complete(messages, provider, model, max_tokens=1400)
    db.add(ApiUsage(provider=provider, kind="chat"))
    db.commit()
    return {"review": review, "model": model, "model_source": source}


@router.post("/chat/interview-review/stream")
async def interview_review_stream(payload: MeetingPayload):
    """Streaming (SSE) interview review — renders progressively in the UI."""
    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    prompt = INTERVIEW_REVIEW_PROMPT.format(transcript=payload.transcript)
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
async def meeting_summary_stream(payload: MeetingPayload):
    """Streaming (SSE) meeting summary — renders progressively in the UI."""
    provider, model, _ = _resolve_chat(
        payload.mode,
        provider=payload.provider,
        model=payload.model,
        model_override=payload.model_override,
    )
    prompt = MEETING_PROMPT.format(transcript=payload.transcript)
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
