# Interview Copilot

Desktop AI-ассистент для интервью: live STT + подсказки по резюме.

**Рабочая копия проекта:** не храните репозиторий в OneDrive — используйте обычную папку (`C:\dev\interview` на Windows или `~/dev/interview` на macOS) или клон с GitHub.

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
python -m venv .venv

# macOS / Linux:
source .venv/bin/activate

# Windows:
# .venv\Scripts\activate

pip install -r requirements.txt
cp .env.example .env   # ключи можно также задать в UI приложения

uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"
```

Проверка: http://127.0.0.1:8000/health

### Desktop — терминал 2

```bash
# из корня репозитория
pnpm --filter @interview/desktop dev
```

Откроется http://localhost:5173 (Electron/Vite).

## OneDrive

Папка на рабочем столе OneDrive — **устаревший дубликат**. Актуальный код — в git (`C:\dev\interview` или клон с GitHub). OneDrive-копию можно удалить после push, если всё есть на GitHub.

## Сборка installer (Windows)

```bash
pnpm dist:desktop
# apps/desktop/release/
```

## Горячие клавиши

- `Ctrl+Shift+S` — старт/стоп сессии
- `Ctrl+Shift+H` — overlay
