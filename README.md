# Interview Copilot

Desktop AI-ассистент для интервью: **локальный** STT (on-device Whisper) + подсказки по резюме.

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
# Локальный Whisper (опционально, ~для live STT): pip install -r requirements-whisper.txt
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

## Горячие клавиши

- `Ctrl+Shift+S` — старт/стоп сессии
- `Ctrl+Shift+H` — overlay
