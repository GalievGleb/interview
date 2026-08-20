"""Quality and grounding tests for tailored vacancy cover letters."""

import asyncio
import json

from app.core.errors import AppError
from app.routers import vacancy as vacancy_router
from app.services import provider_adapter, rag_service


def _payload() -> dict:
    return {
        "vacancyTitle": "QA Auto Python специалист",
        "vacancyCompany": "Clearway Integration",
        "vacancyDescription": (
            "Развитие фреймворка автотестов на Python. E2E на Playwright, REST API, "
            "PostgreSQL, GitLab CI/CD, Allure, Docker и анализ стабильности продукта."
        ),
        "language": "ru",
    }


def _strong_letter() -> str:
    return (
        "Здравствуйте!\n\n"
        "В последние годы я занимаюсь автоматизацией тестирования на Python, и для этой "
        "роли особенно релевантен мой опыт развития тестового фреймворка, а не только "
        "написания отдельных проверок. Я разрабатывал и поддерживал UI- и API-автотесты "
        "на Pytest, Playwright и HTTPX, поэтому хорошо понимаю задачи покрытия разных "
        "уровней приложения.\n\n"
        "Также я настраивал запуски автотестов в CI/CD, подключал Allure и разбирал "
        "нестабильные сценарии. В работе мне важно, чтобы набор тестов оставался понятным, "
        "поддерживаемым и действительно помогал команде быстрее находить проблемы. Этот "
        "опыт напрямую совпадает с задачами по развитию инфраструктуры и повышению "
        "надёжности продукта.\n\n"
        "Мне близок инженерный акцент роли: возможность влиять на архитектуру автоматизации "
        "и развивать её как целостную систему. Буду рад обсудить задачи команды и подробнее "
        "рассказать о своём опыте."
    )


def test_cover_letter_matches_vacancy_to_saved_resume(client, monkeypatch):
    captured: dict = {}

    def fake_context(_db, kind):
        if kind == "resume":
            return (
                "QA Automation Engineer. Python, Pytest, Playwright, HTTPX. "
                "Разрабатывал UI и API автотесты, развивал фреймворк, подключал Allure "
                "и интегрировал запуски в CI/CD."
            )
        return "Сильная сторона — архитектура автоматизации и анализ flaky-тестов."

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        captured["model"] = model
        captured["kwargs"] = kwargs
        return json.dumps(
            {
                "coverLetter": _strong_letter(),
                "matches": [
                    {
                        "vacancyNeed": "Развитие Python-фреймворка",
                        "resumeEvidence": "Развивал фреймворк на Python/Pytest",
                    },
                    {
                        "vacancyNeed": "Playwright и REST API",
                        "resumeEvidence": "Разрабатывал UI- и API-тесты с Playwright и HTTPX",
                    },
                    {
                        "vacancyNeed": "GitLab CI/CD и Allure",
                        "resumeEvidence": "Интегрировал запуски в CI/CD и подключал Allure",
                    },
                ],
                "canAutoFill": True,
                "reason": "",
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(rag_service, "get_context_text", fake_context)
    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    response = client.post("/vacancy/cover-letter", json=_payload())

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["canAutoFill"] is True
    assert body["coverLetter"].startswith("Здравствуйте!")
    assert len(body["matches"]) == 3
    assert "Clearway Integration" in captured["prompt"]
    assert "Python, Pytest, Playwright, HTTPX" in captured["prompt"]
    assert "Never invent or inflate metrics" in captured["prompt"]
    assert 'never write "С уважением"' in captured["prompt"]
    assert captured["kwargs"]["response_format"] == {"type": "json_object"}
    assert captured["kwargs"]["max_tokens"] <= 1200


def test_cover_letter_blocks_generic_or_unsubstantiated_output(client, monkeypatch):
    monkeypatch.setattr(
        rag_service,
        "get_context_text",
        lambda _db, kind: (
            "QA Automation Engineer с опытом Python и Pytest." * 3 if kind == "resume" else ""
        ),
    )

    async def fake_complete(*_args, **_kwargs):
        return json.dumps(
            {
                "coverLetter": "Здравствуйте! Меня заинтересовала ваша вакансия.",
                "matches": [
                    {"vacancyNeed": "Python", "resumeEvidence": "Python"},
                    {"vacancyNeed": "Pytest", "resumeEvidence": "Pytest"},
                ],
                "canAutoFill": True,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post("/vacancy/cover-letter", json=_payload())

    assert response.status_code == 200, response.text
    assert response.json()["canAutoFill"] is False
    assert response.json()["coverLetter"] == ""
    assert response.json()["failureKind"] == "manual"

    async def fake_skill_mismatch(*_args, **_kwargs):
        return json.dumps(
            {
                "coverLetter": "",
                "matches": [],
                "canAutoFill": False,
                "reason": "В резюме нет подтверждённых совпадений с требованиями.",
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_skill_mismatch)
    response = client.post("/vacancy/cover-letter", json=_payload())
    assert response.status_code == 200, response.text
    assert response.json()["failureKind"] == "skill_mismatch"


def test_cover_letter_does_not_treat_malformed_model_output_as_skill_mismatch(client, monkeypatch):
    monkeypatch.setattr(
        rag_service,
        "get_context_text",
        lambda _db, kind: (
            "QA Automation Engineer с опытом Python и Pytest. " * 3 if kind == "resume" else ""
        ),
    )
    model_outputs = iter(
        [
            {},
            {"canAutoFill": False},
            {"matches": []},
        ]
    )

    async def fake_incomplete_response(*_args, **_kwargs):
        return json.dumps(next(model_outputs))

    monkeypatch.setattr(provider_adapter, "complete", fake_incomplete_response)

    for _ in range(3):
        response = client.post("/vacancy/cover-letter", json=_payload())
        assert response.status_code == 200, response.text
        assert response.json()["canAutoFill"] is False
        assert response.json()["failureKind"] == "manual"


def test_cover_letter_blocks_template_signature_and_name_placeholder(client, monkeypatch):
    monkeypatch.setattr(
        rag_service,
        "get_context_text",
        lambda _db, kind: (
            "QA Automation Engineer с опытом Python, Pytest, API и CI/CD. " * 3
            if kind == "resume"
            else ""
        ),
    )

    async def fake_complete(*_args, **_kwargs):
        return json.dumps(
            {
                "coverLetter": f"{_strong_letter()}\n\nС уважением,\n[Ваше имя]",
                "matches": [
                    {"vacancyNeed": "Python", "resumeEvidence": "Python"},
                    {"vacancyNeed": "API", "resumeEvidence": "API"},
                ],
                "canAutoFill": True,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post("/vacancy/cover-letter", json=_payload())

    assert response.status_code == 200, response.text
    assert response.json()["canAutoFill"] is False
    assert response.json()["coverLetter"] == ""


def test_cover_letter_accepts_selected_hh_resume_when_local_documents_are_empty(
    client, monkeypatch
):
    captured: dict = {}
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def fake_complete(messages, *_args, **_kwargs):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps(
            {
                "coverLetter": _strong_letter(),
                "matches": [
                    {"vacancyNeed": "Python", "resumeEvidence": "Автоматизация на Python"},
                    {"vacancyNeed": "API", "resumeEvidence": "API-тесты на Pytest и HTTPX"},
                ],
                "canAutoFill": True,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    payload = {
        **_payload(),
        "resumeText": (
            "Выбранное резюме HH: QA Automation Engineer. Более трёх лет автоматизации "
            "на Python, Pytest и HTTPX, поддержка API-тестов и CI/CD."
        ),
    }
    response = client.post("/vacancy/cover-letter", json=payload)

    assert response.status_code == 200, response.text
    assert response.json()["canAutoFill"] is True
    assert "Выбранное резюме HH" in captured["prompt"]


def test_cover_letter_does_not_call_model_without_resume_or_description(client, monkeypatch):
    monkeypatch.setattr(rag_service, "get_context_text", lambda *_args: "")

    async def should_not_run(*_args, **_kwargs):
        raise AssertionError("model must not be called without grounding")

    monkeypatch.setattr(provider_adapter, "complete", should_not_run)
    response = client.post("/vacancy/cover-letter", json=_payload())
    assert response.status_code == 200
    assert response.json()["canAutoFill"] is False

    missing_description = {**_payload(), "vacancyDescription": "Python"}
    response = client.post("/vacancy/cover-letter", json=missing_description)
    assert response.status_code == 200
    assert response.json()["canAutoFill"] is False


def test_cover_letter_has_a_hard_deadline(client, monkeypatch):
    monkeypatch.setattr(
        rag_service,
        "get_context_text",
        lambda _db, kind: (
            "QA Automation Engineer Python Pytest Playwright CI/CD Allure. " * 3
            if kind == "resume"
            else ""
        ),
    )

    async def slow_complete(*_args, **_kwargs):
        await asyncio.sleep(0.05)
        return "{}"

    monkeypatch.setattr(provider_adapter, "complete", slow_complete)
    monkeypatch.setattr(vacancy_router, "COVER_LETTER_DEADLINE_SECONDS", 0.01)

    response = client.post("/vacancy/cover-letter", json=_payload())

    assert response.status_code == 504
    assert response.json()["detail"] == "Cover-letter generation timed out"


def test_cover_letter_preserves_provider_quota_error(client, monkeypatch):
    calls = 0
    monkeypatch.setattr(
        rag_service,
        "get_context_text",
        lambda _db, kind: (
            "QA Automation Engineer Python Pytest Playwright CI/CD Allure. " * 3
            if kind == "resume"
            else ""
        ),
    )
    monkeypatch.setattr(
        vacancy_router,
        "_resolve",
        lambda _mode: ("openrouter", "openai/a-different-model"),
    )

    async def quota_exhausted(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise AppError("Месячный лимит токенов исчерпан.", 402, "token_quota_exceeded")

    monkeypatch.setattr(provider_adapter, "complete", quota_exhausted)

    response = client.post("/vacancy/cover-letter", json=_payload())

    assert calls == 1
    assert response.status_code == 402
    assert response.json() == {
        "error": {
            "code": "token_quota_exceeded",
            "message": "Месячный лимит токенов исчерпан.",
        }
    }
