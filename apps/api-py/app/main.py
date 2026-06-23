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
    settings as settings_router,
    stt,
    usage,
)

settings = get_settings()
setup_logging(settings.log_level)
logger = logging.getLogger("main")

app = FastAPI(title="Interview & Meeting Copilot API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(AppError, app_error_handler)
app.add_exception_handler(Exception, unhandled_error_handler)

app.include_router(providers.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(sessions.router)
app.include_router(usage.router)
app.include_router(settings_router.router)
app.include_router(stt.router)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    logger.info("Database initialized")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}
