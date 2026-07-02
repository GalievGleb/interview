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
    db_session.add(
        models.Answer(session_id=sid, question="Как устроена репликация в PostgreSQL?")
    )
    db_session.add(
        models.Answer(session_id=sid, question="Расскажите про репликация данных")
    )
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
