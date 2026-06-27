import asyncio
import json
import logging
import os
from collections.abc import AsyncGenerator

import httpx

from app.config import get_settings
from app.core.errors import AppError
from app.services import secrets
from app.services.preferences import DEFAULT_BASE_URL, load_preferences

logger = logging.getLogger("provider")

# Persistent pooled HTTP client: reusing keep-alive connections avoids a fresh
# TLS handshake on every LLM call, cutting ~100-400ms off time-to-first-token.
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0, read=120.0),
            limits=httpx.Limits(
                max_keepalive_connections=10,
                max_connections=20,
                keepalive_expiry=300.0,
            ),
        )
    return _client


async def aclose_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


PROVIDER_CONFIG: dict[str, dict] = {
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "key_name": "openai_api_key",
    },
    "openrouter": {
        "base_url": DEFAULT_BASE_URL,
        "key_name": "openrouter_api_key",
    },
    # Local LLM via Ollama's OpenAI-compatible endpoint — keyless, never used in
    # the live answer path (only the offline review/summary features).
    "ollama": {
        "base_url": "http://127.0.0.1:11434/v1",
        "key_name": None,
        "keyless": True,
    },
}


def _base_url(provider: str) -> str:
    if provider == "openrouter":
        prefs = load_preferences()
        return prefs.base_url or PROVIDER_CONFIG["openrouter"]["base_url"]
    if provider == "ollama":
        return os.environ.get("OLLAMA_BASE_URL") or PROVIDER_CONFIG["ollama"]["base_url"]
    return PROVIDER_CONFIG[provider]["base_url"]


def parse_provider_error(status: int, body: str, provider: str = "openrouter") -> AppError:
    low = body.lower()
    if status == 401:
        return AppError(
            f"Неверный API key ({provider}). Проверьте ключ в настройках.",
            401,
            "invalid_api_key",
        )
    if status == 402 or "insufficient" in low or "credit" in low:
        return AppError(
            "Недостаточно кредитов провайдера. Пополните баланс.",
            402,
            "insufficient_credits",
        )
    if status == 429:
        return AppError(
            "Превышен лимит запросов. Подождите и повторите.",
            429,
            "rate_limited",
        )
    if status == 404 and "model" in low:
        return AppError(
            "Выбранная модель недоступна. Выберите другую или Auto Select.",
            404,
            "model_unavailable",
        )
    if status >= 500:
        return AppError(
            "Провайдер временно недоступен. Повторите позже.",
            status,
            "provider_timeout",
        )
    return AppError(f"Ошибка провайдера: {body[:200]}", status, "provider_error")


def _resolve(provider: str | None) -> tuple[str, str, str]:
    settings = get_settings()
    provider = provider or settings.default_provider
    if provider not in PROVIDER_CONFIG:
        raise AppError(f"Unknown provider: {provider}", 400, "unknown_provider")
    cfg = PROVIDER_CONFIG[provider]
    if cfg.get("keyless"):
        return provider, _base_url(provider), ""
    key = secrets.get_secret(cfg["key_name"])
    if not key:
        raise AppError(
            f"API key for {provider} is not set. Add it in Settings.",
            400,
            "missing_api_key",
        )
    return provider, _base_url(provider), key


def _headers(provider: str, key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if key:  # keyless providers (Ollama) send no Authorization header
        headers["Authorization"] = f"Bearer {key}"
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://localhost"
        headers["X-Title"] = "Interview Copilot"
    return headers


# --- transient-failure retry (hot path) ---
_MAX_ATTEMPTS = 3
_RETRY_STATUS = {429, 500, 502, 503, 504}


def _backoff(attempt: int) -> float:
    return 0.4 * (2**attempt)


def apply_prompt_cache(messages: list[dict], model: str) -> list[dict]:
    """Mark the leading system prompt as cacheable for providers with explicit
    cache breakpoints (Anthropic via OpenRouter). OpenAI-family models cache long
    stable prefixes automatically, so they are returned unchanged."""
    if "anthropic" not in (model or "").lower():
        return messages
    out: list[dict] = []
    marked = False
    for m in messages:
        if not marked and m.get("role") == "system" and isinstance(m.get("content"), str):
            out.append(
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": m["content"],
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                }
            )
            marked = True
        else:
            out.append(m)
    return out


async def _post_with_retry(base_url: str, provider: str, key: str, payload: dict) -> httpx.Response:
    """POST with bounded retry on transient transport errors / 429 / 5xx."""
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = await get_client().post(
                f"{base_url}/chat/completions",
                headers=_headers(provider, key),
                json=payload,
                timeout=120,
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            if attempt >= _MAX_ATTEMPTS - 1:
                raise AppError(
                    "Провайдер не отвечает. Повторите позже.", 504, "provider_timeout"
                ) from exc
            await asyncio.sleep(_backoff(attempt))
            continue
        if resp.status_code in _RETRY_STATUS and attempt < _MAX_ATTEMPTS - 1:
            await asyncio.sleep(_backoff(attempt))
            continue
        return resp
    raise AppError("Провайдер не отвечает. Повторите позже.", 504, "provider_timeout")


THINKING_MODEL_MARKERS = (
    "gemini-2.5",
    "gemini-3",
    "gemini-3.",
    "/o1",
    "/o3",
    "thinking",
    "reasoner",
)


def is_thinking_model(model_id: str) -> bool:
    low = model_id.lower()
    return any(m in low for m in THINKING_MODEL_MARKERS)


def live_stream_options(model_id: str) -> tuple[int, dict | None]:
    """max_tokens и reasoning для live — thinking-модели жрут лимит на скрытый reasoning."""
    if is_thinking_model(model_id):
        return 1800, {"effort": "minimal", "exclude": True}
    return 750, None


async def test_provider(provider: str | None, model: str | None) -> dict:
    provider, base_url, key = _resolve(provider)
    settings = get_settings()
    model = model or settings.default_model
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 5,
    }
    resp = await get_client().post(
        f"{base_url}/chat/completions",
        headers=_headers(provider, key),
        json=payload,
        timeout=30,
    )
    if resp.status_code >= 400:
        raise parse_provider_error(resp.status_code, resp.text, provider)
    return {"ok": True, "provider": provider, "model": model}


async def list_models(provider: str | None) -> list[str]:
    provider, base_url, key = _resolve(provider)
    resp = await get_client().get(f"{base_url}/models", headers=_headers(provider, key), timeout=30)
    if resp.status_code >= 400:
        raise parse_provider_error(resp.status_code, resp.text, provider)
    data = resp.json()
    items = data.get("data", [])
    return sorted(item.get("id", "") for item in items if item.get("id"))


class _StreamRetry(Exception):
    """Internal: the stream failed before any content arrived — safe to retry."""


async def _one_stream_attempt(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    payload: dict,
    provider: str,
    model: str,
) -> AsyncGenerator[str, None]:
    """A single streaming attempt. Raises _StreamRetry only before any content is
    produced; once tokens have been yielded a failure is terminal (no re-emit)."""
    produced = False
    try:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                if resp.status_code in _RETRY_STATUS:
                    raise _StreamRetry()
                raise parse_provider_error(resp.status_code, body.decode(), provider)
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if chunk.get("error"):
                    err = chunk["error"]
                    msg = err.get("message") if isinstance(err, dict) else str(err)
                    raise AppError(msg or "Stream error", 502, "provider_error")
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get("delta") or {}
                if delta.get("reasoning"):
                    continue
                content = delta.get("content") or delta.get("text")
                if not content and choice.get("message"):
                    content = choice.get("message", {}).get("content")
                if content:
                    produced = True
                    yield content
                finish = choice.get("finish_reason")
                if finish == "length":
                    logger.warning("Stream stopped: max_tokens reached for model %s", model)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        if produced:
            raise AppError("Соединение с провайдером прервалось.", 504, "provider_timeout") from exc
        raise _StreamRetry() from exc


async def stream_chat(
    messages: list[dict],
    provider: str | None = None,
    model: str | None = None,
    max_tokens: int = 800,
    temperature: float = 0.4,
    *,
    live_fast: bool = False,
    route_fast: bool = False,
) -> AsyncGenerator[str, None]:
    provider, base_url, key = _resolve(provider)
    settings = get_settings()
    model = model or settings.default_model
    reasoning: dict | None = None
    if live_fast:
        max_tokens, reasoning = live_stream_options(model)
    payload: dict = {
        "model": model,
        "messages": apply_prompt_cache(messages, model),
        "stream": True,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if reasoning:
        payload["reasoning"] = reasoning
    # Ask OpenRouter to prefer the highest-throughput upstream provider for the
    # lowest time-to-first-token (fast-answer mode only).
    if route_fast and provider == "openrouter":
        payload["provider"] = {"sort": "throughput"}

    client = get_client()
    url = f"{base_url}/chat/completions"
    headers = _headers(provider, key)

    for attempt in range(_MAX_ATTEMPTS):
        try:
            async for piece in _one_stream_attempt(client, url, headers, payload, provider, model):
                yield piece
            return
        except _StreamRetry as exc:
            if attempt >= _MAX_ATTEMPTS - 1:
                raise AppError(
                    "Провайдер не отвечает. Повторите позже.", 504, "provider_timeout"
                ) from exc
            await asyncio.sleep(_backoff(attempt))
            continue


async def complete(
    messages: list[dict],
    provider: str | None = None,
    model: str | None = None,
    max_tokens: int = 800,
    temperature: float = 0.4,
) -> str:
    """Неблокирующий полный ответ (для JSON-режима интервью)."""
    provider, base_url, key = _resolve(provider)
    settings = get_settings()
    model = model or settings.default_model
    payload = {
        "model": model,
        "messages": apply_prompt_cache(messages, model),
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    resp = await _post_with_retry(base_url, provider, key, payload)
    if resp.status_code >= 400:
        raise parse_provider_error(resp.status_code, resp.text, provider)
    data = resp.json()
    return data["choices"][0]["message"]["content"]


async def embed(texts: list[str], provider: str | None = None) -> list[list[float]]:
    settings = get_settings()
    provider = provider or settings.embedding_provider
    if provider != "openai":
        raise AppError("Only OpenAI embeddings are supported in MVP", 400, "embed_unsupported")
    key = secrets.get_secret("openai_api_key")
    if not key:
        raise AppError("OpenAI key required for embeddings", 400, "missing_api_key")
    payload = {"model": settings.embedding_model, "input": texts}
    resp = await get_client().post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    if resp.status_code >= 400:
        raise AppError(f"Embedding error: {resp.text[:200]}", resp.status_code, "provider_error")
    data = resp.json()
    return [item["embedding"] for item in data["data"]]
