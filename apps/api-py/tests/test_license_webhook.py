"""Tests for the LemonSqueezy sales webhook (publisher infrastructure)."""

import hashlib
import hmac
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.services import license as lic
from tools import license_webhook as wh

SECRET = "test-webhook-secret"


@pytest.fixture()
def env(monkeypatch):
    """Webhook env + service trusts the same ephemeral keypair."""
    priv = Ed25519PrivateKey.generate()
    priv_hex = priv.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    ).hex()
    pub_hex = (
        priv.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )
    monkeypatch.setenv("LEMONSQUEEZY_WEBHOOK_SECRET", SECRET)
    monkeypatch.setenv("LICENSE_SIGNING_KEY", priv_hex)
    monkeypatch.delenv("SMTP_HOST", raising=False)
    monkeypatch.setattr(lic, "PUBLIC_KEY_HEX", pub_hex)
    return TestClient(wh.app)


def _signed(body: dict) -> tuple[bytes, dict]:
    raw = json.dumps(body).encode()
    sig = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {"X-Signature": sig, "Content-Type": "application/json"}


def _order(email: str = "buyer@mail.com", status: str = "paid") -> dict:
    return {
        "meta": {"event_name": "order_created"},
        "data": {"attributes": {"user_email": email, "status": status}},
    }


def test_valid_order_mints_verifiable_key(env, caplog):
    raw, headers = _signed(_order())
    with caplog.at_level("INFO", logger="license_webhook"):
        res = env.post("/webhook/lemonsqueezy", content=raw, headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["minted"] is True
    # Ключ из лога должен проходить проверку десктоп-сервиса.
    key = next(m for m in caplog.messages if "SKILLCUE-" in m).split(": ", 1)[1].strip()
    info = lic.verify_license_key(key)
    assert info and info["email"] == "buyer@mail.com"


def test_bad_signature_rejected(env):
    raw = json.dumps(_order()).encode()
    res = env.post(
        "/webhook/lemonsqueezy",
        content=raw,
        headers={"X-Signature": "deadbeef", "Content-Type": "application/json"},
    )
    assert res.status_code == 401


def test_missing_signature_rejected(env):
    res = env.post("/webhook/lemonsqueezy", json=_order())
    assert res.status_code == 401


def test_other_events_ignored(env):
    raw, headers = _signed({"meta": {"event_name": "subscription_updated"}, "data": {}})
    res = env.post("/webhook/lemonsqueezy", content=raw, headers=headers)
    assert res.status_code == 200
    assert res.json() == {"ignored": "subscription_updated"}


def test_refunded_order_ignored(env):
    raw, headers = _signed(_order(status="refunded"))
    res = env.post("/webhook/lemonsqueezy", content=raw, headers=headers)
    assert res.status_code == 200
    assert "ignored" in res.json()


# --- план из заказа: сайт продаёт «Базовый» и «Максимум» ---------------------
def _attrs(product="", variant="", custom=None) -> dict:
    attrs: dict = {}
    if product or variant:
        attrs["first_order_item"] = {"product_name": product, "variant_name": variant}
    if custom:
        attrs["custom_data"] = custom
    return attrs


def test_custom_data_plan_wins():
    assert wh.plan_from_order(_attrs("SkillCue Максимум", custom={"plan": "basic"})) == "basic"
    assert wh.plan_from_order(_attrs("SkillCue Базовый", custom={"plan": "max"})) == "max"


def test_max_keywords_ru_and_en():
    assert wh.plan_from_order(_attrs("SkillCue Максимум", "Месяц")) == "max"
    assert wh.plan_from_order(_attrs("SkillCue Maximum", "Monthly")) == "max"


def test_basic_keywords_ru_and_en():
    assert wh.plan_from_order(_attrs("SkillCue Базовый", "Месяц")) == "basic"
    assert wh.plan_from_order(_attrs("SkillCue Basic", "Monthly")) == "basic"


def test_unknown_product_defaults_to_basic():
    # Недовыдача тарифа чинится вручную; перевыдача «Максимума» — потеря денег.
    assert wh.plan_from_order(_attrs("Совершенно другое имя")) == "basic"
    assert wh.plan_from_order({}) == "basic"


def test_order_mints_plan_from_product_name(env, caplog):
    body = _order()
    body["data"]["attributes"].update(
        {"first_order_item": {"product_name": "SkillCue Базовый", "variant_name": "Месяц"}}
    )
    raw, headers = _signed(body)
    with caplog.at_level("INFO", logger="license_webhook"):
        res = env.post("/webhook/lemonsqueezy", content=raw, headers=headers)
    assert res.status_code == 200 and res.json()["plan"] == "basic"
    key = next(m for m in caplog.messages if "SKILLCUE-" in m).split(": ", 1)[1].strip()
    info = lic.verify_license_key(key)
    assert info and lic.normalize_plan(info.get("plan")) == "basic"
