"""HTTP tests for the interview-review endpoints with a mocked LLM provider.

No real API key is needed — `provider_adapter.complete` / `.stream_chat` are
monkeypatched, so we test the routing, prompt wiring, and SSE framing only.
"""

import asyncio
import json

import pytest

from app.core import local_auth
from app.core.errors import AppError
from app.prompts.meeting import (
    build_interview_outcome_prompt,
    build_interview_review_prompt,
    build_meeting_prompt,
)
from app.routers.chat import (
    MAX_PREVIOUS_SCREEN_IMAGE_CHARS,
    MAX_PRIOR_SOLUTION_SUMMARY_CHARS,
    MAX_SCREEN_IMAGE_CHARS,
)
from app.services import provider_adapter


async def _asgi_post_chunks(path: str, chunks: list[bytes], headers: dict[str, str] | None = None):
    """Exercise app middleware with an actual multi-chunk ASGI request body."""
    from app.main import app

    sent: list[dict] = []
    index = 0
    request_headers = {
        "content-type": "application/json",
        "x-skillcue-token": local_auth.API_TOKEN,
        **(headers or {}),
    }

    async def receive():
        nonlocal index
        if index < len(chunks):
            body = chunks[index]
            index += 1
            return {
                "type": "http.request",
                "body": body,
                "more_body": index < len(chunks),
            }
        await asyncio.Future()

    async def send(message):
        sent.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [(key.encode(), value.encode()) for key, value in request_headers.items()],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        },
        receive,
        send,
    )
    return sent


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

    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        **kwargs,
    ):
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

    async def fake_stream(
        messages, provider=None, model=None, max_tokens=800, temperature=0.4, **kwargs
    ):
        captured["messages"] = messages
        captured["stream_kwargs"] = kwargs
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
    assert "не означает автоматически" in system_prompt
    assert "ответ без полного исполняемого блока кода неправильный" in system_prompt
    assert "НЕ переписывай и НЕ исправляй код" in system_prompt
    assert "Сохраняй точные видимые типы и значения" in system_prompt
    assert "Сохрани точные имена, регистр строковых литералов" in system_prompt
    assert "комментарий отдельной строкой сразу под строкой кода" in system_prompt
    assert (
        system_prompt.index("СНАЧАЛА короткая устная сводка")
        < system_prompt.index("ЗАТЕМ решение одним блоком кода")
        < system_prompt.index("Для результата/ошибки")
    )
    assert captured["stream_kwargs"]["reasoning"] == {"effort": "medium", "exclude": True}
    assert captured["stream_kwargs"]["require_complete"] is True


def test_screen_prompt_prefers_smallest_requirement_complete_solution_without_invented_architecture(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "```sql\nSELECT id FROM users;\n```"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Напиши простой SELECT и скажи, что вернёт видимая таблица users.",
        },
    )

    assert response.status_code == 200, response.text
    system_prompt = captured["messages"][0]["content"]
    user_prompt = captured["messages"][-1]["content"][0]["text"]
    prompt_lower = system_prompt.lower()
    assert "самое маленькое стандартное решение" in system_prompt
    assert "всем видимым требованиям" in system_prompt
    for invented in ("таблицы", "поля", "JOIN", "CTE", "JSON", "классы", "архитектуру"):
        assert invented in system_prompt
    assert "не выдумывай" in prompt_lower
    assert "s[0] = 'H'" not in system_prompt
    assert "'Female'" not in system_prompt
    assert "s[index]" not in user_prompt
    assert "str неизменяем" not in user_prompt


def test_screen_refinement_preserves_interfaces_and_changes_only_latest_request(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Теперь добавь только фильтр active = true.",
            "prior_solution_summary": "def load_users(limit: int) -> list[User]: ...",
        },
    )

    assert response.status_code == 200, response.text
    system_prompt = captured["messages"][0]["content"]
    prompt_lower = system_prompt.lower()
    user_prompt = captured["messages"][-1]["content"][0]["text"]
    assert "точные видимые имена, литералы, сигнатуры, схему и форму результата" in system_prompt
    assert "последнее исправление интервьюера имеет приоритет" in prompt_lower
    assert "измени только то, что запросили последним" in system_prompt
    assert "полное обновлённое решение" in system_prompt
    assert "LATEST INTERVIEWER CORRECTION" in user_prompt
    assert "PRIOR SOLUTION SUMMARY" in user_prompt
    assert "def load_users(limit: int)" in user_prompt


def test_screen_mode_word_limit_applies_only_to_spoken_summary_not_code(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "complete"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Инструкция режима: ответ 40–80 слов. Реализуй видимый класс.",
        },
    )

    assert response.status_code == 200, response.text
    system_prompt = captured["messages"][0]["content"]
    prompt_lower = system_prompt.lower()
    assert "лимит слов режима относится только к устной сводке" in prompt_lower
    assert "не сокращает код, чек-листы, комментарии" in prompt_lower


def test_screen_assist_truncation_emits_chunk_then_error_and_never_done(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["kwargs"] = kwargs
        yield "```python\nprint('partial')"
        raise AppError(
            "Ответ обрезан из-за лимита модели. Это неполное решение — повторите запрос.",
            502,
            "provider_output_truncated",
        )

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Реши задачу"},
    )

    assert response.status_code == 200, response.text
    events = [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == ["chunk", "error"]
    assert "неполное решение" in events[-1]["message"]
    assert captured["kwargs"]["require_complete"] is True


def test_screen_assist_stream_keeps_transport_alive_until_slow_first_token(client, monkeypatch):
    """A slow vision model must not look byte-silent to the desktop watchdog."""
    from app.routers import chat as chat_router

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        await asyncio.sleep(0.04)
        yield "Delayed screen answer"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    monkeypatch.setattr(chat_router, "SCREEN_STREAM_KEEPALIVE_SECONDS", 0.01, raising=False)

    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Read the screen"},
    )

    assert response.status_code == 200, response.text
    frames = response.text.split("\n\n")
    assert sum(frame == ": keepalive" for frame in frames) >= 2
    events = [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == ["chunk", "done"]
    assert events[0]["text"] == "Delayed screen answer"


def test_screen_code_contract_requires_spoken_summary_before_code(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "Короткий план.\n\n```sql\nSELECT 1\n-- Возвращаем единицу.\n```"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Объясни подход и реши задачу",
        },
    )

    assert response.status_code == 200, response.text
    system_prompt = captured["messages"][0]["content"]
    summary_contract = "СНАЧАЛА короткая устная сводка"
    code_contract = "ЗАТЕМ решение одним блоком кода"
    assert summary_contract in system_prompt
    assert "что сказать интервьюеру перед написанием кода" in system_prompt
    assert "1–3 коротких предложения" in system_prompt
    assert code_contract in system_prompt
    assert system_prompt.index(summary_contract) < system_prompt.index(code_contract)


def test_screen_assist_done_reports_actual_model_source_and_creates_no_answer(
    client, db_session, monkeypatch
):
    from app.db import models
    from app.routers import chat as chat_router

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        yield "screen answer"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    monkeypatch.setattr(
        chat_router,
        "_resolve_chat",
        lambda *args, **kwargs: ("test-provider", "actual-screen-model", "configured"),
    )
    before = db_session.query(models.Answer).count()
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Q"},
    )
    assert response.status_code == 200, response.text
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "actual-screen-model"
    assert done["model_source"] == "configured"
    assert db_session.query(models.Answer).count() == before


def test_screen_assist_default_question_follows_visible_task_instead_of_forcing_code(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        captured["model"] = model
        yield "```python\nprint('ok')\n```"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    res = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD"},
    )
    assert res.status_code == 200, res.text
    text_part = next(
        part for part in captured["messages"][-1]["content"] if part["type"] == "text"
    )["text"]
    assert "точную формулировку задания" in text_part
    assert "порядок" in text_part
    assert "только если" in text_part
    assert "обязательно дай полный рабочий код" not in text_part
    # Exact visual tasks use the quality-first multimodal model: the previous
    # model read the screenshot but changed case-sensitive SQL literals.
    assert captured["model"] == "openai/gpt-5.6-sol"


def test_screen_assist_keeps_spoken_api_testing_task_as_testing_not_implementation(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        captured["model"] = model
        yield "Уточняющие вопросы и проверки"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": (
                "Здесь у нас новый endpoint. Нужно составить кейсы для тестирования "
                "функционала. Здесь представлен пример запроса и пример ответа."
            ),
            "context": "Интервьюер показывает JSON-RPC и таблицы PostgreSQL.",
        },
    )

    assert response.status_code == 200, response.text
    text_part = next(
        part for part in captured["messages"][-1]["content"] if part["type"] == "text"
    )["text"]
    assert "ЭТО ЗАДАНИЕ НА ТЕСТИРОВАНИЕ" in text_part
    assert "не реализуй endpoint" in text_part
    assert "не пиши SQL или код" in text_part
    assert "проверки, негативные сценарии" in text_part
    # Testing briefs still depend on visual details and must use the same
    # quality-first model as code tasks; only ordinary voice stays on Qwen.
    assert captured["model"] == "openai/gpt-5.6-sol"


def test_screen_assist_mode_instruction_cannot_replace_visible_task(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "session → module → function"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    res = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Инструкция режима: отвечай кратко от первого лица.",
        },
    )
    assert res.status_code == 200, res.text
    text_part = next(
        part for part in captured["messages"][-1]["content"] if part["type"] == "text"
    )["text"]
    assert "точную формулировку задания" in text_part
    assert "Дополнительная просьба пользователя" in text_part
    assert "не заменяет видимое условие" in text_part


def test_screen_assist_preserves_explicit_model_choice(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["model"] = model
        yield "ok"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    res = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "modelOverride": "openai/gpt-4o",
        },
    )
    assert res.status_code == 200, res.text
    assert captured["model"] == "openai/gpt-4o"


def test_screen_assist_rejects_empty_and_huge_images(client, monkeypatch):
    async def fake_stream(*a, **k):
        yield "x"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    assert client.post("/chat/screen/stream", json={"image": ""}).status_code == 400
    huge = "A" * (MAX_SCREEN_IMAGE_CHARS + 1)
    assert client.post("/chat/screen/stream", json={"image": huge}).status_code == 422


def test_screen_assist_orders_previous_frames_before_the_authoritative_current_frame(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated solution"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": [
                "data:image/jpeg;base64,previous-1",
                "data:image/jpeg;base64,previous-2",
            ],
            "prior_solution_summary": "```sql\nSELECT * FROM users;\n```\nKeep the filter.",
            "question": "Add the latest interviewer correction: group by city.",
        },
    )

    assert response.status_code == 200, response.text
    images = [
        part["image_url"]["url"] for part in captured["content"] if part["type"] == "image_url"
    ]
    assert images == [
        "data:image/jpeg;base64,previous-1",
        "data:image/jpeg;base64,previous-2",
        "data:image/jpeg;base64,current",
    ]
    prompt = captured["content"][0]["text"]
    assert "LATEST INTERVIEWER CORRECTION" in prompt
    assert "group by city" in prompt
    assert "current viewport overrides prior context only where an actual conflict exists" in prompt
    assert "SELECT * FROM users" in prompt


def test_screen_assist_rejects_more_than_two_or_over_budget_previous_images(client, monkeypatch):
    async def fake_stream(*args, **kwargs):
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    base = {"image": "data:image/jpeg;base64,current"}
    assert (
        client.post(
            "/chat/screen/stream",
            json={**base, "previous_images": ["one", "two", "three"]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/chat/screen/stream",
            json={
                **base,
                "previous_images": ["a" * MAX_PREVIOUS_SCREEN_IMAGE_CHARS, "b"],
            },
        ).status_code
        == 413
    )
    # Budget applies to the normalized data URL sent to the provider too.
    assert (
        client.post(
            "/chat/screen/stream",
            json={**base, "previous_images": ["a" * (MAX_PREVIOUS_SCREEN_IMAGE_CHARS - 1)]},
        ).status_code
        == 413
    )


def test_screen_assist_schema_counts_blank_previous_frame_entries_and_bounds_fields(client):
    base = {"image": "data:image/jpeg;base64,QUJD"}
    assert (
        client.post(
            "/chat/screen/stream",
            json={**base, "previous_images": ["", " ", "\t"]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/chat/screen/stream",
            json={**base, "previous_images": ["x" * (MAX_PREVIOUS_SCREEN_IMAGE_CHARS + 1)]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/chat/screen/stream",
            json={**base, "prior_solution_summary": "x" * (MAX_PRIOR_SOLUTION_SUMMARY_CHARS + 1)},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/chat/screen/stream",
            json={"image": "x" * (MAX_SCREEN_IMAGE_CHARS + 1)},
        ).status_code
        == 422
    )


def test_screen_assist_rejects_oversized_content_length_before_parsing(client, monkeypatch):
    from app.main import MAX_SCREEN_ASSIST_REQUEST_BYTES

    called = False

    async def fake_stream(*args, **kwargs):
        nonlocal called
        called = True
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        content=b"{" + b"x" * MAX_SCREEN_ASSIST_REQUEST_BYTES + b"}",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "screen_request_too_large"
    assert called is False


async def test_screen_assist_receive_limiter_rejects_missing_content_length_in_multiple_chunks(
    monkeypatch,
):
    from app.main import MAX_SCREEN_ASSIST_REQUEST_BYTES

    called = False

    async def fake_stream(*args, **kwargs):
        nonlocal called
        called = True
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    sent = await _asgi_post_chunks(
        "/chat/screen/stream",
        [
            b"{" + b"x" * (MAX_SCREEN_ASSIST_REQUEST_BYTES // 2),
            b"x" * (MAX_SCREEN_ASSIST_REQUEST_BYTES // 2) + b"}",
        ],
    )

    assert (
        next(message for message in sent if message["type"] == "http.response.start")["status"]
        == 413
    )
    assert called is False


async def test_screen_assist_receive_limiter_rejects_chunked_transfer_encoding(monkeypatch):
    from app.main import MAX_SCREEN_ASSIST_REQUEST_BYTES

    called = False

    async def fake_stream(*args, **kwargs):
        nonlocal called
        called = True
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    sent = await _asgi_post_chunks(
        "/chat/screen/stream",
        [
            b"{" + b"x" * (MAX_SCREEN_ASSIST_REQUEST_BYTES // 2),
            b"x" * (MAX_SCREEN_ASSIST_REQUEST_BYTES // 2) + b"}",
        ],
        {"transfer-encoding": "chunked"},
    )

    assert (
        next(message for message in sent if message["type"] == "http.response.start")["status"]
        == 413
    )
    assert called is False


async def test_screen_assist_receive_limiter_rejects_a_lying_content_length(monkeypatch):
    from app.main import MAX_SCREEN_ASSIST_REQUEST_BYTES

    called = False

    async def fake_stream(*args, **kwargs):
        nonlocal called
        called = True
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    sent = await _asgi_post_chunks(
        "/chat/screen/stream",
        [
            b"{" + b"x" * (MAX_SCREEN_ASSIST_REQUEST_BYTES // 2),
            b"x" * (MAX_SCREEN_ASSIST_REQUEST_BYTES // 2) + b"}",
        ],
        {"content-length": "1"},
    )

    assert (
        next(message for message in sent if message["type"] == "http.response.start")["status"]
        == 413
    )
    assert called is False


async def test_screen_assist_receive_limiter_fast_rejects_negative_content_length():
    sent = await _asgi_post_chunks(
        "/chat/screen/stream",
        [b'{"image":"data:image/jpeg;base64,QUJD"}'],
        {"content-length": "-1"},
    )

    assert (
        next(message for message in sent if message["type"] == "http.response.start")["status"]
        == 413
    )


async def test_screen_assist_receive_limiter_passes_under_limit_chunked_request(monkeypatch):
    called = False

    async def fake_stream(*args, **kwargs):
        nonlocal called
        called = True
        yield "ok"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    body = json.dumps({"image": "data:image/jpeg;base64,QUJD"}).encode()
    sent = await _asgi_post_chunks(
        "/chat/screen/stream",
        [body[:8], body[8:20], body[20:]],
        {"transfer-encoding": "chunked"},
    )

    assert (
        next(message for message in sent if message["type"] == "http.response.start")["status"]
        == 200
    )
    assert called is True


async def test_screen_assist_receive_limiter_does_not_apply_to_unrelated_routes():
    sent = await _asgi_post_chunks(
        "/chat/interview/stream",
        [b"{" + b"x" * 1_100_000, b"x" * 1_100_000 + b"}"],
        {"transfer-encoding": "chunked"},
    )

    response = next(message for message in sent if message["type"] == "http.response.start")
    assert response["status"] != 413


def test_screen_assist_server_clipping_keeps_fenced_code_opening_and_newest_tail(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"][0]["text"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    summary = (
        f"OLD_PROSE {'x' * 1_500}\n```python\nCODE_OPENING_SENTINEL\n"
        f"{'y' * 3_000}\n```\nNEWEST_CORRECTION_SENTINEL"
    )
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "prior_solution_summary": summary},
    )

    assert response.status_code == 200, response.text
    assert "```python\nCODE_OPENING_SENTINEL" in captured["prompt"]
    assert "NEWEST_CORRECTION_SENTINEL" in captured["prompt"]


def test_screen_assist_server_tail_clips_chronological_context_to_latest_lines(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"][0]["text"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    context = "\n".join([f"OLD_TRANSCRIPT_SENTINEL_{index} {'x' * 90}" for index in range(70)])
    context += "\nLATEST_INTERVIEWER_CORRECTION_SENTINEL"
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "context": context},
    )

    assert response.status_code == 200, response.text
    assert "LATEST_INTERVIEWER_CORRECTION_SENTINEL" in captured["prompt"]
    assert "OLD_TRANSCRIPT_SENTINEL_0" not in captured["prompt"]


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


def test_interview_fast_core_uses_one_grounded_provider_call(client, monkeypatch):
    captured: dict = {"stream_calls": 0}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["stream_calls"] += 1
        captured["messages"] = messages
        captured["model"] = model
        captured["kwargs"] = kwargs
        yield "Короткий ответ."

    def forbidden_read(*args, **kwargs):
        raise AssertionError("fast core must not read resume/RAG/profile context")

    async def forbidden_correction(*args, **kwargs):
        raise AssertionError("fast core must not call transcript correction")

    async def forbidden_complete(*args, **kwargs):
        raise AssertionError("fast core must not make a serial provider call")

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "_finalize_question", forbidden_correction)
    monkeypatch.setattr(chat_router.rag_service, "get_context_text", forbidden_read)
    monkeypatch.setattr(chat_router, "get_profile_block", forbidden_read)
    monkeypatch.setattr(provider_adapter, "complete", forbidden_complete)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    question = "В чем разница, чем отличается list.sort() от sorted()?"
    response = client.post(
        "/chat/interview/stream",
        json={
            "question": question,
            "raw_question": "другой текст, который нельзя использовать",
            "resolved_follow_up_question": "подменённый follow-up",
            "question_intent": "experience",
            "weak_topics": ["Python", "API"],
            "fast_answer": True,
            "answer_language": "ru",
        },
    )
    assert response.status_code == 200, response.text
    assert len(captured["messages"]) == 2
    assert captured["stream_calls"] == 1
    system_prompt = captured["messages"][0]["content"]
    user_prompt = captured["messages"][1]["content"]
    assert question in user_prompt
    assert "подменённый follow-up" not in user_prompt
    assert "другой текст" not in user_prompt
    assert "RESUME" not in system_prompt + user_prompt
    assert (
        "sorted(iterable) returns a new list; list.sort() mutates that list in place "
        "and returns None."
    ) in user_prompt
    assert "Чем список отличается от кортежа?" not in user_prompt
    assert "Главное отличие — изменяемость" not in user_prompt
    assert captured["kwargs"]["route_fast"] is True
    assert captured["model"] == "google/gemini-3.5-flash"

    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    meta = done["correction"]
    assert done["model_source"] == "fast_core_accuracy"
    assert meta["prompt_mode"] == "fast_core"
    assert meta["enrichment_used"] is True
    assert meta["knowledgePackUsed"] is False
    assert meta["resume_context_used"] is False
    assert meta["resume_context_level"] == "none"
    assert meta["resume_context_reason"] == "fast_core_local_enrichment"


def test_interview_fast_core_includes_active_screen_task_in_same_provider_call(client, monkeypatch):
    captured: dict = {"stream_calls": 0}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["stream_calls"] += 1
        captured["messages"] = messages
        yield "Обновлённое решение."

    async def forbidden_complete(*args, **kwargs):
        raise AssertionError("screen-task context must not add a resolver provider call")

    monkeypatch.setattr(provider_adapter, "complete", forbidden_complete)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Теперь добавь TTL.",
            "fast_answer": True,
            "active_screen_task": {
                "root_question": "Реализуй LRU cache.",
                "current_question": "Добавь eviction по capacity.",
                "latest_answer": "class LruCache: ...",
                "updated_at_ms": 1_777_777,
            },
        },
    )

    assert response.status_code == 200, response.text
    assert captured["stream_calls"] == 1
    prompt = captured["messages"][-1]["content"]
    assert "ACTIVE SCREEN TASK" in prompt
    assert "Реализуй LRU cache." in prompt
    assert "Добавь eviction по capacity." in prompt
    assert "class LruCache: ..." in prompt
    assert "true follow-up, critique, correction, or refinement" in prompt
    assert "explicit new topic" in prompt


def test_interview_fast_core_uses_preloaded_resume_only_for_personal_answer(client, monkeypatch):
    captured: dict = {"stream_calls": 0}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["stream_calls"] += 1
        captured["messages"] = messages
        captured["model"] = model
        yield "Я автоматизирую UI и API на Python с pytest."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    monkeypatch.setattr(chat_router.rag_service, 'get_context_text', lambda db, kind: 'Synthetic project Orion' if kind == 'legend' else '')

    candidate_context = (
        "QA Automation Engineer. Основной стек: Python, pytest, Playwright, "
        "REST API, Allure и CI/CD. Поддерживал UI- и API-автотесты."
    )
    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи про свой опыт автоматизации тестирования.",
            "candidate_context": candidate_context,
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert captured["stream_calls"] == 1
    assert captured["model"] == "qwen/qwen3.5-flash-02-23"
    user_prompt = captured["messages"][-1]["content"]
    assert candidate_context in user_prompt
    assert 'Synthetic project Orion' in user_prompt
    assert "CONFIRMED CANDIDATE CONTEXT" in user_prompt

    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    meta = done["correction"]
    assert meta["resume_context_used"] is True
    assert meta["resume_context_level"] == "limited"
    assert meta["resume_context_reason"] == "fast_core_preloaded_candidate_context"


def test_interview_fast_core_uses_resume_for_how_your_cicd_was_set_up(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "В автотестах CI/CD был построен вокруг GitLab, Docker, pytest и Allure."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    candidate_context = (
        "QA Automation Engineer. Автотесты запускал в CI/CD через GitLab и Jenkins, "
        "использовал Docker, pytest и Allure для прогонов и отчётов."
    )
    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи подробно, как у вас был устроен CI/CD для автотестов.",
            "candidate_context": candidate_context,
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    user_prompt = captured["messages"][-1]["content"]
    assert candidate_context in user_prompt
    assert "CONFIRMED CANDIDATE CONTEXT" in user_prompt

    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    meta = done["correction"]
    assert meta["question_intent"] == "practical_usage"
    assert meta["resume_context_used"] is True


def test_interview_fast_core_does_not_send_resume_to_theory_model(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        captured["model"] = model
        yield "REST — архитектурный стиль для взаимодействия по HTTP."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    private_marker = "PRIVATE_RESUME_MARKER_83A7"
    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Что такое REST?",
            "candidate_context": private_marker,
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert captured["model"] == "qwen/qwen3.5-flash-02-23"
    assert private_marker not in captured["messages"][-1]["content"]


@pytest.mark.parametrize('unrelated_question', [
    'What is TCP?',
    'Уточни, что такое TCP?',
    'Расскажи подробнее, чем TCP отличается от UDP?',
    'Is there a difference between TCP and UDP?',
])
def test_fast_followup_keeps_project_sources_separate_from_generated_history(client, monkeypatch, db_session, unrelated_question):
    from conftest import TestingSessionLocal

    from app.db.models import AppMeta, Document
    from app.routers import chat as chat_router
    from app.services.candidate_profile import META_KEY
    db_session.add(Document(kind='legend', title='Synthetic legend', raw_text='Project Orion: maintained API checks.'))
    db_session.add(AppMeta(key=META_KEY, value=json.dumps({'hash': 'stale', 'content': 'STALE INVENTED OWNERSHIP'})))
    db_session.commit()
    prompts = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        prompts.append(messages[-1]['content'])
        yield 'I maintained API checks on the project.'

    monkeypatch.setattr(chat_router, 'SessionLocal', TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, 'stream_chat', fake_stream)
    turns = [{'question': 'Расскажи про последний проект', 'answer': 'UNVERIFIED generated claim'}]
    for question in [
        'What did you do there?',
        'А какие техники тест-дизайна ты там применял?',
        'А почему там выбрали это?',
        'What is your role on that project?',
        unrelated_question,
    ]:
        response = client.post('/chat/interview/stream', json={
            'question': question, 'candidate_context': 'Synthetic selected resume',
            'recent_turns': turns, 'fast_answer': True,
        })
        assert response.status_code == 200
    for prompt in prompts[:4]:
        assert 'Project Orion' in prompt
        assert 'Synthetic selected resume' in prompt
        assert 'not confirmed experience' in prompt
        assert 'UNVERIFIED generated claim' in prompt
        assert 'STALE INVENTED OWNERSHIP' not in prompt
    assert 'Project Orion' not in prompts[4]
    assert 'Synthetic selected resume' not in prompts[4]
    assert 'UNVERIFIED generated claim' not in prompts[4]


def test_interview_fast_core_resolves_known_report_asr_alias_before_prompt(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "Основные типы данных в Python — числа, строки, списки и словари."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Каки ти подадна в Питоните знаеш.",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    user_prompt = captured["messages"][-1]["content"]
    assert "QUESTION: Какие типы данных в Python ты знаешь?" in user_prompt
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["correction"]["fast_alias_used"] is True


def test_interview_fast_core_hedges_slow_theory_with_quality_model(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(0.04)
            yield "Медленный быстрый ответ."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Качественный резервный ответ."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_THEORY_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие техники тест-дизайна ты знаешь?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    assert "Качественный резервный ответ." in response.text
    assert "Медленный быстрый ответ." not in response.text
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "openai/gpt-4o-mini"
    assert done["model_source"] == "fast_core_latency_hedge"
    assert done["correction"]["hedgeStarted"] is True
    assert done["correction"]["hedgeWinner"] == "fallback"


def test_interview_fast_core_starts_theory_fallback_before_live_budget_expires(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(1.1)
            yield "Слишком поздний Qwen-ответ."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Резерв успел в live-бюджет."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие техники тест-дизайна ты знаешь?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    assert "Резерв успел в live-бюджет." in response.text
    assert "Слишком поздний Qwen-ответ." not in response.text


def test_interview_fast_core_gives_benchmarked_qwen_startup_window(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(0.65)
            yield "Qwen успел ответить без лишней гонки."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Слишком ранний резервный ответ."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие техники тест-дизайна ты знаешь?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23"]
    assert "Qwen успел ответить без лишней гонки." in response.text
    assert "Слишком ранний резервный ответ." not in response.text


def test_interview_fast_core_uses_fast_theory_model_without_waiting_for_hedge(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        yield "Быстрый точный ответ."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_THEORY_HEDGE_AFTER_SECONDS", 0.02)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие техники тест-дизайна ты знаешь?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "qwen/qwen3.5-flash-02-23"
    assert done["model_source"] == "fast_core_default"
    assert done["correction"]["hedgeStarted"] is False
    assert done["correction"]["hedgeWinner"] == "primary"


def test_interview_fast_core_starts_qwen_for_practical_work_answers(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        yield "В работе начинаю с конкретного риска, затем выбираю технику и проверяю границы."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": (
                "Расскажи, пожалуйста, про техники тест-дизайна. "
                "Какие ты знаешь и какие применяешь в работе?"
            ),
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["correction"]["question_intent"] == "practical_usage"
    assert done["correction"]["hedgeStarted"] is False


def test_interview_fast_core_uses_earlier_practical_hedge_than_personal_experience(
    client, monkeypatch
):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(0.04)
            yield "Слишком поздний основной практический ответ."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Быстрый резервный практический ответ."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_PRACTICAL_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(chat_router, "LIVE_EXPERIENCE_HEDGE_AFTER_SECONDS", 0.1)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи про техники тест-дизайна, которые ты применяешь в работе.",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    assert "Быстрый резервный практический ответ." in response.text
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["correction"]["question_intent"] == "practical_usage"
    assert done["correction"]["hedgeStarted"] is True
    assert done["correction"]["hedgeWinner"] == "fallback"


def test_interview_fast_core_starts_qwen_for_fast_personal_experience(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        await asyncio.sleep(0.01)
        yield "Точный ответ по резюме."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_PRACTICAL_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(chat_router, "LIVE_EXPERIENCE_HEDGE_AFTER_SECONDS", 0.02)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи о своём опыте автоматизации тестирования.",
            "fast_answer": True,
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "qwen/qwen3.5-flash-02-23"
    assert done["correction"]["hedgeStarted"] is False


def test_live_hedge_policy_keeps_practical_deadline_separate_from_experience():
    from app.routers import chat as chat_router

    assert chat_router.LIVE_PRACTICAL_HEDGE_AFTER_SECONDS == 0.8
    assert chat_router.LIVE_EXPERIENCE_HEDGE_AFTER_SECONDS == 1.25


def test_interview_fast_core_hedges_stalled_personal_experience(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(0.04)
            yield "Поздний основной ответ."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Быстрый резервный ответ по опыту."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_EXPERIENCE_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи про свой опыт работы в команде.",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    assert "Быстрый резервный ответ по опыту." in response.text
    assert "Поздний основной ответ." not in response.text
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "openai/gpt-4o-mini"
    assert done["model_source"] == "fast_core_latency_hedge"
    assert done["correction"]["hedgeStarted"] is True
    assert done["correction"]["hedgeWinner"] == "fallback"


def test_interview_fast_core_does_not_treat_topic_hints_as_personal_grounding(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        yield "Использовал Docker: собирал образы и запускал изолированные контейнеры."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи про свой опыт работы с Docker.",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "qwen/qwen3.5-flash-02-23"
    assert done["model_source"] == "fast_core_default"
    assert done["correction"]["enrichment_used"] is True
    assert done["correction"]["hedgeStarted"] is False


def test_interview_fast_core_hedges_stalled_unclear_question(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(0.04)
            yield "Поздний основной ответ."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Быстрый резервный ответ."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_UNCLEAR_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": (
                "И, в общем-то, что происходит у тебя, да, вот от написания, "
                "между написанием запроса и вот рендера страницы?"
            ),
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    assert "Быстрый резервный ответ." in response.text
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "openai/gpt-4o-mini"
    assert done["model_source"] == "fast_core_latency_hedge"
    assert done["correction"]["question_intent"] == "unclear"
    assert done["correction"]["hedgeStarted"] is True
    assert done["correction"]["hedgeWinner"] == "fallback"


def test_interview_fast_core_starts_unclear_fallback_before_live_budget_expires(
    client, monkeypatch
):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            await asyncio.sleep(0.7)
            yield "Слишком поздний основной ответ."
            return
        assert model == "openai/gpt-4o-mini"
        yield "Резерв успел в live-бюджет."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": (
                "И, в общем-то, что происходит у тебя, да, вот от написания, "
                "между написанием запроса и вот рендера страницы?"
            ),
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    assert "Резерв успел в live-бюджет." in response.text
    assert "Слишком поздний основной ответ." not in response.text


def test_interview_fast_core_keeps_fast_unclear_primary_metadata(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        yield "Быстрый основной ответ."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_UNCLEAR_HEDGE_AFTER_SECONDS", 0.02)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": (
                "И, в общем-то, что происходит у тебя, да, вот от написания, "
                "между написанием запроса и вот рендера страницы?"
            ),
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "qwen/qwen3.5-flash-02-23"
    assert done["model_source"] == "fast_core_default"
    assert done["correction"]["hedgeStarted"] is False
    assert done["correction"]["hedgeWinner"] == "primary"


def test_interview_fast_core_rescues_empty_primary_with_reliability_model(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            return
        assert model == "openai/gpt-4o-mini"
        yield "Резервный ответ по опыту автоматизации."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Расскажи о своём опыте автоматизации тестирования.",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["qwen/qwen3.5-flash-02-23", "openai/gpt-4o-mini"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["spoken"] == "Резервный ответ по опыту автоматизации."
    assert done["model"] == "openai/gpt-4o-mini"
    assert done["model_source"] == "fast_core_reliability_fallback"
    assert done["correction"]["reliabilityFallbackStarted"] is True


def test_interview_fast_core_rescues_when_both_theory_hedges_fail(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        if model == "qwen/qwen3.5-flash-02-23":
            raise RuntimeError("temporary upstream failure")
            yield "unreachable"
        assert model == "openai/gpt-4o-mini"
        if calls.count("openai/gpt-4o-mini") == 1:
            raise RuntimeError("temporary reliability failure")
            yield "unreachable"
        yield "Эквивалентное разбиение, граничные значения и таблицы решений."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_THEORY_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие техники тест-дизайна ты знаешь?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == [
        "qwen/qwen3.5-flash-02-23",
        "openai/gpt-4o-mini",
        "openai/gpt-4o-mini",
    ]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "openai/gpt-4o-mini"
    assert done["model_source"] == "fast_core_reliability_fallback"
    assert done["correction"]["reliabilityFallbackStarted"] is True


def test_interview_fast_core_preserves_explicit_model_without_hedging(client, monkeypatch):
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    calls: list[str] = []

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        calls.append(model)
        await asyncio.sleep(0.01)
        yield "Явно выбранная модель."

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(chat_router, "LIVE_THEORY_HEDGE_AFTER_SECONDS", 0.001)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие техники тест-дизайна ты знаешь?",
            "fast_answer": True,
            "modelOverride": "openai/gpt-4o-mini",
        },
    )

    assert response.status_code == 200, response.text
    assert calls == ["openai/gpt-4o-mini"]
    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["model"] == "openai/gpt-4o-mini"
    assert done["correction"]["hedgeStarted"] is False


def test_interview_fast_core_injects_only_verified_curated_pack(client, monkeypatch):
    captured: dict = {"stream_calls": 0}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["stream_calls"] += 1
        captured["messages"] = messages
        yield "yield приостанавливает выполнение."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Что делает yield в Python?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert captured["stream_calls"] == 1
    prompt = captured["messages"][-1]["content"]
    assert "PYTHON VERIFIED FACTUAL CONTRACT" in prompt
    assert "yield превращает функцию в генератор" in prompt
    assert "community reference" not in prompt

    done = next(
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"type": "done"' in line
    )
    assert done["correction"]["knowledgeSource"] == "curated"
    assert done["correction"]["enrichment_used"] is True
    assert done["correction"]["resume_context_used"] is False


def test_interview_fast_core_keeps_required_output_contract(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "Набор проверок."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие проверки нужны для endpoint last_order?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    prompt = captured["messages"][-1]["content"]
    assert "FINAL REQUIRED OUTPUT CONTRACT — last_order" in prompt


def test_interview_fast_core_excludes_personal_domain_templates(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["messages"] = messages
        yield "UI, API и интеграционные тесты."

    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)

    response = client.post(
        "/chat/interview/stream",
        json={
            "question": "Какие виды автоматизации бывают?",
            "fast_answer": True,
            "answer_language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    prompt = captured["messages"][-1]["content"]
    assert "UI-автотесты" in prompt
    assert "интеграционные" in prompt
    assert "В моём опыте" not in prompt
    assert "Optional one personal line" not in prompt


def test_interview_stream_failure_after_partial_tokens_is_not_success(client, monkeypatch):
    async def failing_stream(messages, provider=None, model=None, **kwargs):
        yield "partial"
        raise RuntimeError("secret upstream details")

    monkeypatch.setattr(provider_adapter, "stream_chat", failing_stream)
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    res = client.post("/chat/interview/stream", json={"question": "Что такое REST?"})
    assert res.status_code == 200, res.text
    assert '"type": "stream_failed"' in res.text
    assert '"reason": "provider_error"' in res.text
    assert '"type": "done"' not in res.text
    assert "secret upstream details" not in res.text


def test_interview_stream_failure_before_tokens_is_generic(client, monkeypatch):
    async def failing_stream(messages, provider=None, model=None, **kwargs):
        raise RuntimeError("secret upstream details")
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", failing_stream)
    from conftest import TestingSessionLocal

    from app.routers import chat as chat_router

    monkeypatch.setattr(chat_router, "SessionLocal", TestingSessionLocal)
    res = client.post("/chat/interview/stream", json={"question": "Что такое REST?"})
    assert res.status_code == 200, res.text
    assert '"type": "stream_failed"' in res.text
    assert '"type": "done"' not in res.text
    assert "secret upstream details" not in res.text
    terminal = next(
        json.loads(line[6:])
        for line in res.text.splitlines()
        if line.startswith("data: ") and '"type": "stream_failed"' in line
    )
    assert terminal == {
        "type": "stream_failed",
        "reason": "provider_error",
        "message": "Модели временно недоступны. Повторите вопрос.",
    }


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
