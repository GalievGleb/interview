from __future__ import annotations

from fastapi.testclient import TestClient

from app.core import local_auth
from app.main import app


def test_cors_preflight_is_never_rejected_by_local_token_middleware(monkeypatch) -> None:
    monkeypatch.delenv("SKILLCUE_BUILD_CHANNEL", raising=False)
    client = TestClient(app)

    response = client.options(
        "/sessions",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-skillcue-token",
        },
    )

    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] in {
        "*",
        "http://localhost:5173",
    }


def test_developer_channel_does_not_require_local_token(monkeypatch) -> None:
    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "dev")

    assert local_auth.enabled() is False


def test_stable_channel_remains_token_protected(monkeypatch) -> None:
    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "stable")

    assert local_auth.enabled() is True
