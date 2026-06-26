"""HTTP tests for the interview-review endpoints with a mocked LLM provider.

No real API key is needed — `provider_adapter.complete` / `.stream_chat` are
monkeypatched, so we test the routing, prompt wiring, and SSE framing only.
"""

import json

from app.services import provider_adapter


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
