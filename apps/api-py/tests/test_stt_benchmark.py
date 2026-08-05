from app.services.stt import benchmark
from app.services.stt.base import BaseTranscriptionProvider, ProviderMode


def test_score_case_preserves_raw_transcript() -> None:
    case = {
        "id": "api",
        "title": "API",
        "transcriptKeywords": [{"key": "REST API", "aliases": ["REST API"]}],
        "expectedTerms": ["REST API"],
    }
    transcript = "Что такое REST API?"

    result = benchmark.score_case(case, transcript, 250)

    assert result["raw"]["transcript"] == transcript
    assert "corrected" not in result
    assert result["raw"]["keywordMatch"] == 1.0


class FakeMiniProvider(BaseTranscriptionProvider):
    id = "openai-gpt-4o-mini-transcribe"
    display_name = "OpenAI Mini"
    mode = ProviderMode.CLOUD

    def is_available(self) -> bool:
        return True

    def _active_model(self) -> str:
        return "gpt-4o-mini-transcribe"

    async def _transcribe_file(
        self, audio: bytes, *, language: str | None, sample_rate: int
    ) -> str:
        return "Что такое REST API?"


def test_aggregate_has_no_correction_metrics() -> None:
    provider = FakeMiniProvider()
    report = benchmark._aggregate(
        [
            {
                "caseId": "api",
                "raw": {
                    "transcript": "Что такое REST API?",
                    "latencyMs": 250,
                    "keywordMatch": 1.0,
                    "semanticMatch": 1.0,
                },
                "intentMatch": 1.0,
                "falseNegative": False,
                "errorType": "ok",
            }
        ],
        provider,
    )

    assert report["model"] == "gpt-4o-mini-transcribe"
    assert report["avgLatencyMs"] == 250
    assert "correctionGain" not in report
