"""HTTP tests for the durable mock-interview session store."""


def _payload(sid: str, status: str = "in_progress", started: int = 1000, updated: int = 1000):
    return {
        "id": sid,
        "status": status,
        "startedAt": started,
        "updatedAt": updated,
        "payload": {"id": sid, "status": status, "startedAt": started, "questions": []},
    }


def test_upsert_then_list_roundtrip(client):
    res = client.put("/mock-sessions/s1", json=_payload("s1"))
    assert res.status_code == 200, res.text

    listed = client.get("/mock-sessions").json()["sessions"]
    assert len(listed) == 1
    assert listed[0]["id"] == "s1"
    assert listed[0]["payload"]["questions"] == []


def test_upsert_is_idempotent_update(client):
    client.put("/mock-sessions/s1", json=_payload("s1"))
    client.put("/mock-sessions/s1", json=_payload("s1", status="completed", updated=2000))

    listed = client.get("/mock-sessions").json()["sessions"]
    assert len(listed) == 1
    assert listed[0]["status"] == "completed"
    assert listed[0]["updatedAt"] == 2000


def test_list_sorted_by_started_desc(client):
    client.put("/mock-sessions/old", json=_payload("old", started=100))
    client.put("/mock-sessions/new", json=_payload("new", started=200))
    ids = [s["id"] for s in client.get("/mock-sessions").json()["sessions"]]
    assert ids == ["new", "old"]


def test_delete_removes_row(client):
    client.put("/mock-sessions/s1", json=_payload("s1"))
    res = client.delete("/mock-sessions/s1")
    assert res.status_code == 200
    assert client.get("/mock-sessions").json()["sessions"] == []


def test_id_mismatch_rejected(client):
    res = client.put("/mock-sessions/other", json=_payload("s1"))
    assert res.status_code == 400
