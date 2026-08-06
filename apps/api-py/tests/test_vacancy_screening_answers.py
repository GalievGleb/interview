"""Grounding and schema tests for employer screening-answer generation."""

import asyncio
import json

from app.routers import vacancy as vacancy_router
from app.services import provider_adapter, rag_service


def _payload() -> dict:
    return {
        "vacancyTitle": "IT Project Manager",
        "vacancyCompany": "Movavi",
        "vacancyDescription": "Scrum, Jira, several parallel projects",
        "questions": [
            {
                "id": "parallel-projects",
                "prompt": "Опишите опыт одновременного ведения нескольких IT-проектов.",
                "kind": "text",
                "options": [],
                "required": True,
            },
            {
                "id": "jira-level",
                "prompt": "Работали ли вы с Jira?",
                "kind": "single",
                "options": ["Да", "Нет"],
                "required": True,
            },
        ],
        "language": "ru",
    }


def test_screening_answers_uses_resume_and_preserves_exact_options(client, monkeypatch):
    captured: dict = {}

    def fake_context(_db, kind):
        return "Вёл два проекта, использовал Jira" if kind == "resume" else ""

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        captured["model"] = model
        captured["kwargs"] = kwargs
        return json.dumps(
            {
                "answers": [
                    {
                        "id": "parallel-projects",
                        "answer": "Одновременно вёл два IT-проекта и контролировал сроки в Jira.",
                        "selectedOptions": [],
                        "canAutoFill": True,
                    },
                    {
                        "id": "jira-level",
                        "answer": "",
                        "selectedOptions": ["да", "Maybe"],
                        "canAutoFill": True,
                    },
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(rag_service, "get_context_text", fake_context)
    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    response = client.post("/vacancy/screening-answers", json=_payload())

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["answers"][0]["canAutoFill"] is True
    assert body["answers"][1]["selectedOptions"] == ["Да"]
    assert "Вёл два проекта" in captured["prompt"]
    assert "Never invent project counts" in captured["prompt"]
    assert captured["model"].endswith("gpt-4o-mini")
    assert captured["kwargs"]["max_tokens"] <= 1600
    assert captured["kwargs"]["response_format"] == {"type": "json_object"}


def test_screening_answers_blocks_missing_or_unusable_model_items(client, monkeypatch):
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def fake_complete(*_args, **_kwargs):
        return json.dumps(
            {
                "answers": [
                    {
                        "id": "jira-level",
                        "answer": "",
                        "selectedOptions": ["Несуществующий вариант"],
                        "canAutoFill": True,
                    }
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post("/vacancy/screening-answers", json=_payload())

    assert response.status_code == 200, response.text
    answers = {item["id"]: item for item in response.json()["answers"]}
    assert answers["parallel-projects"]["canAutoFill"] is False
    assert answers["jira-level"]["canAutoFill"] is False


def test_screening_answers_requires_questions(client):
    response = client.post("/vacancy/screening-answers", json={"questions": []})
    assert response.status_code == 400


def test_screening_answers_has_a_hard_interactive_deadline(client, monkeypatch):
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def slow_complete(*_args, **_kwargs):
        await asyncio.sleep(0.05)
        return "{}"

    monkeypatch.setattr(provider_adapter, "complete", slow_complete)
    monkeypatch.setattr(vacancy_router, "SCREENING_ANSWERS_DEADLINE_SECONDS", 0.01)

    response = client.post("/vacancy/screening-answers", json=_payload())

    assert response.status_code == 504
    assert response.json()["detail"] == "Screening answer generation timed out"
