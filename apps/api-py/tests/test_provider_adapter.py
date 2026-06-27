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
