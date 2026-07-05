"""Защита localhost-API от чужих процессов и drive-by запросов из браузера.

Electron генерирует случайный токен на каждый запуск и передаёт его бэкенду
через env SKILLCUE_API_TOKEN; renderer шлёт его в заголовке X-SkillCue-Token
(для WebSocket — query-параметр `token`). Без совпадения — 401.

Когда env не задан (бэкенд запущен вручную в dev-терминале) — проверка
выключена, чтобы не ломать разработку и curl-отладку.
"""

from __future__ import annotations

import hmac
import os

API_TOKEN = os.environ.get("SKILLCUE_API_TOKEN", "")

HEADER_NAME = "x-skillcue-token"
WS_QUERY_PARAM = "token"

# Публичные пути без токена (health-check нужен Electron ДО передачи токена).
PUBLIC_PATHS = {"/health"}


def enabled() -> bool:
    return bool(API_TOKEN)


def token_ok(presented: str | None) -> bool:
    if not API_TOKEN:
        return True
    return hmac.compare_digest(API_TOKEN, presented or "")
