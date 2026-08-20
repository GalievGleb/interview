import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("provider_health.py")
SPEC = importlib.util.spec_from_file_location("provider_health", MODULE_PATH)
provider_health = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(provider_health)


def test_rejects_openrouter_key_sent_to_another_provider():
    result = provider_health.evaluate_provider(
        upstream_base="https://api.proxyapi.ru/openai/v1",
        key_prefix="sk-or-v1-",
        total_credits=20.0,
        total_usage=10.0,
        warning_threshold=1.0,
    )

    assert result == (False, "OpenRouter key is routed to a non-OpenRouter upstream")


def test_warns_before_openrouter_balance_reaches_zero():
    result = provider_health.evaluate_provider(
        upstream_base="https://openrouter.ai/api/v1",
        key_prefix="sk-or-v1-",
        total_credits=20.0,
        total_usage=19.25,
        warning_threshold=1.0,
    )

    assert result == (False, "OpenRouter balance is low: $0.75 remaining")


def test_accepts_matching_provider_with_safe_balance():
    result = provider_health.evaluate_provider(
        upstream_base="https://openrouter.ai/api/v1",
        key_prefix="sk-or-v1-",
        total_credits=20.0,
        total_usage=16.9,
        warning_threshold=1.0,
    )

    assert result == (True, "OpenRouter ready: $3.10 remaining")
