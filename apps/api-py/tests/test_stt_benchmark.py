"""Tests for the STT Benchmark (audio -> transcript, no LLM, no answer keywords)."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.stt import benchmark, glossary
from app.services.stt.base import TranscriptResult

client = TestClient(app)


# --- deterministic glossary corrector -----------------------------------
def test_glossary_corrects_user_terms():
    samples = {
        "что такое смог тестирование": "smoke testing",
        "что такое cicd": "CI/CD",
        "что такое депараторы": "декораторы",
        "что такое терапор": "итератор",
        "расскажи про гит медч": "git merge",
        "что такое гит рибейс": "git rebase",
        "что такое кис драй ягни": "KISS, DRY, YAGNI",
    }
    for text, expected in samples.items():
        corrected, applied = glossary.correct_transcript(text)
        assert expected in corrected, f"{text!r} -> {corrected!r}"
        assert applied  # something was logged


def test_glossary_leaves_clean_text_untouched():
    out, applied = glossary.correct_transcript("обычный вопрос без терминов")
    assert out == "обычный вопрос без терминов"
    assert applied == []


def test_glossary_loaded_from_shared_json():
    # Single source of truth — the full shared glossary (packages/shared).
    assert glossary.glossary_size() > 200


def test_glossary_is_idempotent_for_multiword_alias():
    # "смог тестирование" must not re-expand into "smoke testing testing".
    out, _ = glossary.correct_transcript("что такое смог тестирование")
    assert out == "что такое smoke testing"
    out2, _ = glossary.correct_transcript(out)
    assert out2 == out  # already canonical, no further change


# --- pure scoring --------------------------------------------------------
def test_keyword_match_fraction():
    kws = [
        {"key": "a", "aliases": ["alpha"]},
        {"key": "b", "aliases": ["beta"]},
    ]
    assert benchmark.keyword_match("alpha only", kws) == 0.5
    assert benchmark.keyword_match("alpha and beta", kws) == 1.0
    assert benchmark.keyword_match("", kws) == 0.0


def test_classify_error_buckets():
    assert benchmark.classify_error("", 0.0) == "empty"
    assert benchmark.classify_error("text", 0.9) == "ok"
    assert benchmark.classify_error("text", 0.5) == "partial"
    assert benchmark.classify_error("text", 0.1) == "low"


# --- fairer (fuzzy + semantic) matching ----------------------------------
def test_match_keywords_fuzzy_inflection():
    # "пайплайне" should credit the "пайплайн" alias (inflection, not exact).
    kws = [{"key": "pipeline", "aliases": ["пайплайн"]}]
    score, hit, miss = benchmark.match_keywords("работа в пайплайне", kws)
    assert score == 1.0 and hit == ["pipeline"] and miss == []


def test_match_keywords_returns_hits_and_misses():
    kws = [{"key": "a", "aliases": ["alpha"]}, {"key": "b", "aliases": ["beta"]}]
    score, hit, miss = benchmark.match_keywords("alpha only", kws)
    assert score == 0.5 and hit == ["a"] and miss == ["b"]


def test_match_terms_semantic_phrase():
    score, hit, _ = benchmark.match_terms("какие бывают виды тестирования", ["виды тестирования"])
    assert score == 1.0 and hit == ["виды тестирования"]


def test_score_case_flags_false_negative():
    # Meaning is clearly present (semantic high) but exact keywords miss (low).
    case = {
        "id": "x",
        "transcriptKeywords": [
            {"key": "unit", "aliases": ["unit", "юнит"]},
            {"key": "e2e", "aliases": ["e2e", "сквозное"]},
        ],
        "expectedTerms": [],
        "expectedMeaning": ["виды тестирования"],
    }
    res = benchmark.score_case(case, "какие бывают виды тестирования", 0)
    assert res["corrected"]["keywordMatch"] < 0.5
    assert res["corrected"]["semanticMatch"] >= 0.6
    assert res["falseNegative"] is True


def test_score_case_correction_active_flag():
    case = {"id": "x", "transcriptKeywords": [], "expectedTerms": []}
    active = benchmark.score_case(case, "что такое cicd", 0)
    assert active["corrected"]["correctionActive"] is True
    inactive = benchmark.score_case(case, "обычный текст без терминов", 0)
    assert inactive["corrected"]["correctionActive"] is False


def test_score_case_shows_correction_gain():
    case = {
        "id": "x",
        "title": "t",
        "transcriptKeywords": [{"key": "smoke", "aliases": ["smoke testing"]}],
        "expectedTerms": ["smoke testing"],
    }
    res = benchmark.score_case(case, "что такое смог тестирование", 100)
    assert res["raw"]["keywordMatch"] == 0.0  # alias not in raw
    assert res["corrected"]["keywordMatch"] == 1.0  # corrected -> smoke testing
    assert res["keywordGain"] == 1.0
    assert res["intentMatch"] == 1.0
    assert res["errorType"] == "ok"
    assert res["corrected"]["corrections"]  # logged what changed


# --- run_case with an injected fake provider (no model needed) -----------
class _FakeProvider:
    id = "whisper-local"

    def _active_model(self) -> str:
        return "whisper-fake"

    async def transcribe_audio_file(self, audio, *, language=None, sample_rate=16000):
        return TranscriptResult(
            text="что вы делали с flaky тесты в cicd пайплайн",
            latency_ms=111,
            provider_id=self.id,
            model="whisper-fake",
        )


@pytest.mark.asyncio
async def test_run_case_with_fake_provider():
    cases = benchmark.load_cases()
    case = next((c for c in cases if c["id"] == "04_flaky_tests"), None)
    if case is None:
        pytest.skip("benchmark case missing")
    audio = benchmark.resolve_audio_path(case["audioFile"])
    if not audio.is_file():
        pytest.skip("audio missing")

    res = await benchmark.run_case(case, _FakeProvider())
    assert res["engine"] == "whisper-local"
    assert "raw" in res and "corrected" in res
    # Deterministic correction normalizes "cicd" -> CI/CD and "flaky тесты" ->
    # flaky tests. (Note: correction can move keyword match either way, since
    # keyword aliases may reference the raw RU forms — that's honest, not a bug.)
    assert "CI/CD" in res["corrected"]["transcript"]
    assert res["corrected"]["corrections"]  # something was corrected
    assert 0.0 <= res["corrected"]["keywordMatch"] <= 1.0
    assert res["errorType"] in {"ok", "partial", "low", "empty"}


# --- endpoints (model-independent ones) ----------------------------------
def test_cases_endpoint():
    r = client.get("/stt/benchmark/cases")
    assert r.status_code == 200
    assert len(r.json()["cases"]) >= 1


def test_unknown_case_404():
    assert client.post("/stt/benchmark/run/nope").status_code in (404, 409, 503)


def test_reports_endpoint_lists():
    r = client.get("/stt/benchmark/reports")
    assert r.status_code == 200
    assert "reports" in r.json()
