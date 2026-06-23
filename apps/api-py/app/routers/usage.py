from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import (
    Answer,
    ApiUsage,
    DocChunk,
    Document,
    InterviewSession,
    Transcript,
)
from app.db.session import get_db

router = APIRouter(tags=["usage"])


@router.get("/usage")
def usage(db: Session = Depends(get_db)) -> dict:
    rows = (
        db.query(
            ApiUsage.provider,
            ApiUsage.kind,
            func.count(ApiUsage.id),
            func.sum(ApiUsage.tokens_in),
            func.sum(ApiUsage.tokens_out),
            func.sum(ApiUsage.stt_seconds),
        )
        .group_by(ApiUsage.provider, ApiUsage.kind)
        .all()
    )
    return {
        "usage": [
            {
                "provider": r[0],
                "kind": r[1],
                "requests": r[2],
                "tokens_in": int(r[3] or 0),
                "tokens_out": int(r[4] or 0),
                "stt_seconds": int(r[5] or 0),
            }
            for r in rows
        ]
    }


@router.delete("/data")
def delete_all_data(db: Session = Depends(get_db)) -> dict:
    """Privacy: полное удаление пользовательских данных."""
    for model in (Answer, Transcript, DocChunk, Document, InterviewSession, ApiUsage):
        db.query(model).delete()
    db.commit()
    return {"deleted": True}
