import os

# hf-xet can stall Hugging Face downloads on some Windows routes; disable before
# huggingface_hub is imported anywhere in this process.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

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
    providers,
    sessions,
    stt,
    stt_benchmark,
    usage,
    voice_tests,
)
from app.routers import (
    settings as settings_router,
)

settings = get_settings()
setup_logging(settings.log_level)
logger = logging.getLogger("main")

app = FastAPI(title="SkillCue API", version="0.1.0")

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

app.include_router(providers.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(sessions.router)
app.include_router(usage.router)
app.include_router(settings_router.router)
app.include_router(stt.router)
app.include_router(stt_benchmark.router)
app.include_router(voice_tests.router)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    logger.info("Database initialized")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    from app.services import provider_adapter

    await provider_adapter.aclose_client()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}
