from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import ApiUsage, InterviewSession
from app.services import model_router, provider_adapter, quota
from app.services.preferences import load_preferences


class TopicEvidence(BaseModel):
    topic: str = Field(min_length=2, max_length=120)
    evidence: str = Field(min_length=2, max_length=500)


class WeakTopicEvidence(TopicEvidence):
    learningAction: str = Field(min_length=2, max_length=500)


class TopicAssessment(BaseModel):
    topic: str = Field(min_length=2, max_length=120)
    score: int = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)


class SessionAssessmentPayload(BaseModel):
    interviewType: Literal["technical", "hr", "mixed", "unknown"]
    overallLevel: str = Field(min_length=2, max_length=40)
    overallScore: int = Field(ge=0, le=100)
    overallConfidence: float = Field(ge=0, le=1)
    conclusion: str = Field(min_length=2, max_length=800)
    strengths: list[TopicEvidence] = Field(max_length=8)
    weaknesses: list[WeakTopicEvidence] = Field(max_length=8)
    topicAssessments: list[TopicAssessment] = Field(min_length=1, max_length=16)
    markdown: str = Field(min_length=2, max_length=12_000)


def _extract_first_json_object(raw: str) -> dict:
    decoder = json.JSONDecoder()
    for index, character in enumerate(raw or ""):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(raw[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("response does not contain a JSON object")


def _validate_analysis(raw: str) -> SessionAssessmentPayload:
    return SessionAssessmentPayload.model_validate(_extract_first_json_object(raw))


def _transcript_context(session: InterviewSession) -> tuple[str, bool]:
    lines = [
        item for item in sorted(session.transcripts, key=lambda item: item.ts) if item.text.strip()
    ]
    speakers = {item.speaker for item in lines}
    roles_ambiguous = speakers != {"other", "me"}
    if roles_ambiguous:
        speaker_labels = {
            "other": "Участник (канал other, роль не подтверждена)",
            "me": "Участник (канал me, роль не подтверждена)",
        }
    else:
        speaker_labels = {"other": "Интервьюер", "me": "Кандидат"}
    transcript = "\n".join(
        f"{speaker_labels.get(item.speaker, 'Участник (роль не подтверждена)')}: "
        f"{item.text.strip()}"
        for item in lines
    )
    return transcript, roles_ambiguous


def _role_contract(roles_ambiguous: bool) -> str:
    if not roles_ambiguous:
        return ""
    return """
ROLE ATTRIBUTION WARNING: role attribution is ambiguous because the transcript
contains only one audio channel. Do not assume that this channel is the candidate,
and do not treat questions as candidate answers. Use only clearly answer-like
evidence, state the ambiguity in the conclusion and Markdown, and keep every topic
confidence at or below 0.35.
"""


def _apply_role_ambiguity(
    result: SessionAssessmentPayload,
    language: str,
    roles_ambiguous: bool,
) -> SessionAssessmentPayload:
    if not roles_ambiguous:
        return result
    warning = (
        "⚠ Роли участников не подтверждены: записан только один аудиоканал, "
        "поэтому вопросы и ответы нельзя разделить надёжно."
        if language == "ru"
        else "⚠ Participant roles are unverified because only one audio channel was recorded."
    )
    result.conclusion = f"{warning} {result.conclusion}"[:800]
    result.markdown = f"> {warning}\n\n{result.markdown}"[:12_000]
    result.overallConfidence = min(result.overallConfidence, 0.35)
    for topic in result.topicAssessments:
        topic.confidence = min(topic.confidence, 0.35)
    return result


def _record_usage(
    db: Session,
    provider: str,
    prompt: str,
    completion: str,
) -> None:
    usage = provider_adapter.pop_last_usage() or {}
    db.add(
        ApiUsage(
            provider=provider,
            kind="session_analysis",
            tokens_in=int(usage.get("prompt_tokens") or 0) or max(1, len(prompt) // 4),
            tokens_out=int(usage.get("completion_tokens") or 0) or max(1, len(completion) // 4),
        )
    )
    db.commit()


def _language_contract(language: str) -> str:
    if language == "ru":
        return (
            "Пиши весь обычный текст по-русски. Названия API, библиотек, команд и "
            "фрагменты кода оставляй в общепринятом техническом написании."
        )
    if language == "en":
        return "Write all prose and Markdown headings in English."
    return "Use the dominant language of the transcript for prose and headings."


def _resolve_deep_model() -> tuple[str, str]:
    preferences = load_preferences()
    available = {item.id for item in preferences.models_cache}
    model, _ = model_router.resolve_model(
        "deep",
        prefs=preferences,
        available=available,
    )
    return preferences.provider or "openrouter", model


async def analyze_session(
    db: Session,
    session: InterviewSession,
    language: str,
) -> SessionAssessmentPayload:
    transcript, roles_ambiguous = _transcript_context(session)
    schema = json.dumps(SessionAssessmentPayload.model_json_schema(), ensure_ascii=False)
    provider, model = _resolve_deep_model()
    prompt = f"""Analyze this interview using only the persisted transcript below.
Do not infer facts, skills, answers, or evidence that are absent from it.

{_language_contract(language)}
{_role_contract(roles_ambiguous)}

Classify the interview as technical, hr, mixed, or unknown in interviewType.
- technical: professional knowledge, engineering decisions, coding, QA methods, or architecture;
- hr: availability, motivation, compensation, work history, self-presentation, or culture fit;
- mixed: substantial evidence from both technical and HR blocks;
- unknown: the transcript is too short or roles/content are too ambiguous.
Do not score missing technical topics in an HR interview. For HR interviews assess only
communication, clarity and consistency of experience, motivation, and self-presentation
that are directly present. overallScore is the evidence-weighted quality of the candidate's
observed answers, not a guess about unasked competencies. overallConfidence reflects how
much attributable candidate evidence is actually present.

Return exactly one JSON object matching this schema:
<JSON_SCHEMA>
{schema}
</JSON_SCHEMA>

Every strength, weakness, conclusion, score, and learning action must be grounded
in the transcript. Confidence must reflect how directly the transcript supports the score.

<TRANSCRIPT>
{transcript}
</TRANSCRIPT>
"""
    messages = [
        {
            "role": "system",
            "content": "You are a rigorous interview assessor. Return valid JSON only.",
        },
        {"role": "user", "content": prompt},
    ]
    raw = await provider_adapter.complete(
        messages,
        provider,
        model,
        max_tokens=2400,
        temperature=0.2,
    )
    _record_usage(db, provider, prompt, raw)
    try:
        return _apply_role_ambiguity(_validate_analysis(raw), language, roles_ambiguous)
    except (ValidationError, ValueError) as first_error:
        repair_prompt = f"""Repair the invalid response so it matches the required JSON schema.
Return exactly one corrected JSON object and no commentary.
Use only evidence from the persisted transcript; remove or correct every unsupported claim.

{_language_contract(language)}
{_role_contract(roles_ambiguous)}

<TRANSCRIPT>
{transcript}
</TRANSCRIPT>

<INVALID_RESPONSE>
{raw}
</INVALID_RESPONSE>

<VALIDATION_ERROR>
{first_error}
</VALIDATION_ERROR>

<JSON_SCHEMA>
{schema}
</JSON_SCHEMA>
"""
        quota.check_token_quota(db)
        repaired = await provider_adapter.complete(
            [{"role": "user", "content": repair_prompt}],
            provider,
            model,
            max_tokens=2400,
            temperature=0,
        )
        _record_usage(db, provider, repair_prompt, repaired)
        try:
            return _apply_role_ambiguity(_validate_analysis(repaired), language, roles_ambiguous)
        except (ValidationError, ValueError) as repair_error:
            raise AppError(
                "Не удалось получить корректный разбор сессии",
                502,
                "invalid_session_analysis",
            ) from repair_error
