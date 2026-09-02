"""Unit tests for provider_adapter prompt caching + transient retry.

No real LLM endpoint is hit — get_client / _resolve are monkeypatched.
"""

import asyncio
import json

import httpx
import pytest

from app.core.errors import AppError
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


class _StreamResp:
    def __init__(self, lines: list[str], status_code: int = 200):
        self.lines = lines
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def aread(self) -> bytes:
        return b""

    async def aiter_lines(self):
        for line in self.lines:
            yield line


class _StreamingClient:
    def __init__(self, attempts: list[list[str]]):
        self.attempts = attempts
        self.calls = 0

    def stream(self, *_args, **_kwargs):
        lines = self.attempts[min(self.calls, len(self.attempts) - 1)]
        self.calls += 1
        return _StreamResp(lines)


def _sse_chunk(delta: dict, *, finish_reason=None) -> str:
    payload = {"choices": [{"delta": delta, "finish_reason": finish_reason}]}
    return f"data: {json.dumps(payload)}"


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


def test_fast_routing_option_is_sent_to_openrouter_and_managed_gateway(monkeypatch):
    monkeypatch.setattr(
        provider_adapter,
        "get_settings",
        lambda: type(
            "Settings",
            (),
            {"skillcue_gateway_url": "https://skill-cue.ru/v1"},
        )(),
    )
    assert provider_adapter._supports_openrouter_routing(
        "openrouter", "https://openrouter.ai/api/v1"
    )
    assert provider_adapter._supports_openrouter_routing("openrouter", "https://skill-cue.ru/v1")
    assert not provider_adapter._supports_openrouter_routing(
        "openrouter", "https://untrusted-compatible.example/v1"
    )
    assert not provider_adapter._supports_openrouter_routing("openai", "https://api.openai.com/v1")


@pytest.mark.parametrize("phase", ["observation", "answer", "repair"])
def test_structured_screen_headers_are_sent_only_to_exact_managed_gateway(monkeypatch, phase):
    captured: dict = {}

    class CapClient:
        async def post(self, url, headers=None, json=None, timeout=None):
            captured.update(url=url, headers=headers, json=json)
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    async def fake_resolve(_provider):
        return "openrouter", "https://skill-cue.ru/v1/", "license"

    monkeypatch.setattr(provider_adapter, "_resolve", fake_resolve)
    monkeypatch.setattr(provider_adapter, "get_client", lambda: CapClient())
    monkeypatch.setattr(
        provider_adapter,
        "get_settings",
        lambda: type("Settings", (), {"skillcue_gateway_url": "https://skill-cue.ru/v1"})(),
    )

    out = asyncio.run(
        provider_adapter.complete(
            [{"role": "user", "content": "q"}],
            provider="openrouter",
            model="openai/gpt-5.6-sol",
            screen_workload_phase=phase,
        )
    )

    assert out == "ok"
    assert captured["headers"]["X-SkillCue-Workload"] == "structured-screen-v1"
    assert captured["headers"]["X-SkillCue-Screen-Phase"] == phase
    assert "X-SkillCue-Workload" not in captured["json"]
    assert "X-SkillCue-Screen-Phase" not in captured["json"]


@pytest.mark.parametrize(
    ("provider", "base_url"),
    [
        ("openai", "https://api.openai.com/v1"),
        ("openrouter", "https://openrouter.ai/api/v1"),
        ("openrouter", "https://compatible.example/v1"),
    ],
)
def test_structured_screen_headers_never_leave_managed_gateway(monkeypatch, provider, base_url):
    captured: dict = {}

    class CapClient:
        async def post(self, url, headers=None, json=None, timeout=None):
            captured.update(headers=headers, json=json)
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    async def fake_resolve(_provider):
        return provider, base_url, "byok"

    monkeypatch.setattr(provider_adapter, "_resolve", fake_resolve)
    monkeypatch.setattr(provider_adapter, "get_client", lambda: CapClient())
    monkeypatch.setattr(
        provider_adapter,
        "get_settings",
        lambda: type("Settings", (), {"skillcue_gateway_url": "https://skill-cue.ru/v1"})(),
    )

    asyncio.run(
        provider_adapter.complete(
            [{"role": "user", "content": "q"}],
            provider=provider,
            model="openai/gpt-5.6-sol",
            screen_workload_phase="answer",
        )
    )

    assert "X-SkillCue-Workload" not in captured["headers"]
    assert "X-SkillCue-Screen-Phase" not in captured["headers"]
    assert "X-SkillCue-Workload" not in captured["json"]
    assert "X-SkillCue-Screen-Phase" not in captured["json"]


def test_invalid_structured_screen_phase_fails_before_network(monkeypatch):
    class ForbiddenClient:
        async def post(self, *_args, **_kwargs):
            raise AssertionError("network must not be reached")

    async def fake_resolve(_provider):
        return "openrouter", "https://skill-cue.ru/v1", "license"

    monkeypatch.setattr(provider_adapter, "_resolve", fake_resolve)
    monkeypatch.setattr(provider_adapter, "get_client", lambda: ForbiddenClient())
    monkeypatch.setattr(
        provider_adapter,
        "get_settings",
        lambda: type("Settings", (), {"skillcue_gateway_url": "https://skill-cue.ru/v1"})(),
    )

    with pytest.raises(ValueError, match="screen workload phase"):
        asyncio.run(
            provider_adapter.complete(
                [{"role": "user", "content": "q"}],
                model="openai/gpt-5.6-sol",
                screen_workload_phase="dev-bypass",
            )
        )


# --- retry ----------------------------------------------------------------
def _patch_common(monkeypatch, client):
    async def fake_resolve(_p):
        return ("openrouter", "http://x", "k")

    monkeypatch.setattr(provider_adapter, "_resolve", fake_resolve)
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


def test_stream_retries_successful_response_with_no_visible_content(monkeypatch):
    client = _StreamingClient(
        [
            [_sse_chunk({"reasoning": "hidden"}), "data: [DONE]"],
            [_sse_chunk({"content": "Готовый ответ"}), "data: [DONE]"],
        ]
    )
    _patch_common(monkeypatch, client)

    async def collect() -> str:
        chunks = [
            chunk
            async for chunk in provider_adapter.stream_chat(
                [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
            )
        ]
        return "".join(chunks)

    assert asyncio.run(collect()) == "Готовый ответ"
    assert client.calls == 2


def test_stream_keeps_content_when_reasoning_is_in_the_same_delta(monkeypatch):
    client = _StreamingClient(
        [[_sse_chunk({"reasoning": "hidden", "content": "Видимый ответ"}), "data: [DONE]"]]
    )
    _patch_common(monkeypatch, client)

    async def collect() -> str:
        return "".join(
            [
                chunk
                async for chunk in provider_adapter.stream_chat(
                    [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
                )
            ]
        )

    assert asyncio.run(collect()) == "Видимый ответ"
    assert client.calls == 1


def test_stream_require_complete_raises_on_length_after_preserving_partial(monkeypatch):
    client = _StreamingClient(
        [
            [
                _sse_chunk({"content": "```sql\nSELECT 1"}),
                _sse_chunk({}, finish_reason="length"),
                "data: [DONE]",
            ]
        ]
    )
    _patch_common(monkeypatch, client)
    partial: list[str] = []

    async def collect() -> None:
        async for chunk in provider_adapter.stream_chat(
            [{"role": "user", "content": "q"}],
            model="openai/gpt-4.1",
            require_complete=True,
        ):
            partial.append(chunk)

    with pytest.raises(AppError) as raised:
        asyncio.run(collect())

    assert "".join(partial) == "```sql\nSELECT 1"
    assert raised.value.code == "provider_output_truncated"
    assert client.calls == 1


def test_stream_default_keeps_existing_length_compatibility(monkeypatch):
    client = _StreamingClient(
        [
            [
                _sse_chunk({"content": "Короткий ответ"}),
                _sse_chunk({}, finish_reason="length"),
                "data: [DONE]",
            ]
        ]
    )
    _patch_common(monkeypatch, client)

    async def collect() -> str:
        return "".join(
            [
                chunk
                async for chunk in provider_adapter.stream_chat(
                    [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
                )
            ]
        )

    assert asyncio.run(collect()) == "Короткий ответ"
    assert client.calls == 1


def test_stream_repeated_rate_limit_retains_rate_limited_cause(monkeypatch):
    client = _StreamingClient([[], [], []])
    for response in client.attempts:
        response.append("data: [DONE]")
    # A response status, rather than an arbitrary exception string, is the
    # trusted source for the stable failure code.
    client.stream = lambda *_args, **_kwargs: _StreamResp([], status_code=429)  # type: ignore[method-assign]
    _patch_common(monkeypatch, client)

    async def collect() -> None:
        async for _chunk in provider_adapter.stream_chat(
            [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
        ):
            pass

    with pytest.raises(AppError) as raised:
        asyncio.run(collect())

    assert raised.value.code == "rate_limited"
    assert raised.value.status_code == 429


def test_stream_repeated_5xx_retains_provider_timeout_cause(monkeypatch):
    client = _StreamingClient([[], [], []])
    client.stream = lambda *_args, **_kwargs: _StreamResp([], status_code=503)  # type: ignore[method-assign]
    _patch_common(monkeypatch, client)

    async def collect() -> None:
        async for _chunk in provider_adapter.stream_chat(
            [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
        ):
            pass

    with pytest.raises(AppError) as raised:
        asyncio.run(collect())

    assert raised.value.code == "provider_timeout"
    assert raised.value.status_code == 503


def test_stream_repeated_precontent_transport_failure_retains_provider_timeout(monkeypatch):
    class Client:
        calls = 0

        def stream(self, *_args, **_kwargs):
            self.calls += 1
            raise httpx.ConnectError("PRIVATE transport detail")

    client = Client()
    _patch_common(monkeypatch, client)

    async def collect() -> None:
        async for _chunk in provider_adapter.stream_chat(
            [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
        ):
            pass

    with pytest.raises(AppError) as raised:
        asyncio.run(collect())

    assert raised.value.code == "provider_timeout"
    assert client.calls == 3


def test_stream_post_chunk_transport_failure_is_not_retried(monkeypatch):
    class BrokenAfterChunk(_StreamResp):
        async def aiter_lines(self):
            yield _sse_chunk({"content": "visible"})
            raise httpx.ReadError("PRIVATE upstream body")

    class Client:
        calls = 0

        def stream(self, *_args, **_kwargs):
            self.calls += 1
            return BrokenAfterChunk([])

    client = Client()
    _patch_common(monkeypatch, client)
    chunks: list[str] = []

    async def collect() -> None:
        async for chunk in provider_adapter.stream_chat(
            [{"role": "user", "content": "q"}], model="openai/gpt-4.1"
        ):
            chunks.append(chunk)

    with pytest.raises(AppError) as raised:
        asyncio.run(collect())

    assert chunks == ["visible"]
    assert raised.value.code == "provider_timeout"
    assert client.calls == 1


def test_direct_openai_gpt5_uses_native_reasoning_and_completion_fields(monkeypatch):
    captured: dict = {}

    class CapClient:
        async def post(self, _url, headers=None, json=None, timeout=None):
            captured["json"] = json
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    async def fake_openai_resolve(_p):
        return ("openai", "https://api.openai.test/v1", "k")

    monkeypatch.setattr(provider_adapter, "_resolve", fake_openai_resolve)
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
    assert "temperature" not in captured["json"]
    assert captured["json"]["response_format"] == {"type": "json_object"}


def test_direct_openai_gpt5_stream_omits_unsupported_temperature(monkeypatch):
    captured: dict = {}

    class CapStreamingClient:
        def stream(self, _method, _url, **kwargs):
            captured["json"] = kwargs["json"]
            return _StreamResp([_sse_chunk({"content": "ok"}), "data: [DONE]"])

    async def fake_openai_resolve(_provider):
        return ("openai", "https://api.openai.test/v1", "k")

    monkeypatch.setattr(provider_adapter, "_resolve", fake_openai_resolve)
    monkeypatch.setattr(provider_adapter, "get_client", lambda: CapStreamingClient())

    async def collect() -> str:
        return "".join(
            [
                chunk
                async for chunk in provider_adapter.stream_chat(
                    [{"role": "user", "content": "q"}],
                    provider="openai",
                    model="openai/gpt-5.6-sol",
                    max_tokens=4200,
                    temperature=0.0,
                    reasoning={"effort": "medium", "exclude": True},
                    require_complete=True,
                )
            ]
        )

    assert asyncio.run(collect()) == "ok"
    assert captured["json"]["model"] == "gpt-5.6-sol"
    assert captured["json"]["reasoning_effort"] == "medium"
    assert captured["json"]["max_completion_tokens"] == 4200
    assert "temperature" not in captured["json"]


def test_openrouter_keeps_unified_reasoning_shape(monkeypatch):
    captured: dict = {}

    class CapClient:
        async def post(self, _url, headers=None, json=None, timeout=None):
            captured["json"] = json
            return _Resp(200, {"choices": [{"message": {"content": "ok"}}]})

    async def fake_router_resolve(_p):
        return ("openrouter", "https://router.test/v1", "k")

    monkeypatch.setattr(provider_adapter, "_resolve", fake_router_resolve)
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


def test_complete_honors_route_specific_retry_budget(monkeypatch):
    timeouts: list[float] = []

    class Client:
        async def post(self, *_args, timeout=None, **_kwargs):
            timeouts.append(timeout)
            return _Resp(503, text="busy")

    client = Client()
    _patch_common(monkeypatch, client)

    try:
        asyncio.run(
            provider_adapter.complete(
                [{"role": "user", "content": "q"}],
                model="gpt-4o-mini",
                request_timeout_seconds=20.0,
                max_attempts=2,
            )
        )
    except Exception as exc:  # noqa: BLE001
        assert getattr(exc, "code", "") == "provider_timeout"
    else:
        raise AssertionError("expected failure after route-specific retries")

    assert timeouts == [20.0, 20.0]
    assert provider_adapter.completion_retry_budget_seconds(20.0, 2) == 40.4


def test_complete_strictly_cancels_each_hung_attempt(monkeypatch):
    calls = 0
    cancellations = 0

    class HungClient:
        async def post(self, *_args, **_kwargs):
            nonlocal calls, cancellations
            calls += 1
            try:
                await asyncio.Event().wait()
            finally:
                cancellations += 1

    client = HungClient()
    _patch_common(monkeypatch, client)

    async def run_with_test_guard():
        return await asyncio.wait_for(
            provider_adapter.complete(
                [{"role": "user", "content": "q"}],
                model="gpt-4o-mini",
                request_timeout_seconds=0.005,
                max_attempts=2,
            ),
            timeout=0.2,
        )

    try:
        asyncio.run(run_with_test_guard())
    except Exception as exc:  # noqa: BLE001
        assert getattr(exc, "code", "") == "provider_timeout"
    else:
        raise AssertionError("expected hung attempts to hit the strict timeout")

    assert calls == 2
    assert cancellations == 2


# --- local LLM (Ollama, keyless) ------------------------------------------
async def test_ollama_resolve_is_keyless():
    provider, base_url, key = await provider_adapter._resolve("ollama")
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


def test_unsupported_provider_option_has_a_readable_error():
    err = provider_adapter.parse_provider_error(
        400,
        '{"error":{"message":"Unrecognized request argument supplied: provider"}}',
    )
    assert err.code == "unsupported_provider_option"
    assert "несовместимый параметр" in err.message.lower()
