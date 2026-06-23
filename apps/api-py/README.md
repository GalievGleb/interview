# Interview & Meeting Copilot — Backend (FastAPI)

Локальный backend на Python. Вся логика: провайдеры LLM, RAG, сессии, STT.

## Запуск

```bash
cd apps/api-py
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
copy .env.example .env         # и заполнить ключи (или ввести в UI)
uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"

Or on Windows: `.\run_dev.ps1`
```

Проверка: открыть http://127.0.0.1:8000/health и http://127.0.0.1:8000/docs

## Endpoints

| Метод | Путь | Описание |
|---|---|---|
| GET | `/health` | Проверка статуса |
| POST | `/providers/test` | Проверить ключ/модель |
| GET | `/providers/models` | Список моделей |
| POST | `/settings/keys` | Сохранить ключи (secure storage) |
| GET | `/settings/keys` | Статус ключей |
| POST | `/chat` | Ответ стримом (SSE) с RAG |
| POST | `/chat/interview` | Структурный ответ интервью (short/spoken/detailed/en/risk) |
| POST | `/chat/meeting-summary` | Summary митинга (Markdown) |
| POST | `/documents/upload` | Загрузка PDF/DOCX/TXT |
| POST | `/documents/text` | Загрузка текста напрямую |
| POST | `/documents/search` | RAG-поиск |
| GET | `/documents` | Список документов |
| DELETE | `/documents/{id}` | Удалить документ |
| POST | `/sessions` | Создать сессию |
| GET | `/sessions` | История |
| GET | `/sessions/{id}` | Сессия + transcript + answers |
| POST | `/sessions/{id}/end` | Завершить + summary |
| POST | `/sessions/{id}/transcript` | Добавить реплику |
| GET | `/usage` | Статистика |
| DELETE | `/data` | Удалить ВСЕ данные (privacy) |

## Ключи

Хранятся в OS secure storage (keyring). `.env` — только для локальной разработки.
Ключи не логируются (фильтр в `core/logging.py`).
