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
    _ensure_vacancy_quota(db)
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
- Prefer supported résumé facts, but when a low-risk personal preference or informal history is unknown, provide one conservative, plausible first-person example as a useful starting point.
- A hypothesis MUST have canAutoFill=false and reason must say that the user needs to verify it.
- Do not invent employers, commercial projects, dates, duration, metrics, credentials, legal status, location, salary, work authorization, or contractual commitments.
- For unknown legal, location, compensation, schedule, relocation, or contract facts, return an empty answer and ask for confirmation rather than guessing.
- Keep a hypothetical draft natural and specific enough to edit; do not use placeholders or coaching instructions inside the answer."""
        if payload.draftMode
        else """AUTOMATIC MODE — every answer may be sent without another review.
- If a factual answer is not supported by the supplied sources, return an empty answer, set canAutoFill=false, and explain the missing fact in reason. Do not guess."""
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
    except TimeoutError as exc:
        logger.warning(
            "Screening answer generation exceeded %.1fs deadline",
            deadline,
        )
        raise AppError(
            "Провайдер не успел подготовить ответы. Повторите позже.",
            504,
            "provider_timeout",
        ) from exc
    except AppError as exc:
        logger.warning(
            "Screening answer generation failed (%s, HTTP %s): %s",
            exc.code,
            exc.status_code,
            exc.message,
        )
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Screening answer generation failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)
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
        can_auto_fill = bool(answer_item.get("canAutoFill", False))
        if normalized_question["kind"] == "text" and not answer_text:
            can_auto_fill = False
        if normalized_question["kind"] != "text" and not selected:
            can_auto_fill = False
        answers.append(
            {
                "id": normalized_question["id"],
                "answer": answer_text,
                "selectedOptions": selected,
                "canAutoFill": can_auto_fill,
                "reason": str(answer_item.get("reason", "")).strip()[:300],
                "preparationNote": str(answer_item.get("preparationNote", "")).strip()[:500],
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
