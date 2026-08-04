import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event

from app.core.errors import AppError
from app.db import models
from app.services import model_router, provider_adapter, quota

VALID_ANALYSIS = {
    "interviewType": "technical",
    "overallLevel": "Middle",
    "overallScore": 58,
    "overallConfidence": 0.86,
    "conclusion": "Хорошо понимает API, но ответ по тест-дизайну неполный.",
    "strengths": [{"topic": "API-тестирование", "evidence": "Проверяю JSON и схему ответа."}],
    "weaknesses": [
        {
            "topic": "Техники тест-дизайна",
            "evidence": "Кандидат назвал только классы эквивалентности.",
            "learningAction": "Повторить граничные значения, таблицы решений и pairwise.",
        }
    ],
    "topicAssessments": [{"topic": "Техники тест-дизайна", "score": 42, "confidence": 0.9}],
    "markdown": "## Итог\nНужно усилить техники тест-дизайна.",
}


def _completed_session(client):
    session_id = client.post("/sessions", json={"mode": "interview"}).json()["id"]
    client.post(
        f"/sessions/{session_id}/transcript",
        json={"speaker": "other", "text": "Какие техники тест-дизайна?"},
    )
    client.post(
        f"/sessions/{session_id}/transcript",
        json={"speaker": "me", "text": "Классы эквивалентности."},
    )
    client.post(f"/sessions/{session_id}/end", json={})
    return session_id


def test_session_analysis_is_validated_persisted_and_reused(client, monkeypatch):
    calls = 0

    async def fake_complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    first = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
    second = client.get(f"/sessions/{session_id}/analysis")

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["weaknesses"][0]["topic"] == "Техники тест-дизайна"
    assert calls == 1


def test_session_analysis_uses_ordered_transcript_roles_and_deep_router(client, monkeypatch):
    captured: dict = {}
    resolved_modes: list[str] = []

    def fake_resolve_model(mode, **kwargs):
        resolved_modes.append(mode)
        return "test/deep-model", "auto"

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        captured["provider"] = provider
        captured["model"] = model
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(model_router, "resolve_model", fake_resolve_model)
    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 200, response.text
    prompt = captured["prompt"]
    interviewer = prompt.index("Интервьюер: Какие техники тест-дизайна?")
    candidate = prompt.index("Кандидат: Классы эквивалентности.")
    assert interviewer < candidate
    assert "Пиши весь обычный текст по-русски" in prompt
    assert "Classify the interview as technical, hr, mixed, or unknown" in prompt
    assert "Do not score missing technical topics in an HR interview" in prompt
    assert captured["provider"]
    assert captured["model"] == "test/deep-model"
    assert resolved_modes == ["deep"]


def test_invalid_analysis_gets_one_repair_attempt(client, monkeypatch):
    replies = iter(["not json", json.dumps(VALID_ANALYSIS, ensure_ascii=False)])
    calls = 0
    prompts: list[str] = []

    async def fake_complete(messages, *args, **kwargs):
        nonlocal calls
        calls += 1
        prompts.append(messages[-1]["content"])
        return next(replies)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 200, response.text
    assert calls == 2
    assert "Интервьюер: Какие техники тест-дизайна?" in prompts[1]
    assert "Кандидат: Классы эквивалентности." in prompts[1]


def test_invalid_repair_is_not_persisted(client, monkeypatch):
    calls = 0

    async def fake_complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        return "still not json"

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 502, response.text
    assert calls == 2
    assert client.get(f"/sessions/{session_id}/analysis").status_code == 404


def test_deleting_session_removes_persisted_assessment(client, monkeypatch, db_session):
    async def fake_complete(*args, **kwargs):
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
    assert response.status_code == 200, response.text
    assert db_session.query(models.SessionAssessment).count() == 1

    response = client.delete(f"/sessions/{session_id}")

    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert db_session.query(models.SessionAssessment).count() == 0


def test_privacy_wipe_removes_session_assessments(client, monkeypatch, db_session):
    async def fake_complete(*args, **kwargs):
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    assert (
        client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"}).status_code == 200
    )
    assert db_session.query(models.SessionAssessment).count() == 1

    response = client.delete("/data")

    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert db_session.query(models.InterviewSession).count() == 0
    assert db_session.query(models.SessionAssessment).count() == 0
    assert client.get("/sessions/knowledge-map").json()["weakTopics"] == []


def test_delete_waits_for_inflight_analysis_and_leaves_no_orphan(client, monkeypatch, db_session):
    started = Event()
    release = Event()

    async def fake_complete(*args, **kwargs):
        started.set()
        await asyncio.to_thread(release.wait, 5)
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        analysis = pool.submit(
            client.post,
            f"/sessions/{session_id}/analysis",
            json={"language": "ru"},
        )
        assert started.wait(2)
        deletion = pool.submit(client.delete, f"/sessions/{session_id}")
        time.sleep(0.1)
        release.set()
        analysis_response = analysis.result(timeout=5)
        deletion_response = deletion.result(timeout=5)

    assert analysis_response.status_code == 200, analysis_response.text
    assert deletion_response.status_code == 200, deletion_response.text
    db_session.expire_all()
    assert db_session.query(models.InterviewSession).count() == 0
    assert db_session.query(models.SessionAssessment).count() == 0


def test_concurrent_analysis_requests_share_one_model_call(client, monkeypatch):
    started = Event()
    calls = 0
    second_call_started = Event()

    async def fake_complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        started.set()
        if calls == 1:
            await asyncio.to_thread(second_call_started.wait, 0.5)
        else:
            second_call_started.set()
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(
            client.post,
            f"/sessions/{session_id}/analysis",
            json={"language": "ru"},
        )
        assert started.wait(2)
        second = pool.submit(
            client.post,
            f"/sessions/{session_id}/analysis",
            json={"language": "ru"},
        )
        responses = [first.result(timeout=5), second.result(timeout=5)]

    assert [response.status_code for response in responses] == [200, 200]
    assert calls == 1
    assert responses[0].json() == responses[1].json()


def test_knowledge_map_aggregates_low_scores(client, monkeypatch):
    async def fake_complete(*args, **kwargs):
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
    response = client.get("/sessions/knowledge-map")

    assert response.status_code == 200, response.text
    assert response.json()["weakTopics"][0]["topic"] == "Техники тест-дизайна"
    assert response.json()["weakTopics"][0]["score"] == 42


def test_hr_analysis_does_not_pollute_technical_knowledge_map(client, monkeypatch):
    result = deepcopy(VALID_ANALYSIS)
    result.update(
        {
            "interviewType": "hr",
            "overallLevel": "Уверенная подача",
            "overallScore": 74,
            "overallConfidence": 0.9,
            "topicAssessments": [{"topic": "Самопрезентация", "score": 74, "confidence": 0.9}],
        }
    )

    async def fake_complete(*args, **kwargs):
        return json.dumps(result, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 200, response.text
    assert response.json()["interviewType"] == "hr"
    assert client.get("/sessions/knowledge-map").json()["weakTopics"] == []


def test_knowledge_map_merges_topics_by_normalized_name_and_sorts(client, monkeypatch):
    first = deepcopy(VALID_ANALYSIS)
    first["topicAssessments"] = [
        {"topic": "Тест-дизайн", "score": 40, "confidence": 0.8},
        {"topic": "API", "score": 75, "confidence": 0.5},
    ]
    second = deepcopy(VALID_ANALYSIS)
    second["topicAssessments"] = [
        {"topic": "  тест-дизайн  ", "score": 60, "confidence": 1.0},
        {"topic": "Python", "score": 92, "confidence": 0.9},
    ]
    replies = iter([first, second])

    async def fake_complete(*args, **kwargs):
        return json.dumps(next(replies), ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    for _ in range(2):
        session_id = _completed_session(client)
        response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
        assert response.status_code == 200, response.text

    response = client.get("/sessions/knowledge-map")

    assert response.status_code == 200, response.text
    knowledge = response.json()
    assert knowledge["weakTopics"] == [
        {
            "topic": "Тест-дизайн",
            "score": 51,
            "confidence": 0.9,
            "evidenceCount": 2,
        }
    ]
    assert [item["topic"] for item in knowledge["strongTopics"]] == ["Python", "API"]
    assert knowledge["updatedAt"]


def test_single_channel_analysis_is_explicitly_ambiguous_and_low_confidence(client, monkeypatch):
    captured: dict[str, str] = {}
    result = deepcopy(VALID_ANALYSIS)
    result["topicAssessments"][0]["confidence"] = 0.95

    async def fake_complete(messages, *args, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps(result, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = client.post("/sessions", json={"mode": "interview"}).json()["id"]
    client.post(
        f"/sessions/{session_id}/transcript",
        json={
            "speaker": "other",
            "text": "Что проверяешь в API? Проверяю схему и тело ответа.",
        },
    )
    client.post(f"/sessions/{session_id}/end", json={})

    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["topicAssessments"][0]["confidence"] <= 0.35
    assert payload["conclusion"].startswith("⚠")
    assert payload["markdown"].startswith("> ⚠")
    assert "role attribution is ambiguous" in captured["prompt"]
    assert "do not treat questions as candidate answers" in captured["prompt"]
    assert client.get("/sessions/knowledge-map").json()["weakTopics"] == []


def test_session_analysis_checks_quota_before_calling_model(client, monkeypatch, db_session):
    model_called = False

    def deny_quota(_db):
        raise AppError("quota exhausted", 402, "token_quota_exceeded")

    async def fake_complete(*args, **kwargs):
        nonlocal model_called
        model_called = True
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(quota, "check_token_quota", deny_quota)
    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)

    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 402, response.text
    assert model_called is False
    db_session.expire_all()
    assert db_session.query(models.ApiUsage).count() == 0


def test_session_analysis_records_each_provider_attempt(client, monkeypatch, db_session):
    replies = iter(["invalid", json.dumps(VALID_ANALYSIS, ensure_ascii=False)])

    async def fake_complete(*args, **kwargs):
        return next(replies)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)

    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})

    assert response.status_code == 200, response.text
    db_session.expire_all()
    rows = db_session.query(models.ApiUsage).order_by(models.ApiUsage.ts).all()
    assert [row.kind for row in rows] == ["session_analysis", "session_analysis"]
    assert all(row.tokens_in > 0 for row in rows)
    assert rows[1].tokens_out > 0
