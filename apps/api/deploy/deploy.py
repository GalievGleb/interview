#!/usr/bin/env python3
"""Деплой SkillCue-гейтвея и лидбота на VPS одним запуском.

Запуск (из корня репозитория):
    py -3.12 apps/api/deploy/deploy.py --host <IP> [--user root] [--password ...]

Что делает:
1. Собирает бандл (apps/api + packages/shared + workspace-файлы + tools/leadbot).
2. Готовит gateway.env: ключ OpenRouter из OS keyring, приватный ключ подписи
   лицензий из apps/api-py/.license_signing_key, GATEWAY_ADMIN_SECRET
   (генерируется один раз, хранится в apps/api/deploy/.admin_secret, git-ignored).
3. Заливает на сервер (SFTP), запускает deploy/setup-vps.sh (Node+Redis+systemd).
4. Ставит локальный SSH-ключ в authorized_keys (следующие деплои — без пароля).
5. Смоук: выпускает тестовый ключ через /gateway/issue и проверяет /v1/usage.

Секреты не печатаются и не коммитятся.
"""

from __future__ import annotations

import argparse
import io
import secrets as pysecrets
import sys
import tarfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DEPLOY_DIR = Path(__file__).resolve().parent
ADMIN_SECRET_FILE = DEPLOY_DIR / ".admin_secret"
SIGNING_KEY_FILE = REPO / "apps" / "api-py" / ".license_signing_key"
APP_DIR = "/opt/skillcue"

BUNDLE_INCLUDE = [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "apps/api",
    "packages/shared",
    "tools/leadbot",
    "landing",
]
EXCLUDE_PARTS = {"node_modules", "dist", "dist-crosscheck", "__pycache__", ".turbo"}
# Секреты бота (config.json с токеном) нужны на сервере, поэтому НЕ исключаются.


def _tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    parts = set(Path(info.name).parts)
    if parts & EXCLUDE_PARTS:
        return None
    return info


def build_bundle() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in BUNDLE_INCLUDE:
            src = REPO / rel
            if not src.exists():
                print(f"!! пропущено (нет): {rel}")
                continue
            tar.add(src, arcname=rel, filter=_tar_filter)
    data = buf.getvalue()
    print(f"бандл: {len(data) / 1e6:.1f} МБ")
    return data


def read_openrouter_key() -> str:
    import os

    key = os.environ.get("SKILLCUE_OPENROUTER_KEY", "").strip()
    if not key:
        try:
            import keyring

            key = keyring.get_password("interview-copilot", "openrouter_api_key") or ""
        except Exception:
            key = ""
    if not key:
        # Не блокируем деплой: issue/usage работают и без апстрим-ключа, а
        # LLM-прокси вернёт 503 gateway_unconfigured, пока ключ не добавят в
        # gateway.env на сервере (см. GATEWAY.md).
        print("!! OpenRouter-ключ не найден — гейтвей поедет без него (добавим позже)")
    return key


def read_openai_key() -> str:
    """OpenAI key for managed gpt-4o-mini-transcribe requests."""
    import os

    key = os.environ.get("SKILLCUE_OPENAI_KEY", "").strip()
    if not key:
        try:
            import keyring

            key = keyring.get_password("interview-copilot", "openai_api_key") or ""
        except Exception:
            key = ""
    if not key:
        print("!! OpenAI key not found — managed STT will return 'not configured'")
    return key


def read_yookassa_secret() -> str:
    """Секретный ключ ЮKassa — из env SKILLCUE_YOOKASSA_SECRET или OS keyring.
    Мы его НИКОГДА не коммитим; deploy лишь читает то, что положил владелец.
    Без него /gateway/checkout вернёт 503, остальное работает."""
    import os

    key = os.environ.get("SKILLCUE_YOOKASSA_SECRET", "").strip()
    if not key:
        try:
            import keyring

            key = keyring.get_password("interview-copilot", "yookassa_secret_key") or ""
        except Exception:
            key = ""
    if not key:
        print("!! Секрет ЮKassa не найден — оплата (/gateway/checkout) отдаст 503, пока не добавишь ключ")
    return key


def admin_secret() -> str:
    if ADMIN_SECRET_FILE.exists():
        return ADMIN_SECRET_FILE.read_text(encoding="utf-8").strip()
    value = pysecrets.token_urlsafe(32)
    ADMIN_SECRET_FILE.write_text(value, encoding="utf-8")
    print(f"admin secret сгенерирован -> {ADMIN_SECRET_FILE} (не коммитить)")
    return value


def build_env() -> str:
    signing = (
        SIGNING_KEY_FILE.read_text(encoding="utf-8").strip() if SIGNING_KEY_FILE.exists() else ""
    )
    if not signing:
        print("!! нет .license_signing_key — /gateway/issue работать не будет")
    upstream_key = read_openrouter_key()
    uses_openrouter = upstream_key.startswith("sk-or-v1-")
    upstream_base = (
        "https://openrouter.ai/api/v1"
        if uses_openrouter
        else "https://api.proxyapi.ru/openai/v1"
    )
    upstream_style = "openrouter" if uses_openrouter else "openai"
    lines = [
        "GATEWAY_PORT=8787",
        "REDIS_URL=redis://127.0.0.1:6379",
        f"OPENROUTER_API_KEY={upstream_key}",
        f"GATEWAY_ADMIN_SECRET={admin_secret()}",
        # The key and upstream must be from the same provider.  A previous
        # deploy sent an sk-or-v1 OpenRouter key to ProxyAPI and every customer
        # request failed with 401/402 despite both balances looking healthy.
        f"GATEWAY_UPSTREAM_BASE={upstream_base}",
        f"GATEWAY_UPSTREAM_STYLE={upstream_style}",
        # Блок-лист дорогих моделей: даже в рамках токен-лимита нельзя сливать
        # деньги через премиум-тир (цена токена различается в ~100 раз). Матч по
        # префиксу сырого id; gpt-4o/mini, sonnet, haiku, deepseek, gemini-flash
        # остаются. Заблокированные скрыты и из /v1/models (AUTO их не выберет).
        # Переопределяется env GATEWAY_BLOCKED_MODELS при запуске сервиса.
        "GATEWAY_BLOCKED_MODELS="
        "openai/o1,openai/o3,openai/gpt-4.5,openai/gpt-5.5-pro,openai/gpt-5.4-pro,"
        "anthropic/claude-3-opus,anthropic/claude-opus,google/gemini-2.5-pro",
        # Managed STT: all licensed clients use gpt-4o-mini-transcribe through
        # the HTTP gateway endpoint.
        f"OPENAI_API_KEY={read_openai_key()}",
        "OPENAI_STT_BASE_URL=https://api.openai.com/v1",
        # Оплата ЮKassa (billing.service.ts). Секрет — из keyring/env владельца,
        # в репозиторий не попадает. Без секрета checkout отдаёт 503.
        "YOOKASSA_SHOP_ID=1402744",
        f"YOOKASSA_SECRET_KEY={read_yookassa_secret()}",
        "YOOKASSA_RETURN_URL=https://skill-cue.ru/pay-success.html",
    ]
    if signing:
        lines.append(f"LICENSE_PRIVATE_KEY_HEX={signing}")
    return "\n".join(lines) + "\n"


def ensure_local_ssh_key() -> str:
    """Локальный ed25519-ключ для беспарольных следующих заходов."""
    import subprocess

    key = Path.home() / ".ssh" / "id_ed25519"
    pub = key.with_suffix(".pub")
    if not pub.exists():
        key.parent.mkdir(exist_ok=True)
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(key), "-C", "skillcue-deploy"],
            check=True,
            capture_output=True,
        )
        print("сгенерирован SSH-ключ ~/.ssh/id_ed25519")
    return pub.read_text(encoding="utf-8").strip()


def run(ssh, cmd: str, *, sudo_pass: str | None = None, timeout: int = 900) -> tuple[int, str]:
    if sudo_pass is not None:
        cmd = f"sudo -S -p '' bash -c {cmd!r}"
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=bool(sudo_pass))
    if sudo_pass is not None:
        stdout.channel.send(sudo_pass + "\n")
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    text = (out + ("\n" + err if err.strip() else "")).strip()
    return code, text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--user", default="root")
    ap.add_argument("--password", default=None)
    ap.add_argument("--port", type=int, default=22)
    args = ap.parse_args()

    import os

    import paramiko

    # Пароль опционален: если не задан (флагом/env) — ходим по SSH-ключу
    # (~/.ssh/id_*, уже в authorized_keys VPS). input() спрашиваем ТОЛЬКО в
    # интерактивном терминале, иначе (CI/агент) не вешаем деплой на промпт.
    password = args.password or os.environ.get("SKILLCUE_SSH_PASSWORD")
    if not password:
        # Спрашиваем пароль в терминале; неинтерактивно (CI/агент, stdin закрыт)
        # input() бросает EOFError — тогда идём по SSH-ключу без промпта.
        try:
            password = input(f"SSH-пароль {args.user}@{args.host} (пусто — по ключу): ").strip() or None
        except EOFError:
            password = None

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    auth_kind = "паролю" if password else "SSH-ключу"
    print(f"подключаюсь к {args.user}@{args.host} по {auth_kind}…")
    ssh.connect(
        args.host,
        port=args.port,
        username=args.user,
        password=password,
        timeout=20,
        look_for_keys=password is None,
        allow_agent=password is None,
    )
    sudo_pass = None if args.user == "root" else password

    code, out = run(ssh, "uname -a && free -m | head -2 && python3 --version")
    print(out)

    # 1) SSH-ключ для следующих заходов.
    pub = ensure_local_ssh_key()
    run(
        ssh,
        f"mkdir -p ~/.ssh && grep -qF {pub.split()[1]!r} ~/.ssh/authorized_keys 2>/dev/null "
        f"|| echo {pub!r} >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys",
    )
    print("SSH-ключ установлен (дальше можно без пароля)")

    # 2) Заливаем бандл + env.
    bundle = build_bundle()
    sftp = ssh.open_sftp()
    with sftp.open("/tmp/skillcue-bundle.tgz", "wb") as f:
        f.write(bundle)
    with sftp.open("/tmp/gateway.env", "w") as f:
        f.write(build_env())
    sftp.close()
    print("бандл и env залиты")

    # 3) Распаковка + установка.
    steps = [
        f"mkdir -p {APP_DIR} && tar -xzf /tmp/skillcue-bundle.tgz -C {APP_DIR} "
        f"&& mv /tmp/gateway.env {APP_DIR}/gateway.env && chmod 600 {APP_DIR}/gateway.env",
        f"bash {APP_DIR}/apps/api/deploy/setup-vps.sh",
    ]
    for step in steps:
        print(f"$ {step[:90]}…")
        code, out = run(ssh, step, sudo_pass=sudo_pass)
        print(out[-3000:])
        if code != 0:
            sys.exit(f"шаг упал с кодом {code}")

    # 4) Смоук: выпустить тестовый ключ и проверить /v1/usage.
    secret = admin_secret()
    time.sleep(2)
    code, out = run(
        ssh,
        "curl -s -X POST http://127.0.0.1:8787/gateway/issue "
        f"-H 'x-admin-secret: {secret}' -H 'Content-Type: application/json' "
        "-d '{\"email\":\"smoke@test.dev\",\"plan\":\"max\",\"days\":1}'",
    )
    if '"key"' not in out:
        sys.exit(f"issue smoke failed: {out[:400]}")
    import json as _json

    key = _json.loads(out)["key"]
    code, out = run(
        ssh,
        f"curl -s http://127.0.0.1:8787/v1/usage -H 'Authorization: Bearer {key}'",
    )
    print("usage smoke:", out[:200])
    if '"tokensBudget"' not in out:
        sys.exit("usage smoke failed")
    print("\n✅ Гейтвей и лидбот работают. Дальше: домен + TLS (Caddy) перед реальными продажами.")


if __name__ == "__main__":
    main()
