from __future__ import annotations

import pytest

from app.core.errors import AppError
from app.services import quota


def test_developer_build_bypasses_commercial_token_counter(monkeypatch) -> None:
    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "dev")
    monkeypatch.setattr(
        quota,
        "current_entitlements",
        lambda _db: pytest.fail("developer build must not read commercial quota"),
    )

    quota.check_token_quota(object())


def test_developer_build_reports_active_max_live_entitlement(monkeypatch, db_session) -> None:
    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "dev")
    quota.add_live_seconds(db_session, 24 * 60 * 60)

    entitlements = quota.current_entitlements(db_session)

    assert entitlements["status"] == "active"
    assert entitlements["plan"] == "max"
    assert entitlements["licensed_to"] == "developer"
    assert entitlements["live_allowed"] is True
    assert entitlements["live_seconds_left"] is None
    quota.check_live_allowed(db_session)


def test_stable_build_still_enforces_token_counter(monkeypatch) -> None:
    monkeypatch.delenv("SKILLCUE_BUILD_CHANNEL", raising=False)
    monkeypatch.setattr(
        quota,
        "current_entitlements",
        lambda _db: {"tokens_left_month": 0},
    )

    with pytest.raises(AppError, match="Месячный лимит токенов"):
        quota.check_token_quota(object())
