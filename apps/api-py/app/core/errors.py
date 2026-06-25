import logging

from fastapi import Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("errors")


class AppError(Exception):
    """Доменная ошибка приложения с понятным сообщением для клиента."""

    def __init__(self, message: str, status_code: int = 400, code: str = "app_error"):
        self.message = message
        self.status_code = status_code
        self.code = code
        super().__init__(message)


async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    # Log the full traceback so production 500s aren't silent. The client still
    # gets a generic message (no internal details leaked).
    logger.exception("Unhandled error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "Internal server error"}},
    )
