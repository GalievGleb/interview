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


def test_stable_build_still_enforces_token_counter(monkeypatch) -> None:
    monkeypatch.delenv("SKILLCUE_BUILD_CHANNEL", raising=False)
    monkeypatch.setattr(
        quota,
        "current_entitlements",
        lambda _db: {"tokens_left_month": 0},
    )

    with pytest.raises(AppError, match="Месячный лимит токенов"):
        quota.check_token_quota(object())
