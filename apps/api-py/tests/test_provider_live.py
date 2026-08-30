"""Тесты live-стрима провайдера."""

from app.services.provider_adapter import (
    is_thinking_model,
    live_stream_options,
    screen_stream_options,
    vacancy_eval_options,
)


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


def test_live_stream_options_disables_optional_qwen_reasoning():
    tokens, reasoning = live_stream_options("qwen/qwen3.5-flash-02-23")

    assert tokens == 750
    assert reasoning == {"effort": "none", "exclude": True}


def test_vacancy_feedback_gpt56_is_quality_first():
    tokens, reasoning = vacancy_eval_options("openai/gpt-5.6-sol")

    assert tokens >= 6000
    assert reasoning == {"effort": "high", "exclude": True}


def test_vacancy_feedback_non_reasoning_fallback_keeps_output_room():
    tokens, reasoning = vacancy_eval_options("openai/gpt-4o")

    assert tokens >= 2000
    assert reasoning is None


def test_screen_gpt56_gets_deliberate_reasoning_and_code_room():
    tokens, reasoning = screen_stream_options("openai/gpt-5.6-sol")

    assert tokens >= 1800
    assert reasoning == {"effort": "medium", "exclude": True}


def test_screen_non_reasoning_model_keeps_normal_budget():
    tokens, reasoning = screen_stream_options("openai/gpt-4.1")

    assert tokens >= 1200
    assert reasoning is None
