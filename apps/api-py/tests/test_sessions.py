"""HTTP tests for the sessions router — focuses on bulk delete + ORM cascade.

Shared in-memory DB + client come from conftest.py.
"""

from fastapi.testclient import TestClient

from app.db import models


def _create_session_with_transcript(
    client: TestClient, mode: str = "interview", text: str = "hello"
) -> str:
    res = client.post("/sessions", json={"mode": mode, "title": "t"})
    assert res.status_code == 200, res.text
    sid = res.json()["id"]
    # A transcript makes the session non-empty (list filters empties) and lets
    # us assert the cascade actually removed children.
    res2 = client.post(f"/sessions/{sid}/transcript", json={"speaker": "other", "text": text})
    assert res2.status_code == 200, res2.text
    return sid


def test_delete_all_sessions_removes_everything_and_cascades(client, db_session):
    _create_session_with_transcript(client)
    _create_session_with_transcript(client, text="world")
    assert len(client.get("/sessions").json()["sessions"]) == 2

    res = client.delete("/sessions")
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] == 2

    assert client.get("/sessions").json()["sessions"] == []
    assert db_session.query(models.InterviewSession).count() == 0
    assert db_session.query(models.Transcript).count() == 0  # cascade


def test_delete_all_sessions_post_fallback(client):
    _create_session_with_transcript(client)
    res = client.post("/sessions/delete-all")
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] == 1
    assert client.get("/sessions").json()["sessions"] == []


def test_delete_all_sessions_when_empty_returns_zero(client):
    res = client.delete("/sessions")
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] == 0


def test_single_delete_still_works_after_bulk_route_added(client):
    sid = _create_session_with_transcript(client)
    res = client.delete(f"/sessions/{sid}")
    assert res.status_code == 200, res.text
    assert res.json()["deleted"] == sid
    assert client.get("/sessions").json()["sessions"] == []


def test_session_stats_counts_and_topics(client, db_session):
    sid = _create_session_with_transcript(client)
    db_session.add(models.Answer(session_id=sid, question="Как устроена репликация в PostgreSQL?"))
    db_session.add(models.Answer(session_id=sid, question="Расскажите про репликация данных"))
    db_session.commit()

    res = client.get("/sessions/stats")
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["interview_sessions"] == 1
    assert data["total_answers"] == 2
    assert data["last_session_at"] is not None
    # «репликация» встречается дважды — попадает в частые темы.
    assert any(t["topic"] == "репликация" for t in data["top_topics"])


def test_session_stats_empty_db(client):
    res = client.get("/sessions/stats")
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["interview_sessions"] == 0
    assert data["total_answers"] == 0
    assert data["top_topics"] == []


def test_session_diagnostics_are_stored_replaced_and_returned_with_answer_model(client, db_session):
    sid = _create_session_with_transcript(client, text="Что такое техники тест-дизайна?")
    db_session.add(
        models.Answer(
            session_id=sid,
            question="Что такое техники тест-дизайна?",
            answer_spoken="Это способы системно выбирать проверки.",
            model="openai/gpt-4.1-mini",
        )
    )
    db_session.commit()

    first = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-21T10:00:00.000Z",
        "sampleRate": 16000,
        "durationMs": 6100,
        "audioFile": None,
        "events": [
            {"tMs": 0, "type": "session_start"},
            {
                "tMs": 900,
                "type": "ready",
                "meta": {"engine": "openai-mini", "model": "gpt-4o-mini-transcribe"},
            },
        ],
        "extra": {"sources": {"mic": True, "system": True}},
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=first)
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"saved": sid, "event_count": 2}

    second = {
        **first,
        "durationMs": 9900,
        "events": [*first["events"], {"tMs": 9500, "type": "answer_done"}],
    }
    replaced = client.put(f"/sessions/{sid}/diagnostics", json=second)
    assert replaced.status_code == 200, replaced.text

    detail = client.get(f"/sessions/{sid}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["diagnostics"]["durationMs"] == 9900
    assert [event["type"] for event in body["diagnostics"]["events"]] == [
        "session_start",
        "ready",
        "answer_done",
    ]
    assert body["answers"][0]["model"] == "openai/gpt-4.1-mini"
    assert body["answers"][0]["ts"]
    assert db_session.query(models.SessionDiagnostic).count() == 1


def test_session_diagnostics_reject_unknown_session_and_oversized_snapshot(client):
    missing = client.put(
        "/sessions/missing/diagnostics",
        json={"schemaVersion": 1, "events": []},
    )
    assert missing.status_code == 404

    sid = _create_session_with_transcript(client)
    oversized = client.put(
        f"/sessions/{sid}/diagnostics",
        json={
            "schemaVersion": 1,
            "events": [{"tMs": 1, "type": "error", "reason": "x" * 1_100_000}],
        },
    )
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "diagnostics_too_large"
