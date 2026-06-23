# Interview Assistant

Desktop AI-ассистент для интервью: real-time STT + AI-подсказки.

## Сейчас — локальная разработка (без оплаты)

Оплата отключена через `DEV_SKIP_SUBSCRIPTION=true`. После регистрации сразу доступны все функции.

```bash
# 1. Скопировать env
cp .env.example apps/api/.env
# Заполнить OPENAI_API_KEY и DEEPGRAM_API_KEY в apps/api/.env

# 2. База данных
docker compose up -d

# 3. Установка (лучше НЕ на OneDrive — см. ниже)
pnpm install
pnpm approve-builds
pnpm install

# 4. Запуск
pnpm db:push
pnpm dev:api      # терминал 1
pnpm dev:desktop  # терминал 2
```

## Потом — деплой для пользователей

1. **API на сервер** — backend (NestJS) на VPS/Railway, чтобы приложение ходило за STT/LLM
2. **Сборка .exe** — `pnpm dist:desktop` → installer в `apps/desktop/release/`
3. **Сайт для скачивания** — выложить `landing/index.html` и ссылку на `.exe` (GitHub Releases или свой сервер)

Пункт «webhooks Stripe/ЮKassa» — это настройка оплаты в личных кабинетах платёжек. **Не деплой.** Подключите, когда будете включать подписку (`DEV_SKIP_SUBSCRIPTION=false`).

## OneDrive и зависший `pnpm dist:desktop`

Если команда зависла на `Packages: +806 ... added 0` — нажмите **Ctrl+C**. OneDrive блокирует установку.

**Решение:** перенесите проект:
```powershell
xcopy "C:\Users\galie\OneDrive\Рабочий стол\interview" "C:\dev\interview\" /E /I /H
cd C:\dev\interview
pnpm install
pnpm approve-builds
pnpm install
pnpm dist:desktop
```

## Сборка installer

```bash
pnpm dist:desktop
# Результат: apps/desktop/release/Interview Assistant Setup x.x.x.exe
```

## Горячие клавиши

- `Ctrl+Shift+S` — старт/стоп сессии
- `Ctrl+Shift+H` — показать/скрыть overlay
