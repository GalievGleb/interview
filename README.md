# SkillCue

Desktop AI-приложение для подготовки к интервью: облачное распознавание речи OpenAI + разбор вакансии, пробные собеседования и обратная связь по ответам.

> 📈 **Go-to-Market:** план продаж, SEO и запуска — в [docs/gtm/README.md](docs/gtm/README.md) (стратегия, pre-launch чеклист, воронка, каналы, скрипты продаж, roadmap на 90 дней).

> **Требования:** Node ≥ 22.13, **Python 3.12** для сборки backend (код требует минимум 3.11), `pnpm`.
>
> **Архитектура бэкендов:** приложение работает с локальным `apps/api-py` (FastAPI). Каталог `apps/api` (NestJS, биллинг) пока **не подключён** к десктопу — см. [ADR 0001](docs/adr/0001-backend-architecture.md).

## Быстрый старт (Windows / macOS)

```bash
git clone git@github.com:GalievGleb/interview.git
cd interview

pnpm install
pnpm --filter @interview/shared build
```

### Backend (FastAPI) — терминал 1

```bash
cd apps/api-py
# Windows: py -3.12 -m venv .venv
# macOS:   python3.12 -m venv .venv

# macOS / Linux:
source .venv/bin/activate

# Windows:
# .venv\Scripts\activate

pip install -r requirements.txt
# Для распознавания речи используется облачный OpenAI STT — нужен настроенный ключ OpenAI/SkillCue (задаётся в UI или .env).
cp .env.example .env   # ключи можно также задать в UI приложения

uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"
```

### Тесты и линт (бэкенд)

```bash
cd apps/api-py
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
PYTHONPATH=. pytest -q
```

Проверка: http://127.0.0.1:8000/health

### Desktop — терминал 2

```bash
# из корня репозитория
pnpm --filter @interview/desktop dev
```

Откроется http://localhost:5173 (Electron/Vite).

## Сборка installer (Windows)

```bash
pnpm dist:desktop
# apps/desktop/release/
```

## Сборка на macOS

Нужны Node.js ≥ 22.13, pnpm (через Corepack) и Python 3.12. Сборку выполняйте на Mac той же архитектуры, для которой нужен DMG. В папке `apps/api-py/.venv` команда сама создаст виртуальное окружение и установит Python-зависимости. Для профиля и Google-входа в Stable macOS положите Desktop OAuth JSON в игнорируемый Git файл `.google_oauth_client.json` или передайте `SKILLCUE_GOOGLE_OAUTH_CLIENT_ID` и `SKILLCUE_GOOGLE_OAUTH_CLIENT_SECRET` через окружение сборки. Сервер профиля по умолчанию — `https://skill-cue.ru/account`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build:shared
pnpm dist:desktop:mac
# apps/desktop/release/SkillCue-macOS-arm64.dmg или SkillCue-macOS-x64.dmg
```

Для локального запуска из исходников используйте `pnpm dev:desktop`. Dev-режим берёт Python из `apps/api-py/.venv`, если окружение есть. Если его ещё нет, сначала выполните `pnpm --filter @interview/desktop build:backend` или настройте Python 3.12 и зависимости вручную. Локальный DMG не подписан сертификатом Apple; для распространения вне этого Mac потребуются подпись и нотариализация.

Чтобы обновить локальное приложение без ручного переноса DMG, выполните из корня репозитория `pnpm update:mac:local`. Команда собирает оба компонента, завершает открытую Stable-версию, заменяет `/Applications/SkillCue.app` и открывает новую. Ярлык `~/Desktop/SkillCue Local.app` ведёт на ту же установленную копию. Данные пользователя остаются в каталоге Application Support. Во время разработки интерфейса `pnpm dev:desktop` обновляет страницу через Vite без пересборки приложения.

## Обязательная проверка Dev-сборки перед собеседованием

После любой сборки/установки Dev-версии прогони smoke-gate установленного приложения:

```bash
pnpm dist:desktop:dev                 # сборка Dev-инсталлятора (+ PyInstaller бэкенда)
# установить apps/desktop/release-dev/SkillCue-Dev-Setup.exe, затем:
pnpm --filter @interview/desktop verify:dev:overlay
# или одной командой (сборка → установка → проверка):
pnpm --filter @interview/desktop release:dev:verified
```

Гейт стартует бэкенд из установленного приложения без Electron, отправляет точный SSE-запрос оверлея и валидирует ответ. Без пройденного гейта Dev-сборка считается неверифицированной.

## Горячие клавиши

- `Ctrl+Shift+S` — старт/стоп сессии
- `Ctrl+Shift+H` — overlay
