import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import InterviewSession, SessionAssessment, Transcript
from app.db.session import get_db
from app.services import quota
from app.services.session_analysis import analyze_session
from app.services.session_mutation_lock import (
    async_session_mutation_lock,
    session_mutation_lock,
    session_mutation_locks,
)

router = APIRouter(prefix="/sessions", tags=["sessions"])


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
            }
            for a in sorted(s.answers, key=lambda x: x.ts)
        ],
    }


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
        if existing:
            return json.loads(existing.analysis_json)

        quota.check_token_quota(db)
        result = await analyze_session(db, session, payload.language)
        db.expire_all()
        if not db.query(InterviewSession.id).filter_by(id=session_id).first():
            raise AppError("Session was deleted during analysis", 409, "session_deleted")
        row = SessionAssessment(
            session_id=session_id,
            language=payload.language,
            analysis_json=result.model_dump_json(),
            markdown=result.markdown,
        )
        db.add(row)
        db.commit()
        return result.model_dump()


@router.get("/{session_id}/analysis")
def get_session_analysis(session_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.query(SessionAssessment).filter_by(session_id=session_id).first()
    if not row:
        raise AppError("Session analysis not found", 404, "not_found")
    return json.loads(row.analysis_json)
