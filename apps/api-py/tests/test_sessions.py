"""HTTP tests for the sessions router — focuses on bulk delete + ORM cascade.

Shared in-memory DB + client come from conftest.py.
"""

import json

from fastapi.testclient import TestClient

from app.db import models
from app.routers.sessions import _diagnostic_text


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


def test_schema_v2_diagnostics_are_allowlisted_before_persistence(client):
    sid = _create_session_with_transcript(client)
    payload = {
        "schemaVersion": 2,
        "generatedAt": "2026-08-24T00:00:00.000Z",
        "sampleRate": 16000,
        "durationMs": 1000,
        "audioFile": None,
        "events": [
            {
                "tMs": 10,
                "type": "error",
                "reason": "Bearer transport-secret",
                "requestContext": "event-context-secret",
                "meta": {
                    "queueDepth": 2,
                    "X-SkillCue-Token": "header-secret",
                    "cookieJar": {"sid": "cookie-secret"},
                    "privateKey": "private-secret",
                },
            }
        ],
        "extra": {
            "sources": {"mic": True, "system": False, "unknown": "bad"},
            "exchanges": [
                {
                    "question": "Allowed question",
                    "pipeline": {
                        "model": "openai/gpt-4.1-mini",
                        "timeToAnswerMs": 900,
                        "timeToFinalMs": 444,
                        "resetPreviousTopicReason": "explicit_new_topic",
                        "knowledge": {
                            "knowledgePackUsed": True,
                            "knowledgePackName": "QA pack",
                            "retrievedItemsCount": 3,
                            "knowledgeRetrievalMs": 17,
                        },
                    },
                    "latency": {
                        "sttLatencyMs": None,
                        "llmLatencyMs": 800,
                        "breakdown": {
                            "finalToAnswerStartMs": 62,
                            "llmFirstTokenMs": 500,
                        },
                    },
                }
            ],
            "requestContext": "root-context-secret",
            "authHeaders": {"Authorization": "Basic basic-secret"},
            "token": "generic-secret",
            "licenseKey": "license-secret",
            "rawPayload": "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
            "screenAssists": [
                {
                    "id": "screen-1",
                    "generation": 1,
                    "startedAtMs": 10,
                    "trigger": "manual",
                    "mode": "general",
                    "effectiveQuestion": "Question",
                    "status": "done",
                    "answer": "data:image/png;base64,QUJD",
                    "screenshot": "data:image/png;base64,QUJD",
                }
            ],
        },
        "retention": {
            "events": {"limit": 1000, "retained": 1, "dropped": 0, "total": 1},
            "screenAssists": {"limit": 40, "retained": 1, "dropped": 0, "total": 1},
        },
        "unknownRoot": "root-secret",
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=payload)
    assert saved.status_code == 200, saved.text
    stored = client.get(f"/sessions/{sid}").json()["diagnostics"]
    serialized = json.dumps(stored).lower()
    for forbidden in (
        "transport-secret",
        "event-context-secret",
        "header-secret",
        "cookie-secret",
        "private-secret",
        "root-context-secret",
        "basic-secret",
        "generic-secret",
        "license-secret",
        "qujdrevgr0hjsktmtu5puffsu1rvvldywvo",
        "data:image",
        "screenshot",
        "unknownroot",
        "requestcontext",
        "authheaders",
    ):
        assert forbidden not in serialized
    assert stored["events"][0]["meta"]["queueDepth"] == 2
    assert stored["extra"]["sources"] == {"mic": True, "system": False}
    exchange = stored["extra"]["exchanges"][0]
    assert exchange["pipeline"]["timeToFinalMs"] == 444
    assert exchange["pipeline"]["resetPreviousTopicReason"] == "explicit_new_topic"
    assert exchange["pipeline"]["knowledge"] == {
        "knowledgePackUsed": True,
        "knowledgePackName": "QA pack",
        "retrievedItemsCount": 3,
        "knowledgeRetrievalMs": 17,
    }
    assert exchange["latency"]["breakdown"] == {
        "finalToAnswerStartMs": 62,
        "llmFirstTokenMs": 500,
    }


def test_diagnostic_text_redacts_arbitrary_mime_data_urls():
    value = "prefix data:text/plain;base64,c2VjcmV0LXRleHQ= suffix"
    sanitized = _diagnostic_text(value, 1000)
    assert sanitized == "prefix [OMITTED_DATA_URL] suffix"
    assert "c2VjcmV0" not in sanitized


def test_diagnostic_text_redacts_complete_data_urls_regardless_of_encoding():
    payloads = [
        "data:text/plain,secret-token",
        "data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E",
        "data:application/json,%7B%22token%22%3A%22secret%22%7D",
    ]
    for payload in payloads:
        sanitized = _diagnostic_text(f"prefix {payload} suffix", 1000)
        assert sanitized == "prefix [OMITTED_DATA_URL] suffix"
        assert "data:" not in sanitized


def test_diagnostic_text_preserves_ordinary_data_words_without_url_comma():
    ordinary = "metadata:model=actual userdata:value ordinary data science"
    assert _diagnostic_text(ordinary, 1000) == ordinary


def test_schema_v2_put_redacts_non_image_data_urls(client):
    sid = _create_session_with_transcript(client)
    payload = {
        "schemaVersion": 2,
        "events": [
            {
                "tMs": 1,
                "type": "error",
                "reason": "data:text/plain;base64,c2VjcmV0LXRleHQ=",
            }
        ],
        "extra": {
            "screenAssists": [
                {
                    "id": "screen-data",
                    "generation": 1,
                    "status": "done",
                    "answer": "data:application/json;base64,eyJ0b2tlbiI6InNlY3JldCJ9",
                }
            ]
        },
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=payload)
    assert saved.status_code == 200, saved.text
    stored = client.get(f"/sessions/{sid}").json()["diagnostics"]
    serialized = json.dumps(stored)
    assert "data:text" not in serialized
    assert "data:application" not in serialized
    assert "c2VjcmV0" not in serialized
    assert "eyJ0b2tlbi" not in serialized
    assert "[OMITTED_DATA_URL]" in serialized


def test_schema_v2_put_redacts_percent_encoded_data_urls(client):
    sid = _create_session_with_transcript(client)
    payload = {
        "schemaVersion": 2,
        "events": [
            {"tMs": 1, "type": "error", "reason": "data:text/plain,secret-token"},
            {
                "tMs": 2,
                "type": "error",
                "reason": "data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E",
            },
        ],
        "extra": {
            "screenAssists": [
                {
                    "id": "json-data",
                    "generation": 1,
                    "status": "done",
                    "answer": "data:application/json,%7B%22token%22%3A%22secret%22%7D",
                }
            ]
        },
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=payload)
    assert saved.status_code == 200, saved.text
    serialized = json.dumps(client.get(f"/sessions/{sid}").json()["diagnostics"])
    assert "data:" not in serialized
    assert "secret-token" not in serialized
    assert "%3Csvg" not in serialized
    assert "%7B%22token" not in serialized
    assert serialized.count("[OMITTED_DATA_URL]") == 3


def test_schema_v2_put_counts_sanitizer_trimming(client):
    sid = _create_session_with_transcript(client)
    payload = {
        "schemaVersion": 2,
        "events": [
            {"tMs": index, "type": "partial", "reason": f"event-{index}"} for index in range(1005)
        ],
        "extra": {
            "screenAssists": [
                {"id": f"screen-{index}", "generation": index, "status": "done"}
                for index in range(45)
            ]
        },
        "retention": {
            "events": {"retained": 1005, "dropped": 0, "total": 1005},
            "screenAssists": {"retained": 45, "dropped": 0, "total": 45},
        },
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=payload)
    assert saved.status_code == 200, saved.text
    stored = client.get(f"/sessions/{sid}").json()["diagnostics"]
    assert stored["events"][0]["reason"] == "event-5"
    assert stored["events"][-1]["reason"] == "event-1004"
    assert stored["extra"]["screenAssists"][0]["id"] == "screen-5"
    assert stored["retention"] == {
        "events": {"limit": 1000, "retained": 1000, "dropped": 5, "total": 1005},
        "screenAssists": {"limit": 40, "retained": 40, "dropped": 5, "total": 45},
    }


def test_schema_v2_put_counts_invalid_filtered_records_as_dropped(client):
    sid = _create_session_with_transcript(client)
    payload = {
        "schemaVersion": 2,
        "events": [
            {"tMs": 1, "type": "partial", "reason": "kept"},
            {"tMs": 2, "type": "unknown", "reason": "filtered"},
        ],
        "extra": {
            "screenAssists": [
                {"id": "kept-screen", "generation": 1, "status": "done"},
                {"generation": 2, "status": "done", "screenshot": "filtered"},
            ]
        },
        "retention": {
            "events": {"retained": 2, "dropped": 3, "total": 5},
            "screenAssists": {"retained": 2, "dropped": 3, "total": 5},
        },
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=payload)
    assert saved.status_code == 200, saved.text
    stored = client.get(f"/sessions/{sid}").json()["diagnostics"]
    assert stored["retention"] == {
        "events": {"limit": 1000, "retained": 1, "dropped": 4, "total": 5},
        "screenAssists": {"limit": 40, "retained": 1, "dropped": 4, "total": 5},
    }


def test_schema_v2_put_validates_screens_before_capping_newest_valid_40(client):
    sid = _create_session_with_transcript(client)
    valid = [
        {"id": f"valid-screen-{index}", "generation": index, "status": "done"}
        for index in range(45)
    ]
    invalid_tail = [
        {"generation": 45 + index, "status": "done", "screenshot": f"invalid-{index}"}
        for index in range(5)
    ]
    payload = {
        "schemaVersion": 2,
        "events": [],
        "extra": {"screenAssists": [*valid, *invalid_tail]},
        "retention": {
            "events": {"retained": 0, "dropped": 0, "total": 0},
            "screenAssists": {"retained": 50, "dropped": 0, "total": 50},
        },
    }
    saved = client.put(f"/sessions/{sid}/diagnostics", json=payload)
    assert saved.status_code == 200, saved.text
    stored = client.get(f"/sessions/{sid}").json()["diagnostics"]
    screens = stored["extra"]["screenAssists"]
    assert len(screens) == 40
    assert screens[0]["id"] == "valid-screen-5"
    assert screens[-1]["id"] == "valid-screen-44"
    assert stored["retention"]["screenAssists"] == {
        "limit": 40,
        "retained": 40,
        "dropped": 10,
        "total": 50,
    }
