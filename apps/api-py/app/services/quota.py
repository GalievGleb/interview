"""Квоты: серверный учёт токенов за календарный месяц + гейт live-режима.

Единая точка правды для роутеров: сколько потрачено, сколько можно, можно ли
live. Расход считается по ApiUsage (реальные токены провайдера, см.
provider_adapter.pop_last_usage), так что лимит меряет именно то, что стоит
денег.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import ApiUsage, AppMeta
from app.services.license import (
    PLAN_FEATURES,
    normalize_plan,
    select_effective_license,
    token_budget_for,
    trial_live_seconds_left,
)

_FIRST_RUN_KEY = "first_run_at"
_LICENSE_KEY = "license_key"
_MANAGED_LICENSE_KEY = "managed_license_key"
_LIVE_SECONDS_KEY = "live_seconds_used"


def _meta(db: Session, key: str) -> str | None:
    row = db.get(AppMeta, key)
    return row.value if row else None


def _set_meta(db: Session, key: str, value: str) -> None:
    row = db.get(AppMeta, key)
    if row is None:
        db.add(AppMeta(key=key, value=value))
    else:
        row.value = value


def month_start() -> datetime:
    now = datetime.now(UTC).replace(tzinfo=None)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def month_tokens_used(db: Session) -> int:
    row = (
        db.query(func.sum(ApiUsage.tokens_in) + func.sum(ApiUsage.tokens_out))
        .filter(ApiUsage.ts >= month_start())
        .one()
    )
    return int(row[0] or 0)


def live_seconds_used(db: Session) -> float:
    raw = _meta(db, _LIVE_SECONDS_KEY)
    try:
        return float(raw) if raw else 0.0
    except ValueError:
        return 0.0


def add_live_seconds(db: Session, seconds: float) -> None:
    _set_meta(db, _LIVE_SECONDS_KEY, str(live_seconds_used(db) + max(0.0, seconds)))
    db.commit()


def current_entitlements(db: Session) -> dict:
    """Полная картина прав: план, live, токены. Используется статусом и гейтами."""
    if os.environ.get("SKILLCUE_BUILD_CHANNEL", "").strip().lower() == "dev":
        # Dev is the owner's acceptance environment: expose the same feature
        # surface as Max and never let an exhausted commercial counter turn the
        # live start control red. `check_token_quota` also bypasses the counter.
        used = month_tokens_used(db)
        budget = token_budget_for("max")
        return {
            "status": "active",
            "plan": "max",
            "licensed_to": "developer",
            "live_allowed": True,
            "live_seconds_left": None,
            "tokens_used_month": used,
            "tokens_budget_month": budget,
            "tokens_left_month": max(1, budget - used),
        }

    _, payload = select_effective_license(
        _meta(db, _MANAGED_LICENSE_KEY),
        _meta(db, _LICENSE_KEY),
    )

    if payload:
        plan = normalize_plan(str(payload.get("plan", "")))
        licensed_to = str(payload.get("email", ""))
        live_left = None  # лицензия не ограничивает live по времени
        live_allowed = PLAN_FEATURES[plan]["live"]
        status = "active"
    else:
        plan = "trial"
        licensed_to = None
        live_left = trial_live_seconds_left(live_seconds_used(db))
        live_allowed = live_left > 0
        status = "trial" if live_left > 0 else "expired"

    budget = token_budget_for(plan, payload)
    used = month_tokens_used(db)
    return {
        "status": status,
        "plan": plan,
        "licensed_to": licensed_to,
        "live_allowed": live_allowed,
        "live_seconds_left": live_left,
        "tokens_used_month": used,
        "tokens_budget_month": budget,
        "tokens_left_month": max(0, budget - used),
    }


def check_token_quota(db: Session) -> None:
    """Вызывается перед каждым LLM-запросом. 402 при исчерпании бюджета."""
    # The developer build is the owner's test surface. It must exercise the real
    # AI path even after the commercial plan counter is exhausted; stable builds
    # still fail closed and enforce the licensed monthly budget.
    if os.environ.get("SKILLCUE_BUILD_CHANNEL", "").strip().lower() == "dev":
        return
    ent = current_entitlements(db)
    if ent["tokens_left_month"] <= 0:
        raise AppError(
            "Месячный лимит токенов тарифа исчерпан. Лимит обновится 1-го числа; "
            "нужен больший объём — свяжитесь с поддержкой.",
            402,
            "token_quota_exceeded",
        )


def check_live_allowed(db: Session) -> None:
    """Гейт live-режима: 403 если тариф не включает live или trial-минуты сгорели."""
    ent = current_entitlements(db)
    if not ent["live_allowed"]:
        if ent["plan"] == "basic":
            raise AppError(
                "Тариф basic не включает live-режим. Обновитесь до max.",
                403,
                "live_not_in_plan",
            )
        raise AppError(
            "Пробные 15 минут live закончились. Активируйте лицензию в Настройках.",
            403,
            "trial_live_exhausted",
        )
