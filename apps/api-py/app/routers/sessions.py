import json
import math
import re
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import InterviewSession, SessionAssessment, SessionDiagnostic, Transcript
from app.db.session import get_db
from app.services import quota
from app.services.session_analysis import analyze_session, session_analysis_source_fingerprint
from app.services.session_mutation_lock import (
    async_session_mutation_lock,
    session_mutation_lock,
    session_mutation_locks,
)

router = APIRouter(prefix="/sessions", tags=["sessions"])

MAX_SESSION_DIAGNOSTICS_BYTES = 1_000_000


def _naive_utc_now() -> datetime:
    # БД хранит наивный UTC — сохраняем формат, избегая deprecated utcnow().
    return datetime.now(UTC).replace(tzinfo=None)


def _session_is_empty(session: InterviewSession) -> bool:
    return len(session.answers) == 0 and len(session.transcripts) == 0


def _session_has_content(session: InterviewSession) -> bool:
    return not _session_is_empty(session) or bool(session.summary)


class CreateSessionPayload(BaseModel):
    mode: str  # interview | meeting
    title: str | None = None


@router.post("")
def create_session(payload: CreateSessionPayload, db: Session = Depends(get_db)) -> dict:
    if payload.mode not in {"interview", "meeting"}:
        raise AppError("mode must be interview or meeting", 400, "invalid_mode")
    s = InterviewSession(mode=payload.mode, title=payload.title)
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"id": s.id, "mode": s.mode, "title": s.title, "started_at": s.started_at.isoformat()}


@router.get("")
def list_sessions(db: Session = Depends(get_db)) -> dict:
    rows = db.query(InterviewSession).order_by(InterviewSession.started_at.desc()).all()
    return {
        "sessions": [
            {
                "id": s.id,
                "mode": s.mode,
                "title": s.title,
                "started_at": s.started_at.isoformat(),
                "ended_at": s.ended_at.isoformat() if s.ended_at else None,
                "answer_count": len(s.answers),
                "transcript_count": len(s.transcripts),
            }
            for s in rows
            if _session_has_content(s)
        ]
    }


# Слова, не несущие темы вопроса, — отфильтровываем при подсчёте частых тем.
_TOPIC_STOPWORDS = {
    "как",
    "что",
    "чем",
    "почему",
    "зачем",
    "какие",
    "какой",
    "какая",
    "когда",
    "где",
    "расскажи",
    "расскажите",
    "объясни",
    "объясните",
    "можно",
    "нужно",
    "есть",
    "было",
    "быть",
    "это",
    "или",
    "для",
    "при",
    "про",
    "вам",
    "вас",
    "она",
    "оно",
    "они",
    "его",
    "еще",
    "ещё",
    "уже",
    "если",
    "чтобы",
    "такое",
    "работает",
    "используете",
    "делали",
    "the",
    "and",
    "you",
    "your",
    "how",
    "what",
    "why",
    "when",
    "where",
    "does",
    "did",
    "with",
    "for",
    "are",
    "was",
    "have",
    "has",
}


@router.get("/stats")
def session_stats(db: Session = Depends(get_db)) -> dict:
    """Агрегаты по истории для дашборда: счётчики, активность, частые темы вопросов."""
    rows = db.query(InterviewSession).all()
    kept = [s for s in rows if _session_has_content(s)]
    interviews = [s for s in kept if s.mode == "interview"]
    meetings = [s for s in kept if s.mode == "meeting"]
    answers = [a for s in interviews for a in s.answers]

    topic_counts: dict[str, int] = {}
    for a in answers:
        for word in (a.question or "").lower().replace("?", " ").replace(",", " ").split():
            token = word.strip(".!:;()«»\"'")
            if len(token) < 4 or token in _TOPIC_STOPWORDS:
                continue
            topic_counts[token] = topic_counts.get(token, 0) + 1
    top_topics = sorted(topic_counts.items(), key=lambda kv: kv[1], reverse=True)[:8]

    last_session_at = None
    for s in kept:
        if last_session_at is None or s.started_at > last_session_at:
            last_session_at = s.started_at

    return {
        "interview_sessions": len(interviews),
        "meeting_sessions": len(meetings),
        "total_answers": len(answers),
        "avg_answers_per_session": (round(len(answers) / len(interviews), 1) if interviews else 0),
        "last_session_at": last_session_at.isoformat() if last_session_at else None,
        "top_topics": [{"topic": t, "count": c} for t, c in top_topics if c > 1],
    }


@router.get("/knowledge-map")
def session_knowledge_map(db: Session = Depends(get_db)) -> dict:
    grouped: dict[str, dict] = {}
    for row in db.query(SessionAssessment).order_by(SessionAssessment.created_at).all():
        assessment = json.loads(row.analysis_json)
        # HR conversations describe communication and work-history presentation,
        # not technical readiness. Keep them in personal progress but never let
        # them distort the technical knowledge map used by live prompts.
        if assessment.get("interviewType", "technical") not in {"technical", "mixed"}:
            continue
        for item in assessment.get("topicAssessments", []):
            topic = str(item["topic"]).strip()
            confidence = float(item["confidence"])
            # A single-channel session is deliberately capped at 0.35 because
            # speaker roles are unverified. Low-confidence evidence remains in
            # the saved analysis but must not steer future live prompts.
            if confidence < 0.5:
                continue
            key = topic.casefold()
            bucket = grouped.setdefault(
                key,
                {
                    "topic": topic,
                    "scores": [],
                    "confidences": [],
                },
            )
            bucket["scores"].append(float(item["score"]))
            bucket["confidences"].append(confidence)

    topics = []
    for bucket in grouped.values():
        scores = bucket["scores"]
        confidences = bucket["confidences"]
        total_confidence = sum(confidences)
        if total_confidence:
            score = round(
                sum(value * confidence for value, confidence in zip(scores, confidences))
                / total_confidence
            )
        else:
            score = round(sum(scores) / len(scores))
        topics.append(
            {
                "topic": bucket["topic"],
                "score": score,
                "confidence": round(sum(confidences) / len(confidences), 2),
                "evidenceCount": len(scores),
            }
        )

    topics.sort(key=lambda item: (item["score"], item["topic"].casefold()))
    return {
        "weakTopics": [topic for topic in topics if topic["score"] < 70][:12],
        "strongTopics": [topic for topic in reversed(topics) if topic["score"] >= 70][:12],
        "updatedAt": _naive_utc_now().isoformat(),
    }


def _assessment_score(assessment: dict) -> int:
    explicit = assessment.get("overallScore")
    if isinstance(explicit, (int, float)):
        return max(0, min(100, round(explicit)))
    topics = assessment.get("topicAssessments") or []
    weighted = [
        (float(item.get("score", 0)), max(0.0, float(item.get("confidence", 0))))
        for item in topics
        if isinstance(item, dict)
    ]
    total = sum(confidence for _, confidence in weighted)
    if total:
        return round(sum(score * confidence for score, confidence in weighted) / total)
    if weighted:
        return round(sum(score for score, _ in weighted) / len(weighted))
    return 0


def _assessment_confidence(assessment: dict) -> float:
    explicit = assessment.get("overallConfidence")
    if isinstance(explicit, (int, float)):
        return max(0.0, min(1.0, round(float(explicit), 2)))
    topics = assessment.get("topicAssessments") or []
    values = [
        max(0.0, min(1.0, float(item.get("confidence", 0))))
        for item in topics
        if isinstance(item, dict)
    ]
    return round(sum(values) / len(values), 2) if values else 0.0


def _build_development_track(entries: list[dict]) -> dict:
    if not entries:
        return {
            "level": None,
            "score": None,
            "confidence": 0,
            "evidenceCount": 0,
            "strengths": [],
            "focusAreas": [],
        }

    score_weight = sum(max(0.05, item["confidence"]) for item in entries)
    score = round(
        sum(item["score"] * max(0.05, item["confidence"]) for item in entries) / score_weight
    )
    confidence = round(sum(item["confidence"] for item in entries) / len(entries), 2)

    grouped: dict[str, dict] = {}
    for entry in entries:
        assessment = entry["assessment"]
        actions = {
            str(item.get("topic", "")).strip().casefold(): str(
                item.get("learningAction", "")
            ).strip()
            for item in assessment.get("weaknesses", [])
            if isinstance(item, dict) and str(item.get("topic", "")).strip()
        }
        for item in assessment.get("topicAssessments", []):
            if not isinstance(item, dict):
                continue
            topic = str(item.get("topic", "")).strip()
            item_confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
            if not topic or item_confidence < 0.5:
                continue
            key = topic.casefold()
            bucket = grouped.setdefault(
                key,
                {
                    "topic": topic,
                    "weightedScore": 0.0,
                    "weight": 0.0,
                    "confidences": [],
                    "evidenceCount": 0,
                    "learningAction": "",
                },
            )
            bucket["weightedScore"] += float(item.get("score", 0)) * item_confidence
            bucket["weight"] += item_confidence
            bucket["confidences"].append(item_confidence)
            bucket["evidenceCount"] += 1
            if actions.get(key):
                bucket["learningAction"] = actions[key]

    topics = [
        {
            "topic": bucket["topic"],
            "score": round(bucket["weightedScore"] / bucket["weight"]),
            "confidence": round(sum(bucket["confidences"]) / len(bucket["confidences"]), 2),
            "evidenceCount": bucket["evidenceCount"],
            "learningAction": bucket["learningAction"] or None,
        }
        for bucket in grouped.values()
        if bucket["weight"]
    ]
    strengths = sorted(
        (item for item in topics if item["score"] >= 70),
        key=lambda item: (-item["score"], item["topic"].casefold()),
    )[:6]
    focus_areas = sorted(
        (item for item in topics if item["score"] < 70),
        key=lambda item: (item["score"], item["topic"].casefold()),
    )[:6]
    latest = max(entries, key=lambda item: item["startedAt"])
    return {
        "level": latest["assessment"].get("overallLevel"),
        "score": score,
        "confidence": confidence,
        "evidenceCount": len(entries),
        "strengths": strengths,
        "focusAreas": focus_areas,
    }


def _recent_answer_evidence(entries: list[dict]) -> list[dict]:
    evidence: list[dict] = []
    for entry in sorted(entries, key=lambda item: item["startedAt"], reverse=True):
        for review in entry["assessment"].get("answerReviews", []):
            if not isinstance(review, dict):
                continue
            question = str(review.get("question", "")).strip()
            candidate_answer = str(review.get("candidateAnswer", "")).strip()
            if not question or not candidate_answer:
                continue
            evidence.append(
                {
                    "sessionId": entry["sessionId"],
                    "title": entry["title"],
                    "startedAt": entry["startedAt"],
                    "interviewType": entry["interviewType"],
                    "question": question,
                    "candidateAnswer": candidate_answer,
                    "topic": str(review.get("topic", "")).strip(),
                    "score": max(0, min(100, round(float(review.get("score", 0))))),
                    "confidence": max(0.0, min(1.0, round(float(review.get("confidence", 0)), 2))),
                    "problems": [
                        str(value).strip()
                        for value in review.get("problems", [])
                        if str(value).strip()
                    ][:8],
                    "missingPoints": [
                        str(value).strip()
                        for value in review.get("missingPoints", [])
                        if str(value).strip()
                    ][:8],
                    "betterAnswer": str(review.get("betterAnswer", "")).strip(),
                }
            )
            if len(evidence) >= 20:
                return evidence
    return evidence


@router.get("/development-profile")
def development_profile(db: Session = Depends(get_db)) -> dict:
    entries: list[dict] = []
    rows = db.query(SessionAssessment).order_by(SessionAssessment.created_at).all()
    for row in rows:
        try:
            assessment = json.loads(row.analysis_json)
        except (TypeError, json.JSONDecodeError):
            continue
        kind = assessment.get("interviewType", "technical")
        if kind not in {"technical", "hr", "mixed", "unknown"}:
            kind = "unknown"
        session = row.session
        entries.append(
            {
                "sessionId": row.session_id,
                "title": session.title if session else None,
                "startedAt": (
                    session.started_at.isoformat() if session else row.created_at.isoformat()
                ),
                "interviewType": kind,
                "overallLevel": assessment.get("overallLevel"),
                "score": _assessment_score(assessment),
                "confidence": _assessment_confidence(assessment),
                "assessment": assessment,
            }
        )

    technical = [item for item in entries if item["interviewType"] in {"technical", "mixed"}]
    hr = [item for item in entries if item["interviewType"] in {"hr", "mixed"}]
    recent = sorted(entries, key=lambda item: item["startedAt"], reverse=True)[:12]
    return {
        "analyzedSessions": len(entries),
        "technical": _build_development_track(technical),
        "hr": _build_development_track(hr),
        "recentSessions": [
            {key: value for key, value in item.items() if key != "assessment"} for item in recent
        ],
        "recentAnswers": _recent_answer_evidence(entries),
        "updatedAt": _naive_utc_now().isoformat(),
    }


@router.get("/{session_id}")
def get_session(session_id: str, db: Session = Depends(get_db)) -> dict:
    s = db.query(InterviewSession).filter(InterviewSession.id == session_id).first()
    if not s:
        raise AppError("Session not found", 404, "not_found")
    return {
        "id": s.id,
        "mode": s.mode,
        "title": s.title,
        "started_at": s.started_at.isoformat(),
        "ended_at": s.ended_at.isoformat() if s.ended_at else None,
        "summary": s.summary,
        "diagnostics": json.loads(s.diagnostic.payload_json) if s.diagnostic else None,
        "transcripts": [
            {"speaker": t.speaker, "text": t.text, "ts": t.ts.isoformat()}
            for t in sorted(s.transcripts, key=lambda x: x.ts)
        ],
        "answers": [
            {
                "id": a.id,
                "question": a.question,
                "short": a.answer_short,
                "spoken": a.answer_spoken,
                "detailed": a.answer_detailed,
                "english": a.answer_en,
                "risk": a.risk_note,
                "model": a.model,
                "ts": a.ts.isoformat(),
            }
            for a in sorted(s.answers, key=lambda x: x.ts)
        ],
    }


class SessionDiagnosticsPayload(BaseModel):
    model_config = {"extra": "allow"}

    schemaVersion: int = 1
    events: list[dict[str, Any]] = Field(default_factory=list)


_DIAGNOSTIC_EVENT_TYPES = {
    "session_start",
    "ready",
    "speech_started",
    "partial",
    "final",
    "low_quality",
    "answer_blocked",
    "answer_started",
    "answer_first_token",
    "answer_done",
    "source_warning",
    "source_recovered",
    "error",
}
_DATA_URL_RE = re.compile(
    r"(^|[^a-z0-9_-])data:[^,\s\"'<>]*,[^\s\"'<>]*",
    re.I,
)
_AUTH_RE = re.compile(r"\b(?:authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+", re.I)
_LABELLED_SECRET_RE = re.compile(
    r"\b(?:token|api[_-]?key|access[_-]?key|private[_-]?key|license[_-]?key|password|secret)"
    r"\s*[:=]\s*[^\s,;]+",
    re.I,
)
_COOKIE_RE = re.compile(r"\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+", re.I)
_RAW_BASE64_RE = re.compile(r"(^|[\s\"'=:])([A-Za-z0-9+/]{32,}={0,2})(?=$|[\s\"',;])", re.M)


def _diagnostic_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = _DATA_URL_RE.sub(
        lambda match: f"{match.group(1)}[OMITTED_DATA_URL]",
        value,
    )
    cleaned = _AUTH_RE.sub("[REDACTED]", cleaned)
    cleaned = _LABELLED_SECRET_RE.sub("[REDACTED]", cleaned)
    cleaned = _COOKIE_RE.sub("[REDACTED]", cleaned)
    cleaned = _RAW_BASE64_RE.sub(lambda match: f"{match.group(1)}[OMITTED_BASE64]", cleaned)
    return cleaned[:limit]


def _diagnostic_number(value: Any) -> int | float | None:
    return (
        value
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        else None
    )


def _put_if(target: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        target[key] = value


def _diagnostic_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _diagnostic_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _sanitize_event_meta(value: Any) -> dict[str, Any] | None:
    source = _diagnostic_dict(value)
    result: dict[str, Any] = {}
    for key in ("model", "modelSource", "engine", "readyKind", "utteranceId", "recoveredFrom"):
        _put_if(result, key, _diagnostic_text(source.get(key), 300))
    for key in (
        "sampleRate",
        "sttLatencyMs",
        "llmLatencyMs",
        "speechEndToFinalMs",
        "openaiInferenceMs",
        "queueWaitMs",
        "queueDepth",
        "capturedAtMs",
        "captureEpoch",
    ):
        _put_if(result, key, _diagnostic_number(source.get(key)))
    for key in ("reconnected", "recoverable", "nonFatal"):
        if isinstance(source.get(key), bool):
            result[key] = source[key]
    return result or None


def _sanitize_diagnostic_event(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("type") not in _DIAGNOSTIC_EVENT_TYPES:
        return None
    result: dict[str, Any] = {
        "tMs": max(0, _diagnostic_number(value.get("tMs")) or 0),
        "type": value["type"],
    }
    if value.get("source") in {"mic", "system"}:
        result["source"] = value["source"]
    if value.get("speaker") in {"me", "other"}:
        result["speaker"] = value["speaker"]
    _put_if(result, "text", _diagnostic_text(value.get("text"), 550))
    _put_if(result, "reason", _diagnostic_text(value.get("reason"), 550))
    _put_if(result, "meta", _sanitize_event_meta(value.get("meta")))
    return result


def _sanitize_source_health(value: Any) -> dict[str, Any] | None:
    source = _diagnostic_dict(value)
    raw_sources = _diagnostic_dict(source.get("sources"))
    sources: dict[str, Any] = {}
    for source_name in ("mic", "system"):
        raw_state = raw_sources.get(source_name)
        if not isinstance(raw_state, dict):
            continue
        state: dict[str, Any] = {}
        for key in ("requested", "ready"):
            if isinstance(raw_state.get(key), bool):
                state[key] = raw_state[key]
        for key in (
            "readyAtMs",
            "captureEpoch",
            "firstFrameAtMs",
            "firstSignalAtMs",
            "firstSpeechAtMs",
            "signalFrameCount",
            "speechStartCount",
        ):
            if raw_state.get(key) is None and key in raw_state:
                state[key] = None
            else:
                _put_if(state, key, _diagnostic_number(raw_state.get(key)))
        if raw_state.get("warning") is None and "warning" in raw_state:
            state["warning"] = None
        else:
            _put_if(state, "warning", _diagnostic_text(raw_state.get("warning"), 300))
        sources[source_name] = state
    result: dict[str, Any] = {}
    if sources:
        result["sources"] = sources
    if source.get("warning") is None and "warning" in source:
        result["warning"] = None
    else:
        _put_if(result, "warning", _diagnostic_text(source.get("warning"), 300))
    return result or None


def _sanitize_screen_assist(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    screen_id = _diagnostic_text(value.get("id"), 300)
    if not screen_id:
        return None
    result: dict[str, Any] = {"id": screen_id}
    for key in (
        "generation",
        "startedAtMs",
        "captureMs",
        "firstOutputMs",
        "totalMs",
        "encodedByteCount",
    ):
        _put_if(result, key, _diagnostic_number(value.get(key)))
    if value.get("trigger") in {"manual", "visual_question", "stt_timeout"}:
        result["trigger"] = value["trigger"]
    if value.get("status") in {"requested", "captured", "done", "error", "cancelled"}:
        result["status"] = value["status"]
    for key, limit in (
        ("mode", 80),
        ("effectiveQuestion", 2000),
        ("model", 200),
        ("modelSource", 100),
        ("answer", 8000),
        ("error", 1000),
        ("imageMimeType", 100),
    ):
        _put_if(result, key, _diagnostic_text(value.get(key), limit))
    return result


def _sanitize_exchange(value: Any) -> dict[str, Any]:
    source = _diagnostic_dict(value)
    result: dict[str, Any] = {}
    for key, limit in (("id", 300), ("question", 2000), ("spoken", 8000)):
        _put_if(result, key, _diagnostic_text(source.get(key), limit))
    _put_if(result, "ts", _diagnostic_number(source.get("ts")))
    if source.get("source") in {"live", "manual"}:
        result["source"] = source["source"]
    pipeline_source = _diagnostic_dict(source.get("pipeline"))
    pipeline: dict[str, Any] = {}
    for key in (
        "model",
        "modelSource",
        "rawTranscript",
        "normalizedTranscript",
        "resolvedQuestion",
        "previousTopic",
        "currentCanonicalTopic",
        "followUpReason",
        "resetPreviousTopicReason",
        "questionIntent",
        "answerStrategy",
        "hallucinationRisk",
        "resumeContextLevel",
        "resumeContextReason",
    ):
        _put_if(pipeline, key, _diagnostic_text(pipeline_source.get(key), 2000))
    for key in (
        "isFollowUp",
        "usedPreviousContext",
        "wasPreviousTopicUsed",
        "resetPreviousTopic",
        "resumeContextUsed",
    ):
        if isinstance(pipeline_source.get(key), bool):
            pipeline[key] = pipeline_source[key]
    for key in ("timeToAnswerMs", "timeToFinalMs"):
        _put_if(pipeline, key, _diagnostic_number(pipeline_source.get(key)))
    knowledge_source = _diagnostic_dict(pipeline_source.get("knowledge"))
    knowledge: dict[str, Any] = {}
    if isinstance(knowledge_source.get("knowledgePackUsed"), bool):
        knowledge["knowledgePackUsed"] = knowledge_source["knowledgePackUsed"]
    for key in ("knowledgePackName", "knowledgeSource"):
        _put_if(knowledge, key, _diagnostic_text(knowledge_source.get(key), 300))
    for key in (
        "retrievedItemsCount",
        "injectedContextTokens",
        "knowledgeRetrievalMs",
        "answerLatencyWithKnowledgeMs",
    ):
        _put_if(knowledge, key, _diagnostic_number(knowledge_source.get(key)))
    if knowledge:
        pipeline["knowledge"] = knowledge
    if pipeline:
        result["pipeline"] = pipeline
    for group in ("latency", "stt"):
        group_source = _diagnostic_dict(source.get(group))
        allowed = (
            ("sttLatencyMs", "llmLatencyMs", "totalLatencyMs")
            if group == "latency"
            else (
                "capturedAtMs",
                "queueWaitMs",
                "queueDepth",
                "speechEndToFinalMs",
                "openaiInferenceMs",
            )
        )
        sanitized: dict[str, Any] = {}
        for key in allowed:
            if group_source.get(key) is None and key in group_source:
                sanitized[key] = None
            else:
                _put_if(sanitized, key, _diagnostic_number(group_source.get(key)))
        if group == "latency":
            breakdown_source = _diagnostic_dict(group_source.get("breakdown"))
            breakdown: dict[str, Any] = {}
            for key in (
                "speechEndToFinalMs",
                "speechStartToFinalMs",
                "finalToAnswerStartMs",
                "llmFirstTokenMs",
                "llmTotalMs",
                "sessionElapsedToFinalMs",
            ):
                _put_if(breakdown, key, _diagnostic_number(breakdown_source.get(key)))
            if breakdown:
                sanitized["breakdown"] = breakdown
        if group == "stt":
            _put_if(
                sanitized, "utteranceId", _diagnostic_text(group_source.get("utteranceId"), 300)
            )
            if group_source.get("source") in {"mic", "system"}:
                sanitized["source"] = group_source["source"]
        if sanitized:
            result[group] = sanitized
    return result


def _sanitize_retention(
    value: Any,
    limit: int,
    retained: int,
    input_count: int,
) -> dict[str, int]:
    source = _diagnostic_dict(value)
    prior_dropped = max(0, int(_diagnostic_number(source.get("dropped")) or 0))
    dropped = prior_dropped + max(0, input_count - retained)
    return {
        "limit": limit,
        "retained": retained,
        "dropped": dropped,
        "total": max(
            retained + dropped,
            int(_diagnostic_number(source.get("total")) or retained + dropped),
        ),
    }


def _sanitize_schema_v2_diagnostics(value: dict[str, Any]) -> dict[str, Any]:
    raw_events = _diagnostic_list(value.get("events"))
    events = [
        event
        for event in (_sanitize_diagnostic_event(item) for item in raw_events)
        if event is not None
    ][-1000:]
    extra_source = _diagnostic_dict(value.get("extra"))
    extra: dict[str, Any] = {}
    stt = _sanitize_event_meta(extra_source.get("stt"))
    if stt:
        extra["stt"] = stt
    raw_sources = _diagnostic_dict(extra_source.get("sources"))
    sources = {
        key: raw_sources[key] for key in ("mic", "system") if isinstance(raw_sources.get(key), bool)
    }
    if sources:
        extra["sources"] = sources
    source_health = _sanitize_source_health(extra_source.get("sourceHealth"))
    if source_health:
        extra["sourceHealth"] = source_health
    if isinstance(extra_source.get("exchanges"), list):
        extra["exchanges"] = [_sanitize_exchange(item) for item in extra_source["exchanges"][-200:]]
    screens: list[dict[str, Any]] = []
    raw_screens = _diagnostic_list(extra_source.get("screenAssists"))
    if raw_screens:
        valid_screens = [
            screen
            for screen in (_sanitize_screen_assist(item) for item in raw_screens)
            if screen is not None
        ]
        screens = valid_screens[-40:]
        extra["screenAssists"] = screens
    retention_source = _diagnostic_dict(value.get("retention"))
    result: dict[str, Any] = {
        "schemaVersion": 2,
        "generatedAt": _diagnostic_text(value.get("generatedAt"), 100)
        or datetime.now(UTC).isoformat(),
        "sampleRate": max(0, _diagnostic_number(value.get("sampleRate")) or 16000),
        "durationMs": max(0, _diagnostic_number(value.get("durationMs")) or 0),
        "audioFile": _diagnostic_text(value.get("audioFile"), 255)
        if value.get("audioFile") is not None
        else None,
        "events": events,
        "retention": {
            "events": _sanitize_retention(
                retention_source.get("events"), 1000, len(events), len(raw_events)
            ),
            "screenAssists": _sanitize_retention(
                retention_source.get("screenAssists"), 40, len(screens), len(raw_screens)
            ),
        },
    }
    if extra:
        result["extra"] = extra
    return result


@router.put("/{session_id}/diagnostics")
def save_session_diagnostics(
    session_id: str,
    payload: SessionDiagnosticsPayload,
    db: Session = Depends(get_db),
) -> dict:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise AppError("Session not found", 404, "not_found")
    raw_payload = payload.model_dump()
    stored_payload = (
        _sanitize_schema_v2_diagnostics(raw_payload) if payload.schemaVersion >= 2 else raw_payload
    )
    serialized = json.dumps(stored_payload, ensure_ascii=False, separators=(",", ":"))
    if len(serialized.encode("utf-8")) > MAX_SESSION_DIAGNOSTICS_BYTES:
        raise AppError(
            "Session diagnostics are too large",
            413,
            "diagnostics_too_large",
        )
    row = session.diagnostic
    if row is None:
        row = SessionDiagnostic(session_id=session_id, payload_json=serialized)
        db.add(row)
    else:
        row.payload_json = serialized
        row.updated_at = _naive_utc_now()
    db.commit()
    return {"saved": session_id, "event_count": len(stored_payload.get("events", []))}


@router.delete("")
def delete_all_sessions(db: Session = Depends(get_db)) -> dict:
    return _delete_all_sessions(db)


@router.post("/delete-all")
def delete_all_sessions_post(db: Session = Depends(get_db)) -> dict:
    return _delete_all_sessions(db)


def _delete_all_sessions(db: Session) -> dict:
    session_ids = [row[0] for row in db.query(InterviewSession.id).all()]
    with session_mutation_locks(session_ids):
        rows = db.query(InterviewSession).all()
        count = len(rows)
        for s in rows:
            db.delete(s)  # ORM cascade removes answers + transcripts + assessment
        db.commit()
        return {"deleted": count}


@router.delete("/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db)) -> dict:
    return _delete_session(session_id, db)


@router.post("/{session_id}/delete")
def delete_session_post(session_id: str, db: Session = Depends(get_db)) -> dict:
    return _delete_session(session_id, db)


def _delete_session(session_id: str, db: Session) -> dict:
    with session_mutation_lock(session_id):
        s = db.query(InterviewSession).filter(InterviewSession.id == session_id).first()
        if not s:
            raise AppError("Session not found", 404, "not_found")
        db.delete(s)
        db.commit()
        return {"deleted": session_id}


class EndPayload(BaseModel):
    summary: str | None = None


@router.post("/{session_id}/end")
def end_session(session_id: str, payload: EndPayload, db: Session = Depends(get_db)) -> dict:
    s = db.query(InterviewSession).filter(InterviewSession.id == session_id).first()
    if not s:
        raise AppError("Session not found", 404, "not_found")
    # A summary alone (e.g. meeting review) makes the session worth keeping.
    if _session_is_empty(s) and not payload.summary:
        db.delete(s)
        db.commit()
        return {"deleted": session_id}
    s.ended_at = _naive_utc_now()
    if payload.summary:
        s.summary = payload.summary
    db.commit()
    return {"id": s.id, "ended_at": s.ended_at.isoformat()}


class TranscriptPayload(BaseModel):
    speaker: str = "other"
    text: str
    is_final: bool = True


@router.post("/{session_id}/transcript")
def add_transcript(
    session_id: str, payload: TranscriptPayload, db: Session = Depends(get_db)
) -> dict:
    s = db.query(InterviewSession).filter(InterviewSession.id == session_id).first()
    if not s:
        raise AppError("Session not found", 404, "not_found")
    t = Transcript(
        session_id=session_id,
        speaker=payload.speaker,
        text=payload.text,
        is_final=payload.is_final,
    )
    db.add(t)
    db.commit()
    return {"id": t.id}


class AnalyzeSessionRequest(BaseModel):
    language: str = "ru"
    force: bool = False


@router.post("/{session_id}/analysis")
async def create_session_analysis(
    session_id: str,
    payload: AnalyzeSessionRequest,
    db: Session = Depends(get_db),
) -> dict:
    async with async_session_mutation_lock(session_id):
        session = db.get(InterviewSession, session_id)
        if not session:
            raise AppError("Session not found", 404, "not_found")
        existing = db.query(SessionAssessment).filter_by(session_id=session_id).first()
        source_fingerprint = session_analysis_source_fingerprint(session, payload.language)
        if existing and not payload.force:
            saved = json.loads(existing.analysis_json)
            saved_language = saved.get("analysisLanguage") or existing.language
            saved_fingerprint = saved.get("sourceFingerprint")
            if saved.get("analysisVersion") == 2 and saved_language == payload.language:
                if not saved_fingerprint:
                    # One-time metadata upgrade for previously persisted v2 reports.
                    # The evidence itself is unchanged, so this must not spend tokens.
                    saved["analysisLanguage"] = payload.language
                    saved["sourceFingerprint"] = source_fingerprint
                    existing.analysis_json = json.dumps(saved, ensure_ascii=False)
                    db.commit()
                    return saved
                if saved_fingerprint == source_fingerprint:
                    return saved

        quota.check_token_quota(db)
        result = await analyze_session(db, session, payload.language)
        result_payload = result.model_dump()
        result_payload["analysisLanguage"] = payload.language
        result_payload["sourceFingerprint"] = source_fingerprint
        result_json = json.dumps(result_payload, ensure_ascii=False)
        db.expire_all()
        if not db.query(InterviewSession.id).filter_by(id=session_id).first():
            raise AppError("Session was deleted during analysis", 409, "session_deleted")
        if existing:
            existing.language = payload.language
            existing.analysis_json = result_json
            existing.markdown = result.markdown
        else:
            db.add(
                SessionAssessment(
                    session_id=session_id,
                    language=payload.language,
                    analysis_json=result_json,
                    markdown=result.markdown,
                )
            )
        db.commit()
        return result_payload


@router.get("/{session_id}/analysis")
def get_session_analysis(session_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.query(SessionAssessment).filter_by(session_id=session_id).first()
    if not row:
        raise AppError("Session analysis not found", 404, "not_found")
    session = db.get(InterviewSession, session_id)
    if not session:
        raise AppError("Session not found", 404, "not_found")
    saved = json.loads(row.analysis_json)
    language = saved.get("analysisLanguage") or row.language
    current_fingerprint = session_analysis_source_fingerprint(session, language)
    saved_fingerprint = saved.get("sourceFingerprint")
    if saved_fingerprint and saved_fingerprint != current_fingerprint:
        raise AppError(
            "Session transcript changed after the saved analysis",
            409,
            "stale_session_analysis",
        )
    if not saved_fingerprint:
        # Backfill cache metadata for existing installations without asking the
        # model to repeat an analysis whose source data has not changed.
        saved["analysisLanguage"] = language
        saved["sourceFingerprint"] = current_fingerprint
        row.analysis_json = json.dumps(saved, ensure_ascii=False)
        db.commit()
    return saved
