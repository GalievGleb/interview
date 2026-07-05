"""Durable storage for Vacancy Smoke Review (mock interview) sessions.

The renderer keeps localStorage as a synchronous read cache; this API is the
source of truth so sessions survive profile cleanups and machine moves.
The payload is stored as opaque JSON — its schema belongs to the frontend.
"""

import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import MockSession
from app.db.session import get_db

router = APIRouter(prefix="/mock-sessions", tags=["mock-sessions"])

MAX_SESSIONS = 100


class MockSessionPayload(BaseModel):
    id: str
    status: str = "in_progress"
    startedAt: int = 0
    updatedAt: int = 0
    payload: dict


@router.get("")
def list_mock_sessions(db: Session = Depends(get_db)) -> dict:
    rows = db.query(MockSession).order_by(MockSession.started_at.desc()).all()
    sessions = []
    for r in rows:
        try:
            sessions.append(
                {
                    "id": r.id,
                    "status": r.status,
                    "startedAt": r.started_at,
                    "updatedAt": r.updated_at,
                    "payload": json.loads(r.payload),
                }
            )
        except json.JSONDecodeError:
            continue  # a corrupt row must not break the whole list
    return {"sessions": sessions}


@router.put("/{session_id}")
def upsert_mock_session(
    session_id: str, body: MockSessionPayload, db: Session = Depends(get_db)
) -> dict:
    if session_id != body.id:
        raise AppError("id mismatch", 400, "id_mismatch")
    row = db.get(MockSession, session_id)
    if row is None:
        row = MockSession(id=session_id)
        db.add(row)
    row.status = body.status
    row.started_at = body.startedAt
    row.updated_at = body.updatedAt
    row.payload = json.dumps(body.payload, ensure_ascii=False)
    _prune(db)
    db.commit()
    return {"saved": session_id}


@router.delete("/{session_id}")
def delete_mock_session(session_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.get(MockSession, session_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"deleted": session_id}


def _prune(db: Session) -> None:
    """Keep the newest MAX_SESSIONS rows (mirrors the old localStorage cap, higher)."""
    ids = [
        r.id
        for r in db.query(MockSession.id, MockSession.started_at)
        .order_by(MockSession.started_at.desc())
        .offset(MAX_SESSIONS)
        .all()
    ]
    if ids:
        db.query(MockSession).filter(MockSession.id.in_(ids)).delete(synchronize_session=False)
