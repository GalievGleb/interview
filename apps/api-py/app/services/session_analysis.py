from __future__ import annotations

import hashlib
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


class AnswerReview(BaseModel):
    question: str = Field(min_length=2, max_length=800)
    candidateAnswer: str = Field(min_length=2, max_length=2_500)
    topic: str = Field(min_length=2, max_length=120)
    score: int = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)
    whatWasGood: list[str] = Field(default_factory=list, max_length=6)
    problems: list[str] = Field(default_factory=list, max_length=8)
    missingPoints: list[str] = Field(default_factory=list, max_length=8)
    betterAnswer: str = Field(min_length=2, max_length=2_500)


class SessionAssessmentPayload(BaseModel):
    analysisVersion: Literal[2] = 2
    interviewType: Literal["technical", "hr", "mixed", "unknown"]
    overallLevel: str = Field(min_length=2, max_length=40)
    overallScore: int = Field(ge=0, le=100)
    overallConfidence: float = Field(ge=0, le=1)
    conclusion: str = Field(min_length=2, max_length=800)
    strengths: list[TopicEvidence] = Field(max_length=8)
    weaknesses: list[WeakTopicEvidence] = Field(max_length=8)
    topicAssessments: list[TopicAssessment] = Field(min_length=1, max_length=16)
    answerReviews: list[AnswerReview] = Field(default_factory=list, max_length=16)
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


def _append_bullets(lines: list[str], values: list[str]) -> None:
    lines.extend(f"- {value.strip()}" for value in values if value.strip())


def _render_markdown(result: SessionAssessmentPayload, language: str) -> SessionAssessmentPayload:
    """Build the visible report from structured evidence instead of trusting a vague free-form recap."""
    ru = language == "ru"
    labels = (
        {
            "title": "Итог по реальным ответам",
            "level": "Уровень",
            "score": "Оценка",
            "confidence": "уверенность",
            "answers": "Разбор вопросов и ваших ответов",
            "answer": "Что вы ответили",
            "good": "Что получилось хорошо",
            "problems": "Ошибки и неточности",
            "missing": "Чего не хватило",
            "better": "Как ответить сильнее",
            "strengths": "Подтверждённые сильные стороны",
            "growth": "Пробелы и зоны роста",
            "action": "Что сделать",
        }
        if ru
        else {
            "title": "Assessment of your actual answers",
            "level": "Level",
            "score": "Score",
            "confidence": "confidence",
            "answers": "Questions and your answers",
            "answer": "What you actually said",
            "good": "What worked",
            "problems": "Errors and inaccuracies",
            "missing": "What was missing",
            "better": "A stronger answer",
            "strengths": "Confirmed strengths",
            "growth": "Knowledge gaps and growth areas",
            "action": "Next action",
        }
    )
    lines = [
        f"## {labels['title']}",
        "",
        result.conclusion.strip(),
        "",
        f"**{labels['level']}:** {result.overallLevel} · "
        f"**{labels['score']}:** {result.overallScore}/100 · "
        f"**{labels['confidence']}:** {round(result.overallConfidence * 100)}%",
    ]
    if result.answerReviews:
        lines.extend(["", f"## {labels['answers']}"])
        for index, review in enumerate(result.answerReviews, start=1):
            lines.extend(
                [
                    "",
                    f"### {index}. {review.question.strip()}",
                    "",
                    f"**{labels['answer']}:** {review.candidateAnswer.strip()}",
                    "",
                    f"**{labels['score']}:** {review.score}/100 · "
                    f"**{labels['confidence']}:** {round(review.confidence * 100)}%",
                ]
            )
            if review.whatWasGood:
                lines.extend(["", f"**{labels['good']}:**"])
                _append_bullets(lines, review.whatWasGood)
            if review.problems:
                lines.extend(["", f"**{labels['problems']}:**"])
                _append_bullets(lines, review.problems)
            if review.missingPoints:
                lines.extend(["", f"**{labels['missing']}:**"])
                _append_bullets(lines, review.missingPoints)
            lines.extend(["", f"**{labels['better']}:** {review.betterAnswer.strip()}"])
    if result.strengths:
        lines.extend(["", f"## {labels['strengths']}"])
        _append_bullets(
            lines,
            [f"**{item.topic}:** {item.evidence}" for item in result.strengths],
        )
    if result.weaknesses:
        lines.extend(["", f"## {labels['growth']}"])
        _append_bullets(
            lines,
            [
                f"**{item.topic}:** {item.evidence} **{labels['action']}:** {item.learningAction}"
                for item in result.weaknesses
            ],
        )
    result.markdown = "\n".join(lines)[:12_000]
    return result


def _finalize_analysis(
    result: SessionAssessmentPayload,
    language: str,
    roles_ambiguous: bool,
) -> SessionAssessmentPayload:
    return _apply_role_ambiguity(_render_markdown(result, language), language, roles_ambiguous)


def _ordered_transcript_lines(session: InterviewSession):
    return [
        item
        for item in sorted(session.transcripts, key=lambda item: (item.ts, item.id))
        if item.text.strip()
    ]


def session_analysis_source_fingerprint(session: InterviewSession, language: str) -> str:
    """Stable identity of the exact persisted evidence used by the assessment."""
    source = {
        "language": language,
        "transcript": [
            {"speaker": item.speaker, "text": item.text.strip()}
            for item in _ordered_transcript_lines(session)
        ],
    }
    encoded = json.dumps(
        source,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _transcript_context(session: InterviewSession) -> tuple[str, bool]:
    lines = _ordered_transcript_lines(session)
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
    for review in result.answerReviews:
        review.confidence = min(review.confidence, 0.35)
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

The transcript is the only source of truth. "Кандидат"/"Candidate" lines are what the
user actually said. Never use, reconstruct, or evaluate an AI-generated suggested answer.
Build answerReviews for every substantial interviewer question that has an attributable
candidate reply. In candidateAnswer, preserve what the candidate really said; do not replace
it with an ideal answer. For each review:
- judge whether the reply directly answered the question;
- name concrete technical or factual errors in problems (never write only "be clearer");
- put absent but expected details in missingPoints, without claiming they were said;
- make betterAnswer a stronger version that preserves the candidate's supported facts;
- keep confidence low when the question/answer pairing or speech recognition is uncertain.
The overall conclusion and topic scores must be derived primarily from answerReviews.
Do not award a skill based on an interviewer statement or on an unanswered question.

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
        return _finalize_analysis(_validate_analysis(raw), language, roles_ambiguous)
    except (ValidationError, ValueError) as first_error:
        repair_prompt = f"""Repair the invalid response so it matches the required JSON schema.
Return exactly one corrected JSON object and no commentary.
Use only evidence from the persisted transcript; remove or correct every unsupported claim.
Only Candidate lines are the user's actual answers. Populate answerReviews from those lines;
never substitute a generated or ideal answer into candidateAnswer.

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
            return _finalize_analysis(_validate_analysis(repaired), language, roles_ambiguous)
        except (ValidationError, ValueError) as repair_error:
            raise AppError(
                "Не удалось получить корректный разбор сессии",
                502,
                "invalid_session_analysis",
            ) from repair_error
