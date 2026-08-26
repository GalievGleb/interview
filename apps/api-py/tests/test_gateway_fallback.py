"""Гейтвей-фолбэк provider_adapter: лицензия открывает прокси без ключа OpenRouter."""

import time

from app.services import provider_adapter


def _reset_cache():
    provider_adapter._gateway_cache["at"] = 0.0
    provider_adapter._gateway_cache["key"] = ""


async def test_no_key_no_gateway_raises(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "")
    try:
        await provider_adapter._resolve("openrouter")
        raise AssertionError("must raise missing_api_key")
    except Exception as exc:  # noqa: BLE001
        assert "missing_api_key" in str(getattr(exc, "code", "")) or "not set" in str(exc)


async def test_license_key_routes_via_gateway(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1/")

    async def mock_gateway_license_key() -> str:
        return "SKILLCUE-abc.def"

    monkeypatch.setattr(provider_adapter, "_gateway_license_key", mock_gateway_license_key)

    provider, base_url, key = await provider_adapter._resolve("openrouter")
    assert provider == "openrouter"
    assert base_url == "https://gw.example/v1"  # без хвостового слэша
    assert key == "SKILLCUE-abc.def"


async def test_no_user_key_claims_limited_trial_key_via_gateway(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1")
    monkeypatch.setattr(provider_adapter, "_stored_gateway_license_key", lambda: "", raising=False)

    async def mock_claim_trial_key(gateway_url: str) -> str:
        return "SKILLCUE-trial.key"

    monkeypatch.setattr(
        provider_adapter,
        "_claim_gateway_trial_key",
        mock_claim_trial_key,
        raising=False,
    )

    provider, base_url, key = await provider_adapter._resolve("openrouter")
    assert provider == "openrouter"
    assert base_url == "https://gw.example/v1"
    assert key == "SKILLCUE-trial.key"


async def test_empty_initial_cache_is_not_fresh_during_first_system_minute(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1")
    monkeypatch.setattr(provider_adapter, "_stored_gateway_license_key", lambda: "", raising=False)
    monkeypatch.setattr(time, "monotonic", lambda: 30.0)

    async def mock_claim_trial_key(gateway_url: str) -> str:
        return "SKILLCUE-fresh-boot.key"

    monkeypatch.setattr(
        provider_adapter,
        "_claim_gateway_trial_key",
        mock_claim_trial_key,
        raising=False,
    )

    provider, base_url, key = await provider_adapter._resolve("openrouter")

    assert provider == "openrouter"
    assert base_url == "https://gw.example/v1"
    assert key == "SKILLCUE-fresh-boot.key"


async def test_own_key_wins_over_gateway(monkeypatch):
    """BYOK-пользователь не должен внезапно поехать через гейтвей."""
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "sk-own-key")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1")

    _, base_url, key = await provider_adapter._resolve("openrouter")
    assert key == "sk-own-key"
    assert "gw.example" not in base_url
