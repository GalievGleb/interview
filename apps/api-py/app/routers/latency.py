"""Latency telemetry: record per-answer pipeline timings, report p50/p95 vs budget.

Budgets encode the product bar ("answer fast enough to say aloud"): the
Diagnostics screen shows the trend and flags stages that breach them.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import AnswerLatency
from app.db.session import get_db

router = APIRouter(prefix="/latency", tags=["latency"])

# Product budgets, ms. Speech-end → final transcript; LLM first token; end-to-end.
BUDGETS_MS = {"stt_ms": 1200, "llm_first_ms": 1500, "total_ms": 3500}
MAX_ROWS = 500


class LatencyPayload(BaseModel):
    stt_ms: int | None = None
    llm_first_ms: int | None = None
    llm_total_ms: int | None = None
    total_ms: int | None = None


def _percentile(sorted_vals: list[int], q: float) -> int:
    """Nearest-rank percentile — simple and honest for small samples."""
    if not sorted_vals:
        return 0
    idx = min(len(sorted_vals) - 1, max(0, round(q * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


@router.post("")
def record_latency(payload: LatencyPayload, db: Session = Depends(get_db)) -> dict:
    row = AnswerLatency(
        stt_ms=payload.stt_ms,
        llm_first_ms=payload.llm_first_ms,
        llm_total_ms=payload.llm_total_ms,
        total_ms=payload.total_ms,
    )
    db.add(row)
    # Ring-buffer the table: keep the newest MAX_ROWS.
    ids = [
        r.id
        for r in db.query(AnswerLatency.id)
        .order_by(AnswerLatency.ts.desc())
        .offset(MAX_ROWS - 1)
        .all()
    ]
    if ids:
        db.query(AnswerLatency).filter(AnswerLatency.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    return {"recorded": row.id}


@router.get("/summary")
def latency_summary(db: Session = Depends(get_db)) -> dict:
    rows = db.query(AnswerLatency).order_by(AnswerLatency.ts.desc()).limit(200).all()
    out: dict = {"count": len(rows), "stages": {}, "budgets_ms": BUDGETS_MS}
    for stage in ("stt_ms", "llm_first_ms", "llm_total_ms", "total_ms"):
        vals = sorted(v for r in rows if (v := getattr(r, stage)) is not None)
        if not vals:
            out["stages"][stage] = None
            continue
        p50 = _percentile(vals, 0.5)
        p95 = _percentile(vals, 0.95)
        budget = BUDGETS_MS.get(stage)
        out["stages"][stage] = {
            "p50": p50,
            "p95": p95,
            "n": len(vals),
            "budget": budget,
            "within_budget": (p95 <= budget) if budget else None,
        }
    return out
