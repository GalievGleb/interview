import json
import logging
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


PROVIDER_CONFIG = {
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "key_name": "openai_api_key",
    },
    "openrouter": {
        "base_url": DEFAULT_BASE_URL,
        "key_name": "openrouter_api_key",
    },
}


def _base_url(provider: str) -> str:
    if provider == "openrouter":
        prefs = load_preferences()
        return prefs.base_url or PROVIDER_CONFIG["openrouter"]["base_url"]
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
    key = secrets.get_secret(cfg["key_name"])
    if not key:
        raise AppError(
            f"API key for {provider} is not set. Add it in Settings.",
            400,
            "missing_api_key",
        )
    return provider, _base_url(provider), key


def _headers(provider: str, key: str) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://localhost"
        headers["X-Title"] = "Interview Copilot"
    return headers


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
        "messages": messages,
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
    async with client.stream(
        "POST",
        f"{base_url}/chat/completions",
        headers=_headers(provider, key),
        json=payload,
    ) as resp:
        if resp.status_code >= 400:
            body = await resp.aread()
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
                yield content
            finish = choice.get("finish_reason")
            if finish == "length":
                logger.warning("Stream stopped: max_tokens reached for model %s", model)


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
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    resp = await get_client().post(
        f"{base_url}/chat/completions",
        headers=_headers(provider, key),
        json=payload,
        timeout=120,
    )
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
