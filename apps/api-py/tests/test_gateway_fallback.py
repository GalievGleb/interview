"""Гейтвей-фолбэк provider_adapter: лицензия открывает прокси без ключа OpenRouter."""

from app.services import provider_adapter


def _reset_cache():
    provider_adapter._gateway_cache["at"] = 0.0
    provider_adapter._gateway_cache["key"] = ""


def test_no_key_no_gateway_raises(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "")
    try:
        provider_adapter._resolve("openrouter")
        raise AssertionError("must raise missing_api_key")
    except Exception as exc:  # noqa: BLE001
        assert "missing_api_key" in str(getattr(exc, "code", "")) or "not set" in str(exc)


def test_license_key_routes_via_gateway(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1/")
    monkeypatch.setattr(provider_adapter, "_gateway_license_key", lambda: "SKILLCUE-abc.def")

    provider, base_url, key = provider_adapter._resolve("openrouter")
    assert provider == "openrouter"
    assert base_url == "https://gw.example/v1"  # без хвостового слэша
    assert key == "SKILLCUE-abc.def"


def test_no_user_key_claims_limited_trial_key_via_gateway(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1")
    monkeypatch.setattr(provider_adapter, "_stored_gateway_license_key", lambda: "", raising=False)
    monkeypatch.setattr(
        provider_adapter,
        "_claim_gateway_trial_key",
        lambda gateway_url: "SKILLCUE-trial.key",
        raising=False,
    )

    provider, base_url, key = provider_adapter._resolve("openrouter")
    assert provider == "openrouter"
    assert base_url == "https://gw.example/v1"
    assert key == "SKILLCUE-trial.key"


def test_own_key_wins_over_gateway(monkeypatch):
    """BYOK-пользователь не должен внезапно поехать через гейтвей."""
    _reset_cache()
    monkeypatch.setattr(provider_adapter.secrets, "get_secret", lambda name: "sk-own-key")
    settings = provider_adapter.get_settings()
    monkeypatch.setattr(settings, "skillcue_gateway_url", "https://gw.example/v1")

    _, base_url, key = provider_adapter._resolve("openrouter")
    assert key == "sk-own-key"
    assert "gw.example" not in base_url
