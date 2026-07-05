from datetime import UTC, datetime, timedelta

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


def _usage_rows(db: Session, since: datetime | None = None) -> list[dict]:
    query = db.query(
        ApiUsage.provider,
        ApiUsage.kind,
        func.count(ApiUsage.id),
        func.sum(ApiUsage.tokens_in),
        func.sum(ApiUsage.tokens_out),
        func.sum(ApiUsage.stt_seconds),
    )
    if since is not None:
        query = query.filter(ApiUsage.ts >= since)
    return [
        {
            "provider": r[0],
            "kind": r[1],
            "requests": r[2],
            "tokens_in": int(r[3] or 0),
            "tokens_out": int(r[4] or 0),
            "stt_seconds": int(r[5] or 0),
        }
        for r in query.group_by(ApiUsage.provider, ApiUsage.kind).all()
    ]


@router.get("/usage")
def usage(db: Session = Depends(get_db)) -> dict:
    # БД хранит наивные UTC-датывремена — сравниваем с таким же наивным UTC.
    since = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=30)
    return {
        "usage": _usage_rows(db),
        "last_30_days": _usage_rows(db, since=since),
    }


@router.delete("/data")
def delete_all_data(db: Session = Depends(get_db)) -> dict:
    """Privacy: полное удаление пользовательских данных."""
    for model in (Answer, Transcript, DocChunk, Document, InterviewSession, ApiUsage):
        db.query(model).delete()
    db.commit()
    return {"deleted": True}
