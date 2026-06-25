from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import Answer, InterviewSession, Transcript
from app.db.session import get_db

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _session_is_empty(session: InterviewSession) -> bool:
    return len(session.answers) == 0 and len(session.transcripts) == 0


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
            if not _session_is_empty(s)
        ]
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


@router.delete("/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db)) -> dict:
    return _delete_session(session_id, db)


@router.post("/{session_id}/delete")
def delete_session_post(session_id: str, db: Session = Depends(get_db)) -> dict:
    return _delete_session(session_id, db)


def _delete_session(session_id: str, db: Session) -> dict:
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
    from datetime import datetime

    s = db.query(InterviewSession).filter(InterviewSession.id == session_id).first()
    if not s:
        raise AppError("Session not found", 404, "not_found")
    if _session_is_empty(s):
        db.delete(s)
        db.commit()
        return {"deleted": session_id}
    s.ended_at = datetime.utcnow()
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
