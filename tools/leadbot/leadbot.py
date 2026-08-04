#!/usr/bin/env python3
"""SkillCue lead bot — приём вакансий и вопросов в Telegram.

Без внешних зависимостей: только стандартная библиотека Python (>= 3.11).
Работает через long polling — хостинг не нужен, достаточно запустить на своём ПК.

Запуск (Windows):        py -3.12 tools/leadbot/leadbot.py   (или start-leadbot.bat)
Оформить профиль бота:   py -3.12 tools/leadbot/leadbot.py --setup
    (имя, описание, меню команд — один раз после изменения текстов)

Первый запуск создаст config.json рядом со скриптом — впиши туда токен от @BotFather.
Подробная инструкция: docs/gtm/00-start-here.md
"""

import base64
import json
import os
import re
import sys
import time
import traceback
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
    "download_url": "https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-Setup.exe",
    # Платёжная ссылка (Т-Банк «перевод по ссылке» / ЮKassa / Lava). Если задана —
    # показывается первой, СБП — как запасной способ.
    "pay_url": "",
    # СБП-реквизиты для перевода (все три поля заданы — бот показывает блок СБП).
    "sbp_phone": "",
    "sbp_bank": "",
    "sbp_name": "",
    # Приватный ключ подписи лицензий; пусто — apps/api-py/.license_signing_key из репо.
    "signing_key_path": "",
}

# Сообщение длиннее этого порога считаем вакансией, короче — вопросом.
VACANCY_MIN_CHARS = 300

# ---------------------------------------------------------------- тексты ---

BOT_NAME = "SkillCue — подготовка к собеседованиям"

BOT_SHORT_DESCRIPTION = (  # «о боте» в профиле, максимум 120 символов
    "Пришли вакансию — бесплатно покажу вероятные вопросы и слабые места до собеседования."
)

BOT_DESCRIPTION = (  # текст до кнопки «Start», максимум 512 символов
    "Собеседование скоро, а что спросят — неизвестно?\n\n"
    "Пришли текст вакансии — бесплатно верну:\n"
    "• вероятные вопросы по позиции\n"
    "• риски и слабые темы\n"
    "• что подтянуть в первую очередь\n\n"
    "А в приложении SkillCue — тренировка ответов, карта готовности и live-подсказки "
    "во время созвона. Бесплатный старт, карта не нужна.\n\n"
    "Жми «Начать» и вставляй вакансию 👇"
)

WELCOME = (
    "Привет! Это SkillCue 👋\n\n"
    "Собес на носу, а что спросят — загадка? Исправим: узнаешь вопросы ДО звонка, "
    "а не на нём.\n\n"
    "📄 Вставь сюда полный текст вакансии одним сообщением — и бесплатно получишь:\n"
    "• вероятные вопросы именно по этой позиции\n"
    "• темы, на которых тебя, скорее всего, «прожмут»\n"
    "• что подтянуть в первую очередь\n\n"
    "Разбор делает живой эксперт — обычно 1–2 часа, зато по делу и без воды.\n\n"
    "⬇️ Хочешь готовиться всерьёз? В приложении SkillCue: тренировка ответов, карта "
    "готовности и live-подсказки прямо во время созвона. Бесплатный старт, карта не нужна."
)

ACK_VACANCY = (
    "Вакансию принял, беру в разбор! 🔥\n\n"
    "В течение 1–2 часов пришлю сюда:\n"
    "• вероятные вопросы\n"
    "• риски и слабые темы\n"
    "• план подготовки\n\n"
    "Пока ждёшь — поставь SkillCue: там разбор глубже, плюс тренировка ответов и карта "
    "готовности. Старт бесплатный, карта не нужна."
)

ACK_MESSAGE = (
    "Принял! 👍 Скоро отвечу.\n\n"
    "Если готовишься к собеседованию — пришли полный текст вакансии (описание + требования "
    "одним сообщением), сделаю бесплатный разбор: вопросы, риски, что подтянуть."
)

ACK_NOT_TEXT = (
    "Принял 👀 Но текстом разбор получится точнее: скопируй текст вакансии и вставь его "
    "сюда обычным сообщением."
)

HELP = (
    "Как получить бесплатный разбор вакансии:\n\n"
    "1. Открой вакансию (hh, career.habr — откуда угодно)\n"
    "2. Скопируй весь текст: описание, требования, обязанности\n"
    "3. Вставь сюда одним сообщением\n\n"
    "В ответ за 1–2 часа: вероятные вопросы, риски и план подготовки.\n\n"
    "Вопросы по приложению SkillCue — тоже сюда, отвечаю быстро."
)

ADMIN_HELP = (
    "Ты админ этого бота. Что умею:\n\n"
    "• Ответить лиду — просто ответь реплаем на уведомление о лиде\n"
    "• /reply <chat_id> <текст> — то же самое вручную\n"
    "• /key <basic|max> <дней|0> <email> [chat_id] — выпустить лицензионный ключ\n"
    "  (0 дней = бессрочный; с chat_id ключ сразу уйдёт покупателю)\n"
    "• /stats — статистика по лидам\n\n"
    "Все лиды пишутся в leads.jsonl рядом со скриптом."
)

# Витрина тарифов (цены синхронизированы с apps/desktop/src/lib/billing.ts и лендингом).
PLAN_CATALOG = {
    "basic": {"title": "💼 Базовый — подготовка", "rub": 1490},
    "max": {"title": "🚀 Максимум — всё включено", "rub": 2990},
}

BUY_INTRO = (
    "Тарифы SkillCue:\n\n"
    "💼 Базовый — подготовка: 1 490 ₽/мес\n"
    "Мок-собеседования, анализ вакансий, тренировка ответов, 5 млн токенов ИИ.\n\n"
    "🚀 Максимум — всё включено: 2 990 ₽/мес\n"
    "+ live-подсказки на созвоне, оверлей, анализ экрана, 20 млн токенов ИИ.\n\n"
    "Год = цена 10 месяцев (2 в подарок).\n\n"
)

KEY_DELIVERY = (
    "🎉 Готово! Твой лицензионный ключ:\n\n{key}\n\n"
    "Активация: открой SkillCue → Настройки → Лицензия → вставь ключ целиком "
    "(начинается со SKILLCUE-).\n"
    "Тариф: {plan_title}, срок: {term}.\n\n"
    "Если что-то не заработало — просто напиши сюда."
)

USER_COMMANDS = [
    {"command": "start", "description": "Что умеет бот"},
    {"command": "buy", "description": "Купить тариф (Базовый / Максимум)"},
    {"command": "help", "description": "Как получить бесплатный разбор"},
]

ADMIN_COMMANDS = USER_COMMANDS + [
    {"command": "stats", "description": "Статистика по лидам"},
    {"command": "reply", "description": "Ответить лиду: /reply <chat_id> <текст>"},
    {"command": "key", "description": "Выпустить ключ: /key <basic|max> <дней|0> <email> [chat_id]"},
]


def pay_instructions(cfg: dict) -> str:
    ways = []
    if cfg.get("pay_url"):
        ways.append(f"💳 Оплата по ссылке (карта любого банка):\n{cfg['pay_url']}")
    if cfg.get("sbp_phone") and cfg.get("sbp_bank") and cfg.get("sbp_name"):
        ways.append(
            "📱 Перевод по СБП (займёт минуту):\n"
            f"Телефон: {cfg['sbp_phone']}\n"
            f"Банк: {cfg['sbp_bank']}\n"
            f"Получатель: {cfg['sbp_name']} — сверь имя перед отправкой"
        )
    if not ways:
        return (
            "Напиши сюда «Беру Базовый» или «Беру Максимум» — пришлю реквизиты для оплаты. "
            "После оплаты вышлю лицензионный ключ в течение часа."
        )
    return (
        "\n\n".join(ways)
        + "\n\nПосле оплаты пришли сюда скрин перевода — в течение часа вышлю "
        "лицензионный ключ (обычно быстрее)."
    )

# ------------------------------------------------------------- инфраструктура ---


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


def download_button(cfg: dict) -> dict:
    rows = [[{"text": "⬇️ Скачать SkillCue для Windows", "url": cfg["download_url"]}]]
    if cfg.get("channel_url"):
        rows.append([{"text": "📣 Канал SkillCue", "url": cfg["channel_url"]}])
    return {"inline_keyboard": rows}


def send(token: str, chat_id: int, text: str, reply_markup: dict | None = None):
    # Telegram ограничивает сообщение 4096 символами; кнопки вешаем на последний кусок
    chunks = [text[i : i + 4000] for i in range(0, len(text), 4000)] or [""]
    for i, chunk in enumerate(chunks):
        params = {"chat_id": chat_id, "text": chunk}
        if reply_markup and i == len(chunks) - 1:
            params["reply_markup"] = reply_markup
        api(token, "sendMessage", **params)


def save_lead(record: dict):
    record["ts"] = datetime.now(UTC).isoformat()
    with LEADS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def log(text: str):
    print(f"[{datetime.now(UTC):%H:%M:%S}] {text}", flush=True)


def persist_state(state: dict):
    # Windows: антивирус/индексатор может кратко держать файл — пробуем несколько раз
    for attempt in range(3):
        try:
            STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
            return
        except OSError as e:
            if attempt == 2:
                log(f"state.json не записался: {e} (offset={state['offset']})")
            else:
                time.sleep(0.2)


def mint_license(cfg: dict, plan: str, days: int, email: str) -> str:
    """Выпустить Ed25519-ключ — тот же формат, что проверяет apps/api-py (license.py).

    Требует пакет cryptography и приватный ключ издателя. Логика зеркалит
    apps/api-py/tools/generate_license_key.py — формат менять только синхронно!
    """
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError:
        raise RuntimeError(
            "нет пакета cryptography — установи: py -3.12 -m pip install cryptography"
        ) from None

    key_path = Path(cfg.get("signing_key_path") or "")
    if not cfg.get("signing_key_path"):
        key_path = BASE.parent.parent / "apps" / "api-py" / ".license_signing_key"
    if not key_path.exists():
        raise RuntimeError(f"нет приватного ключа подписи: {key_path}")

    priv = Ed25519PrivateKey.from_private_bytes(
        bytes.fromhex(key_path.read_text(encoding="utf-8").strip())
    )
    payload: dict = {"email": email, "issued_at": int(time.time()), "plan": plan}
    if days > 0:
        payload["expires_at"] = int(time.time()) + days * 86400
    body = json.dumps(payload, separators=(",", ":")).encode()

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).decode().rstrip("=")

    return f"SKILLCUE-{b64url(body)}.{b64url(priv.sign(body))}"


# ------------------------------------------------------------------ обработка ---


def notify_admin_lead(cfg: dict, kind_label: str, msg: dict, body: str):
    admin_id = int(cfg.get("admin_chat_id") or 0)
    if not admin_id:
        return
    user = msg.get("from", {})
    username = user.get("username") or "—"
    name = " ".join(filter(None, [user.get("first_name"), user.get("last_name")])) or "—"
    chat_id = msg["chat"]["id"]
    send(
        cfg["bot_token"],
        admin_id,
        f"{kind_label}\nchat_id: {chat_id}\nusername: @{username}\nимя: {name}\n"
        f"{'-' * 20}\n{body[:3400]}\n{'-' * 20}\n"
        f"💬 Ответь реплаем на это сообщение — перешлю лиду. Или: /reply {chat_id} <текст>",
    )


def handle_admin(cfg: dict, msg: dict):
    token = cfg["bot_token"]
    admin_id = int(cfg["admin_chat_id"])
    text = msg.get("text", "")

    # ответ лиду обычным реплаем на уведомление
    replied = msg.get("reply_to_message", {}).get("text", "")
    match = re.search(r"chat_id:\s*(\d+)", replied)
    if match and text:
        target = int(match.group(1))
        send(token, target, text)
        send(token, admin_id, f"✅ Отправлено лиду {target}")
        save_lead({"kind": "admin_reply", "chat_id": target, "text": text})
        return

    if text.startswith("/reply "):
        try:
            _, target, reply_text = text.split(" ", 2)
            send(token, int(target), reply_text)
            send(token, admin_id, f"✅ Отправлено лиду {target}")
            save_lead({"kind": "admin_reply", "chat_id": int(target), "text": reply_text})
        except (ValueError, RuntimeError) as e:
            send(token, admin_id, f"⚠️ Не получилось: {e}\nФормат: /reply <chat_id> <текст>")
        return

    if text.startswith("/key"):
        # /key <basic|max> <дней|0> <email> [chat_id покупателя]
        parts = text.split()
        try:
            plan = parts[1].lower()
            if plan not in PLAN_CATALOG:
                raise ValueError(f"план должен быть basic или max, а не «{plan}»")
            days = int(parts[2])
            email = parts[3]
            target = int(parts[4]) if len(parts) > 4 else None
            key = mint_license(cfg, plan, days, email)
            term = f"{days} дн." if days > 0 else "бессрочно"
            save_lead(
                {"kind": "key_issued", "plan": plan, "days": days, "email": email,
                 "chat_id": target or 0}
            )
            if target:
                send(
                    token,
                    target,
                    KEY_DELIVERY.format(
                        key=key, plan_title=PLAN_CATALOG[plan]["title"], term=term
                    ),
                )
                send(token, admin_id, f"✅ Ключ {plan}/{term} отправлен покупателю {target}")
            else:
                send(token, admin_id, f"Ключ {plan}/{term} для {email}:\n\n{key}")
        except (IndexError, ValueError, RuntimeError) as e:
            send(
                token,
                admin_id,
                f"⚠️ Не получилось: {e}\n"
                "Формат: /key <basic|max> <дней|0> <email> [chat_id]\n"
                "Примеры: /key max 30 ivan@mail.ru 628321557 — сразу покупателю;\n"
                "/key basic 0 test@test.ru — бессрочный, покажу тебе.",
            )
        return

    if text.startswith("/stats"):
        rows = []
        if LEADS_PATH.exists():
            with LEADS_PATH.open(encoding="utf-8") as f:
                rows = [json.loads(line) for line in f if line.strip()]
        today = datetime.now(UTC).date().isoformat()
        kinds = {}
        for r in rows:
            kinds[r.get("kind", "?")] = kinds.get(r.get("kind", "?"), 0) + 1
        today_count = sum(1 for r in rows if r.get("ts", "").startswith(today))
        lines = [f"📊 Всего записей: {len(rows)} (сегодня: {today_count})"]
        lines += [f"• {k}: {v}" for k, v in sorted(kinds.items())]
        send(token, admin_id, "\n".join(lines))
        return

    send(token, admin_id, ADMIN_HELP)


def _handle_buy(cfg: dict, msg: dict, lead_base: dict, payload: str):
    """Покупка: /buy или deep-link buy_<план>_<период> из кнопки «Оплатить» приложения."""
    token = cfg["bot_token"]
    chat_id = msg["chat"]["id"]
    parts = payload.split("_")  # ["buy"] | ["buy", "max", "monthly"]
    plan = parts[1] if len(parts) > 1 and parts[1] in PLAN_CATALOG else None
    period = parts[2] if len(parts) > 2 else ""

    save_lead({**lead_base, "kind": "buy_intent", "plan": plan or "", "period": period})

    if plan:
        info = PLAN_CATALOG[plan]
        price = info["rub"] * 10 if period == "yearly" else info["rub"]
        price_str = f"{price:,}".replace(",", " ")
        unit = "₽/год (цена 10 месяцев)" if period == "yearly" else "₽/мес"
        text = (
            f"Отличный выбор!\n\n{info['title']}: {price_str} {unit}\n\n"
            f"{pay_instructions(cfg)}\n\n"
            "Ключ активируется в приложении: Настройки → Лицензия."
        )
    else:
        text = BUY_INTRO + pay_instructions(cfg)
    send(token, chat_id, text)

    admin_id = int(cfg.get("admin_chat_id") or 0)
    if admin_id:
        send(
            token,
            admin_id,
            f"🤑 ХОЧЕТ КУПИТЬ: {plan or 'смотрит тарифы'}"
            f"{f' / {period}' if period else ''}\n"
            f"chat_id: {chat_id}\nusername: @{lead_base['username'] or '—'}\n"
            f"имя: {lead_base['name'] or '—'}\n"
            f"💬 Ответь реплаем (реквизиты/вопросы). После оплаты:\n"
            f"/key {plan or 'max'} 30 email@покупателя {chat_id}",
        )


def handle_user(cfg: dict, msg: dict):
    token = cfg["bot_token"]
    chat_id = msg["chat"]["id"]
    user = msg.get("from", {})
    lead_base = {
        "chat_id": chat_id,
        "username": user.get("username", ""),
        "name": " ".join(filter(None, [user.get("first_name"), user.get("last_name")])),
    }
    text = msg.get("text", "")

    if text.startswith("/start"):
        payload = text[7:].strip()  # /start utm_метка ИЛИ buy_<план>_<период> из приложения
        if payload.startswith("buy"):
            _handle_buy(cfg, msg, lead_base, payload)
            return
        save_lead({**lead_base, "kind": "start", "utm": payload})
        send(token, chat_id, WELCOME, reply_markup=download_button(cfg))
        admin_id = int(cfg.get("admin_chat_id") or 0)
        if admin_id:
            send(
                token,
                admin_id,
                f"👋 Новый контакт: {lead_base['name']} @{lead_base['username'] or '—'} "
                f"(chat_id: {chat_id}, utm: {payload or '—'})",
            )
        else:
            send(
                token,
                chat_id,
                f"[настройка] Ваш chat_id: {chat_id} — впишите его в config.json "
                "как admin_chat_id, если вы владелец бота.",
            )
        return

    if text.startswith("/buy"):
        _handle_buy(cfg, msg, lead_base, "buy")
        return

    if text.startswith("/help"):
        send(token, chat_id, HELP)
        return

    if not text:
        # фото/файл/голос: пересылаем админу как есть + просим текст
        save_lead({**lead_base, "kind": "non_text"})
        admin_id = int(cfg.get("admin_chat_id") or 0)
        if admin_id:
            api(
                token,
                "forwardMessage",
                chat_id=admin_id,
                from_chat_id=chat_id,
                message_id=msg["message_id"],
            )
            notify_admin_lead(cfg, "📎 Не-текстовое сообщение (переслал выше)", msg, "")
        send(token, chat_id, ACK_NOT_TEXT)
        return

    if len(text) >= VACANCY_MIN_CHARS:
        save_lead({**lead_base, "kind": "vacancy", "text": text})
        send(token, chat_id, ACK_VACANCY, reply_markup=download_button(cfg))
        notify_admin_lead(cfg, "🔥 ВАКАНСИЯ НА РАЗБОР", msg, text)
    else:
        save_lead({**lead_base, "kind": "message", "text": text})
        send(token, chat_id, ACK_MESSAGE)
        notify_admin_lead(cfg, "✉️ Сообщение", msg, text)


def handle_message(cfg: dict, msg: dict):
    admin_id = int(cfg.get("admin_chat_id") or 0)
    if admin_id and msg["chat"]["id"] == admin_id:
        handle_admin(cfg, msg)
    else:
        handle_user(cfg, msg)


# --------------------------------------------------------------- профиль бота ---


def setup_profile(cfg: dict):
    """Оформление профиля через Bot API (аватар API не умеет — только @BotFather)."""
    token = cfg["bot_token"]
    steps = [
        ("setMyName", {"name": BOT_NAME}),
        ("setMyShortDescription", {"short_description": BOT_SHORT_DESCRIPTION}),
        ("setMyDescription", {"description": BOT_DESCRIPTION}),
        ("setMyCommands", {"commands": USER_COMMANDS}),
    ]
    admin_id = int(cfg.get("admin_chat_id") or 0)
    if admin_id:
        steps.append(
            (
                "setMyCommands",
                {
                    "commands": ADMIN_COMMANDS,
                    "scope": {"type": "chat", "chat_id": admin_id},
                },
            )
        )
    for method, params in steps:
        try:
            api(token, method, timeout=20, **params)
            print(f"OK   {method}")
        except (RuntimeError, urllib.error.URLError) as e:
            print(f"FAIL {method}: {e}")
    print("Готово. Аватар поставь через @BotFather: /setuserpic")


# ----------------------------------------------------------------------- main ---


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

    if "--setup" in sys.argv:
        setup_profile(cfg)
        return

    me = api(token, "getMe", timeout=15)
    print(f"Бот запущен: @{me['username']}, PID {os.getpid()} (Ctrl+C — остановить)", flush=True)
    if not cfg.get("admin_chat_id"):
        print("admin_chat_id пока не задан: напиши боту /start со своего аккаунта —")
        print("он покажет твой chat_id, впиши его в config.json и перезапусти.")

    state = load_json(STATE_PATH, {"offset": 0})
    while True:
        try:
            updates = api(
                token,
                "getUpdates",
                offset=state["offset"],
                timeout=65,
                allowed_updates=["message"],
            )
        except Exception as e:  # сеть/API на Windows кидает разные типы (URLError, OSError, JSON...)
            log(f"сеть/API: {type(e).__name__}: {e}; повтор через 5 сек")
            time.sleep(5)
            continue

        for upd in updates:
            try:  # бот не должен падать из-за одного апдейта, что бы ни случилось
                state["offset"] = upd["update_id"] + 1
                persist_state(state)
                msg = upd.get("message")
                if msg:
                    handle_message(cfg, msg)
            except Exception as e:
                log(f"ошибка обработки: {type(e).__name__}: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлен.")
    except Exception:
        # молчаливых смертей не бывает: причина всегда остаётся в crash.log
        crash = f"[{datetime.now(UTC).isoformat()}]\n{traceback.format_exc()}\n"
        try:
            with (BASE / "crash.log").open("a", encoding="utf-8") as f:
                f.write(crash)
        finally:
            print(crash, file=sys.stderr, flush=True)
        raise
