from __future__ import annotations

import pytest

from app.core.errors import AppError
from app.services import quota


def test_alpha_does_not_reuse_legacy_gateway_key(monkeypatch, db_session):
    from app.db import session
    from app.db.models import AppMeta
    from app.services import license, provider_adapter

    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "alpha")
    db_session.add(AppMeta(key="license_key", value="legacy-key"))
    db_session.commit()
    monkeypatch.setattr(session, "SessionLocal", lambda: db_session)
    calls = []

    def select(managed, legacy):
        calls.append((managed, legacy))
        return legacy, {"plan": "trial"} if legacy else None

    monkeypatch.setattr(license, "select_effective_license", select)
    assert provider_adapter._stored_gateway_license_key() == ""
    assert calls == [("", "")]


@pytest.mark.asyncio
async def test_alpha_never_claims_anonymous_trial(monkeypatch):
    from app.services import provider_adapter

    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "alpha")
    with pytest.raises(AppError, match="Google"):
        await provider_adapter._claim_gateway_trial_key("https://invalid.example")


def test_alpha_requires_account_before_free_tokens_or_live(monkeypatch, db_session):
    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "alpha")
    entitlements = quota.current_entitlements(db_session)
    assert entitlements["status"] == "auth_required"
    assert entitlements["tokens_left_month"] == 0
    for check in (quota.check_token_quota, quota.check_live_allowed):
        with pytest.raises(AppError, match="Google"):
            check(db_session)


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
