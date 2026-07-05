"""Лицензирование SkillCue: 15-минутный live-trial, тарифы и токен-бюджеты.

Модель монетизации:
- **Trial** (без ключа): 15 минут live-режима суммарно (серверный счётчик на
  STT-вебсокете) + маленький токен-бюджет на подготовку — достаточно понять
  ценность, «бесконечно бесплатно» не получится.
- **basic** — подготовка к собесам (разбор вакансии, mock, история). Live и
  оверлей выключены. Скромный месячный токен-бюджет.
- **max** — всё: live + оверлей + mock. Токен-бюджет больше, но КОНЕЧНЫЙ:
  подписка стоит фикс (например 3000₽), а бюджет подобран так, чтобы расход
  API не превышал ~2000₽/мес. Бюджет можно переопределить в самом ключе
  (`tokens_month`) при выпуске.

Ключ — Ed25519-подписанный payload: ``SKILLCUE-<b64url(json)>.<b64url(sig)>``.
Проверка полностью оффлайн; приватный ключ только у издателя
(tools/generate_license_key.py). ВАЖНО: локальная проверка защищает от честных
пользователей; для продажи подписок с ВАШИМИ API-ключами обязателен серверный
прокси (см. SECURITY.md) — это дорожная карта, текущие лимиты — первый рубеж.
"""

from __future__ import annotations

import base64
import json
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Публичный ключ издателя (Ed25519, raw hex).
PUBLIC_KEY_HEX = "6c8c28be738e231af5429b12837d3406d9934c802b9fd32300d7ad6cb8fd4876"

KEY_PREFIX = "SKILLCUE-"

# Trial: суммарное live-время (сервер копит на вебсокете), не календарные дни.
TRIAL_LIVE_SECONDS = 15 * 60

# Месячные токен-бюджеты по тарифам (вход+выход суммарно). Переопределяются
# полем `tokens_month` в ключе. Ориентир: gpt-4o-mini через OpenRouter — u
# blended ~$0.3/1M; бюджет max (~20M) ≈ $6-8, с запасом до дорогих моделей.
PLAN_TOKEN_BUDGETS = {
    "trial": 300_000,
    "basic": 5_000_000,
    "max": 20_000_000,
}

# Что разрешает тариф.
PLAN_FEATURES = {
    "trial": {"live": True, "overlay": True, "mock": True},  # live — пока не сгорели 15 минут
    "basic": {"live": False, "overlay": False, "mock": True},
    "max": {"live": True, "overlay": True, "mock": True},
}


def normalize_plan(plan: str | None) -> str:
    """Ключи первых партий выпускались с plan="pro" — это нынешний max."""
    p = (plan or "").strip().lower()
    if p in ("max", "pro", "full"):
        return "max"
    if p == "basic":
        return "basic"
    return "max"  # неизвестный план в подписанном ключе трактуем в пользу покупателя


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def verify_license_key(key: str) -> dict | None:
    """Вернуть payload валидного ключа или None. Не бросает исключений."""
    key = (key or "").strip()
    if not key.startswith(KEY_PREFIX):
        return None
    body = key[len(KEY_PREFIX) :]
    if "." not in body:
        return None
    payload_b64, sig_b64 = body.rsplit(".", 1)
    try:
        payload_bytes = _b64url_decode(payload_b64)
        signature = _b64url_decode(sig_b64)
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUBLIC_KEY_HEX)).verify(
            signature, payload_bytes
        )
        payload = json.loads(payload_bytes)
    except (InvalidSignature, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not payload.get("email"):
        return None
    expires_at = payload.get("expires_at")
    if expires_at is not None and time.time() > float(expires_at):
        return None
    return payload


def token_budget_for(plan: str, payload: dict | None = None) -> int:
    """Месячный токен-бюджет тарифа (с переопределением из ключа)."""
    if payload:
        override = payload.get("tokens_month")
        if isinstance(override, int | float) and override > 0:
            return int(override)
    return PLAN_TOKEN_BUDGETS.get(plan, PLAN_TOKEN_BUDGETS["trial"])


def trial_live_seconds_left(used_seconds: float) -> int:
    return max(0, TRIAL_LIVE_SECONDS - int(used_seconds))
