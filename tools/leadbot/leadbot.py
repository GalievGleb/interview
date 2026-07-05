#!/usr/bin/env python3
"""SkillCue lead bot — приём вакансий и вопросов в Telegram.

Без внешних зависимостей: только стандартная библиотека Python (>= 3.11).
Работает через long polling — хостинг не нужен, достаточно запустить на своём ПК.

Запуск (Windows):
    py -3.12 tools/leadbot/leadbot.py

Первый запуск создаст config.json рядом со скриптом — впиши туда токен от @BotFather
и перезапусти. Подробная инструкция: docs/gtm/00-start-here.md
"""

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"
LEADS_PATH = BASE / "leads.jsonl"
STATE_PATH = BASE / "state.json"

DEFAULT_CONFIG = {
    "bot_token": "ВСТАВЬ_ТОКЕН_ОТ_BOTFATHER",
    "admin_chat_id": 0,
    "channel_url": "",
    "download_url": "https://github.com/GalievGleb/ScillCue/releases/latest",
}

WELCOME = (
    "Привет! Это SkillCue — подготовка к собеседованиям.\n\n"
    "Пришли текст вакансии (просто вставь его сюда сообщением) — бесплатно вернём:\n"
    "• вероятные вопросы на собеседовании\n"
    "• риски и слабые темы\n"
    "• что подтянуть в первую очередь\n\n"
    "Или скачай приложение (бесплатный старт, карта не нужна): {download_url}"
)

ACK = (
    "Принял 👍 Разбор пришлём сюда в ближайшие 1–2 часа.\n\n"
    "Пока ждёшь — можешь скачать приложение и посмотреть разбор там: {download_url}"
)

NOT_TEXT = "Пришли, пожалуйста, текст вакансии обычным сообщением (скопируй и вставь)."


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def api(token: str, method: str, timeout: int = 65, **params):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(params).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram API {method}: {payload}")
    return payload["result"]


def send(token: str, chat_id: int, text: str):
    # Telegram ограничивает сообщение 4096 символами
    for chunk_start in range(0, len(text), 4000):
        api(token, "sendMessage", chat_id=chat_id, text=text[chunk_start : chunk_start + 4000])


def save_lead(record: dict):
    with LEADS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def handle_message(cfg: dict, msg: dict):
    token = cfg["bot_token"]
    admin_id = int(cfg.get("admin_chat_id") or 0)
    chat_id = msg["chat"]["id"]
    user = msg.get("from", {})
    username = user.get("username", "")
    name = " ".join(filter(None, [user.get("first_name"), user.get("last_name")]))
    text = msg.get("text", "")

    # --- команды администратора ---
    if admin_id and chat_id == admin_id:
        if text.startswith("/reply "):
            try:
                _, target, reply_text = text.split(" ", 2)
                send(token, int(target), reply_text)
                send(token, admin_id, f"✅ Отправлено в {target}")
            except (ValueError, RuntimeError) as e:
                send(token, admin_id, f"⚠️ Не получилось: {e}\nФормат: /reply <chat_id> <текст>")
        elif text == "/leads":
            count = sum(1 for _ in LEADS_PATH.open(encoding="utf-8")) if LEADS_PATH.exists() else 0
            send(token, admin_id, f"Всего записей в leads.jsonl: {count}")
        else:
            send(token, admin_id, "Команды: /reply <chat_id> <текст> — ответить лиду; /leads — счётчик лидов.")
        return

    # --- пользовательский поток ---
    if text.startswith("/start"):
        payload = text[7:].strip()  # /start utm_метка — атрибуция источника
        save_lead(
            {
                "ts": datetime.now(UTC).isoformat(),
                "kind": "start",
                "chat_id": chat_id,
                "username": username,
                "name": name,
                "utm": payload,
            }
        )
        send(token, chat_id, WELCOME.format(download_url=cfg["download_url"]))
        if admin_id:
            send(token, admin_id, f"👋 Новый контакт: {name} @{username} (chat_id: {chat_id}, utm: {payload or '—'})")
        else:
            send(token, chat_id, f"[настройка] Ваш chat_id: {chat_id} — впишите его в config.json как admin_chat_id, если вы владелец бота.")
        return

    if text == "/id":
        send(token, chat_id, f"Ваш chat_id: {chat_id}")
        return

    if not text:
        send(token, chat_id, NOT_TEXT)
        return

    # обычное текстовое сообщение = лид (вакансия или вопрос)
    save_lead(
        {
            "ts": datetime.now(UTC).isoformat(),
            "kind": "lead",
            "chat_id": chat_id,
            "username": username,
            "name": name,
            "text": text,
        }
    )
    send(token, chat_id, ACK.format(download_url=cfg["download_url"]))
    if admin_id:
        send(
            token,
            admin_id,
            f"🔥 Новый лид\nchat_id: {chat_id}\nusername: @{username or '—'}\nимя: {name or '—'}\n"
            f"{'-' * 20}\n{text[:3500]}\n{'-' * 20}\nОтветить: /reply {chat_id} <текст>",
        )


def main():
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(
            json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Создан {CONFIG_PATH}")
        print("1) Получи токен у @BotFather (/newbot) и впиши его в bot_token")
        print("2) Запусти скрипт снова")
        sys.exit(0)

    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG_PATH, {})}
    token = cfg["bot_token"]
    if not token or "ВСТАВЬ" in token:
        print(f"Впиши токен от @BotFather в {CONFIG_PATH} и перезапусти.")
        sys.exit(1)

    me = api(token, "getMe", timeout=15)
    print(f"Бот запущен: @{me['username']} (Ctrl+C — остановить)")
    if not cfg.get("admin_chat_id"):
        print("admin_chat_id пока не задан: напиши боту /start со своего аккаунта —")
        print("он покажет твой chat_id, впиши его в config.json и перезапусти.")

    state = load_json(STATE_PATH, {"offset": 0})
    while True:
        try:
            updates = api(token, "getUpdates", offset=state["offset"], timeout=65, allowed_updates=["message"])
        except (urllib.error.URLError, TimeoutError, RuntimeError) as e:
            print(f"[{datetime.now(UTC):%H:%M:%S}] сеть/API: {e}; повтор через 5 сек")
            time.sleep(5)
            continue

        for upd in updates:
            state["offset"] = upd["update_id"] + 1
            STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
            msg = upd.get("message")
            if not msg:
                continue
            try:
                handle_message(cfg, msg)
            except Exception as e:  # бот не должен падать из-за одного сообщения
                print(f"[{datetime.now(UTC):%H:%M:%S}] ошибка обработки: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлен.")
