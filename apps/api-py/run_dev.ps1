# Dev-сервер без reload на SQLite (иначе SSE-стрим обрывается mid-flight)
.venv\Scripts\uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"
