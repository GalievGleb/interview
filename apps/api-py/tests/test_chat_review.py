"""HTTP tests for the interview-review endpoints with a mocked LLM provider.

No real API key is needed — `provider_adapter.complete` / `.stream_chat` are
monkeypatched, so we test the routing, prompt wiring, and SSE framing only.
"""

import json

from app.routers.chat import MAX_SCREEN_IMAGE_CHARS
from app.prompts.meeting import (
    build_interview_outcome_prompt,
    build_interview_review_prompt,
    build_meeting_prompt,
)
from app.services import provider_adapter


def test_interview_outcome_prompt_is_compact_and_stage_specific():
    prompt = build_interview_outcome_prompt(
        "HR: Формат удалённый. Следующий этап во вторник.",
        "hr",
        "QA Automation",
        "Acme",
        "ru",
    )
    assert '"conditions"' in prompt
    assert '"nextSteps"' in prompt
    assert "зарплатную вилку" in prompt
    assert "Do not evaluate the candidate" in prompt


def test_interview_outcome_returns_normalized_json(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        captured["kwargs"] = kwargs
        return json.dumps(
            {
                "headline": "Договорились о техническом этапе.",
                "facts": ["Команда из пяти человек"],
                "conditions": ["Удалённый формат"],
                "nextSteps": ["Технический этап во вторник"],
                "openQuestions": ["Зарплатная вилка"],
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/chat/interview-outcome",
        json={
            "transcript": "HR: Работа удалённая.",
            "interview_type": "hr",
            "vacancy_title": "QA Automation",
            "company_name": "Acme",
            "answer_language": "ru",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["conditions"] == ["Удалённый формат"]
    assert body["nextSteps"] == ["Технический этап во вторник"]
    assert captured["kwargs"]["response_format"] == {"type": "json_object"}
    assert "QA Automation" in captured["prompt"]


def test_prompt_builders_detect_transcript_language_when_not_explicit():
    russian = build_meeting_prompt(
        "Интервьюер: Расскажите про API. Кандидат: Проверяю схему ответа.",
        None,
    )
    english = build_interview_review_prompt(
        "Interviewer: What is an API? Candidate: It is an interface.",
        None,
    )

    assert "## Кратко" in russian
    assert "## Summary" not in russian
    assert "## Conclusion" in english
    assert "## Итог" not in english


def test_interview_review_returns_review_and_wires_prompt(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, provider=None, model=None, max_tokens=800, temperature=0.4):
        captured["messages"] = messages
        captured["max_tokens"] = max_tokens
        return "РАЗБОР: кандидат путает unit и integration тесты."

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post(
        "/chat/interview-review",
        json={"transcript": "Кандидат: я тестирую только вручную."},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["review"].startswith("РАЗБОР")
    assert "model" in body

    # The transcript must reach the model, wrapped in the review instructions.
    user_msg = captured["messages"][-1]["content"]
    assert "я тестирую только вручную" in user_msg
    assert "Проблемные места" in user_msg  # marker from INTERVIEW_REVIEW_PROMPT
    assert captured["max_tokens"] >= 1000  # review needs room


def test_interview_review_stream_emits_chunks_then_done(client, monkeypatch):
    async def fake_stream(messages, provider=None, model=None, max_tokens=800, temperature=0.4):
        for piece in ["Итог: ", "ответы слабые."]:
            yield piece

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    res = client.post("/chat/interview-review/stream", json={"transcript": "..."})
    assert res.status_code == 200, res.text
    assert "text/event-stream" in res.headers["content-type"]

    events = [
        json.loads(line[len("data: ") :])
        for line in res.text.splitlines()
        if line.startswith("data: ")
    ]
    types = [e["type"] for e in events]
    assert "chunk" in types
    assert types[-1] == "done"

    streamed = "".join(e["text"] for e in events if e["type"] == "chunk")
    assert streamed == "Итог: ответы слабые."


def test_interview_review_stream_reports_provider_error(client, monkeypatch):
    async def boom(messages, provider=None, model=None, max_tokens=800, temperature=0.4):
        raise RuntimeError("provider down")
        yield  # pragma: no cover  (makes this an async generator)

    monkeypatch.setattr(provider_adapter, "stream_chat", boom)

    res = client.post("/chat/interview-review/stream", json={"transcript": "x"})
    assert res.status_code == 200, res.text
    events = [
        json.loads(line[len("data: ") :])
        for line in res.text.splitlines()
        if line.startswith("data: ")
    ]
    assert any(e["type"] == "error" for e in events)


def test_meeting_summary_stream_emits_chunks_then_done(client, monkeypatch):
    async def fake_stream(messages, provider=None, model=None, max_tokens=800, temperature=0.4):
        for piece in ["Summary: ", "решения приняты."]:
            yield piece

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    res = client.post("/chat/meeting-summary/stream", json={"transcript": "..."})
    assert res.status_code == 200, res.text
    assert "text/event-stream" in res.headers["content-type"]

    events = [
        json.loads(line[len("data: ") :])
        for line in res.text.splitlines()
        if line.startswith("data: ")
    ]
    types = [e["type"] for e in events]
    assert "chunk" in types
    assert types[-1] == "done"
    assert "".join(e["text"] for e in events if e["type"] == "chunk") == "Summary: решения приняты."


def test_screen_assist_stream_builds_multimodal_message(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, max_tokens=800, temperature=0.4):
        captured["messages"] = messages
        yield "На экране задача по SQL."

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    res = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Помоги решить",
            "context": "Интервьюер: реши задачу",
        },
    )
    assert res.status_code == 200, res.text
    events = [
        json.loads(line[len("data: ") :])
        for line in res.text.splitlines()
        if line.startswith("data: ")
    ]
    assert any(e["type"] == "chunk" for e in events)

    user = captured["messages"][-1]
    parts = user["content"]
    kinds = {p["type"] for p in parts}
    assert kinds == {"text", "image_url"}
    text_part = next(p for p in parts if p["type"] == "text")["text"]
    assert "Помоги решить" in text_part
    assert "реши задачу" in text_part  # транскрипт подмешан
    img = next(p for p in parts if p["type"] == "image_url")["image_url"]["url"]
    assert img.startswith("data:image/jpeg;base64,")
    assert next(p for p in parts if p["type"] == "image_url")["image_url"]["detail"] == "high"
    system_prompt = captured["messages"][0]["content"]
    assert "Декоратор с args и kwargs" in system_prompt
    assert "полный рабочий" in system_prompt
    assert "ответ без исполняемого блока кода считается неправильным" in system_prompt
    assert system_prompt.index("СНАЧАЛА решение одним блоком кода") < system_prompt.index("После кода")


def test_screen_assist_default_question_demands_executable_code(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "```python\nprint('ok')\n```"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    res = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD"},
    )
    assert res.status_code == 200, res.text
    text_part = next(
        part
        for part in captured["messages"][-1]["content"]
        if part["type"] == "text"
    )["text"]
    assert "обязательно дай полный рабочий код" in text_part


def test_screen_assist_rejects_empty_and_huge_images(client, monkeypatch):
    async def fake_stream(*a, **k):
        yield "x"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    assert client.post("/chat/screen/stream", json={"image": ""}).status_code == 400
    huge = "A" * (MAX_SCREEN_IMAGE_CHARS + 1)
    assert client.post("/chat/screen/stream", json={"image": huge}).status_code == 413


def test_chat_injects_answer_language_block(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kw):
        captured["messages"] = messages
        yield "ok"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    res = client.post("/chat", json={"message": "Привет", "answer_language": "en"})
    assert res.status_code == 200, res.text
    user_msg = captured["messages"][-1]["content"]
    assert "OUTPUT LANGUAGE" in user_msg
    assert "English" in user_msg

    # Без настройки блок не добавляется — модель отвечает на языке вопроса.
    res = client.post("/chat", json={"message": "Привет"})
    assert res.status_code == 200, res.text
    assert "OUTPUT LANGUAGE" not in captured["messages"][-1]["content"]


def test_fast_chat_skips_rag_and_prioritizes_fast_stream(client, monkeypatch):
    from app.routers import chat as chat_router

    captured: dict = {}

    async def forbidden_search(*args, **kwargs):
        raise AssertionError("fast chat must not call RAG")

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        captured.update(kwargs)
        yield "быстро"

    monkeypatch.setattr(chat_router.rag_service, "search", forbidden_search)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat",
        json={
            "message": "Что такое тестирование?",
            "mode": "fast",
            "context": "Собеседование на позицию QA.",
        },
    )

    assert response.status_code == 200, response.text
    assert captured["route_fast"] is True
    assert captured["max_tokens"] == 450
    assert captured["temperature"] == 0.3
    assert "Собеседование на позицию QA." in captured["messages"][1]["content"]


def test_interview_stream_injects_answer_language_block(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kw):
        captured["messages"] = messages
        yield "Готовый ответ."

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    # Стрим-endpoint открывает собственный SessionLocal (живёт дольше запроса) —
    # в тестах он должен указывать на in-memory БД, а не на файл разработчика.
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)

    res = client.post(
        "/chat/interview/stream",
        json={"question": "Что такое REST?", "answer_language": "en"},
    )
    assert res.status_code == 200, res.text
    user_msg = captured["messages"][-1]["content"]
    assert "OUTPUT LANGUAGE" in user_msg
    assert "English" in user_msg


def test_screen_assist_injects_answer_language_block(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kw):
        captured["messages"] = messages
        yield "ok"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    res = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "answer_language": "ru"},
    )
    assert res.status_code == 200, res.text
    text_part = next(p for p in captured["messages"][-1]["content"] if p["type"] == "text")["text"]
    assert "OUTPUT LANGUAGE" in text_part
    assert "Russian" in text_part


def test_answer_variant_language_block_skips_english_variant(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, provider=None, model=None, **kw):
        captured["messages"] = messages
        return "вариант"

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    base = {"question": "Q", "answer": "A", "answer_language": "ru"}

    res = client.post("/chat/answer-variant", json={**base, "variant": "short"})
    assert res.status_code == 200, res.text
    assert "OUTPUT LANGUAGE" in captured["messages"][-1]["content"]

    # Вариант "english" всегда английский — настройка не должна его ломать.
    res = client.post("/chat/answer-variant", json={**base, "variant": "english"})
    assert res.status_code == 200, res.text
    assert "OUTPUT LANGUAGE" not in captured["messages"][-1]["content"]


def test_meeting_summary_russian_language_uses_russian_headings(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        yield "## Кратко\n- Обсудили API."

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/meeting-summary/stream",
        json={"transcript": "Интервьюер: Что такое API?", "answer_language": "ru"},
    )

    assert response.status_code == 200
    assert "## Кратко" in captured["prompt"]
    assert "## Summary" not in captured["prompt"]
    assert "Пиши весь обычный текст по-русски" in captured["prompt"]


def test_interview_review_russian_language_is_explicit(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        return "## Итог\nОтвет поверхностный."

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/chat/interview-review",
        json={"transcript": "Кандидат: Не знаю.", "answer_language": "ru"},
    )

    assert response.status_code == 200
    assert "Пиши весь обычный текст по-русски" in captured["prompt"]
