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
    # managed_openrouter = «гейтвей есть И своего ключа нет». На дев-машине в
    # OS-keyring может лежать настоящий ключ — мокаем секреты, иначе тест
    # зависит от окружения разработчика.
    from app.services import secrets

    monkeypatch.setattr(secrets, "has_secret", lambda name: False)

    res = client.get("/settings/keys")
    assert res.status_code == 200
    data = res.json()
    assert data["openrouter"] is True
    assert data["managed_openrouter"] is True

    ai = client.get("/settings/ai")
    assert ai.status_code == 200
    assert ai.json()["has_openrouter_key"] is True


def test_settings_ignores_removed_stt_credentials(client, monkeypatch):
    from app.services import secrets

    stored: dict[str, str] = {}
    monkeypatch.setattr(secrets, "set_secret", lambda name, value: stored.__setitem__(name, value))
    monkeypatch.setattr(secrets, "has_secret", lambda name: bool(stored.get(name)))

    response = client.post(
        "/settings/keys",
        json={
            "aws_access_key_id": "AKIA_TEST",
            "aws_secret_access_key": "secret",
            "aws_session_token": "session",
            "aws_region": "ap-southeast-2",
        },
    )

    assert response.status_code == 200
    assert "amazon" not in response.json()
    assert stored == {}
