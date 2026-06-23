"""Тесты live-стрима провайдера."""

from app.services.provider_adapter import is_thinking_model, live_stream_options


def test_thinking_model_detection():
    assert is_thinking_model("google/gemini-3.5-flash")
    assert is_thinking_model("google/gemini-2.5-flash")
    assert not is_thinking_model("openai/gpt-4o-mini")


def test_live_stream_options_thinking():
    tokens, reasoning = live_stream_options("google/gemini-3.5-flash")
    assert tokens >= 1500
    assert reasoning == {"effort": "minimal", "exclude": True}


def test_live_stream_options_fast():
    tokens, reasoning = live_stream_options("openai/gpt-4o-mini")
    assert tokens == 750
    assert reasoning is None
