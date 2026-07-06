from app.routers import settings as settings_router
from app.services import preferences


def test_ai_settings_roundtrip_includes_vacancy_review_model(client, tmp_path, monkeypatch):
    monkeypatch.setattr(preferences, "PREFS_PATH", tmp_path / "ai_preferences.json")

    initial = client.get("/settings/ai")
    assert initial.status_code == 200
    assert initial.json()["vacancy_review_model"] == "auto"

    saved = client.post(
        "/settings/ai",
        json={"vacancy_review_model": "openai/gpt-5.4"},
    )
    assert saved.status_code == 200
    assert saved.json()["vacancy_review_model"] == "openai/gpt-5.4"

    reloaded = client.get("/settings/ai")
    assert reloaded.status_code == 200
    assert reloaded.json()["vacancy_review_model"] == "openai/gpt-5.4"


def test_keys_status_treats_configured_gateway_as_ai_ready(client, monkeypatch):
    s = settings_router.get_settings()
    monkeypatch.setattr(s, "skillcue_gateway_url", "https://skill-cue.ru/v1")

    res = client.get("/settings/keys")
    assert res.status_code == 200
    data = res.json()
    assert data["openrouter"] is True
    assert data["managed_openrouter"] is True

    ai = client.get("/settings/ai")
    assert ai.status_code == 200
    assert ai.json()["has_openrouter_key"] is True
