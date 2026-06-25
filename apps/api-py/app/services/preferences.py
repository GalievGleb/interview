"""Локальное хранение AI-настроек (без API-ключей)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from app.config import DATA_DIR

PREFS_PATH = DATA_DIR / "ai_preferences.json"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


class ModelPricingModel(BaseModel):
    prompt: str = "0"
    completion: str = "0"


class ModelCapabilitiesModel(BaseModel):
    vision: bool = False
    tools: bool = False
    reasoning: bool = False


class NormalizedModelModel(BaseModel):
    id: str
    name: str
    provider: str
    description: str = ""
    context_length: int = 0
    pricing: ModelPricingModel = Field(default_factory=ModelPricingModel)
    capabilities: ModelCapabilitiesModel = Field(default_factory=ModelCapabilitiesModel)
    tags: list[str] = Field(default_factory=list)


class AiPreferencesModel(BaseModel):
    provider: str = "openrouter"
    base_url: str = DEFAULT_BASE_URL
    default_copilot_model: str = "auto"
    coding_assistant_model: str = "auto"
    fast_live_model: str = "auto"
    deep_reasoning_model: str = "auto"
    last_models_sync_at: str | None = None
    models_cache: list[NormalizedModelModel] = Field(default_factory=list)


def _defaults() -> AiPreferencesModel:
    return AiPreferencesModel()


def load_preferences() -> AiPreferencesModel:
    if not PREFS_PATH.exists():
        return _defaults()
    try:
        raw = json.loads(PREFS_PATH.read_text(encoding="utf-8"))
        return AiPreferencesModel.model_validate(raw)
    except Exception:
        return _defaults()


def save_preferences(prefs: AiPreferencesModel) -> AiPreferencesModel:
    PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PREFS_PATH.write_text(
        prefs.model_dump_json(indent=2),
        encoding="utf-8",
    )
    return prefs


def update_preferences(**fields: Any) -> AiPreferencesModel:
    prefs = load_preferences()
    data = prefs.model_dump()
    data.update(fields)
    return save_preferences(AiPreferencesModel.model_validate(data))


def set_models_cache(models: list[NormalizedModelModel]) -> AiPreferencesModel:
    return update_preferences(
        models_cache=models,
        last_models_sync_at=datetime.now(UTC).isoformat(),
    )


def get_cached_model_ids() -> set[str]:
    return {m.id for m in load_preferences().models_cache}
