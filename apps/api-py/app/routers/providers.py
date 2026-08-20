import time

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


class ReadinessPayload(BaseModel):
    model: str | None = None


_READINESS_QUESTION = (
    "Что такое техники тест-дизайна? Назови несколько примеров и кратко объясни их."
)
_READINESS_TERMS = (
    "эквивалент",
    "граничн",
    "таблиц",
    "попарн",
    "состояни",
    "сценар",
    "use case",
)


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


@router.post("/readiness")
async def readiness(payload: ReadinessPayload) -> dict:
    """Real pre-call smoke through the same provider/model used by live hints.

    A TCP/health check is insufficient: an upstream can be reachable while its
    key has no credits. This endpoint deliberately performs a small completion
    and rejects an empty or irrelevant response before an interview starts.
    """
    prefs = load_preferences()
    available = {m.id for m in prefs.models_cache}
    model = payload.model
    if not model or model == "auto":
        model, _ = model_router.resolve_model("fast", available=available)
    started = time.perf_counter()
    answer = await provider_adapter.complete(
        [
            {
                "role": "system",
                "content": "Ответь по-русски кратко и технически точно, как помощник на QA-собеседовании.",
            },
            {"role": "user", "content": _READINESS_QUESTION},
        ],
        "openrouter",
        model,
        max_tokens=220,
        temperature=0.1,
    )
    normalized = answer.strip().lower()
    matched = [term for term in _READINESS_TERMS if term in normalized]
    ok = len(normalized) >= 80 and len(matched) >= 2
    return {
        "ok": ok,
        "model": model,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "answer": answer.strip(),
        "matched_concepts": matched,
        "question": _READINESS_QUESTION,
    }


@router.get("/openrouter/models")
async def openrouter_models_list(use_cache: bool = False) -> dict:
    items = await openrouter_models.fetch_openrouter_models(use_cache=use_cache)
    return {"models": [m.model_dump() for m in items]}
