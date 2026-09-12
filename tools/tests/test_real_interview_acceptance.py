from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import pytest

import tools.real_interview_acceptance as acceptance_module
from tools.real_interview_acceptance import (
    AcceptanceRuntimeError,
    InstalledBackendSession,
    ManifestError,
    ask_interview,
    backend_launch_spec,
    build_privacy_safe_report,
    complete_sse_events,
    evaluate_attempt,
    finalize_request_complete,
    merge_transcript_fragments,
    nearest_rank_percentile,
    pcm_duration_seconds,
    pcm_frames,
    run_acceptance_suite,
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


def _report_hash(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()[:16]}"


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
    assert report["attempts"][0]["matchedAnswerKeys"] == [_report_hash("container")]
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

    assert (
        merge_transcript_fragments(fragments) == "Какие техники тест-дизайна ты знаешь?"
    )


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
    case = validate_manifest({"version": 1, "cases": [_voice_case(source)]}, tmp_path)[
        "cases"
    ][0]

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
    case = validate_manifest({"version": 1, "cases": [_voice_case(source)]}, tmp_path)[
        "cases"
    ][0]

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


def test_source_backend_launch_uses_workspace_uvicorn() -> None:
    root = Path(__file__).resolve().parents[2]

    command, cwd = backend_launch_spec(source_backend=True, port=8123, root=root)

    assert command[1:4] == ["-m", "uvicorn", "app.main:app"]
    assert command[-2:] == ["--port", "8123"]
    assert cwd == root / "apps" / "api-py"


def test_installed_backend_path_and_cli_select_the_isolated_alpha_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\tester\AppData\Local")

    assert acceptance_module._installed_backend_path("dev") == Path(
        r"C:\Users\tester\AppData\Local\Programs\skillcue-dev\resources\backend\skillcue-backend.exe"
    )
    assert acceptance_module._installed_backend_path("alpha") == Path(
        r"C:\Users\tester\AppData\Local\Programs\skillcue-alpha\resources\backend\skillcue-backend.exe"
    )
    args = acceptance_module._parse_args(
        ["--manifest", "cases.json", "--channel", "alpha"]
    )
    assert args.channel == "alpha"


def test_source_backend_launch_uses_only_managed_gateway_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured_env: dict[str, str] = {}

    def launch(*_args, **kwargs):
        captured_env.update(kwargs["env"])
        raise OSError("stop after environment capture")

    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-source-backend")
    monkeypatch.setenv("OPENROUTER_API_KEY", "must-not-reach-source-backend")
    monkeypatch.setenv("PYTHON_KEYRING_BACKEND", "unsafe.backend")
    monkeypatch.setenv("SKILLCUE_GATEWAY_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setattr(acceptance_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        acceptance_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(acceptance_module.subprocess, "Popen", launch)
    monkeypatch.setattr(
        acceptance_module,
        "_installed_backend_path",
        lambda _channel="dev": tmp_path / "not-used-for-source.exe",
    )

    with pytest.raises(OSError, match="environment capture"):
        InstalledBackendSession(source_backend=True).__enter__()

    assert captured_env["OPENAI_API_KEY"] == ""
    assert captured_env["OPENROUTER_API_KEY"] == ""
    assert captured_env["PYTHON_KEYRING_BACKEND"] == "keyring.backends.null.Keyring"
    assert captured_env["SKILLCUE_GATEWAY_URL"] == "https://skill-cue.ru/v1"


def test_source_backend_session_entry_never_discovers_installed_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def launch(*_args, **_kwargs):
        raise OSError("source launch reached")

    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(acceptance_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        acceptance_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(acceptance_module.subprocess, "Popen", launch)

    with pytest.raises(OSError, match="source launch reached"):
        InstalledBackendSession(source_backend=True).__enter__()


def test_installed_backend_launch_keeps_existing_environment_contract(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured_env: dict[str, str] = {}
    backend = tmp_path / "skillcue-backend.exe"
    backend.write_bytes(b"")

    def launch(*_args, **kwargs):
        captured_env.update(kwargs["env"])
        raise OSError("stop after environment capture")

    monkeypatch.setenv("OPENAI_API_KEY", "installed-openai")
    monkeypatch.setenv("OPENROUTER_API_KEY", "installed-openrouter")
    monkeypatch.setenv("PYTHON_KEYRING_BACKEND", "installed.backend")
    monkeypatch.setattr(acceptance_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        acceptance_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(acceptance_module.subprocess, "Popen", launch)
    monkeypatch.setattr(
        acceptance_module, "_installed_backend_path", lambda _channel="dev": backend
    )

    with pytest.raises(OSError, match="environment capture"):
        InstalledBackendSession(source_backend=False, channel="alpha").__enter__()

    assert captured_env["OPENAI_API_KEY"] == "installed-openai"
    assert captured_env["OPENROUTER_API_KEY"] == "installed-openrouter"
    assert captured_env["PYTHON_KEYRING_BACKEND"] == "installed.backend"
    assert captured_env["SKILLCUE_BUILD_CHANNEL"] == "alpha"


def test_voice_request_uses_managed_openrouter_auto_route_without_model_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_payload: dict = {}

    def stream(request, *, timeout_s):
        del timeout_s
        captured_payload.update(json.loads(request.data.decode("utf-8")))
        return "answer", 100, 200, {"type": "done"}

    monkeypatch.setattr(acceptance_module, "_stream_sse", stream)

    ask_interview(
        8123,
        "local-token",
        "Что такое Docker?",
        {"mode": "fast", "answerLanguage": "ru", "model": "must-not-override-auto"},
    )

    assert captured_payload["provider"] == "openrouter"
    assert "model" not in captured_payload


def test_report_sanitizes_untrusted_diagnostics_and_bounds_stt_timeline() -> None:
    unsafe_path = r"C:\Users\person\private-transcript.txt"
    attempts = [
        {
            "caseId": "safe-case",
            "kind": "voice",
            "repetition": 1,
            "passed": True,
            "sourceHash": "sha256:abc123",
            "matchedTranscriptKeys": ["docker"],
            "matchedAnswerKeys": ["container"],
            "sttMs": math.nan,
            "firstChunkMs": True,
            "triggerToFirstAnswerMs": 2100,
            "totalMs": -1,
            "model": unsafe_path,
            "sttModel": "sk-private-secret",
            "sttInferenceMs": unsafe_path,
            "fragmentCount": 2,
            "fragmentArrivalMs": [100, unsafe_path, -1],
            "fragmentForced": [True, False, unsafe_path],
            "sttEventTimeline": [
                {
                    "type": "transcript",
                    "arrivalMs": 100,
                    "forced": True,
                    "reason": "PRIVATE TRANSCRIPT REASON",
                    "raw": unsafe_path,
                },
                {
                    "type": "PRIVATE TRANSCRIPT EVENT",
                    "arrivalMs": unsafe_path,
                    "forced": unsafe_path,
                },
            ]
            + [
                {"type": "utterance_end", "arrivalMs": index, "forced": False}
                for index in range(100)
            ],
            "questionIntent": unsafe_path,
            "answerSource": "fast_core_default",
            "answerLatencyMs": float("inf"),
            "hedgeStarted": True,
            "hedgeWinner": "primary",
            "failures": [],
            "transcript": "PRIVATE TRANSCRIPT",
            "answer": "PRIVATE ANSWER",
            "raw": unsafe_path,
            "reason": "PRIVATE REASON",
        }
    ]

    report = build_privacy_safe_report("safe-suite", attempts)
    safe = report["attempts"][0]
    serialized = json.dumps(report, ensure_ascii=False)

    assert safe["model"] == _report_hash(unsafe_path)
    assert safe["sttModel"] == _report_hash("sk-private-secret")
    assert safe["modelVerified"] is False
    assert safe["sttMs"] is None
    assert safe["firstChunkMs"] is None
    assert safe["triggerToFirstAnswerMs"] == 2100
    assert safe["totalMs"] is None
    assert safe["sttInferenceMs"] is None
    assert safe["fragmentArrivalMs"] == [100, None, None]
    assert safe["fragmentForced"] == [True, False, False]
    assert safe["answerLatencyMs"] is None
    assert len(safe["sttEventTimeline"]) == 64
    assert all(
        set(event) == {"type", "arrivalMs", "forced"}
        for event in safe["sttEventTimeline"]
    )
    assert all(
        event["type"] in {"transcript", "utterance_end"}
        for event in safe["sttEventTimeline"]
    )
    for forbidden in (
        "PRIVATE TRANSCRIPT",
        "PRIVATE ANSWER",
        "PRIVATE REASON",
        "private-transcript.txt",
        "sk-private-secret",
        "reason",
        '"raw"',
    ):
        assert forbidden not in serialized


def test_report_rejects_unhashable_or_free_form_metadata_without_crashing() -> None:
    report = build_privacy_safe_report(
        "safe-suite",
        [
            {
                "caseId": ["PRIVATE"],
                "kind": ["voice"],
                "repetition": True,
                "passed": "yes",
                "sourceHash": {"PRIVATE": "PATH"},
                "matchedTranscriptKeys": [{"PRIVATE": "TRANSCRIPT"}],
                "matchedAnswerKeys": [],
                "model": ["PRIVATE MODEL"],
                "sttEventTimeline": [
                    {
                        "type": ["transcript"],
                        "arrivalMs": {"PRIVATE": "TIMING"},
                        "forced": "yes",
                    }
                ],
                "failures": [{"PRIVATE": "REASON"}],
            }
        ],
    )

    safe = report["attempts"][0]
    assert safe["caseId"] == "unknown"
    assert safe["kind"] == "unknown"
    assert safe["repetition"] is None
    assert safe["passed"] is False
    assert safe["sourceHash"] == "unknown"
    assert safe["matchedTranscriptKeys"] == []
    assert safe["model"] == "unknown"
    assert safe["sttEventTimeline"] == []
    assert safe["failures"] == []
    assert "PRIVATE" not in json.dumps(report)


def test_report_hashes_opaque_identifiers_and_enumerates_question_intent() -> None:
    opaque = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"
    expected_hash = _report_hash(opaque)
    report = build_privacy_safe_report(
        "opaque-suite",
        [
            {
                "caseId": opaque,
                "kind": "voice",
                "repetition": 1,
                "passed": True,
                "sourceHash": "sha256:abc123",
                "matchedTranscriptKeys": [opaque],
                "matchedAnswerKeys": [opaque],
                "model": opaque,
                "sttModel": opaque,
                "questionIntent": opaque,
                "answerSource": opaque,
                "hedgeWinner": opaque,
                "failures": [],
            }
        ],
    )

    safe = report["attempts"][0]
    serialized = json.dumps(report)
    assert safe["caseId"] == expected_hash
    assert safe["matchedTranscriptKeys"] == [expected_hash]
    assert safe["matchedAnswerKeys"] == [expected_hash]
    assert safe["model"] == expected_hash
    assert safe["sttModel"] == expected_hash
    assert safe["questionIntent"] == "unknown"
    assert safe["answerSource"] == "unknown"
    assert safe["hedgeWinner"] == "unknown"
    assert opaque not in serialized


def test_report_preserves_only_enumerated_safe_diagnostic_values() -> None:
    report = build_privacy_safe_report(
        "safe-suite",
        [
            {
                "caseId": "case-one",
                "kind": "voice",
                "repetition": 1,
                "passed": True,
                "sourceHash": "sha256:abc123",
                "matchedTranscriptKeys": [],
                "matchedAnswerKeys": [],
                "model": "qwen/qwen3.5-flash-02-23",
                "sttModel": "gpt-4o-mini-transcribe",
                "questionIntent": "technical_definition",
                "answerSource": "fast_core_latency_hedge",
                "hedgeWinner": "primary",
                "failures": [],
            }
        ],
    )

    safe = report["attempts"][0]
    assert safe["model"] == "qwen/qwen3.5-flash-02-23"
    assert safe["sttModel"] == "gpt-4o-mini-transcribe"
    assert safe["questionIntent"] == "technical_definition"
    assert safe["answerSource"] == "fast_core_latency_hedge"
    assert safe["hedgeWinner"] == "primary"


def test_manifest_bounds_case_count_and_repetitions(tmp_path: Path) -> None:
    source = tmp_path / "question.wav"
    source.write_bytes(b"private-audio")
    cases = []
    for index in range(65):
        case = _voice_case(source)
        case["id"] = f"case-{index}"
        cases.append(case)

    with pytest.raises(ManifestError, match="at most 64 cases"):
        validate_manifest({"version": 1, "cases": cases}, tmp_path)

    case = _voice_case(source)
    case["repetitions"] = 11
    with pytest.raises(ManifestError, match="at most 10 repetitions"):
        validate_manifest({"version": 1, "cases": [case]}, tmp_path)


def test_suite_repetition_override_cannot_bypass_manifest_bound(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "question.wav"
    source.write_bytes(b"private-audio")
    manifest = validate_manifest(
        {"version": 1, "cases": [_voice_case(source)]}, tmp_path
    )

    class NeverLaunchSession:
        def __init__(self, **_kwargs) -> None:
            pass

        def __enter__(self):
            raise AssertionError(
                "backend must not launch for an invalid repetition bound"
            )

        def __exit__(self, *_args) -> None:
            pass

    monkeypatch.setattr(
        acceptance_module, "InstalledBackendSession", NeverLaunchSession
    )

    with pytest.raises(ManifestError, match="at most 10 repetitions"):
        run_acceptance_suite(manifest, repetitions_override=11)


def test_report_bounds_attempt_rows_but_keeps_honest_total_and_omitted_counts() -> None:
    attempts = [
        {
            "caseId": f"case-{index}",
            "kind": "voice",
            "repetition": 1,
            "passed": index % 10 != 0,
            "sourceHash": "sha256:abc123",
            "matchedTranscriptKeys": [],
            "matchedAnswerKeys": [],
            "model": "qwen/qwen3.5-flash-02-23",
            "failures": [] if index % 10 else ["answer_semantics"],
            "triggerToFirstAnswerMs": 2000 + index,
        }
        for index in range(300)
    ]

    report = build_privacy_safe_report("bounded-suite", attempts)

    assert len(report["attempts"]) == 256
    assert report["summary"]["attempts"] == 300
    assert report["summary"]["failedAttempts"] == 30
    assert report["summary"]["reportedAttempts"] == 256
    assert report["summary"]["omittedAttempts"] == 44
