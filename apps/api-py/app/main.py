import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.core.errors import AppError, app_error_handler, unhandled_error_handler
from app.core.logging import setup_logging
from app.db.session import init_db
from app.routers import (
    chat,
    documents,
    feedback,
    latency,
    license,
    mock_sessions,
    providers,
    sessions,
    stt,
    stt_benchmark,
    tts,
    usage,
    vacancy,
    voice_tests,
)
from app.routers import (
    settings as settings_router,
)

settings = get_settings()
setup_logging(settings.log_level)
logger = logging.getLogger("main")

app = FastAPI(title="SkillCue API", version="0.1.9")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    # No credentials are used; `allow_credentials=True` with a wildcard origin
    # is invalid per the CORS spec, so we keep it False.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Starlette types handlers as taking the base Exception; our typed AppError
# handler is a known false-positive, hence the targeted ignore.
app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
app.add_exception_handler(Exception, unhandled_error_handler)


@app.middleware("http")
async def _require_local_token(request, call_next):
    """Отсекает чужие локальные процессы/сайты от API (см. core/local_auth)."""
    from fastapi.responses import JSONResponse

    from app.core import local_auth

    if (
        local_auth.enabled()
        and request.url.path not in local_auth.PUBLIC_PATHS
        and not local_auth.token_ok(request.headers.get(local_auth.HEADER_NAME))
    ):
        return JSONResponse(
            {"error": {"message": "unauthorized", "code": "bad_local_token"}}, status_code=401
        )
    return await call_next(request)


app.include_router(providers.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(sessions.router)
app.include_router(mock_sessions.router)
app.include_router(latency.router)
app.include_router(feedback.router)
app.include_router(license.router)
app.include_router(usage.router)
app.include_router(settings_router.router)
app.include_router(stt.router)
app.include_router(stt_benchmark.router)
app.include_router(tts.router)
app.include_router(voice_tests.router)
app.include_router(vacancy.router)


@app.on_event("startup")
async def on_startup() -> None:
    init_db()
    logger.info("Database initialized")
    from app.services.stt.registry import resolve_default_provider

    async def warm_stt() -> None:
        try:
            await resolve_default_provider().prewarm_model_async()
            logger.info("OpenAI Mini STT connection is ready")
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI Mini STT background warmup failed: %s", exc)

    asyncio.create_task(warm_stt())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    from app.services import provider_adapter
    from app.services.stt.openai_transcribe import get_answer_transcriber
    from app.services.stt.registry import resolve_default_provider

    await provider_adapter.aclose_client()
    await resolve_default_provider().aclose()
    await get_answer_transcriber().aclose()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": "0.1.9"}
