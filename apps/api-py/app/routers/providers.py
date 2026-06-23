from fastapi import APIRouter
from pydantic import BaseModel

from app.services import model_router, openrouter_models, provider_adapter
from app.services.preferences import load_preferences

router = APIRouter(prefix="/providers", tags=["providers"])


class TestPayload(BaseModel):
    provider: str | None = None
    model: str | None = None


class OpenRouterTestPayload(BaseModel):
    model: str | None = None


@router.post("/test")
async def test(payload: TestPayload) -> dict:
    return await provider_adapter.test_provider(payload.provider, payload.model)


@router.get("/models")
async def models(provider: str | None = None) -> dict:
    items = await provider_adapter.list_models(provider)
    return {"models": items}


@router.post("/openrouter/test")
async def openrouter_test(payload: OpenRouterTestPayload) -> dict:
    prefs = load_preferences()
    model = payload.model
    if not model or model == "auto":
        available = {m.id for m in prefs.models_cache}
        model, _ = model_router.resolve_model("general", available=available)
    return await provider_adapter.test_provider("openrouter", model)


@router.get("/openrouter/models")
async def openrouter_models_list(use_cache: bool = False) -> dict:
    items = await openrouter_models.fetch_openrouter_models(use_cache=use_cache)
    return {"models": [m.model_dump() for m in items]}
