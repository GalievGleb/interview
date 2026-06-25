# Dev-сервер без reload на SQLite (иначе SSE-стрим обрывается mid-flight)
# После git pull с новыми routes: Ctrl+C и перезапусти этот скрипт.
.venv\Scripts\uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"
