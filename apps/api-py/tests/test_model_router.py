"""Тесты model_router."""

from app.services import model_router
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


def test_pick_auto_fast_prefers_benchmarked_qwen_over_gpt_41_mini():
    available = {
        "openai/gpt-4o-mini",
        "openai/gpt-4.1-mini",
        "qwen/qwen3.5-flash-02-23",
        "google/gemini-2.0-flash-001",
    }
    assert pick_auto_model("fast", available) == "qwen/qwen3.5-flash-02-23"


def test_pick_auto_fast_empty_cache_uses_benchmarked_qwen_default():
    assert pick_auto_model("fast", set()) == "qwen/qwen3.5-flash-02-23"


def test_screen_default_uses_quality_first_vision_model():
    assert model_router.SCREEN_DEFAULT_MODEL == "openai/gpt-5.6-sol"


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


def test_pick_auto_feedback_prefers_low_latency_model():
    available = {
        "openai/gpt-4o",
        "openai/gpt-5.6-sol",
        "openai/gpt-4o-mini",
    }

    assert pick_auto_model("feedback", available) == "openai/gpt-4o-mini"


def test_pick_auto_feedback_empty_cache_uses_low_latency_default():
    assert pick_auto_model("feedback", set()) == "openai/gpt-4o-mini"


def test_resolve_vacancy_ignores_dedicated_setting_when_explicit():
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
    assert source == "manual"


def test_resolve_vacancy_uses_manual_setting():
    prefs = AiPreferencesModel(
        vacancy_review_model="openai/gpt-5.5",
        models_cache=[],
    )

    model, source = resolve_model(
        "vacancy",
        prefs=prefs,
        available={"openai/gpt-4o", "openai/gpt-5.5"},
    )

    assert model == "openai/gpt-5.5"
    assert source == "manual"


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


def test_resolve_client_override_is_used():
    prefs = AiPreferencesModel(default_copilot_model="auto")
    model, source = resolve_model(
        "general",
        model_override="anthropic/claude-3.5-sonnet",
        prefs=prefs,
        available={"openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"},
    )
    assert model == "anthropic/claude-3.5-sonnet"
    assert source == "manual"


def test_resolve_manual_setting_is_used_even_when_catalog_is_stale():
    prefs = AiPreferencesModel(default_copilot_model="missing/model")
    model, source = resolve_model(
        "general",
        prefs=prefs,
        available={"openai/gpt-4o-mini"},
    )
    assert model == "missing/model"
    assert source == "manual"
