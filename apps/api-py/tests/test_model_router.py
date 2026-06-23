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
