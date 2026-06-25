"""Загрузка и нормализация каталога моделей OpenRouter."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.errors import AppError
from app.services import secrets
from app.services.preferences import (
    DEFAULT_BASE_URL,
    ModelCapabilitiesModel,
    ModelPricingModel,
    NormalizedModelModel,
    load_preferences,
    set_models_cache,
)
from app.services.provider_adapter import _headers

logger = logging.getLogger("openrouter_models")

PROVIDER_LABELS: dict[str, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "deepseek": "DeepSeek",
    "meta-llama": "Meta",
    "mistralai": "Mistral",
    "qwen": "Qwen",
    "cohere": "Cohere",
    "perplexity": "Perplexity",
}


def _provider_label(model_id: str) -> str:
    slug = model_id.split("/")[0] if "/" in model_id else model_id
    return PROVIDER_LABELS.get(slug, slug.replace("-", " ").title())


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _infer_tags(
    model_id: str, name: str, pricing: ModelPricingModel, caps: ModelCapabilitiesModel
) -> list[str]:
    low_id = model_id.lower()
    low_name = name.lower()
    tags: list[str] = []

    prompt_p = _safe_float(pricing.prompt)
    completion_p = _safe_float(pricing.completion)
    if prompt_p == 0 and completion_p == 0:
        tags.append("free")

    fast_kw = ("flash", "mini", "haiku", "turbo", "small", "lite")
    if any(k in low_id or k in low_name for k in fast_kw):
        tags.append("fast")

    code_kw = ("coder", "code", "codestral")
    if any(k in low_id or k in low_name for k in code_kw):
        tags.append("coding")

    reason_kw = ("o1", "o3", "opus", "reason", "pro")
    if any(k in low_id or k in low_name for k in reason_kw):
        tags.append("reasoning")

    premium_kw = ("opus", "gpt-4", "o1", "o3", "pro")
    if any(k in low_id or k in low_name for k in premium_kw):
        tags.append("premium")

    if prompt_p > 0 and prompt_p < 0.000001:
        tags.append("cheap")

    if caps.vision:
        tags.append("vision")

    if caps.reasoning:
        tags.append("reasoning")

    return list(dict.fromkeys(tags))


def normalize_model(item: dict[str, Any]) -> NormalizedModelModel | None:
    model_id = item.get("id") or item.get("canonical_slug") or ""
    if not model_id:
        return None

    name = item.get("name") or model_id.split("/")[-1].replace("-", " ").title()
    description = item.get("description") or ""
    context_length = int(item.get("context_length") or 0)

    raw_pricing = item.get("pricing") or {}
    pricing = ModelPricingModel(
        prompt=str(raw_pricing.get("prompt", "0")),
        completion=str(raw_pricing.get("completion", "0")),
    )

    arch = item.get("architecture") or {}
    modalities = arch.get("modality") or arch.get("input_modalities") or []
    if isinstance(modalities, str):
        modalities = [modalities]

    caps = ModelCapabilitiesModel(
        vision=any("image" in str(m).lower() for m in modalities),
        tools=bool(
            item.get("supported_parameters") and "tools" in item.get("supported_parameters", [])
        ),
        reasoning="reason" in model_id.lower()
        or "o1" in model_id.lower()
        or "o3" in model_id.lower(),
    )

    tags = _infer_tags(model_id, name, pricing, caps)

    return NormalizedModelModel(
        id=model_id,
        name=name,
        provider=_provider_label(model_id),
        description=description[:300],
        context_length=context_length,
        pricing=pricing,
        capabilities=caps,
        tags=tags,
    )


def sort_models(models: list[NormalizedModelModel]) -> list[NormalizedModelModel]:
    """Recommended → free → fast → coding → reasoning/premium → other."""

    def score(m: NormalizedModelModel) -> tuple[int, str]:
        tags = set(m.tags)
        if "free" in tags:
            return (1, m.name.lower())
        if "fast" in tags:
            return (2, m.name.lower())
        if "coding" in tags:
            return (3, m.name.lower())
        if "reasoning" in tags or "premium" in tags:
            return (4, m.name.lower())
        return (5, m.name.lower())

    recommended_ids = {
        "openai/gpt-4o-mini",
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3-opus",
        "google/gemini-2.0-flash-001",
        "deepseek/deepseek-chat",
    }

    recommended = [m for m in models if m.id in recommended_ids]
    rest = [m for m in models if m.id not in recommended_ids]
    recommended.sort(key=lambda m: m.name.lower())
    rest.sort(key=score)
    return recommended + rest


def _parse_provider_error(status: int, body: str) -> AppError:
    low = body.lower()
    if status == 401:
        return AppError(
            "Неверный API key OpenRouter. Проверьте ключ в настройках.",
            401,
            "invalid_api_key",
        )
    if status == 402 or "insufficient" in low or "credit" in low:
        return AppError(
            "Недостаточно кредитов OpenRouter. Пополните баланс на openrouter.ai.",
            402,
            "insufficient_credits",
        )
    if status == 429:
        return AppError(
            "Превышен лимит запросов OpenRouter. Подождите и повторите.",
            429,
            "rate_limited",
        )
    if status >= 500:
        return AppError(
            "OpenRouter временно недоступен. Повторите позже.",
            status,
            "provider_timeout",
        )
    return AppError(f"Ошибка OpenRouter: {body[:200]}", status, "provider_error")


async def fetch_openrouter_models(*, use_cache: bool = False) -> list[NormalizedModelModel]:
    if use_cache:
        cached = load_preferences().models_cache
        if cached:
            return cached

    key = secrets.get_secret("openrouter_api_key")
    if not key:
        raise AppError(
            "OpenRouter API key не задан. Добавьте ключ в настройках.",
            400,
            "missing_api_key",
        )

    prefs = load_preferences()
    base_url = prefs.base_url or DEFAULT_BASE_URL

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(
            f"{base_url.rstrip('/')}/models",
            headers=_headers("openrouter", key),
        )

    if resp.status_code >= 400:
        raise _parse_provider_error(resp.status_code, resp.text)

    data = resp.json()
    items = data.get("data") or []
    normalized: list[NormalizedModelModel] = []
    for item in items:
        model = normalize_model(item)
        if model:
            normalized.append(model)

    if not normalized:
        raise AppError(
            "OpenRouter не вернул модели. Проверьте API key и повторите.",
            502,
            "no_models",
        )

    sorted_models = sort_models(normalized)
    set_models_cache(sorted_models)
    logger.info("Synced %d OpenRouter models", len(sorted_models))
    return sorted_models
