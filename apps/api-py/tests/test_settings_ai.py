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
