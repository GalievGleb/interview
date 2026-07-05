"""Tests for the answer-feedback endpoints (👍/👎 quality loop)."""


def test_record_and_summary(client):
    for _ in range(3):
        assert (
            client.post(
                "/feedback",
                json={"verdict": "up", "question": "Что такое CI/CD?", "answer": "..."},
            ).status_code
            == 200
        )
    client.post(
        "/feedback",
        json={
            "verdict": "down",
            "question": "Что такое фикстуры?",
            "answer": "плохой ответ",
            "raw_transcript": "что такое фикстуры",
            "source": "live",
        },
    )

    s = client.get("/feedback/summary").json()
    assert s["up"] == 3
    assert s["down"] == 1
    assert len(s["recent_downvotes"]) == 1
    dv = s["recent_downvotes"][0]
    assert dv["question"] == "Что такое фикстуры?"
    assert dv["raw_transcript"] == "что такое фикстуры"


def test_invalid_verdict_rejected(client):
    res = client.post("/feedback", json={"verdict": "meh"})
    assert res.status_code == 400
