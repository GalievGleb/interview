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
                        "preparationNote": "Повторить базовые рабочие процессы Jira.",
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
    assert body["answers"][1]["preparationNote"] == "Повторить базовые рабочие процессы Jira."
    assert "Вёл два проекта" in captured["prompt"]
    assert "Never invent project counts" in captured["prompt"]
    assert "Narrow familiarity bridge" in captured["prompt"]
    assert "AUTOMATIC MODE" in captured["prompt"]
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


def test_screening_answers_accepts_selected_hh_resume(client, monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def fake_complete(messages, *_args, **_kwargs):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps({"answers": []})

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/vacancy/screening-answers",
        json={**_payload(), "resumeText": "Выбранное резюме HH: вёл проекты и работал с Jira."},
    )

    assert response.status_code == 200, response.text
    assert "Выбранное резюме HH" in captured["prompt"]


def test_screening_answers_accepts_user_confirmed_preferences_without_broadening_them(client, monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def fake_complete(messages, *_args, **_kwargs):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps({"answers": []})

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/vacancy/screening-answers",
        json={
            **_payload(),
            "confirmedAnswers": [
                {
                    "question": "Готовы ли вы к релокации в Саудовскую Аравию на 3 месяца?",
                    "answer": "Да, если релокация оплачивается работодателем.",
                    "selectedOptions": [],
                }
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert "Саудовскую Аравию" in captured["prompt"]
    assert "does not imply consent to another country" in captured["prompt"]


def test_screening_answers_can_generate_a_review_only_hypothesis(client, monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def fake_complete(messages, *_args, **_kwargs):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps(
            {
                "answers": [
                    {
                        "id": "games",
                        "answer": "Да, играл в StarCraft II и Age of Empires II.",
                        "selectedOptions": [],
                        "canAutoFill": False,
                        "reason": "Пользователь должен подтвердить предположение.",
                    }
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/vacancy/screening-answers",
        json={
            "vacancyTitle": "Junior SDET",
            "vacancyCompany": "Gear Games",
            "questions": [
                {
                    "id": "games",
                    "prompt": "Нравятся ли вам игры жанра RTS? Во что играли?",
                    "kind": "text",
                    "options": [],
                    "required": True,
                }
            ],
            "draftMode": True,
            "language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    answer = response.json()["answers"][0]
    assert answer["answer"].startswith("Да, играл")
    assert answer["canAutoFill"] is False
    assert "INTERACTIVE DRAFT MODE" in captured["prompt"]
    assert "never submitted without explicit user confirmation" in captured["prompt"]


def test_screening_answers_requires_questions(client):
    response = client.post("/vacancy/screening-answers", json={"questions": []})
    assert response.status_code == 400


def test_screening_answers_refines_the_users_existing_draft(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, *_args, **_kwargs):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps(
            {
                "answers": [
                    {
                        "id": "matrix",
                        "answer": "Да, знаком с Matrix и использовал его для командного общения и проверки интеграций.",
                        "selectedOptions": [],
                        "canAutoFill": False,
                    }
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/vacancy/screening-answers",
        json={
            "vacancyTitle": "QA Automation Engineer",
            "questions": [
                {
                    "id": "matrix",
                    "prompt": "Был ли у вас опыт с Matrix?",
                    "kind": "text",
                    "options": [],
                    "required": True,
                }
            ],
            "draftMode": True,
            "existingDraft": {
                "questionId": "matrix",
                "answer": "да немного знаком с matrix использовал для общения",
            },
            "language": "ru",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["answers"][0]["answer"].startswith("Да, знаком")
    assert "REFINEMENT MODE" in captured["prompt"]
    assert "да немного знаком с matrix использовал для общения" in captured["prompt"]
    assert "Do not replace it with a generic template" in captured["prompt"]


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
