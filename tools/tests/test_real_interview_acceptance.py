from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.real_interview_acceptance import (
    AcceptanceRuntimeError,
    ManifestError,
    build_privacy_safe_report,
    complete_sse_events,
    evaluate_attempt,
    finalize_request_complete,
    merge_transcript_fragments,
    nearest_rank_percentile,
    pcm_duration_seconds,
    pcm_frames,
    silence_pcm,
    summarize_attempts,
    validate_manifest,
    voice_timings,
)


def _voice_case(source: Path) -> dict:
    return {
        "id": "ozon-docker",
        "kind": "voice",
        "source": str(source),
        "expectedTranscript": [
            {"key": "docker", "aliases": ["docker", "докер"]},
        ],
        "expectedAnswer": [
            {"key": "container", "aliases": ["контейнер", "container"]},
        ],
        "minTranscriptMatches": 1,
        "minAnswerMatches": 1,
        "budgets": {
            "sttMs": 6000,
            "firstChunkMs": 5000,
            "triggerToFirstAnswerMs": 4000,
            "totalMs": 10000,
        },
    }


def test_validate_manifest_rejects_duplicate_ids(tmp_path: Path) -> None:
    source = tmp_path / "question.wav"
    source.write_bytes(b"private-audio")
    case = _voice_case(source)

    with pytest.raises(ManifestError, match="Duplicate case id"):
        validate_manifest({"version": 1, "cases": [case, dict(case)]}, tmp_path)


def test_validate_manifest_rejects_missing_private_media(tmp_path: Path) -> None:
    case = _voice_case(tmp_path / "missing.wav")

    with pytest.raises(ManifestError, match="does not exist"):
        validate_manifest({"version": 1, "cases": [case]}, tmp_path)


def test_nearest_rank_percentile_is_strict_at_p50_and_p95() -> None:
    values = [100, 200, 300, 400]

    assert nearest_rank_percentile(values, 50) == 200
    assert nearest_rank_percentile(values, 95) == 400


def test_suite_fails_when_one_repetition_fails() -> None:
    attempts = [
        {"caseId": "pause", "passed": True, "triggerToFirstAnswerMs": 2500},
        {
            "caseId": "pause",
            "passed": False,
            "triggerToFirstAnswerMs": 4100,
            "failures": ["trigger_to_first_answer_budget"],
        },
    ]

    summary = summarize_attempts(attempts)

    assert summary["passed"] is False
    assert summary["attempts"] == 2
    assert summary["failedAttempts"] == 1
    assert summary["latencyMs"]["triggerToFirstAnswer"]["p95"] == 4100


def test_report_drops_private_content_and_absolute_paths(tmp_path: Path) -> None:
    secret_source = tmp_path / "private" / "interview.wav"
    attempts = [
        {
            "caseId": "ozon-docker",
            "kind": "voice",
            "passed": True,
            "source": str(secret_source),
            "transcript": "PRIVATE INTERVIEW TRANSCRIPT",
            "answer": "PRIVATE MODEL ANSWER",
            "sourceHash": "sha256:abc123",
            "matchedTranscriptKeys": ["docker"],
            "matchedAnswerKeys": ["container"],
            "sttMs": 1200,
            "firstChunkMs": 900,
            "triggerToFirstAnswerMs": 2100,
            "totalMs": 3200,
            "model": "example-model",
            "questionIntent": "technical_definition",
            "answerSource": "fast_core_latency_hedge",
            "hedgeStarted": True,
            "hedgeWinner": "fallback",
            "failures": [],
        }
    ]

    report = build_privacy_safe_report("private-real-interviews", attempts)
    serialized = json.dumps(report, ensure_ascii=False)

    assert "PRIVATE INTERVIEW TRANSCRIPT" not in serialized
    assert "PRIVATE MODEL ANSWER" not in serialized
    assert str(secret_source) not in serialized
    assert report["attempts"][0]["sourceHash"] == "sha256:abc123"
    assert report["attempts"][0]["matchedAnswerKeys"] == ["container"]
    assert report["attempts"][0]["questionIntent"] == "technical_definition"
    assert report["attempts"][0]["hedgeWinner"] == "fallback"


def test_pcm_frames_match_real_time_100ms_capture_chunks() -> None:
    sample_rate = 16_000
    one_second_pcm = b"\x01\x00" * sample_rate

    frames = list(pcm_frames(one_second_pcm, sample_rate, frame_ms=100))

    assert len(frames) == 10
    assert all(len(frame) == 3_200 for frame in frames)
    assert pcm_duration_seconds(one_second_pcm, sample_rate) == pytest.approx(1.0)


def test_post_roll_is_real_silent_pcm_not_an_empty_wait() -> None:
    pcm = silence_pcm(100, sample_rate=16_000)

    assert pcm == b"\x00\x00" * 1_600
    assert pcm_duration_seconds(pcm, 16_000) == pytest.approx(0.1)


def test_merge_transcript_fragments_preserves_pause_split_question() -> None:
    fragments = [
        "Какие техники?",
        "Какие техники тест-дизайна",
        "ты знаешь?",
        "ты знаешь?",
    ]

    assert merge_transcript_fragments(fragments) == "Какие техники тест-дизайна ты знаешь?"


def test_voice_timings_measure_from_ctrl_enter_not_audio_start() -> None:
    timings = voice_timings(stt_ms=1_200, first_chunk_ms=900, llm_total_ms=2_000)

    assert timings == {
        "sttMs": 1_200,
        "firstChunkMs": 900,
        "triggerToFirstAnswerMs": 2_100,
        "totalMs": 3_200,
    }


def test_empty_terminal_voice_answer_always_fails(tmp_path: Path) -> None:
    source = tmp_path / "question.wav"
    source.write_bytes(b"private-audio")
    case = validate_manifest(
        {"version": 1, "cases": [_voice_case(source)]}, tmp_path
    )["cases"][0]

    result = evaluate_attempt(
        case,
        transcript="Что такое Docker и зачем он нужен?",
        answer="",
        timings=voice_timings(stt_ms=900, first_chunk_ms=800, llm_total_ms=1_500),
        model="example-model",
    )

    assert result["passed"] is False
    assert "empty_terminal_answer" in result["failures"]


def test_voice_attempt_fails_semantics_and_trigger_latency(tmp_path: Path) -> None:
    source = tmp_path / "question.wav"
    source.write_bytes(b"private-audio")
    case = validate_manifest(
        {"version": 1, "cases": [_voice_case(source)]}, tmp_path
    )["cases"][0]

    result = evaluate_attempt(
        case,
        transcript="Расскажите о другом инструменте",
        answer="Ответ не про контейнеры",
        timings=voice_timings(stt_ms=3_500, first_chunk_ms=900, llm_total_ms=1_500),
        model="example-model",
    )

    assert result["passed"] is False
    assert "transcript_semantics" in result["failures"]
    assert "trigger_to_first_answer_budget" in result["failures"]


def test_finalize_waits_for_idless_active_job_after_force_empty() -> None:
    request_id = "force-1"
    events = [
        {"type": "speech_started", "_receivedAt": 1.0},
        {
            "type": "force_empty",
            "force_request_id": request_id,
            "_receivedAt": 2.0,
        },
    ]

    assert finalize_request_complete(events, request_id) is False

    events.append(
        {
            "type": "transcript",
            "text": "Какие техники тест-дизайна ты знаешь?",
            "force_request_id": None,
            "_receivedAt": 2.8,
        }
    )
    assert finalize_request_complete(events, request_id) is True


def test_finalize_accepts_already_finalized_prefix_on_force_empty() -> None:
    request_id = "force-2"
    events = [
        {"type": "speech_started", "_receivedAt": 1.0},
        {"type": "transcript", "text": "Что такое Docker?", "_receivedAt": 1.8},
        {
            "type": "force_empty",
            "force_request_id": request_id,
            "_receivedAt": 2.0,
        },
    ]

    assert finalize_request_complete(events, request_id) is True


def test_finalize_tracks_overlapping_pause_split_utterances() -> None:
    request_id = "force-overlap"
    events = [
        {"type": "speech_started", "_receivedAt": 1.0},
        {"type": "speech_started", "_receivedAt": 2.0},
        {"type": "transcript", "text": "Какие техники?", "_receivedAt": 2.5},
        {
            "type": "force_empty",
            "force_request_id": request_id,
            "_receivedAt": 3.0,
        },
    ]

    assert finalize_request_complete(events, request_id) is False

    events.append(
        {
            "type": "transcript",
            "text": "Техники тест-дизайна ты знаешь?",
            "_receivedAt": 4.0,
        }
    )
    assert finalize_request_complete(events, request_id) is True


def test_incomplete_screen_stream_is_a_hard_failure() -> None:
    with pytest.raises(AcceptanceRuntimeError, match="stream did not finish"):
        complete_sse_events(
            [{"type": "chunk", "text": "Частичный ответ", "_elapsedMs": 500}],
            total_ms=700,
        )


def test_complete_sse_stream_uses_terminal_spoken_answer() -> None:
    answer, first_chunk_ms, total_ms, done = complete_sse_events(
        [
            {"type": "chunk", "text": "Черновой ", "_elapsedMs": 450},
            {
                "type": "done",
                "spoken": "Итоговый ответ",
                "model": "example-model",
                "_elapsedMs": 900,
            },
        ],
        total_ms=950,
    )

    assert answer == "Итоговый ответ"
    assert first_chunk_ms == 450
    assert total_ms == 950
    assert done["model"] == "example-model"


def test_validate_screen_case_requires_question(tmp_path: Path) -> None:
    source = tmp_path / "task.png"
    source.write_bytes(b"private-image")
    case = {
        "id": "lamoda-api-task",
        "kind": "screen",
        "source": str(source),
        "expectedAnswer": [{"key": "status", "aliases": ["статус", "status"]}],
        "minAnswerMatches": 1,
        "budgets": {"firstChunkMs": 5000, "totalMs": 15000},
    }

    with pytest.raises(ManifestError, match="question"):
        validate_manifest({"version": 1, "cases": [case]}, tmp_path)
