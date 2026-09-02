import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
# A structured continuation can legitimately carry the current JPEG, two
# bounded prior JPEGs and a pixel-free UTF-8 task ledger. Keep this limit local
# to the screen endpoint; unrelated API routes retain their existing behavior.
MAX_SCREEN_ASSIST_REQUEST_BYTES = 4_000_000


class _ScreenAssistRequestTooLarge(Exception):
    pass


def _screen_request_too_large_response() -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": "screen_request_too_large",
                "message": "Screen request is too large.",
            }
        },
        status_code=413,
    )


class ScreenAssistRequestSizeLimitMiddleware:
    """Count only screen-request ASGI chunks before FastAPI parses them."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        is_screen_request = (
            scope["type"] == "http"
            and scope["method"] == "POST"
            and scope["path"] == "/chat/screen/stream"
        )
        if not is_screen_request:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        raw_content_length = headers.get(b"content-length")
        if raw_content_length is not None:
            try:
                declared_size = int(raw_content_length)
            except ValueError:
                declared_size = -1
            if declared_size < 0 or declared_size > MAX_SCREEN_ASSIST_REQUEST_BYTES:
                await _screen_request_too_large_response()(scope, receive, send)
                return

        received_size = 0
        exceeded_limit = False
        overflow_response_sent = False

        async def limited_receive():
            nonlocal received_size, exceeded_limit
            message = await receive()
            if message["type"] == "http.request":
                received_size += len(message.get("body", b""))
                if received_size > MAX_SCREEN_ASSIST_REQUEST_BYTES:
                    exceeded_limit = True
                    raise _ScreenAssistRequestTooLarge
            return message

        async def limited_send(message):
            nonlocal overflow_response_sent
            if exceeded_limit:
                if not overflow_response_sent:
                    overflow_response_sent = True
                    await _screen_request_too_large_response()(scope, receive, send)
                return
            await send(message)

        try:
            await self.app(scope, limited_receive, limited_send)
        except _ScreenAssistRequestTooLarge:
            if not overflow_response_sent:
                overflow_response_sent = True
                await _screen_request_too_large_response()(scope, receive, send)


app = FastAPI(title="SkillCue API", version="0.1.12")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    # No credentials are used; `allow_credentials=True` with a wildcard origin
    # is invalid per the CORS spec, so we keep it False.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ScreenAssistRequestSizeLimitMiddleware)

# Starlette types handlers as taking the base Exception; our typed AppError
# handler is a known false-positive, hence the targeted ignore.
app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
app.add_exception_handler(Exception, unhandled_error_handler)


@app.middleware("http")
async def _require_local_token(request, call_next):
    """Отсекает чужие локальные процессы/сайты от API (см. core/local_auth)."""
    from app.core import local_auth

    if (
        local_auth.enabled()
        and request.method != "OPTIONS"
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
    return {"status": "ok", "version": "0.1.12"}
