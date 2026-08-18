import asyncio
import contextvars
import json
import logging
import os
import uuid
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


def _supports_openrouter_routing(provider: str, base_url: str) -> bool:
    """Return whether the endpoint accepts OpenRouter-only routing options."""
    return provider == "openrouter" and "openrouter.ai" in base_url.lower()


# Коды ошибок НАШЕГО гейтвея лицензий: у них уже есть готовое русское сообщение
# для покупателя — пробрасываем как есть, не подменяя на generic-текст провайдера
# (иначе «лимит тарифа исчерпан» превратился бы в «пополните баланс провайдера»).
_GATEWAY_ERROR_CODES = {
    "token_quota_exceeded",
    "model_not_allowed",
    "invalid_license",
    "gateway_unconfigured",
}


def _gateway_error(body: str) -> tuple[str, str] | None:
    try:
        err = (json.loads(body) or {}).get("error") or {}
    except (json.JSONDecodeError, AttributeError, TypeError):
        return None
    code, msg = err.get("code"), err.get("message")
    if code in _GATEWAY_ERROR_CODES and isinstance(msg, str) and msg.strip():
        return msg.strip(), code
    return None


def parse_provider_error(status: int, body: str, provider: str = "openrouter") -> AppError:
    passthrough = _gateway_error(body)
    if passthrough is not None:
        msg, code = passthrough
        return AppError(msg, status, code)
    low = body.lower()
    if status == 413:
        return AppError(
            "Снимок экрана оказался слишком большим. SkillCue уменьшит его — повторите запрос.",
            413,
            "image_too_large",
        )
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
    if status == 400 and "unrecognized request argument supplied" in low:
        return AppError(
            "Провайдер отклонил несовместимый параметр запроса. Повторите запрос.",
            400,
            "unsupported_provider_option",
        )
    if status >= 500:
        return AppError(
            "Провайдер временно недоступен. Повторите позже.",
            status,
            "provider_timeout",
        )
    return AppError(f"Ошибка провайдера: {body[:200]}", status, "provider_error")


# Гейтвей-фолбэк: кэш лицензии на минуту, чтобы не ходить в SQLite на каждый запрос.
_gateway_cache: dict = {"at": 0.0, "key": ""}
_gateway_cache_lock = asyncio.Lock()


def _stored_gateway_license_key() -> str:
    try:
        from app.db.models import AppMeta
        from app.db.session import SessionLocal
        from app.services.license import verify_license_key

        with SessionLocal() as db:
            row = db.get(AppMeta, "license_key")
            stored = (row.value if row else "").strip()
        return stored if stored and verify_license_key(stored) else ""
    except Exception:  # noqa: BLE001
        return ""


def _gateway_root_url(gateway_url: str) -> str:
    root = gateway_url.rstrip("/")
    return root[:-3] if root.endswith("/v1") else root


def _get_or_create_install_id() -> str:
    from app.db.models import AppMeta
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        row = db.get(AppMeta, "install_id")
        if row and row.value:
            return row.value
        value = str(uuid.uuid4())
        if row is None:
            db.add(AppMeta(key="install_id", value=value))
        else:
            row.value = value
        db.commit()
        return value


def _store_gateway_license_key(key: str, email: str = "") -> None:
    from app.db.models import AppMeta
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        for meta_key, value in (("license_key", key), ("license_email", email)):
            row = db.get(AppMeta, meta_key)
            if row is None:
                db.add(AppMeta(key=meta_key, value=value))
            else:
                row.value = value
        db.commit()


async def _claim_gateway_trial_key(gateway_url: str) -> str:
    try:
        install_id = _get_or_create_install_id()
        root = _gateway_root_url(gateway_url)
        client = get_client()
        resp = await client.post(f"{root}/gateway/trial", json={"clientId": install_id})
        if resp.status_code >= 400:
            logger.warning("gateway trial claim failed: %s %s", resp.status_code, resp.text[:200])
            return ""
        data = resp.json()
        key = str(data.get("key") or "").strip()
        if key:
            _store_gateway_license_key(key, str(data.get("email") or ""))
        return key
    except Exception as exc:  # noqa: BLE001
        logger.warning("gateway trial claim failed: %s", exc)
        return ""


async def _gateway_license_key() -> str:
    """Валидный лицензионный ключ из AppMeta (или ''), с минутным кэшем."""
    import time

    async with _gateway_cache_lock:
        now = time.monotonic()
        if now - _gateway_cache["at"] < 60:
            return _gateway_cache["key"]
        key = await asyncio.to_thread(_stored_gateway_license_key)
        if not key and get_settings().skillcue_gateway_url:
            key = await _claim_gateway_trial_key(get_settings().skillcue_gateway_url)
        _gateway_cache["at"] = now
        _gateway_cache["key"] = key
        return key


async def _resolve(provider: str | None) -> tuple[str, str, str]:
    settings = get_settings()
    provider = provider or settings.default_provider
    if provider not in PROVIDER_CONFIG:
        raise AppError(f"Unknown provider: {provider}", 400, "unknown_provider")
    cfg = PROVIDER_CONFIG[provider]
    if cfg.get("keyless"):
        return provider, _base_url(provider), ""
    key = secrets.get_secret(cfg["key_name"])
    if not key and provider == "openrouter" and settings.skillcue_gateway_url:
        # Покупательский путь: свой OpenRouter-ключ не нужен — валидная лицензия
        # открывает серверный гейтвей SkillCue (тот же OpenAI-совместимый API).
        license_key = await _gateway_license_key()
        if license_key:
            return provider, settings.skillcue_gateway_url.rstrip("/"), license_key
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


def _model_for_provider(provider: str, model: str) -> str:
    """OpenRouter uses provider/model IDs; direct OpenAI uses the bare slug."""
    if provider == "openai" and model.lower().startswith("openai/"):
        return model.split("/", 1)[1]
    return model


# Token usage последнего LLM-вызова в ЭТОМ асинхронном контексте (contextvar —
# безопасно при параллельных запросах). Роутеры забирают через pop_last_usage()
# сразу после вызова, чтобы записать реальные токены в ApiUsage.
_last_usage: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "llm_last_usage", default=None
)


def pop_last_usage() -> dict | None:
    """Usage последнего complete()/stream_chat() в текущем контексте (и сброс)."""
    usage = _last_usage.get()
    _last_usage.set(None)
    return usage


# --- transient-failure retry (hot path) ---
_MAX_ATTEMPTS = 3
_RETRY_STATUS = {429, 500, 502, 503, 504}
_COMPLETION_REQUEST_TIMEOUT_SECONDS = 120.0
_MIN_COMPLETION_REQUEST_TIMEOUT_SECONDS = 0.001


def _backoff(attempt: int) -> float:
    return 0.4 * (2**attempt)


def completion_retry_budget_seconds(
    request_timeout_seconds: float | None = None,
    max_attempts: int | None = None,
) -> float:
    """Worst-case wall-clock budget for one non-streaming completion.

    Routes with their own outer deadline use this helper so that deadline does
    not cancel the provider while its configured retry policy is still active.
    """
    attempt_timeout = max(
        _MIN_COMPLETION_REQUEST_TIMEOUT_SECONDS,
        float(
            _COMPLETION_REQUEST_TIMEOUT_SECONDS
            if request_timeout_seconds is None
            else request_timeout_seconds
        ),
    )
    attempts = max(1, int(_MAX_ATTEMPTS if max_attempts is None else max_attempts))
    return attempt_timeout * attempts + sum(_backoff(attempt) for attempt in range(attempts - 1))


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


async def _post_with_retry(
    base_url: str,
    provider: str,
    key: str,
    payload: dict,
    *,
    request_timeout_seconds: float | None = None,
    max_attempts: int | None = None,
) -> httpx.Response:
    """POST with bounded retry on transient transport errors / 429 / 5xx."""
    attempt_timeout = max(
        _MIN_COMPLETION_REQUEST_TIMEOUT_SECONDS,
        float(
            _COMPLETION_REQUEST_TIMEOUT_SECONDS
            if request_timeout_seconds is None
            else request_timeout_seconds
        ),
    )
    attempts = max(1, int(_MAX_ATTEMPTS if max_attempts is None else max_attempts))
    for attempt in range(attempts):
        try:
            resp = await asyncio.wait_for(
                get_client().post(
                    f"{base_url}/chat/completions",
                    headers=_headers(provider, key),
                    json=payload,
                    timeout=attempt_timeout,
                ),
                timeout=attempt_timeout,
            )
        except (TimeoutError, httpx.TimeoutException, httpx.TransportError) as exc:
            if attempt >= attempts - 1:
                raise AppError(
                    "Провайдер не отвечает. Повторите позже.", 504, "provider_timeout"
                ) from exc
            await asyncio.sleep(_backoff(attempt))
            continue
        if resp.status_code in _RETRY_STATUS and attempt < attempts - 1:
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
    # GPT-5-family models can default to non-trivial reasoning effort too;
    # OpenRouter's unified `reasoning` schema handles this uniformly, so
    # including it here is safe even for models where it's a no-op.
    "gpt-5",
)


def is_thinking_model(model_id: str) -> bool:
    low = model_id.lower()
    return any(m in low for m in THINKING_MODEL_MARKERS)


def live_stream_options(model_id: str) -> tuple[int, dict | None]:
    """max_tokens и reasoning для live — thinking-модели жрут лимит на скрытый reasoning."""
    if is_thinking_model(model_id):
        return 1800, {"effort": "minimal", "exclude": True}
    return 750, None


def vacancy_eval_options(model_id: str) -> tuple[int, dict | None]:
    """Quality-first completion budget for one finished practice answer review.

    GPT-5.6 Sol gets deliberate reasoning room: this route must both diagnose a
    noisy answer and synthesize a grounded, logically complete replacement.
    Other thinking models keep a smaller budget so catalog fallbacks remain
    usable without changing the latency profile as dramatically.
    """
    if "gpt-5.6" in model_id.lower():
        return 6000, {"effort": "high", "exclude": True}
    if is_thinking_model(model_id):
        return 3600, {"effort": "medium", "exclude": True}
    return 2200, None


def _apply_reasoning_options(
    payload: dict, *, provider: str, model: str, reasoning: dict | None
) -> None:
    """Translate the shared reasoning contract to the provider's API shape."""
    if not reasoning:
        return
    if provider == "openai" and "gpt-5" in model.lower():
        effort = reasoning.get("effort")
        if effort:
            payload["reasoning_effort"] = effort
        return
    payload["reasoning"] = reasoning


def _apply_completion_limit(payload: dict, *, provider: str, model: str) -> None:
    """Use the current Chat Completions token-limit field for direct GPT-5 calls."""
    if provider == "openai" and "gpt-5" in model.lower():
        payload["max_completion_tokens"] = payload.pop("max_tokens")


async def test_provider(provider: str | None, model: str | None) -> dict:
    provider, base_url, key = await _resolve(provider)
    settings = get_settings()
    model = model or settings.default_model
    model = _model_for_provider(provider, model)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 5,
    }
    _apply_completion_limit(payload, provider=provider, model=model)
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
    provider, base_url, key = await _resolve(provider)
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
                # OpenRouter шлёт usage в финальном чанке; OpenAI — при
                # stream_options.include_usage. Записываем для ApiUsage.
                if isinstance(chunk.get("usage"), dict):
                    _last_usage.set(chunk["usage"])
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
    provider, base_url, key = await _resolve(provider)
    settings = get_settings()
    model = model or settings.default_model
    model = _model_for_provider(provider, model)
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
    _apply_completion_limit(payload, provider=provider, model=model)
    _apply_reasoning_options(payload, provider=provider, model=model, reasoning=reasoning)
    # Ask OpenRouter to prefer the highest-throughput upstream provider for the
    # lowest time-to-first-token (fast-answer mode only).
    if route_fast and _supports_openrouter_routing(provider, base_url):
        payload["provider"] = {"sort": "throughput"}
    # OpenAI отдаёт usage в стриме только по явному запросу (OpenRouter — сам).
    if provider == "openai":
        payload["stream_options"] = {"include_usage": True}

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
    *,
    reasoning: dict | None = None,
    response_format: dict | None = None,
    request_timeout_seconds: float | None = None,
    max_attempts: int | None = None,
) -> str:
    """Неблокирующий полный ответ (для JSON-режима интервью).

    `reasoning` mirrors stream_chat's option (e.g. {"effort": "minimal",
    "exclude": True}) — pass it for latency-sensitive JSON calls so a
    thinking-capable model doesn't burn the response budget on hidden
    reasoning tokens (see is_thinking_model / vacancy_eval_options)."""
    provider, base_url, key = await _resolve(provider)
    settings = get_settings()
    model = model or settings.default_model
    model = _model_for_provider(provider, model)
    payload = {
        "model": model,
        "messages": apply_prompt_cache(messages, model),
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    _apply_completion_limit(payload, provider=provider, model=model)
    _apply_reasoning_options(payload, provider=provider, model=model, reasoning=reasoning)
    if response_format:
        payload["response_format"] = response_format
    resp = await _post_with_retry(
        base_url,
        provider,
        key,
        payload,
        request_timeout_seconds=request_timeout_seconds,
        max_attempts=max_attempts,
    )
    if resp.status_code >= 400:
        raise parse_provider_error(resp.status_code, resp.text, provider)
    data = resp.json()
    if isinstance(data.get("usage"), dict):
        _last_usage.set(data["usage"])
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
