from fastapi import APIRouter
from pydantic import BaseModel

from app.config import get_settings
from app.services import secrets
from app.services.preferences import (
    AiPreferencesModel,
    load_preferences,
    save_preferences,
)

router = APIRouter(prefix="/settings", tags=["settings"])


class KeysPayload(BaseModel):
    openai_api_key: str | None = None
    openrouter_api_key: str | None = None
    deepgram_api_key: str | None = None
    yandex_api_key: str | None = None


class KeysStatus(BaseModel):
    openai: bool
    openrouter: bool
    deepgram: bool
    yandex: bool
    default_provider: str
    default_model: str


class AiSettingsPayload(BaseModel):
    provider: str | None = None
    base_url: str | None = None
    default_copilot_model: str | None = None
    coding_assistant_model: str | None = None
    fast_live_model: str | None = None
    deep_reasoning_model: str | None = None
    vacancy_review_model: str | None = None


class AiSettingsResponse(BaseModel):
    provider: str
    base_url: str
    default_copilot_model: str
    coding_assistant_model: str
    fast_live_model: str
    deep_reasoning_model: str
    vacancy_review_model: str
    last_models_sync_at: str | None
    models_cache_count: int
    has_openrouter_key: bool


@router.post("/keys", response_model=KeysStatus)
def save_keys(payload: KeysPayload) -> KeysStatus:
    if payload.openai_api_key is not None:
        secrets.set_secret("openai_api_key", payload.openai_api_key)
    if payload.openrouter_api_key is not None:
        secrets.set_secret("openrouter_api_key", payload.openrouter_api_key)
    if payload.deepgram_api_key is not None:
        secrets.set_secret("deepgram_api_key", payload.deepgram_api_key)
    if payload.yandex_api_key is not None:
        secrets.set_secret("yandex_api_key", payload.yandex_api_key)
    return _status()


@router.get("/keys", response_model=KeysStatus)
def get_keys_status() -> KeysStatus:
    return _status()


@router.get("/ai", response_model=AiSettingsResponse)
def get_ai_settings() -> AiSettingsResponse:
    return _ai_response()


@router.post("/ai", response_model=AiSettingsResponse)
def save_ai_settings(payload: AiSettingsPayload) -> AiSettingsResponse:
    prefs = load_preferences()
    data = prefs.model_dump()
    for field in (
        "provider",
        "base_url",
        "default_copilot_model",
        "coding_assistant_model",
        "fast_live_model",
        "deep_reasoning_model",
        "vacancy_review_model",
    ):
        value = getattr(payload, field)
        if value is not None:
            data[field] = value
    save_preferences(AiPreferencesModel.model_validate(data))
    return _ai_response()


def _ai_response() -> AiSettingsResponse:
    prefs = load_preferences()
    return AiSettingsResponse(
        provider=prefs.provider,
        base_url=prefs.base_url,
        default_copilot_model=prefs.default_copilot_model,
        coding_assistant_model=prefs.coding_assistant_model,
        fast_live_model=prefs.fast_live_model,
        deep_reasoning_model=prefs.deep_reasoning_model,
        vacancy_review_model=prefs.vacancy_review_model,
        last_models_sync_at=prefs.last_models_sync_at,
        models_cache_count=len(prefs.models_cache),
        has_openrouter_key=secrets.has_secret("openrouter_api_key"),
    )


def _status() -> KeysStatus:
    s = get_settings()
    prefs = load_preferences()
    return KeysStatus(
        openai=secrets.has_secret("openai_api_key"),
        openrouter=secrets.has_secret("openrouter_api_key"),
        deepgram=secrets.has_secret("deepgram_api_key"),
        yandex=secrets.has_secret("yandex_api_key"),
        default_provider=prefs.provider or s.default_provider,
        default_model=prefs.default_copilot_model
        if prefs.default_copilot_model != "auto"
        else s.default_model,
    )
