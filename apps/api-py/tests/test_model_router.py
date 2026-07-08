"""Тесты model_router."""

from app.services.model_router import pick_auto_model, resolve_model
from app.services.preferences import AiPreferencesModel


def test_pick_auto_fast_skips_gemini3():
    available = {
        "google/gemini-3.5-flash",
        "openai/gpt-4o-mini",
        "google/gemini-2.0-flash-001",
    }
    model = pick_auto_model("fast", available)
    assert model == "openai/gpt-4o-mini"


def test_pick_auto_fast():
    available = {
        "openai/gpt-4o-mini",
        "anthropic/claude-3-opus",
        "google/gemini-2.0-flash-001",
    }
    model = pick_auto_model("fast", available)
    assert "flash" in model or "mini" in model


def test_pick_auto_vacancy_prefers_fast_quality_over_slow_reasoning():
    # Разбор/оценку ждут вживую: быстрые качественные модели (gpt-4o) важнее
    # тяжёлых reasoning-моделей (gpt-5.x / claude-sonnet-4 thinking), которые
    # давали ответ по 25–30 с и часть из них заблокирована на гейтвейе.
    available = {
        "openai/gpt-4o",
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4",
    }
    model = pick_auto_model("vacancy", available)
    assert model == "openai/gpt-4o"


def test_pick_auto_vacancy_empty_cache_uses_strong_default():
    # gpt-4o (не gpt-5.5): дефолт разбора должен быть из моделей, разрешённых
    # гейтвеем (gpt-5.5 в блоклисте ради экономики) — иначе разбор упрётся в 403.
    assert pick_auto_model("vacancy", set()) == "openai/gpt-4o"


def test_resolve_vacancy_uses_dedicated_setting_when_explicit():
    prefs = AiPreferencesModel(
        deep_reasoning_model="openai/gpt-4o-mini",
        vacancy_review_model="anthropic/claude-sonnet-4",
        models_cache=[],
    )
    model, source = resolve_model(
        "vacancy",
        prefs=prefs,
        available={"openai/gpt-5.4", "anthropic/claude-sonnet-4"},
    )
    assert model == "anthropic/claude-sonnet-4"
    assert source == "setting"


def test_resolve_vacancy_ignores_deep_setting_when_vacancy_setting_is_auto():
    prefs = AiPreferencesModel(
        deep_reasoning_model="anthropic/claude-sonnet-4",
        vacancy_review_model="auto",
        models_cache=[],
    )
    model, source = resolve_model(
        "vacancy",
        prefs=prefs,
        available={"openai/gpt-4o", "anthropic/claude-sonnet-4"},
    )
    assert model == "openai/gpt-4o"
    assert source == "auto"


def test_resolve_auto():
    prefs = AiPreferencesModel(
        default_copilot_model="auto",
        models_cache=[],
    )
    model, source = resolve_model("general", prefs=prefs, available={"openai/gpt-4o-mini"})
    assert model == "openai/gpt-4o-mini"
    assert source == "auto"


def test_resolve_override():
    prefs = AiPreferencesModel(default_copilot_model="auto")
    model, source = resolve_model(
        "general",
        model_override="anthropic/claude-3.5-sonnet",
        prefs=prefs,
        available={"anthropic/claude-3.5-sonnet"},
    )
    assert model == "anthropic/claude-3.5-sonnet"
    assert source == "override"


def test_resolve_unavailable_fallback():
    prefs = AiPreferencesModel(default_copilot_model="missing/model")
    model, source = resolve_model(
        "general",
        prefs=prefs,
        available={"openai/gpt-4o-mini"},
    )
    assert model == "openai/gpt-4o-mini"
    assert source == "fallback_unavailable_setting"
