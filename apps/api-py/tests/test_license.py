"""Tests for licensing v2: key verification, plans, live-trial minutes, quotas."""

import base64
import json
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.services import license as lic
from app.services import quota


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


@pytest.fixture()
def keypair(monkeypatch):
    priv = Ed25519PrivateKey.generate()
    pub_hex = (
        priv.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )
    monkeypatch.setattr(lic, "PUBLIC_KEY_HEX", pub_hex)
    return priv


def _mint(priv: Ed25519PrivateKey, payload: dict) -> str:
    body = json.dumps(payload, separators=(",", ":")).encode()
    return f"SKILLCUE-{_b64url(body)}.{_b64url(priv.sign(body))}"


# --- verification ----------------------------------------------------------
def test_valid_key_verifies(keypair):
    key = _mint(keypair, {"email": "a@b.c", "plan": "max"})
    info = lic.verify_license_key(key)
    assert info and info["email"] == "a@b.c"


def test_tampered_payload_rejected(keypair):
    key = _mint(keypair, {"email": "a@b.c"})
    prefix, rest = key.split("-", 1)
    _, sig = rest.rsplit(".", 1)
    forged = json.dumps({"email": "hacker@evil.com"}, separators=(",", ":")).encode()
    assert lic.verify_license_key(f"{prefix}-{_b64url(forged)}.{sig}") is None


def test_garbage_keys_rejected(keypair):
    for bad in ("", "SKILLCUE-", "SKILLCUE-abc.def", "NOPE-xxx.yyy", "SKILLCUE-no-dot"):
        assert lic.verify_license_key(bad) is None


def test_expired_subscription_key_rejected(keypair):
    key = _mint(keypair, {"email": "a@b.c", "expires_at": time.time() - 10})
    assert lic.verify_license_key(key) is None


# --- plans / budgets ---------------------------------------------------------
def test_plan_normalization():
    assert lic.normalize_plan("trial") == "trial"
    assert lic.normalize_plan("pro") == "max"
    assert lic.normalize_plan("basic") == "basic"
    assert lic.normalize_plan(None) == "max"


def test_token_budget_override():
    assert lic.token_budget_for("max") == lic.PLAN_TOKEN_BUDGETS["max"]
    assert lic.token_budget_for("max", {"tokens_month": 1_000_000}) == 1_000_000
    assert lic.token_budget_for("basic") == lic.PLAN_TOKEN_BUDGETS["basic"]


def test_trial_live_seconds_left():
    assert lic.trial_live_seconds_left(0) == lic.TRIAL_LIVE_SECONDS
    assert lic.trial_live_seconds_left(lic.TRIAL_LIVE_SECONDS + 5) == 0


# --- HTTP: status / activate -------------------------------------------------
def test_status_starts_as_live_trial(client):
    s = client.get("/license/status").json()
    assert s["status"] == "trial"
    assert s["plan"] == "trial"
    assert s["live_allowed"] is True
    assert s["live_seconds_left"] == lic.TRIAL_LIVE_SECONDS
    assert s["tokens_budget_month"] == lic.PLAN_TOKEN_BUDGETS["trial"]


def test_trial_expires_after_live_minutes(client, db_session):
    quota.add_live_seconds(db_session, lic.TRIAL_LIVE_SECONDS + 1)
    s = client.get("/license/status").json()
    assert s["status"] == "expired"
    assert s["live_allowed"] is False
    assert s["live_seconds_left"] == 0


def test_activate_max_enables_live(client, keypair):
    key = _mint(keypair, {"email": "buyer@mail.com", "plan": "max"})
    res = client.post("/license/activate", json={"key": key})
    assert res.status_code == 200, res.text
    s = res.json()
    assert s["status"] == "active"
    assert s["plan"] == "max"
    assert s["live_allowed"] is True
    assert s["live_seconds_left"] is None


def test_basic_plan_blocks_live_but_not_prep(client, keypair):
    key = _mint(keypair, {"email": "b@mail.com", "plan": "basic"})
    client.post("/license/activate", json={"key": key})
    s = client.get("/license/status").json()
    assert s["plan"] == "basic"
    assert s["live_allowed"] is False
    assert s["tokens_budget_month"] == lic.PLAN_TOKEN_BUDGETS["basic"]


def test_activate_rejects_bad_key(client, keypair):
    assert client.post("/license/activate", json={"key": "SKILLCUE-fake.key"}).status_code == 400


# --- token quota -------------------------------------------------------------
def test_quota_blocks_llm_when_budget_spent(client, db_session, keypair):
    key = _mint(keypair, {"email": "q@mail.com", "plan": "max", "tokens_month": 100})
    client.post("/license/activate", json={"key": key})
    from app.db.models import ApiUsage

    db_session.add(ApiUsage(provider="openrouter", kind="chat", tokens_in=90, tokens_out=20))
    db_session.commit()

    s = client.get("/license/status").json()
    assert s["tokens_left_month"] == 0
    res = client.post("/chat/meeting-summary", json={"transcript": "test"})
    assert res.status_code == 402
    assert "лимит" in res.json()["error"]["message"].lower()


def test_quota_allows_when_budget_remains(client, db_session, keypair, monkeypatch):
    key = _mint(keypair, {"email": "ok@mail.com", "plan": "max"})
    client.post("/license/activate", json={"key": key})

    from app.services import provider_adapter

    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        **kwargs,
    ):
        return "summary text"

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    res = client.post("/chat/meeting-summary", json={"transcript": "test"})
    assert res.status_code == 200, res.text
