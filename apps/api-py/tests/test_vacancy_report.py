"""HTTP tests for POST /vacancy/report — narrative wiring with a mocked LLM."""

import json

from app.services import provider_adapter

_PAYLOAD = {
    "targetRole": "QA Automation Engineer",
    "seniorityLevel": "middle",
    "overallScore": 58,
    "topics": [
        {
            "title": "Pytest",
            "score": 72,
            "status": "strong",
            "missingPoints": [],
        },
        {
            "title": "CI/CD",
            "score": 41,
            "status": "weak",
            "missingPoints": ["stages", "artifacts"],
        },
    ],
    "weakAnswers": [
        {"question": "Как устроен ваш pipeline?", "missing": ["stages"], "score": 41}
    ],
    "resumeText": "QA engineer, Python, pytest",
    "legendText": "",
    "vacancyText": "Ищем QA Automation (Python)",
    "language": "ru",
}

_ANALYZE_PAYLOAD = {
    "vacancyText": (
        "Senior QA automation Python specialist: Python, pytest, Playwright, "
        "REST API, SQL, Docker, CI/CD, mentoring and framework design."
    ),
    "targetRole": "Senior QA automation Python specialist",
    "language": "ru",
}


def test_analyze_reserves_enough_output_for_complete_json(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured.update(kwargs)
        return json.dumps(
            {
                "targetRole": "Senior QA automation Python specialist",
                "seniorityLevel": "senior",
                "extractedRequirements": ["Python"],
                "optionalSkills": [],
                "competencies": [],
                "interviewTopics": [
                    {
                        "title": "Python",
                        "category": "Automation",
                        "importance": "high",
                        "level": "senior",
                        "expectedKnowledge": "Архитектура тестового фреймворка",
                        "sampleQuestions": ["Как устроен ваш фреймворк?"],
                        "vacancyEvidence": "Python",
                    }
                ],
                "projectQuestions": [],
                "riskAreas": [],
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    response = client.post("/vacancy/analyze", json=_ANALYZE_PAYLOAD)

    assert response.status_code == 200, response.text
    assert captured["max_tokens"] >= 5000


def test_report_returns_narrative_and_wires_prompt(client, monkeypatch):
    captured: dict = {}

    async def fake_complete(messages, provider=None, model=None, **kw):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps(
            {
                "verdict": "К интервью почти готов, но CI/CD проседает.",
                "interviewerImpression": "Уверенный middle.",
                "nextPracticePlan": ["Прогони 3 вопроса по CI/CD с упором на stages."],
                "focusTopic": "CI/CD",
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post("/vacancy/report", json=_PAYLOAD)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["verdict"].startswith("К интервью")
    assert body["focusTopic"] == "CI/CD"
    assert body["nextPracticePlan"]

    # Всё существенное должно дойти до модели: темы со скорами, слабые ответы, документы.
    prompt = captured["prompt"]
    assert "CI/CD: 41/100" in prompt
    assert "Как устроен ваш pipeline?" in prompt
    assert "QA engineer, Python, pytest" in prompt
    assert "58/100" in prompt


def test_report_requires_topics(client):
    res = client.post("/vacancy/report", json={**_PAYLOAD, "topics": []})
    assert res.status_code == 400


def test_report_maps_provider_error_to_502(client, monkeypatch):
    async def boom(*a, **kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(provider_adapter, "complete", boom)
    res = client.post("/vacancy/report", json=_PAYLOAD)
    assert res.status_code == 502
