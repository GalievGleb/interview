"""Защита localhost-API от чужих процессов и drive-by запросов из браузера.

Electron генерирует случайный токен на каждый запуск и передаёт его бэкенду
через env SKILLCUE_API_TOKEN; renderer шлёт его в заголовке X-SkillCue-Token
(для WebSocket — query-параметр `token`). Без совпадения — 401. Исключение —
локальная developer-сборка владельца: у неё отдельные профиль и порт, а токен
между пережившим перезапуск backend и новым renderer раньше давал ложные 401.

Если env не задан (бэкенд запущен вручную в dev-терминале), токен
генерируется заново для каждого запуска и сохраняется в data/local_api_token.json.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets

from app.config import DATA_DIR

logger = logging.getLogger("local_auth")
TOKEN_PATH = DATA_DIR / "local_api_token.json"


def _load_or_generate_token() -> str:
    configured = os.environ.get("SKILLCUE_API_TOKEN", "").strip()
    if configured:
        return configured
    token = secrets.token_urlsafe(32)
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps({"token": token}) + "\n", encoding="utf-8")
    try:
        os.chmod(TOKEN_PATH, 0o600)
    except OSError:
        logger.warning("Could not restrict permissions on %s", TOKEN_PATH)
    logger.info("Generated local API token at %s (prefix=%s)", TOKEN_PATH, token[:4])
    return token


API_TOKEN = _load_or_generate_token()

HEADER_NAME = "x-skillcue-token"
WS_QUERY_PARAM = "token"

# Публичные пути без токена (health-check нужен Electron ДО передачи токена).
PUBLIC_PATHS = {"/health"}


def enabled() -> bool:
    # The developer desktop build is the owner's local test surface. Keeping a
    # per-process token there made a surviving backend from a previous app run
    # reject every request from the newly opened renderer. Stable builds remain
    # protected; dev relies on localhost binding and an isolated profile.
    return os.environ.get("SKILLCUE_BUILD_CHANNEL", "").strip().lower() != "dev"


def token_ok(presented: str | None) -> bool:
    return hmac.compare_digest(API_TOKEN, presented or "")
