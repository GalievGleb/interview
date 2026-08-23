# SkillCue

Desktop AI-приложение для подготовки к интервью: облачное распознавание речи OpenAI + разбор вакансии, пробные собеседования и обратная связь по ответам.

> 📈 **Go-to-Market:** план продаж, SEO и запуска — в [docs/gtm/README.md](docs/gtm/README.md) (стратегия, pre-launch чеклист, воронка, каналы, скрипты продаж, roadmap на 90 дней).

> **Требования:** Node ≥ 20, **Python ≥ 3.11** (код использует `datetime.UTC`; на 3.10 не запустится), `pnpm`.
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
py -3.12 -m venv .venv     # или любой Python >= 3.11

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
