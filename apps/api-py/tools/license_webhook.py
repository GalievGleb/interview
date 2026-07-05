"""Webhook продаж SkillCue (LemonSqueezy) — инфраструктура издателя.

Отдельное приложение (НЕ часть десктоп-бэкенда): деплоится на любой хост с
Python (Railway/Fly/VPS). Принимает `order_created`, проверяет HMAC-подпись
LemonSqueezy, минтит Ed25519-лицензию тем же кодом, что и десктоп её проверяет,
и отправляет ключ покупателю письмом (SMTP) — либо просто логирует, если SMTP
не настроен.

Запуск:
    LEMONSQUEEZY_WEBHOOK_SECRET=***  LICENSE_SIGNING_KEY=<hex приватного ключа>
    [SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM]  # опционально
    uvicorn tools.license_webhook:app --port 8100

В LemonSqueezy: Settings → Webhooks → URL https://host/webhook/lemonsqueezy,
событие `order_created`, secret = LEMONSQUEEZY_WEBHOOK_SECRET.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import smtplib
import time
from email.message import EmailMessage

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, Header, HTTPException, Request

logger = logging.getLogger("license_webhook")

app = FastAPI(title="SkillCue License Webhook")

KEY_PREFIX = "SKILLCUE-"
# Подписочные планы можно мицевать с истечением: LICENSE_DAYS=365. Пусто — бессрочно.
LICENSE_DAYS = int(os.environ.get("LICENSE_DAYS", "0")) or None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def mint_key(email: str, days: int | None = None, priv_hex: str | None = None) -> str:
    """Тот же формат ключа, что проверяет app/services/license.py."""
    priv_hex = priv_hex or os.environ["LICENSE_SIGNING_KEY"]
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex.strip()))
    payload: dict = {"email": email, "issued_at": int(time.time()), "plan": "pro"}
    if days:
        payload["expires_at"] = int(time.time()) + days * 86400
    body = json.dumps(payload, separators=(",", ":")).encode()
    return f"{KEY_PREFIX}{_b64url(body)}.{_b64url(priv.sign(body))}"


def verify_ls_signature(raw_body: bytes, signature: str | None, secret: str | None = None) -> bool:
    """LemonSqueezy подписывает сырое тело HMAC-SHA256, hex в X-Signature."""
    secret = secret if secret is not None else os.environ.get("LEMONSQUEEZY_WEBHOOK_SECRET", "")
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip())


def send_key_email(email: str, key: str) -> bool:
    """True если письмо ушло; False если SMTP не настроен (ключ только в логе)."""
    host = os.environ.get("SMTP_HOST")
    if not host:
        return False
    msg = EmailMessage()
    msg["Subject"] = "Ваш лицензионный ключ SkillCue"
    msg["From"] = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", "noreply@skillcue.app"))
    msg["To"] = email
    msg.set_content(
        "Спасибо за покупку SkillCue!\n\n"
        f"Ваш лицензионный ключ:\n\n{key}\n\n"
        "Активация: Настройки → Лицензия → вставьте ключ → «Активировать».\n"
        "Ключ работает оффлайн и привязан к этой почте."
    )
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587"))) as smtp:
        smtp.starttls()
        user = os.environ.get("SMTP_USER")
        if user:
            smtp.login(user, os.environ.get("SMTP_PASSWORD", ""))
        smtp.send_message(msg)
    return True


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/webhook/lemonsqueezy")
async def lemonsqueezy_webhook(
    request: Request,
    x_signature: str | None = Header(default=None),
) -> dict:
    raw = await request.body()
    if not verify_ls_signature(raw, x_signature):
        raise HTTPException(status_code=401, detail="invalid signature")

    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid json") from exc

    event_name = (event.get("meta") or {}).get("event_name", "")
    if event_name != "order_created":
        return {"ignored": event_name}  # подписаны только на order_created, но не падаем

    attrs = ((event.get("data") or {}).get("attributes")) or {}
    email = (attrs.get("user_email") or "").strip().lower()
    status = attrs.get("status", "")
    if not email:
        raise HTTPException(status_code=400, detail="no buyer email in payload")
    if status not in ("paid", ""):
        return {"ignored": f"order status {status}"}

    key = mint_key(email, days=LICENSE_DAYS)
    emailed = send_key_email(email, key)
    # Ключ всегда в логе — если SMTP упал/не настроен, его можно отправить вручную.
    logger.info("license minted for %s (emailed=%s): %s", email, emailed, key)
    return {"minted": True, "emailed": emailed, "email": email}
