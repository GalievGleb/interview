"""Unit tests for provider_adapter prompt caching + transient retry.

No real LLM endpoint is hit — get_client / _resolve are monkeypatched.
"""

import asyncio

import httpx

from app.services import provider_adapter


class _Resp:
    def __init__(self, status: int, payload: dict | None = None, text: str = ""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text

    def json(self) -> dict:
        return self._payload


class _Client:
    """Replays a script of responses/exceptions across successive .post calls."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    async def post(self, *_args, **_kwargs):
        item = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        if isinstance(item, Exception):
            raise item
        return item


# --- prompt caching -------------------------------------------------------
def test_apply_prompt_cache_marks_system_for_anthropic():
    msgs = [{"role": "system", "content": "BIG CONTEXT"}, {"role": "user", "content": "q"}]
    out = provider_adapter.apply_prompt_cache(msgs, "anthropic/claude-sonnet-4")
    block = out[0]["content"][0]
    assert block["text"] == "BIG CONTEXT"
    assert block["cache_control"] == {"type": "ephemeral"}
    assert out[1] == {"role": "user", "content": "q"}  # other messages untouched


def test_apply_prompt_cache_noop_for_openai():
    msgs = [{"role": "system", "content": "BIG"}, {"role": "user", "content": "q"}]
    assert provider_adapter.apply_prompt_cache(msgs, "openai/gpt-4o-mini") == msgs


# --- retry ----------------------------------------------------------------
def _patch_common(monkeypatch, client):
    monkeypatch.setattr(provider_adapter, "_resolve", lambda p: ("openrouter", "http://x", "k"))
    monkeypatch.setattr(provider_adapter, "get_client", lambda: client)

    async def _no_sleep(_seconds):
        return None

    monkeypatch.setattr(provider_adapter.asyncio, "sleep", _no_sleep)


def test_complete_retries_on_5xx(monkeypatch):
    client = _Client(
        [_Resp(503, text="busy"), _Resp(200, {"choices": [{"message": {"content": "hi"}}]})]
    )
    _patch_common(monkeypatch, client)
    out = asyncio.run(
        provider_adapter.complete([{"role": "user", "content": "q"}], model="gpt-4o-mini")
    )
    assert out == "hi"
    assert client.calls == 2


def test_complete_retries_on_transport_error(monkeypatch):
    client = _Client(
        [httpx.ConnectError("boom"), _Resp(200, {"choices": [{"message": {"content": "ok"}}]})]
    )
    _patch_common(monkeypatch, client)
    out = asyncio.run(
        provider_adapter.complete([{"role": "user", "content": "q"}], model="gpt-4o-mini")
    )
    assert out == "ok"
    assert client.calls == 2


def test_direct_openai_gpt5_uses_native_reasoning_and_completion_fields(monkeypatch):
    captured: dict = {}

    class CapClient:
        async def post(self, _url, headers=None, json=None, timeout=None):
            captured["json"] = json
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    monkeypatch.setattr(
        provider_adapter, "_resolve", lambda _p: ("openai", "https://api.openai.test/v1", "k")
    )
    monkeypatch.setattr(provider_adapter, "get_client", lambda: CapClient())

    out = asyncio.run(
        provider_adapter.complete(
            [{"role": "user", "content": "q"}],
            provider="openai",
            model="openai/gpt-5.6-sol",
            max_tokens=6000,
            reasoning={"effort": "high", "exclude": True},
            response_format={"type": "json_object"},
        )
    )

    assert out == "ok"
    assert captured["json"]["model"] == "gpt-5.6-sol"
    assert captured["json"]["reasoning_effort"] == "high"
    assert captured["json"]["max_completion_tokens"] == 6000
    assert "reasoning" not in captured["json"]
    assert "max_tokens" not in captured["json"]
    assert captured["json"]["response_format"] == {"type": "json_object"}


def test_openrouter_keeps_unified_reasoning_shape(monkeypatch):
    captured: dict = {}

    class CapClient:
        async def post(self, _url, headers=None, json=None, timeout=None):
            captured["json"] = json
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    monkeypatch.setattr(
        provider_adapter, "_resolve", lambda _p: ("openrouter", "https://router.test/v1", "k")
    )
    monkeypatch.setattr(provider_adapter, "get_client", lambda: CapClient())

    asyncio.run(
        provider_adapter.complete(
            [{"role": "user", "content": "q"}],
            provider="openrouter",
            model="openai/gpt-5.6-sol",
            max_tokens=6000,
            reasoning={"effort": "high", "exclude": True},
        )
    )

    assert captured["json"]["reasoning"] == {"effort": "high", "exclude": True}
    assert captured["json"]["max_tokens"] == 6000
    assert "reasoning_effort" not in captured["json"]


def test_complete_gives_up_after_max_attempts(monkeypatch):
    client = _Client([_Resp(503, text="busy")] * 5)
    _patch_common(monkeypatch, client)
    try:
        asyncio.run(
            provider_adapter.complete([{"role": "user", "content": "q"}], model="gpt-4o-mini")
        )
    except Exception as exc:  # noqa: BLE001
        # parse_provider_error turns a final 503 into a provider_timeout AppError
        assert getattr(exc, "code", "") in {"provider_timeout", "provider_error"}
    else:
        raise AssertionError("expected failure after retries")
    assert client.calls == provider_adapter._MAX_ATTEMPTS


# --- local LLM (Ollama, keyless) ------------------------------------------
def test_ollama_resolve_is_keyless():
    provider, base_url, key = provider_adapter._resolve("ollama")
    assert provider == "ollama"
    assert key == ""  # no secret required
    assert "11434" in base_url


def test_ollama_headers_omit_authorization():
    headers = provider_adapter._headers("ollama", "")
    assert "Authorization" not in headers
    assert headers["Content-Type"] == "application/json"


def test_ollama_complete_targets_local_server(monkeypatch):
    """End-to-end shaping (no live server): real keyless resolve + headers, mocked POST."""
    captured: dict = {}

    class CapClient:
        async def post(self, url, headers=None, json=None, timeout=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    monkeypatch.setattr(provider_adapter, "get_client", lambda: CapClient())
    out = asyncio.run(
        provider_adapter.complete(
            [{"role": "user", "content": "q"}], provider="ollama", model="llama3.1"
        )
    )
    assert out == "ok"
    assert "11434" in captured["url"]
    assert "Authorization" not in captured["headers"]
    assert captured["json"]["model"] == "llama3.1"


# --- token usage capture ----------------------------------------------------
def test_complete_captures_usage(monkeypatch):
    client = _Client(
        [
            _Resp(
                200,
                {
                    "choices": [{"message": {"content": "hi"}}],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 45},
                },
            )
        ]
    )
    _patch_common(monkeypatch, client)

    async def run():
        # pop — в той же корутине, как это делают роутеры (contextvar per-task).
        out = await provider_adapter.complete(
            [{"role": "user", "content": "q"}], model="gpt-4o-mini"
        )
        return out, provider_adapter.pop_last_usage(), provider_adapter.pop_last_usage()

    out, usage, again = asyncio.run(run())
    assert out == "hi"
    assert usage == {"prompt_tokens": 120, "completion_tokens": 45}
    assert again is None  # pop очищает


def test_gateway_errors_pass_through_with_own_message():
    """Ошибки нашего гейтвея (лицензия) доходят до покупателя дословно, а не как
    generic-текст провайдера («пополните баланс провайдера»)."""
    import json

    quota_body = json.dumps(
        {
            "error": {
                "message": "Месячный лимит токенов тарифа исчерпан.",
                "code": "token_quota_exceeded",
            }
        },
        ensure_ascii=False,
    )
    err = provider_adapter.parse_provider_error(402, quota_body)
    assert err.code == "token_quota_exceeded"
    assert "лимит токенов" in err.message.lower()

    model_body = json.dumps(
        {
            "error": {
                "message": "Модель «openai/gpt-5.5» недоступна на этом тарифе.",
                "code": "model_not_allowed",
            }
        },
        ensure_ascii=False,
    )
    err = provider_adapter.parse_provider_error(403, model_body)
    assert err.code == "model_not_allowed"
    assert "недоступна" in err.message.lower()

    # Чужой провайдерский 402 (не наш код) идёт по обычному маппингу.
    generic = provider_adapter.parse_provider_error(
        402, '{"error":{"message":"insufficient credit"}}'
    )
    assert generic.code == "insufficient_credits"
