"""Answer feedback: collect 👍/👎 and expose the material for quality tuning.

Downvotes carry the question, the answer and (when available) the raw STT
transcript — exactly what is needed to grow the glossary and fix prompts.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import AnswerFeedback
from app.db.session import get_db

router = APIRouter(prefix="/feedback", tags=["feedback"])

MAX_ROWS = 1000


class FeedbackPayload(BaseModel):
    verdict: str  # up | down
    question: str = ""
    answer: str = ""
    raw_transcript: str | None = None
    source: str = "live"


@router.post("")
def record_feedback(payload: FeedbackPayload, db: Session = Depends(get_db)) -> dict:
    if payload.verdict not in {"up", "down"}:
        raise AppError("verdict must be up or down", 400, "invalid_verdict")
    row = AnswerFeedback(
        verdict=payload.verdict,
        question=payload.question[:2000],
        answer=payload.answer[:8000],
        raw_transcript=(payload.raw_transcript or None),
        source=payload.source,
    )
    db.add(row)
    ids = [
        r.id
        for r in db.query(AnswerFeedback.id)
        .order_by(AnswerFeedback.ts.desc())
        .offset(MAX_ROWS - 1)
        .all()
    ]
    if ids:
        db.query(AnswerFeedback).filter(AnswerFeedback.id.in_(ids)).delete(
            synchronize_session=False
        )
    db.commit()
    return {"recorded": row.id}


@router.get("/summary")
def feedback_summary(db: Session = Depends(get_db)) -> dict:
    """Counts + the recent downvotes (question/raw transcript) for tuning."""
    up = db.query(AnswerFeedback).filter(AnswerFeedback.verdict == "up").count()
    down = db.query(AnswerFeedback).filter(AnswerFeedback.verdict == "down").count()
    recent_down = (
        db.query(AnswerFeedback)
        .filter(AnswerFeedback.verdict == "down")
        .order_by(AnswerFeedback.ts.desc())
        .limit(20)
        .all()
    )
    return {
        "up": up,
        "down": down,
        "recent_downvotes": [
            {
                "question": r.question,
                "raw_transcript": r.raw_transcript,
                "source": r.source,
                "ts": r.ts.isoformat(),
            }
            for r in recent_down
        ],
    }
