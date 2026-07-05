"""Tests for the latency telemetry endpoints (record + p50/p95 summary)."""


def test_summary_empty(client):
    s = client.get("/latency/summary").json()
    assert s["count"] == 0
    assert s["stages"]["total_ms"] is None
    assert s["budgets_ms"]["total_ms"] > 0


def test_record_then_summary_percentiles(client):
    # 10 answers: stt 100..1000ms — p50 ≈ 500-600, p95 ≈ 1000.
    for i in range(1, 11):
        res = client.post(
            "/latency",
            json={
                "stt_ms": i * 100,
                "llm_first_ms": 400,
                "llm_total_ms": 900,
                "total_ms": i * 100 + 900,
            },
        )
        assert res.status_code == 200, res.text

    s = client.get("/latency/summary").json()
    assert s["count"] == 10
    stt = s["stages"]["stt_ms"]
    assert stt["n"] == 10
    assert 400 <= stt["p50"] <= 600
    assert stt["p95"] >= 900
    assert stt["budget"] == 1200
    assert stt["within_budget"] is True


def test_budget_breach_flagged(client):
    for _ in range(5):
        client.post("/latency", json={"stt_ms": 5000, "total_ms": 9000})
    s = client.get("/latency/summary").json()
    assert s["stages"]["stt_ms"]["within_budget"] is False
    assert s["stages"]["total_ms"]["within_budget"] is False


def test_partial_payload_ok(client):
    res = client.post("/latency", json={"total_ms": 1500})
    assert res.status_code == 200
    s = client.get("/latency/summary").json()
    assert s["stages"]["total_ms"]["n"] == 1
    assert s["stages"]["stt_ms"] is None
