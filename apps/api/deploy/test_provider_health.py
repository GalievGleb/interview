import importlib.util
import sys
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


def test_main_rejects_openrouter_host_with_stale_openai_style(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=sk-or-v1-test\n"
        "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openai",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        provider_health, "_openrouter_credits", lambda _key: (20.0, 10.0)
    )
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 1
    assert "style" in capsys.readouterr().out.lower()


def test_main_rejects_openai_host_with_stale_openrouter_style(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=openai-compatible-test\n"
        "GATEWAY_UPSTREAM_BASE=https://api.openai.com/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openrouter",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        provider_health, "_openrouter_credits", lambda _key: (20.0, 10.0)
    )
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 1
    assert "style" in capsys.readouterr().out.lower()


def test_main_checks_compatible_proxy_without_calling_openrouter_credits(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=compatible-proxy-key\n"
        "GATEWAY_UPSTREAM_BASE=https://api.proxyapi.ru/openai/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openai",
        encoding="utf-8",
    )

    def forbidden_credits_call(_key):
        raise AssertionError("OpenRouter credits must not be called for ProxyAPI")

    monkeypatch.setattr(provider_health, "_openrouter_credits", forbidden_credits_call)
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 0
    output = capsys.readouterr().out.lower()
    assert "compatible upstream" in output
    assert "openrouter ready" not in output


def test_compatible_upstream_rejects_malformed_and_plaintext_urls():
    for upstream in ("not-a-url", "http://proxy.example/v1"):
        ready, message = provider_health.evaluate_compatible_upstream(
            upstream_base=upstream,
            upstream_style="openai",
            key_prefix="other",
        )
        assert ready is False
        assert "https" in message.lower()


def test_openai_chat_readiness_prefers_dedicated_chat_credentials_without_exposing_key():
    ready, message = provider_health.evaluate_openai_chat_readiness(
        {
            "OPENAI_CHAT_API_KEY": "dedicated-secret-key",
            "OPENAI_CHAT_BASE_URL": "https://api.openai.com/v1",
            "OPENAI_API_KEY": "legacy-secret-key",
            "OPENAI_STT_BASE_URL": "https://stt.example/v1",
        }
    )

    assert ready is True
    assert "api.openai.com" in message
    assert "dedicated-secret-key" not in message
    assert "legacy-secret-key" not in message


def test_openai_chat_readiness_dedicated_key_defaults_to_official_base():
    ready, message = provider_health.evaluate_openai_chat_readiness(
        {
            "OPENAI_CHAT_API_KEY": "dedicated-secret-key",
            "OPENAI_STT_BASE_URL": "https://stt.example/v1",
            "OPENAI_API_KEY": "legacy-secret-key",
        }
    )

    assert ready is True
    assert "api.openai.com" in message


def test_openai_chat_readiness_rejects_partial_dedicated_configuration():
    ready, message = provider_health.evaluate_openai_chat_readiness(
        {
            "OPENAI_CHAT_BASE_URL": "https://api.openai.com/v1",
            "OPENAI_API_KEY": "legacy-secret-key",
            "OPENAI_STT_BASE_URL": "https://api.openai.com/v1",
        }
    )

    assert ready is False
    assert "partial" in message.lower()


def test_openai_chat_readiness_keeps_legacy_credentials_working():
    ready, message = provider_health.evaluate_openai_chat_readiness(
        {
            "OPENAI_API_KEY": "legacy-secret-key",
            "OPENAI_STT_BASE_URL": "https://api.openai.com/v1",
        }
    )

    assert ready is True
    assert "ready" in message.lower()


def test_openai_chat_readiness_is_optional_and_reports_missing_key():
    ready, message = provider_health.evaluate_openai_chat_readiness({})

    assert ready is False
    assert "not configured" in message.lower()


def test_main_exposes_openai_chat_readiness_without_printing_secret(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=sk-or-v1-test\n"
        "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openrouter\n"
        "OPENAI_CHAT_API_KEY=must-not-leak\n"
        "OPENAI_CHAT_BASE_URL=https://api.openai.com/v1",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        provider_health, "_openrouter_credits", lambda _key: (20.0, 10.0)
    )
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 0
    output = capsys.readouterr().out
    assert "OpenAI direct chat ready" in output
    assert "must-not-leak" not in output


def test_main_fails_when_direct_chat_is_required_but_missing(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=sk-or-v1-test\n"
        "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openrouter\n"
        "OPENAI_CHAT_REQUIRED=1",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        provider_health, "_openrouter_credits", lambda _key: (20.0, 10.0)
    )
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 1
    assert "not configured" in capsys.readouterr().out.lower()


def test_main_fails_when_explicit_direct_chat_configuration_is_invalid(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=sk-or-v1-test\n"
        "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openrouter\n"
        "OPENAI_CHAT_API_KEY=dedicated-test\n"
        "OPENAI_CHAT_BASE_URL=https://proxy.example/v1",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        provider_health, "_openrouter_credits", lambda _key: (20.0, 10.0)
    )
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 1
    assert "unavailable" in capsys.readouterr().out.lower()


def test_main_keeps_missing_optional_direct_chat_as_warning(
    monkeypatch, tmp_path, capsys
):
    env_path = tmp_path / "gateway.env"
    env_path.write_text(
        "OPENROUTER_API_KEY=sk-or-v1-test\n"
        "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1\n"
        "GATEWAY_UPSTREAM_STYLE=openrouter",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        provider_health, "_openrouter_credits", lambda _key: (20.0, 10.0)
    )
    monkeypatch.setattr(sys, "argv", ["provider_health.py", "--env", str(env_path)])

    assert provider_health.main() == 0
    assert "not configured" in capsys.readouterr().out.lower()
