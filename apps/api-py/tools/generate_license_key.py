"""Генератор лицензионных ключей SkillCue (инструмент издателя).

Использование:
    # новый ключ для покупателя (приватный ключ читается из .license_signing_key)
    python tools/generate_license_key.py buyer@mail.com
    # подписочный ключ с истечением через 365 дней
    python tools/generate_license_key.py buyer@mail.com --days 365
    # сгенерировать НОВУЮ ключевую пару (печатает публичный hex для license.py)
    python tools/generate_license_key.py --new-keypair

Приватный ключ (.license_signing_key, hex) не коммитится — он в .gitignore.
При подключении платёжного провайдера (LemonSqueezy/Gumroad webhook) провайдер
мицует те же ключи этим же кодом.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

KEY_FILE = Path(__file__).resolve().parent.parent / ".license_signing_key"
PREFIX = "SKILLCUE-"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def new_keypair() -> None:
    priv = Ed25519PrivateKey.generate()
    priv_hex = priv.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    ).hex()
    pub_hex = (
        priv.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )
    KEY_FILE.write_text(priv_hex, encoding="utf-8")
    print(f"private key -> {KEY_FILE} (NOT for git!)")
    print(f'update app/services/license.py: PUBLIC_KEY_HEX = "{pub_hex}"')


def mint(email: str, days: int | None, plan: str = "max", tokens_month: int | None = None) -> str:
    priv_hex = KEY_FILE.read_text(encoding="utf-8").strip()
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex))
    payload: dict = {"email": email, "issued_at": int(time.time()), "plan": plan}
    if days:
        payload["expires_at"] = int(time.time()) + days * 86400
    if tokens_month:
        payload["tokens_month"] = int(tokens_month)
    body = json.dumps(payload, separators=(",", ":")).encode()
    sig = priv.sign(body)
    return f"{PREFIX}{_b64url(body)}.{_b64url(sig)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("email", nargs="?", help="почта покупателя")
    ap.add_argument(
        "--days", type=int, default=None, help="срок действия (дней); без флага — бессрочный"
    )
    ap.add_argument("--plan", choices=("basic", "max"), default="max", help="тариф ключа")
    ap.add_argument(
        "--tokens", type=int, default=None, help="месячный токен-бюджет (переопределяет тариф)"
    )
    ap.add_argument("--new-keypair", action="store_true")
    args = ap.parse_args()

    if args.new_keypair:
        new_keypair()
        return
    if not args.email:
        ap.error("укажите email покупателя или --new-keypair")
    if not KEY_FILE.exists():
        sys.exit(f"нет {KEY_FILE} — сначала --new-keypair")
    print(mint(args.email, args.days, plan=args.plan, tokens_month=args.tokens))


if __name__ == "__main__":
    main()
