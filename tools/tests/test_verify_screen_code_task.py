from __future__ import annotations

import ast
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

import tools.verify_screen_code_task as screen_module
from tools import backend_process
from tools.verify_screen_code_task import (
    ScreenRequestFailure,
    _has_protected_name_rebinding,
    build_privacy_safe_regression_report,
    load_real_interview_scenarios,
    run_real_interview_regressions,
    score_multiscroll_gitlab_answer,
    score_route_checklist_refinement,
    score_simple_order_sql_answer,
)


def test_report_preserves_bounded_runtime_failure_diagnostics() -> None:
    report = build_privacy_safe_regression_report(
        [
            {
                "case_id": "multiscroll-gitlab-cicd",
                "repetition": 1,
                "model": "openai/gpt-4o-mini",
                "transport_first_byte_ms": 12,
                "model_first_chunk_ms": None,
                "total_ms": 34,
                "semantic_checks": {},
                "failure_codes": ["rate_limited"],
                "failure_stage": "initial_request",
                "retry_count": 1,
            }
        ]
    )

    assert report["attempts"][0]["failureStage"] == "initial_request"
    assert report["attempts"][0]["retryCount"] == 1
    assert report["attempts"][0]["initialSemanticChecks"] == {}


def test_screen_request_failure_never_copies_raw_sse_message() -> None:
    failure = ScreenRequestFailure.from_sse_event(
        {
            "type": "error",
            "code": "rate_limited",
            "status": 429,
            "model": "openai/gpt-4o-mini",
            "message": "C:/Users/private/raw body",
        },
        stage="initial_request",
        transport_first_byte_ms=10,
        model_first_chunk_ms=None,
        total_ms=20,
        visible_content_started=False,
    )

    assert failure.code == "rate_limited"
    assert failure.model == "openai/gpt-4o-mini"
    assert "private" not in str(failure).casefold()


def test_screen_request_failure_normalizes_an_unsafe_sse_model_identifier() -> None:
    failure = ScreenRequestFailure.from_sse_event(
        {
            "type": "error",
            "code": "rate_limited",
            "status": "429",
            "model": "C:/Users/private/model",
            "message": "RAW",
        },
        stage="initial_request",
        transport_first_byte_ms=10,
        model_first_chunk_ms=None,
        total_ms=20,
        visible_content_started=False,
    )

    assert failure.model == "unknown"
    assert failure.code == "rate_limited"


@pytest.mark.parametrize(
    ("raw_code", "expected_code"),
    [
        ("token_quota_exceeded", "quota_exceeded"),
        ("invalid_license", "auth_failed"),
        ("model_unavailable", "provider_error"),
    ],
)
def test_screen_request_failure_maps_managed_gateway_codes(
    raw_code: str,
    expected_code: str,
) -> None:
    failure = ScreenRequestFailure.from_sse_event(
        {
            "type": "error",
            "code": raw_code,
            "model": "safe/model",
            "message": "PRIVATE",
        },
        stage="initial_request",
        transport_first_byte_ms=1,
        model_first_chunk_ms=None,
        total_ms=2,
        visible_content_started=False,
    )

    assert failure.code == expected_code
    assert failure.model == "safe/model"


@pytest.mark.parametrize(
    "raw_code",
    [
        "invalid_screen_observation",
        "invalid_screen_answer",
        "unsupported_screen_python_profile",
        "invalid_screen_task_state",
        "invalid_screen_task_action",
        "screen_task_state_expired",
    ],
)
def test_screen_request_failure_preserves_allowlisted_typed_pipeline_code(
    raw_code: str,
) -> None:
    failure = ScreenRequestFailure.from_sse_event(
        {
            "type": "error",
            "code": raw_code,
            "model": "safe/model",
            "message": "untrusted provider detail",
        },
        stage="initial_request",
        transport_first_byte_ms=1,
        model_first_chunk_ms=None,
        total_ms=2,
        visible_content_started=False,
    )

    assert failure.code == raw_code


@pytest.mark.parametrize(
    "failure_code",
    [
        "invalid_screen_observation",
        "invalid_screen_answer",
        "unsupported_screen_python_profile",
        "invalid_screen_task_state",
        "invalid_screen_task_action",
        "screen_task_state_expired",
    ],
)
def test_regression_report_accepts_allowlisted_typed_pipeline_failure_code(
    failure_code: str,
) -> None:
    failure = ScreenRequestFailure(
        code=failure_code,
        stage="initial_request",
        model="safe/model",
        transport_first_byte_ms=1,
        model_first_chunk_ms=None,
        total_ms=2,
        visible_content_started=False,
    )

    report = build_privacy_safe_regression_report(
        [
            screen_module._failure_attempt(
                case_id="simple-order-sql-refinement",
                repetition=1,
                failure=failure,
            )
        ]
    )

    assert report["attempts"][0]["failureCodes"] == [failure_code]


@pytest.mark.parametrize(
    "raw_code",
    [
        "future_unreviewed_screen_failure",
        {"unexpected": "object"},
        ["unexpected", "array"],
    ],
)
def test_screen_request_failure_collapses_unknown_pipeline_code(
    raw_code: object,
) -> None:
    failure = ScreenRequestFailure.from_sse_event(
        {
            "type": "error",
            "code": raw_code,
            "model": "safe/model",
        },
        stage="initial_request",
        transport_first_byte_ms=1,
        model_first_chunk_ms=None,
        total_ms=2,
        visible_content_started=False,
    )

    assert failure.code == "request_failed"


def test_typed_screen_failure_report_never_serializes_untrusted_sse_fields() -> None:
    private_values = (
        "PRIVATE_MESSAGE_7E7E",
        "C:/Users/private/screen.png",
        "PRIVATE_ANSWER_8F8F",
        "PRIVATE_TASK_STATE_9A9A",
        "PRIVATE_STATE_A0A0",
    )
    failure = ScreenRequestFailure.from_sse_event(
        {
            "type": "error",
            "code": "invalid_screen_answer",
            "model": "safe/model",
            "message": private_values[0],
            "path": private_values[1],
            "answer": private_values[2],
            "task_state": private_values[3],
            "state": {"raw": private_values[4]},
        },
        stage="initial_request",
        transport_first_byte_ms=1,
        model_first_chunk_ms=None,
        total_ms=2,
        visible_content_started=False,
    )
    report = build_privacy_safe_regression_report(
        [
            screen_module._failure_attempt(
                case_id="simple-order-sql-refinement",
                repetition=1,
                failure=failure,
            )
        ]
    )
    serialized = json.dumps(report, ensure_ascii=False)

    assert all(value not in serialized for value in private_values)


@pytest.mark.parametrize(
    ("lines", "expected_code"),
    [
        ([], "missing_done"),
        ([b"data: {not-json}\n"], "malformed_protocol"),
    ],
)
def test_request_screen_classifies_protocol_failure_without_response_text(
    monkeypatch: pytest.MonkeyPatch,
    lines: list[bytes],
    expected_code: str,
) -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def __iter__(self):
            return iter(lines)

    monkeypatch.setattr(
        screen_module.urllib.request, "urlopen", lambda *_args, **_kwargs: Response()
    )

    with pytest.raises(ScreenRequestFailure) as raised:
        screen_module._request_screen(
            8123, "not-persisted", {"image": "data:image/png;base64,AA"}
        )

    assert raised.value.code == expected_code
    assert raised.value.total_ms is not None
    assert "json" not in str(raised.value).casefold()


def test_request_screen_rejects_unknown_event_type_as_malformed_protocol(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def __iter__(self):
            return iter([b'data: {"type":"surprise","secret":"C:/Users/private"}\n'])

    monkeypatch.setattr(
        screen_module.urllib.request, "urlopen", lambda *_args, **_kwargs: Response()
    )

    with pytest.raises(ScreenRequestFailure) as raised:
        screen_module._request_screen(
            8123, "not-persisted", {"image": "data:image/png;base64,AA"}
        )

    assert raised.value.code == "malformed_protocol"
    assert "private" not in str(raised.value).casefold()


def test_request_screen_keeps_typed_state_in_memory_for_structured_continuation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_state = json.dumps(
        {
            "version": 1,
            "frames": [{"sensitive": "PRIVATE FRAME TEXT"}, {}],
            "ledger": [
                {"finding": {"active": True, "claim": "PRIVATE PRIOR CLAIM"}},
                {"finding": {"active": False, "claim": "PRIVATE OLD CLAIM"}},
                {"finding": {"active": True, "claim": "PRIVATE CURRENT CLAIM"}},
            ],
            "source_ledger": [
                {"source": {"active": True, "text": "PRIVATE SOURCE"}},
                {"source": {"active": False, "text": "PRIVATE OLD SOURCE"}},
            ],
        }
    )

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def __iter__(self):
            return iter(
                [
                    b'data: {"type":"chunk","text":"answer"}\n',
                    (
                        "data: "
                        + json.dumps(
                            {
                                "type": "done",
                                "model": "safe/model",
                                "task_state": task_state,
                            }
                        )
                        + "\n"
                    ).encode(),
                ]
            )

    monkeypatch.setattr(
        screen_module.urllib.request, "urlopen", lambda *_args, **_kwargs: Response()
    )

    answer, done = screen_module._request_screen(
        8123,
        "not-persisted",
        {
            "image": "data:image/png;base64,AA",
            "structuredScreen": True,
            "taskAction": "new",
        },
    )

    assert answer == "answer"
    assert done["_task_state"] == task_state
    assert done["_typed_state_diagnostics"] == {
        "observationAccepted": True,
        "frameCount": 2,
        "activeFindingCount": 2,
        "activeSourceCount": 1,
        "generationCompleted": True,
    }
    assert "PRIVATE" not in json.dumps(done["_typed_state_diagnostics"])


def test_request_screen_rejects_structured_done_without_typed_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def __iter__(self):
            return iter([b'data: {"type":"done","model":"safe/model"}\n'])

    monkeypatch.setattr(
        screen_module.urllib.request, "urlopen", lambda *_args, **_kwargs: Response()
    )

    with pytest.raises(ScreenRequestFailure) as raised:
        screen_module._request_screen(
            8123,
            "not-persisted",
            {
                "image": "data:image/png;base64,AA",
                "structuredScreen": True,
                "taskAction": "new",
            },
        )

    assert raised.value.code == "malformed_protocol"


def test_empty_chunk_does_not_mark_a_following_error_as_visible_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def __iter__(self):
            return iter(
                [
                    b'data: {"type":"chunk","text":""}\n',
                    b'data: {"type":"error","code":"rate_limited","model":"safe/model","message":"RAW"}\n',
                ]
            )

    monkeypatch.setattr(
        screen_module.urllib.request, "urlopen", lambda *_args, **_kwargs: Response()
    )

    with pytest.raises(ScreenRequestFailure) as raised:
        screen_module._request_screen(
            8123, "not-persisted", {"image": "data:image/png;base64,AA"}
        )

    assert raised.value.code == "rate_limited"
    assert raised.value.visible_content_started is False


def test_request_serialization_failure_is_reduced_to_a_safe_request_failure() -> None:
    with pytest.raises(ScreenRequestFailure) as raised:
        screen_module._request_screen(8123, "not-persisted", {"image": object()})

    assert raised.value.code == "request_failed"
    assert "object" not in str(raised.value).casefold()


@pytest.mark.parametrize(
    ("status", "expected_code"),
    [
        (401, "auth_failed"),
        (402, "quota_exceeded"),
        (429, "rate_limited"),
        (503, "provider_timeout"),
    ],
)
def test_request_screen_classifies_http_status_without_reading_body(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    expected_code: str,
) -> None:
    error = screen_module.urllib.error.HTTPError(
        "http://127.0.0.1:8123/chat/screen/stream", status, "PRIVATE BODY", {}, None
    )
    monkeypatch.setattr(
        screen_module.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )

    with pytest.raises(ScreenRequestFailure) as raised:
        screen_module._request_screen(
            8123, "not-persisted", {"image": "data:image/png;base64,AA"}
        )

    assert raised.value.code == expected_code
    assert "private" not in str(raised.value).casefold()


def test_initial_request_retries_once_with_injected_delay_and_keeps_incident_visible() -> (
    None
):
    calls: list[dict] = []
    delays: list[float] = []

    def request(_port: int, _token: str, payload: dict):
        calls.append(payload)
        if len(calls) == 1:
            raise ScreenRequestFailure(
                "rate_limited",
                "initial_request",
                "openai/gpt-4o-mini",
                10,
                None,
                20,
                False,
            )
        return "not scored", {
            "model": "openai/gpt-4o-mini",
            "_e2e_transport_first_byte_ms": 10,
            "_e2e_first_chunk_ms": 20,
            "_e2e_total_ms": 30,
        }

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=lambda case, frame: f"{case}:{frame}".encode(),
        sleep=delays.append,
    )

    assert len(delays) == 1
    assert delays[0] >= 2.0
    assert calls[0] == calls[1]
    assert calls[2]["prior_solution_summary"] == "not scored"
    assert attempts[0]["failure_codes"] == ["semantic_gate", "rate_limited"]
    assert attempts[0]["failure_stage"] == "initial_request"
    assert attempts[0]["retry_count"] == 1


def test_refinement_retry_reuses_first_answer_without_repeating_initial_request() -> (
    None
):
    calls: list[dict] = []
    delays: list[float] = []

    def request(_port: int, _token: str, payload: dict):
        calls.append(payload)
        if len(calls) == 2:
            raise ScreenRequestFailure(
                "provider_timeout",
                "refinement_request",
                "openai/gpt-4o-mini",
                10,
                None,
                20,
                False,
            )
        return "not scored", {
            "model": "openai/gpt-4o-mini",
            "_e2e_transport_first_byte_ms": 10,
            "_e2e_first_chunk_ms": 20,
            "_e2e_total_ms": 30,
        }

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=lambda case, frame: f"{case}:{frame}".encode(),
        sleep=delays.append,
    )

    assert delays == [0.2]
    assert calls[1] == calls[2]
    assert "prior_solution_summary" not in calls[0]
    assert attempts[0]["failure_codes"] == ["semantic_gate", "provider_timeout"]
    assert attempts[0]["failure_stage"] == "refinement_request"


def test_scenario_uses_one_retry_budget_and_keeps_recovered_plus_terminal_failure() -> (
    None
):
    calls: list[dict] = []
    delays: list[float] = []

    def render(case_id: str, frame_index: int) -> bytes:
        if case_id != "multiscroll-gitlab-cicd":
            raise RuntimeError("C:/Users/private/frame.png")
        return f"{case_id}:{frame_index}".encode()

    def request(_port: int, _token: str, payload: dict):
        calls.append(payload)
        if len(calls) == 1:
            raise ScreenRequestFailure(
                "rate_limited", "initial_request", "safe/model", 1, None, 2, False
            )
        if len(calls) == 3:
            raise ScreenRequestFailure(
                "provider_timeout",
                "refinement_request",
                "safe/model",
                3,
                None,
                4,
                False,
            )
        return "first answer", {
            "model": "safe/model",
            "_e2e_transport_first_byte_ms": 1,
            "_e2e_first_chunk_ms": 2,
            "_e2e_total_ms": 3,
        }

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=render,
        sleep=delays.append,
    )

    assert len(calls) == 3
    assert delays == [2.0]
    assert attempts[0]["failure_codes"] == ["rate_limited", "provider_timeout"]
    assert attempts[0]["failure_stage"] == "refinement_request"
    assert attempts[0]["retry_count"] == 1


def test_scorer_failure_preserves_a_recovered_runtime_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def render(case_id: str, frame_index: int) -> bytes:
        if case_id != "multiscroll-gitlab-cicd":
            raise RuntimeError("C:/Users/private/frame.png")
        return f"{case_id}:{frame_index}".encode()

    def request(_port: int, _token: str, _payload: dict):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ScreenRequestFailure(
                "rate_limited", "initial_request", "safe/model", 1, None, 2, False
            )
        return "answer", {
            "model": "safe/model",
            "_e2e_transport_first_byte_ms": 1,
            "_e2e_first_chunk_ms": 2,
            "_e2e_total_ms": 3,
        }

    monkeypatch.setattr(
        screen_module,
        "score_multiscroll_gitlab_answer",
        lambda _answer: (_ for _ in ()).throw(
            RuntimeError("C:/Users/private/raw-answer")
        ),
    )
    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=render,
        sleep=lambda _delay: None,
    )

    assert calls == 3
    assert attempts[0]["failure_codes"] == ["rate_limited", "scorer_failed"]
    assert attempts[0]["failure_stage"] == "scorer"
    assert attempts[0]["retry_count"] == 1
    assert "private" not in str(attempts[0]).casefold()


def test_second_frame_render_failure_preserves_recovered_incident_without_private_path() -> (
    None
):
    calls = 0

    def render(case_id: str, frame_index: int) -> bytes:
        if case_id == "multiscroll-gitlab-cicd" and frame_index == 1:
            raise RuntimeError("C:/Users/private/second-frame.png")
        if case_id != "multiscroll-gitlab-cicd":
            raise RuntimeError("C:/Users/private/other-frame.png")
        return b"first-frame"

    def request(_port: int, _token: str, _payload: dict):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ScreenRequestFailure(
                "rate_limited", "initial_request", "safe/model", 1, None, 2, False
            )
        return "first answer", {
            "model": "safe/model",
            "_e2e_transport_first_byte_ms": 1,
            "_e2e_first_chunk_ms": 2,
            "_e2e_total_ms": 3,
        }

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=render,
        sleep=lambda _delay: None,
    )

    assert calls == 2
    assert attempts[0]["failure_codes"] == ["rate_limited", "render_failed"]
    assert attempts[0]["failure_stage"] == "render"
    assert attempts[0]["retry_count"] == 1
    assert "private" not in str(attempts[0]).casefold()


def test_two_terminal_transients_open_circuit_without_additional_requests() -> None:
    calls = 0

    def request(_port: int, _token: str, _payload: dict):
        nonlocal calls
        calls += 1
        raise ScreenRequestFailure(
            "provider_timeout", "initial_request", "unknown", 10, None, 20, False
        )

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=lambda case, frame: f"{case}:{frame}".encode(),
        sleep=lambda _delay: None,
    )

    assert calls == 4
    assert [attempt["failure_codes"] for attempt in attempts] == [
        ["provider_timeout"],
        ["provider_timeout"],
        ["circuit_open"],
    ]
    assert attempts[2]["failure_stage"] == "circuit"


@pytest.mark.parametrize(
    "code",
    (
        "auth_failed",
        "quota_exceeded",
        "provider_output_truncated",
        "malformed_protocol",
    ),
)
def test_non_transient_screen_failures_are_not_retried(code: str) -> None:
    calls = 0

    def request(_port: int, _token: str, _payload: dict):
        nonlocal calls
        calls += 1
        raise ScreenRequestFailure(
            code, "initial_request", "unknown", 1, None, 2, False
        )

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=lambda case, frame: f"{case}:{frame}".encode(),
        sleep=lambda _delay: pytest.fail("non-transient failure must not sleep"),
    )

    assert calls == 3
    assert [attempt["failure_codes"] for attempt in attempts] == [
        [code],
        [code],
        [code],
    ]


def test_visible_content_transient_is_not_retried() -> None:
    calls = 0

    def request(_port: int, _token: str, _payload: dict):
        nonlocal calls
        calls += 1
        raise ScreenRequestFailure(
            "provider_timeout", "initial_request", "unknown", 1, 2, 3, True
        )

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-persisted",
        repetitions=1,
        request_screen=request,
        render_frame=lambda case, frame: f"{case}:{frame}".encode(),
        sleep=lambda _delay: pytest.fail("post-chunk failure must not sleep"),
    )

    assert calls == 2
    assert attempts[-1]["failure_codes"] == ["circuit_open"]


def test_screen_cleanup_removes_sqlite_companions_without_raising(
    tmp_path: Path,
) -> None:
    database = tmp_path / "screen.sqlite"
    for target in (database, Path(f"{database}-wal"), Path(f"{database}-shm")):
        target.write_bytes(b"fixture")

    screen_module._cleanup_screen_backend(None, None, database)

    assert not any(
        target.exists()
        for target in (database, Path(f"{database}-wal"), Path(f"{database}-shm"))
    )


def test_screen_launch_failure_still_runs_safe_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(screen_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        screen_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        screen_module.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("PRIVATE launch path")),
    )
    monkeypatch.setattr(
        screen_module,
        "_cleanup_screen_backend",
        lambda _process, _tree, _path: calls.append("cleanup"),
    )
    monkeypatch.setattr(sys, "argv", ["verify_screen_code_task.py", "--source-backend"])

    with pytest.raises(OSError, match="PRIVATE launch path"):
        screen_module.main()

    assert calls == ["cleanup"]


def test_source_backend_launch_uses_only_managed_gateway_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_env: dict[str, str] = {}

    def launch(*_args, **kwargs):
        captured_env.update(kwargs["env"])
        raise OSError("stop after environment capture")

    monkeypatch.setenv("OPENROUTER_API_KEY", "must-not-reach-source-backend")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-source-backend")
    monkeypatch.setenv("PYTHON_KEYRING_BACKEND", "inherited.backend.MustNotBeUsed")
    monkeypatch.setenv("SKILLCUE_GATEWAY_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setattr(screen_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        screen_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(screen_module.subprocess, "Popen", launch)
    monkeypatch.setattr(screen_module, "_cleanup_screen_backend", lambda *_args: None)
    monkeypatch.setattr(sys, "argv", ["verify_screen_code_task.py", "--source-backend"])

    with pytest.raises(OSError, match="environment capture"):
        screen_module.main()

    assert captured_env["PYTHON_KEYRING_BACKEND"] == "keyring.backends.null.Keyring"
    assert captured_env["SKILLCUE_GATEWAY_URL"] == "https://skill-cue.ru/v1"
    assert captured_env["OPENROUTER_API_KEY"] == ""
    assert captured_env["OPENAI_API_KEY"] == ""


def test_source_backend_direct_openai_keeps_only_in_memory_openai_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_env: dict[str, str] = {}

    def launch(*_args, **kwargs):
        captured_env.update(kwargs["env"])
        raise OSError("stop after environment capture")

    monkeypatch.setenv("OPENROUTER_API_KEY", "must-not-reach-source-backend")
    monkeypatch.setenv("OPENAI_API_KEY", "direct-key-stays-in-memory")
    monkeypatch.setenv("PYTHON_KEYRING_BACKEND", "inherited.backend.MustNotBeUsed")
    monkeypatch.setenv("SKILLCUE_GATEWAY_URL", "https://skill-cue.ru/v1")
    monkeypatch.setattr(screen_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        screen_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(screen_module.subprocess, "Popen", launch)
    monkeypatch.setattr(screen_module, "_cleanup_screen_backend", lambda *_args: None)
    monkeypatch.setattr(
        sys,
        "argv",
        ["verify_screen_code_task.py", "--source-backend", "--provider", "openai"],
    )

    with pytest.raises(OSError, match="environment capture"):
        screen_module.main()

    assert captured_env["PYTHON_KEYRING_BACKEND"] == "keyring.backends.null.Keyring"
    assert captured_env["SKILLCUE_GATEWAY_URL"] == ""
    assert captured_env["OPENROUTER_API_KEY"] == ""
    assert captured_env["OPENAI_API_KEY"] == "direct-key-stays-in-memory"


def test_main_forwards_model_override_to_real_interview_regressions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured_call: dict = {}

    class Process:
        pid = 123

    def run_regressions(**kwargs):
        captured_call.update(kwargs)
        return []

    monkeypatch.setattr(screen_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        screen_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        screen_module.subprocess, "Popen", lambda *_args, **_kwargs: Process()
    )
    monkeypatch.setattr(
        screen_module.OwnedProcessTree,
        "capture",
        classmethod(lambda _cls, _pid: None),
    )
    monkeypatch.setattr(screen_module, "_wait_for_health", lambda _port: None)
    monkeypatch.setattr(screen_module, "_cleanup_screen_backend", lambda *_args: None)
    monkeypatch.setattr(
        screen_module, "run_real_interview_regressions", run_regressions
    )
    monkeypatch.setattr(
        screen_module,
        "build_privacy_safe_regression_report",
        lambda _attempts: {
            "summary": {"passed": True, "attempts": 0, "failedAttempts": 0},
            "attempts": [],
        },
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_screen_code_task.py",
            "--source-backend",
            "--real-interview-regressions",
            "--model",
            "qwen/qwen3.5-flash",
            "--provider",
            "openai",
            "--report",
            str(tmp_path / "report.json"),
        ],
    )

    assert screen_module.main() == 0
    assert captured_call["model_override"] == "qwen/qwen3.5-flash"
    assert captured_call["provider_override"] == "openai"


def test_main_forwards_provider_to_one_shot_screen_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_payload: dict = {}

    class Process:
        pid = 123

    monkeypatch.setattr(screen_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        screen_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        screen_module.subprocess, "Popen", lambda *_args, **_kwargs: Process()
    )
    monkeypatch.setattr(
        screen_module.OwnedProcessTree,
        "capture",
        classmethod(lambda _cls, _pid: None),
    )
    monkeypatch.setattr(screen_module, "_wait_for_health", lambda _port: None)
    monkeypatch.setattr(screen_module, "_cleanup_screen_backend", lambda *_args: None)
    monkeypatch.setattr(screen_module, "render_code_png", lambda: b"png")

    def request(_port: int, _token: str, payload: dict):
        captured_payload.update(payload)
        return "False, затем TypeError: строки неизменяемы.", {
            "model": "openai/gpt-5.6-sol"
        }

    monkeypatch.setattr(screen_module, "_request_screen", request)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_screen_code_task.py",
            "--source-backend",
            "--provider",
            "openai",
            "--model",
            "openai/gpt-5.6-sol",
        ],
    )

    assert screen_module.main() == 0
    assert captured_payload["provider"] == "openai"
    assert captured_payload["modelOverride"] == "openai/gpt-5.6-sol"


def test_screen_cleanup_failure_does_not_mask_primary_verifier_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Process:
        pid = 0

    monkeypatch.setattr(screen_module, "_free_port", lambda: 8123)
    monkeypatch.setattr(
        screen_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        screen_module.subprocess, "Popen", lambda *_args, **_kwargs: Process()
    )
    monkeypatch.setattr(
        screen_module.OwnedProcessTree,
        "capture",
        classmethod(lambda _cls, _pid: None),
    )
    monkeypatch.setattr(
        screen_module,
        "_wait_for_health",
        lambda _port: (_ for _ in ()).throw(RuntimeError("primary failure")),
    )
    monkeypatch.setattr(
        screen_module,
        "_cleanup_screen_backend",
        lambda *_args: (_ for _ in ()).throw(OSError("cleanup failure")),
    )
    monkeypatch.setattr(sys, "argv", ["verify_screen_code_task.py", "--source-backend"])
    with pytest.raises(RuntimeError, match="primary failure"):
        screen_module.main()


def test_owned_process_cleanup_rechecks_creation_identity_in_one_windows_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = backend_process._WindowsProcessSnapshot(10, 0, 100)
    child = backend_process._WindowsProcessSnapshot(11, 10, 101)
    commands: list[list[str]] = []

    class Process:
        def poll(self):
            return 0

        def wait(self, timeout=None):
            return 0

    class Tree:
        def current_processes(self):
            return [root, child]

    monkeypatch.setattr(backend_process, "_windows_process_snapshot", dict)
    monkeypatch.setattr(
        backend_process.subprocess,
        "run",
        lambda command, **_kwargs: commands.append(command),
    )

    backend_process.terminate_owned_process_tree(Process(), Tree())

    script = commands[0][-1]
    assert script.index("pid=11;ticks=101") < script.index("pid=10;ticks=100")
    assert "CreationDate.ToUniversalTime().Ticks" in script
    assert "Stop-Process -Id $target.pid" in script


def test_owned_process_cleanup_uses_kill_after_wait_timeout() -> None:
    class Process:
        terminated = 0
        killed = 0
        waits = 0

        def poll(self):
            return None

        def terminate(self):
            self.terminated += 1

        def wait(self, timeout=None):
            self.waits += 1
            if self.waits == 1:
                raise backend_process.subprocess.TimeoutExpired("backend", timeout)
            return 0

        def kill(self):
            self.killed += 1

    process = Process()
    backend_process.terminate_owned_process_tree(process, None)

    assert process.terminated == 1
    assert process.killed == 1
    assert process.waits == 2


def test_owned_process_cleanup_ignores_an_already_exited_launcher() -> None:
    class Process:
        def poll(self):
            return 0

        def terminate(self):
            pytest.fail("already exited launcher must not be terminated")

        def wait(self, timeout=None):
            return 0

    backend_process.terminate_owned_process_tree(Process(), None)


def test_sqlite_artifact_cleanup_reports_permanent_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "screen.sqlite"
    database.write_bytes(b"fixture")
    monkeypatch.setattr(
        Path,
        "unlink",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(PermissionError()),
    )

    assert backend_process.remove_sqlite_artifacts(database, attempts=1) is False


def test_shared_scenarios_have_every_required_real_interview_sequence() -> None:
    scenarios = load_real_interview_scenarios()

    assert set(scenarios) == {
        "candidate-cold-start-active-speech",
        "duplicate-screen-command",
        "screen-first-answer-at-26000ms",
        "multiscroll-gitlab-cicd",
        "simple-order-sql-refinement",
        "route-checklist-novelty",
        "truncated-code-stream",
        "long-session-95m",
    }


def test_gitlab_scenario_explicitly_requests_platform_identification_without_answer_hint() -> (
    None
):
    scenario = load_real_interview_scenarios()["multiscroll-gitlab-cicd"]

    for question in scenario["questions"]:
        normalized = question.casefold()
        assert "платформ" in normalized
        assert "gitlab" not in normalized
        assert ".gitlab-ci" not in normalized


def test_shared_scenario_loader_rejects_missing_required_properties(
    tmp_path: Path,
) -> None:
    path = tmp_path / "scenarios.json"
    path.write_text(
        json.dumps(
            {"schemaVersion": 1, "scenarios": [{"id": "duplicate-screen-command"}]}
        ),
        "utf-8",
    )

    with pytest.raises(ValueError, match="missing required properties"):
        load_real_interview_scenarios(path)


def _scenario_document() -> dict:
    source = (
        Path(__file__).resolve().parents[2]
        / "tests"
        / "real-interview-overlay"
        / "scenarios.json"
    )
    return json.loads(source.read_text("utf-8"))


def _write_scenario_document(tmp_path: Path, document: dict) -> Path:
    path = tmp_path / "scenarios.json"
    path.write_text(json.dumps(document, ensure_ascii=False), "utf-8")
    return path


@pytest.mark.parametrize(
    ("scenario_id", "mutation"),
    [
        (
            "multiscroll-gitlab-cicd",
            lambda scenario: scenario.update(frames="C:/Users/private/screen.png"),
        ),
        (
            "multiscroll-gitlab-cicd",
            lambda scenario: scenario["viewport"].update(width=0),
        ),
        (
            "candidate-cold-start-active-speech",
            lambda scenario: scenario["timeline"][0].update(image="PRIVATEPIXELS"),
        ),
        (
            "simple-order-sql-refinement",
            lambda scenario: scenario["screenText"].append(
                "data:image/png;base64,PRIVATEPIXELS"
            ),
        ),
        (
            "simple-order-sql-refinement",
            lambda scenario: scenario["screenText"].append(
                "Источник: C:/Users/private/screen.png"
            ),
        ),
        (
            "route-checklist-novelty",
            lambda scenario: scenario.update(maximumBulletJaccard=1.2),
        ),
        (
            "long-session-95m",
            lambda scenario: scenario["budgets"].update(sttMs=True),
        ),
        (
            "duplicate-screen-command",
            lambda scenario: scenario.update(unexpected="not part of the schema"),
        ),
    ],
)
def test_shared_scenario_loader_rejects_unsafe_or_malformed_nested_data(
    tmp_path: Path,
    scenario_id: str,
    mutation,
) -> None:
    document = deepcopy(_scenario_document())
    scenario = next(item for item in document["scenarios"] if item["id"] == scenario_id)
    mutation(scenario)

    with pytest.raises(ValueError):
        load_real_interview_scenarios(_write_scenario_document(tmp_path, document))


def test_gitlab_sequence_scorer_accepts_cross_viewport_diagnosis() -> None:
    result = score_multiscroll_gitlab_answer(
        "Это .gitlab-ci.yml. В первом экране build_job только echo и ничего не собирает. "
        "На текущем экране regression_test_job тоже только печатает строку, а stage post "
        "не объявлен в stages; cleanup удаляет теги, но не очищает cache."
    )

    assert result["passed"] is True
    assert result["checks"] == {
        "gitlab_identified": True,
        "prior_frame_defect": True,
        "current_frame_defect": True,
        "not_github_actions": True,
    }


def test_gitlab_sequence_scorer_accepts_precise_natural_prior_defect_paraphrase() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. На текущем экране stage post не объявлен, "
        "regression_test_job только печатает строку, а удаление тегов не очищает cache. "
        "Остальные ранее найденные проблемы — отсутствие реальной сборки и artifacts — "
        "также сохраняются."
    )

    assert result["passed"] is True
    assert result["checks"]["prior_frame_defect"] is True


def test_gitlab_sequence_scorer_accepts_russian_negative_quantifier_paraphrase() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job ничего не собирает, только echo выводит текст. "
        "На текущем экране regression_test_job тоже только echo, а stage post не объявлен."
    )

    assert result["passed"] is True
    assert result["checks"]["prior_frame_defect"] is True


def test_gitlab_sequence_scorer_accepts_yaml_key_value_causal_prior_defect() -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. У build_job указан script: echo build, поэтому реальной "
        "сборки нет. Stage post не объявлен в stages."
    )

    assert result["passed"] is True
    assert result["checks"]["prior_frame_defect"] is True


def test_gitlab_sequence_scorer_accepts_direct_subject_missing_behavior_claim() -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job не выполняет видимую операцию сборки: "
        "единственная команда лишь печатает текст. Stage post не объявлен в stages."
    )

    assert result["passed"] is True
    assert result["checks"]["prior_frame_defect"] is True


def test_gitlab_sequence_scorer_accepts_typed_ledger_claim_before_yaml_evidence() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. Для build_job отсутствует реальная сборка — "
        "в script указан echo build. Stage post не объявлен в stages."
    )

    assert result["passed"] is True
    assert result["checks"]["prior_frame_defect"] is True


def test_gitlab_sequence_scorer_rejects_denied_typed_ledger_claim_before_evidence() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. Неверно, что для build_job отсутствует реальная сборка — "
        "после echo build создаётся артефакт. Stage post не объявлен в stages."
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


@pytest.mark.parametrize(
    "prior_finding",
    [
        (
            "Неверно, что build_job не выполняет видимую операцию сборки: "
            "ниже он создаёт артефакт."
        ),
        (
            "build_job выполняет полноценную сборку, а соседний deploy_job не выполняет "
            "операцию сборки."
        ),
    ],
)
def test_gitlab_sequence_scorer_rejects_denied_or_disconnected_direct_subject_claim(
    prior_finding: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        f"Это GitLab CI/CD. {prior_finding} Stage post не объявлен в stages."
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


@pytest.mark.parametrize(
    "prior_finding",
    [
        (
            "Неверно, что build_job использует script: echo build, поэтому реальной "
            "сборки нет: ниже выполняется полноценная сборка."
        ),
        (
            "Фраза «build_job использует script: echo build, поэтому реальной сборки "
            "нет» — чужой пример; здесь сборка выполняется."
        ),
        (
            "build_job выполняет полноценную сборку. В документации отдельно показан "
            "script: echo build."
        ),
    ],
)
def test_gitlab_sequence_scorer_rejects_denied_quoted_or_disconnected_yaml_prior(
    prior_finding: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        f"Это GitLab CI/CD. {prior_finding} Stage post не объявлен в stages."
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


@pytest.mark.parametrize(
    "current_finding",
    [
        (
            "У regression_test_job указан script: echo regression, поэтому "
            "регрессионные тесты не запускаются."
        ),
        "Stage: post не входит в объявленный список stages.",
        (
            "Команда post_cleanup_job удаляет теги, хотя комментарий обещает очистку cache."
        ),
    ],
)
def test_gitlab_sequence_scorer_accepts_coherent_yaml_current_defect_prose(
    current_finding: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. У build_job указан script: echo build, поэтому реальной "
        f"сборки нет. {current_finding}"
    )

    assert result["passed"] is True
    assert result["checks"]["prior_frame_defect"] is True
    assert result["checks"]["current_frame_defect"] is True


@pytest.mark.parametrize(
    "finding",
    [
        (
            "Неверно, что regression_test_job использует script: echo regression, "
            "поэтому регрессионные тесты не запускаются: job запускает pytest."
        ),
        (
            "Фраза «regression_test_job использует script: echo regression, поэтому "
            "регрессионные тесты не запускаются» — чужой пример; здесь запускается pytest."
        ),
        (
            "regression_test_job запускает pytest. В документации отдельно показан "
            "script: echo regression."
        ),
        "Stage: post не входит в stages? Нет, он входит и объявлен ниже.",
        (
            "Неверно, что post_cleanup_job удаляет теги, хотя комментарий обещает "
            "очистку cache: cache тоже очищается."
        ),
        (
            "post_cleanup_job очищает cache. Другая команда удаляет теги, а комментарий "
            "описывает её назначение."
        ),
    ],
)
def test_gitlab_sequence_scorer_rejects_denied_quoted_or_disconnected_yaml_prose(
    finding: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        f"Это GitLab CI/CD. build_job ничего не собирает, только echo выводит текст. {finding}"
    )

    assert result["passed"] is False
    assert result["checks"]["current_frame_defect"] is False


@pytest.mark.parametrize(
    "answer",
    [
        (
            "Это GitLab CI/CD. Неверно, что build_job ничего не собирает: он создаёт "
            "артефакт, а echo пишет лог. На текущем экране stage post не объявлен."
        ),
        (
            "Это GitLab CI/CD. Фраза «build_job ничего не собирает» — чужой пример, "
            "а здесь job создаёт артефакт. На текущем экране stage post не объявлен."
        ),
        (
            "Это GitLab CI/CD. В вопросе написано: «build_job ничего не собирает», "
            "но это неверно — он собирает артефакт. На текущем экране stage post "
            "не объявлен."
        ),
        (
            "Это GitLab CI/CD. Не могу сказать, что build_job ничего не собирает: "
            "он собирает артефакт. На текущем экране stage post не объявлен."
        ),
        (
            "Это GitLab CI/CD. Интервьюер сказал: «build_job ничего не собирает», "
            "однако job собирает артефакт. На текущем экране stage post не объявлен."
        ),
    ],
)
def test_gitlab_sequence_scorer_does_not_turn_denied_or_quoted_negative_quantifier_into_claim(
    answer: str,
) -> None:
    result = score_multiscroll_gitlab_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


@pytest.mark.parametrize(
    "current_finding",
    [
        "stage post не входит в список stages этой конфигурации.",
        "regression_test_job лишь печатает echo и не выполняет регрессионные тесты.",
        "Команда удаляет локальные теги вместо очистки cache.",
    ],
)
def test_gitlab_sequence_scorer_accepts_bounded_current_defect_paraphrases(
    current_finding: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job ничего не собирает, только echo выводит текст. "
        f"{current_finding}"
    )

    assert result["passed"] is True
    assert result["checks"]["current_frame_defect"] is True


def test_gitlab_sequence_scorer_rejects_question_followed_by_positive_rebuttal() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job ничего не собирает, только echo выводит текст. "
        "Stage post не входит в stages? Нет, он входит и объявлен ниже."
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is True
    assert result["checks"]["current_frame_defect"] is False


@pytest.mark.parametrize(
    "rebuttal",
    [
        "Stage post не входит в stages? Нет — он входит и объявлен ниже.",
        "Stage post не входит в stages? Нет. Он входит и объявлен ниже.",
        "Stage post не входит в stages? Нет! Он входит и объявлен ниже.",
        "Stage post не входит в stages? Нет? Он входит и объявлен ниже.",
    ],
)
def test_gitlab_sequence_scorer_rejects_punctuated_positive_rebuttal(
    rebuttal: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        f"Это GitLab CI/CD. build_job ничего не собирает, только echo выводит текст. {rebuttal}"
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is True
    assert result["checks"]["current_frame_defect"] is False


@pytest.mark.parametrize(
    "current_finding",
    [
        (
            "Неверно, что stage post не входит в stages: этот stage объявлен ниже, "
            "поэтому конфигурация корректна."
        ),
        (
            "Фраза «regression_test_job лишь печатает echo» — чужой пример; "
            "здесь job действительно запускает тесты."
        ),
        "Неверно, что теги удаляются вместо очистки cache: cache тоже очищается.",
        "stage post объявлен. Совсем другой job не входит в stages.",
        "regression_test_job запускает тесты, а echo только пишет служебный лог.",
        "Локальные теги удаляются, и cache затем тоже очищается.",
    ],
)
def test_gitlab_sequence_scorer_rejects_denied_quoted_or_disconnected_current_terms(
    current_finding: str,
) -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job ничего не собирает, только echo выводит текст. "
        f"{current_finding}"
    )

    assert result["passed"] is False
    assert result["checks"]["current_frame_defect"] is False


def test_gitlab_sequence_scorer_rejects_positive_build_clause_with_echo_logging() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job выполняет реальную сборку и публикует artifact, "
        "а echo только пишет служебный лог. На текущем экране stage post не объявлен."
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


@pytest.mark.parametrize(
    "answer",
    [
        (
            "Это GitLab CI/CD. Неверно, что `build_job не собирает` артефакт: "
            "он выполняет реальную сборку, а echo пишет только служебный лог. "
            "На текущем экране stage post не объявлен."
        ),
        (
            "Это GitLab CI/CD. Отсутствие реальной сборки не подтверждается: "
            "build_job создаёт artifact. На текущем экране stage post не объявлен."
        ),
    ],
)
def test_gitlab_sequence_scorer_rejects_explicit_denial_of_prior_defect(
    answer: str,
) -> None:
    result = score_multiscroll_gitlab_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


def test_gitlab_sequence_scorer_rejects_attributed_quote_instead_of_a_defect_claim() -> (
    None
):
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. Фраза «build_job только echo» приведена как чужой пример, "
        "а здесь job собирает артефакт. На текущем экране stage post не объявлен."
    )

    assert result["passed"] is False
    assert result["checks"]["prior_frame_defect"] is False


def test_gitlab_sequence_scorer_rejects_denied_current_frame_defect() -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitLab CI/CD. build_job только echo. Неверно, что post отсутствует: "
        "stage post объявлен ниже."
    )

    assert result["passed"] is False
    assert result["checks"]["current_frame_defect"] is False


def test_gitlab_sequence_scorer_rejects_denied_ci_system_identification() -> None:
    result = score_multiscroll_gitlab_answer(
        "Это не GitLab CI/CD. build_job только echo, а stage post не объявлен."
    )

    assert result["passed"] is False
    assert result["checks"]["gitlab_identified"] is False


def test_gitlab_sequence_scorer_rejects_report_style_github_flip() -> None:
    result = score_multiscroll_gitlab_answer(
        "Это GitHub Actions: добавьте needs и checkout. Конфигурация корректна."
    )

    assert result["passed"] is False
    assert result["checks"]["gitlab_identified"] is False
    assert result["checks"]["not_github_actions"] is False


def test_simple_sql_scorer_accepts_canonical_lookup_with_russian_plan_and_comments() -> (
    None
):
    answer = """Сначала выполню один параметризованный запрос к Order по идентификатору и сохраню сигнатуру функции.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
# Сохраняем заданную сигнатуру.
    rows = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Ищем только заказ с переданным идентификатором.
    return [dict(row) for row in rows]
    # Возвращаем строки в заявленном формате.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is True
    assert result["checks"]["balanced_single_fence"] is True
    assert result["checks"]["no_forbidden_architecture"] is True
    assert result["checks"]["preserved_get_order_signature"] is True
    assert result["checks"]["parameterized_order_lookup"] is True
    assert result["checks"]["minimal_order_solution"] is True
    assert result["checks"]["russian_comment_pairs"] is True


def test_simple_sql_scorer_rejects_changed_visible_signature_and_scalar_projection() -> (
    None
):
    answer = """Сделаю простой параметризованный запрос и верну результат.

```python
def get_order(conn: str, order_id: str) -> int:
    # Меняем заданные типы аргументов и результата.
    rows = conn.execute('SELECT 1 FROM "Order" WHERE id = ?', (order_id,))
    # Выбираем константу вместо полей строки заказа.
    return [dict(row) for row in rows]
    # Пытаемся преобразовать скалярный результат в словарь.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["preserved_get_order_signature"] is False
    assert result["checks"]["parameterized_order_lookup"] is False
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_separates_valid_cursor_lookup_from_nonminimal_solution() -> (
    None
):
    answer = """Сделаю один параметризованный запрос к Order по идентификатору и верну список словарей.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем заданную сигнатуру.
    cursor = conn.cursor()
    # Создаём курсор из переданного соединения.
    try:
        # Гарантируем закрытие курсора.
        cursor.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
        # Передаём идентификатор отдельно от SQL.
        row = cursor.fetchone()
        # Получаем одну найденную запись.
        columns = [item[0] for item in cursor.description]
        # Читаем имена колонок результата.
        return [dict(zip(columns, row))] if row else []
        # Возвращаем одну запись либо пустой список.
    finally:
        # Закрываем курсор при любом исходе.
        cursor.close()
        # Освобождаем ресурс курсора.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is True
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_recognizes_direct_fetchone_parameter_binding_without_calling_it_minimal() -> (
    None
):
    answer = """Сделаю один параметризованный запрос и верну найденную запись в заявленном формате.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем требуемую сигнатуру функции.
    row = conn.execute('SELECT * FROM "Order" WHERE id = %s', (order_id,)).fetchone()
    # Безопасно передаём идентификатор и читаем одну строку.
    return [dict(row)] if row else []
    # Возвращаем найденную запись либо пустой список.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is True
    assert result["checks"]["minimal_order_solution"] is False


def _direct_fetchall_zip_order_answer(statements: str) -> str:
    indented = "\n".join(f"    {line}" for line in statements.splitlines())
    return f"""Сделаю один параметризованный запрос и преобразую строки в заявленный формат.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем видимую сигнатуру функции.
{indented}
    columns = [column[0] for column in cursor.description]
    # Получаем названия колонок результата.
    rows = cursor.fetchall()
    # Получаем найденные строки после выполнения запроса.
    return [dict(zip(columns, row)) for row in rows]
    # Связываем названия колонок со значениями каждой строки.
```"""


@pytest.mark.parametrize(
    ("placeholder", "parameters"),
    [
        ("?", "(order_id,)"),
        ("%s", "[order_id]"),
        (":order_id", "{'order_id': order_id}"),
    ],
)
def test_simple_sql_scorer_recognizes_direct_fetchall_zip_parameter_binding_without_calling_it_minimal(
    placeholder: str,
    parameters: str,
) -> None:
    answer = _direct_fetchall_zip_order_answer(
        f"""query = 'SELECT * FROM \"Order\" WHERE id = {placeholder}'
    # Готовим запрос к одной записи заказа.
params = {parameters}
    # Передаём идентификатор отдельно от текста запроса.
cursor = conn.execute(query, params)
    # Выполняем ровно один запрос через переданное соединение."""
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is True
    assert result["checks"]["minimal_order_solution"] is False


@pytest.mark.parametrize(
    "statements",
    [
        """cursor = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (wrong_id,))
    # Передаём значение не из аргумента order_id.""",
        """cursor = conn.execute(f'SELECT * FROM \"Order\" WHERE id = {order_id}')
    # Подставляем значение прямо в строку запроса.""",
        """cursor = external.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Выполняем запрос через неподтверждённый объект.""",
        """cursor = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Выполняем первый запрос.
conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Выполняем лишний второй запрос.""",
        """conn = external
    # Перезаписываем переданное соединение.
cursor = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Пытаемся выполнить запрос через подменённое значение.""",
        """return []
    # Завершаем функцию до обращения к базе.
cursor = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Недостижимый запрос не доказывает корректную параметризацию.""",
    ],
)
def test_simple_sql_scorer_rejects_unsafe_direct_fetchall_zip_parameter_shapes(
    statements: str,
) -> None:
    result = score_simple_order_sql_answer(
        _direct_fetchall_zip_order_answer(statements)
    )

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False
    assert result["checks"]["minimal_order_solution"] is False


def _cursor_lookup_with_early_empty_branch(
    *,
    cursor_source: str = "conn.cursor()",
    parameters: str = "(order_id,)",
    extra_execute: bool = False,
    prefix: str = "",
    before_execute: str = "",
    after_execute: str = "",
) -> str:
    extra = (
        "        cursor.execute('SELECT 1')\n        # Выполняем лишний запрос.\n"
        if extra_execute
        else ""
    )
    return f"""Сделаю один связанный запрос и верну запись в заявленном формате.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем публичную сигнатуру функции.
{prefix}    cursor = {cursor_source}
    # Получаем курсор только из переданного соединения.
    try:
        # Гарантируем освобождение курсора.
{before_execute}{extra}        cursor.execute('SELECT * FROM "Order" WHERE id = %s', {parameters})
        # Передаём идентификатор отдельно от SQL.
{after_execute}        row = cursor.fetchone()
        # Читаем одну найденную строку.
        if row is None:
            # Обрабатываем отсутствие заказа до чтения метаданных.
            return []
            # Возвращаем заявленный пустой список.
        columns = [column[0] for column in cursor.description]
        # Получаем имена столбцов найденной строки.
        return [dict(zip(columns, row))]
        # Собираем запись в словарь.
    finally:
        # Выполняем очистку при любом исходе.
        cursor.close()
        # Закрываем курсор.
```"""


def test_simple_sql_scorer_proves_bound_cursor_query_independently_from_minimal_shape() -> (
    None
):
    result = score_simple_order_sql_answer(_cursor_lookup_with_early_empty_branch())

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is True
    assert result["checks"]["minimal_order_solution"] is False


@pytest.mark.parametrize(
    "answer",
    [
        _cursor_lookup_with_early_empty_branch(cursor_source="external.cursor()"),
        _cursor_lookup_with_early_empty_branch(parameters="(wrong_id,)"),
        _cursor_lookup_with_early_empty_branch(extra_execute=True),
        _cursor_lookup_with_early_empty_branch(
            prefix=(
                "    order_id = replacement_id\n    # Подменяем защищённый идентификатор.\n"
            )
        ),
    ],
)
def test_simple_sql_scorer_rejects_untrusted_or_ambiguous_cursor_parameter_binding(
    answer: str,
) -> None:
    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


@pytest.mark.parametrize(
    ("before_execute", "after_execute"),
    [
        (
            (
                "        cursor = external.cursor()\n"
                "        # Подменяем доверенный курсор перед запросом.\n"
            ),
            "",
        ),
        (
            "",
            (
                "        cursor = external.cursor()\n"
                "        # Подменяем доверенный курсор перед чтением строки.\n"
            ),
        ),
    ],
)
def test_simple_sql_scorer_rejects_cursor_rebinding_after_trusted_creation(
    before_execute: str,
    after_execute: str,
) -> None:
    result = score_simple_order_sql_answer(
        _cursor_lookup_with_early_empty_branch(
            before_execute=before_execute,
            after_execute=after_execute,
        )
    )

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


@pytest.mark.parametrize(
    "dynamic_binding",
    [
        (
            "        import external as cursor\n"
            "        # Подменяем курсор импортированным модулем.\n"
        ),
        (
            "        try:\n"
            "        # Открываем вложенную защищённую секцию.\n"
            "            risky_call()\n"
            "            # Выполняем потенциально ошибочную операцию.\n"
            "        except Exception as cursor:\n"
            "        # Подменяем курсор объектом исключения.\n"
            "            pass\n"
            "            # Завершаем обработку исключения.\n"
        ),
        (
            "        helper = lambda cursor: cursor\n"
            "        # Подменяем имя курсора параметром вложенной функции.\n"
        ),
        (
            "        with manager() as cursor:\n"
            "        # Подменяем курсор значением контекстного менеджера.\n"
            "            pass\n"
            "            # Завершаем лишний контекст.\n"
        ),
        (
            "        match value:\n"
            "        # Проверяем лишнее значение перед запросом.\n"
            "            case cursor:\n"
            "            # Подменяем курсор захваченным шаблоном.\n"
            "                pass\n"
            "                # Завершаем ветку шаблона.\n"
        ),
        (
            "        def cursor():\n"
            "        # Подменяем курсор именем вложенной функции.\n"
            "            return None\n"
            "            # Возвращаем пустое значение.\n"
        ),
    ],
)
def test_simple_sql_scorer_rejects_all_dynamic_cursor_binding_forms(
    dynamic_binding: str,
) -> None:
    result = score_simple_order_sql_answer(
        _cursor_lookup_with_early_empty_branch(before_execute=dynamic_binding)
    )

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


@pytest.mark.parametrize(
    "module_scaffolding",
    [
        (
            "class Helper:\n"
            "# Объявляем лишний вспомогательный класс.\n"
            "    pass\n"
            "    # Добавляем ненужное тело класса.\n"
        ),
        (
            "helper = make_helper()\n# Выполняем лишний побочный вызов на уровне модуля.\n"
        ),
    ],
)
def test_simple_sql_scorer_rejects_nonminimal_module_scaffolding(
    module_scaffolding: str,
) -> None:
    answer = f"""Сделаю один простой параметризованный запрос без лишней архитектуры.

```python
{module_scaffolding}def get_order(conn, order_id: int) -> list[dict[str, Any]]:
# Сохраняем заданную сигнатуру функции.
    rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Ищем только заказ с переданным идентификатором.
    return [dict(row) for row in rows]
    # Возвращаем строки в заявленном формате.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_rejects_unrelated_module_import_as_nonminimal() -> None:
    answer = """Сделаю один простой параметризованный запрос без лишней архитектуры.

```python
import sqlalchemy
# Подключаем лишнюю библиотеку с побочными эффектами импорта.
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
# Сохраняем заданную сигнатуру функции.
    rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Ищем только заказ с переданным идентификатором.
    return [dict(row) for row in rows]
    # Возвращаем строки в заявленном формате.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_allows_exact_typing_any_import_for_visible_signature() -> (
    None
):
    answer = """Сделаю один простой параметризованный запрос без лишней архитектуры.

```python
from typing import Any
# Импортируем тип, который требуется видимой сигнатуре.
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
# Сохраняем заданную сигнатуру функции.
    rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Ищем только заказ с переданным идентификатором.
    return [dict(row) for row in rows]
    # Возвращаем строки в заявленном формате.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is True
    assert result["checks"]["minimal_order_solution"] is True


def test_simple_sql_scorer_accepts_bounded_cursor_lookup_with_explicit_empty_branch() -> (
    None
):
    answer = """Сделаю один параметризованный запрос и сохраню заявленный список словарей.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем заданную сигнатуру.
    cursor = conn.cursor()
    # Создаём курсор из переданного соединения.
    try:
        # Гарантируем закрытие курсора.
        cursor.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
        # Передаём идентификатор отдельно от SQL.
        row = cursor.fetchone()
        # Получаем одну найденную запись.
        columns = [item[0] for item in cursor.description]
        # Читаем имена колонок результата.
        if row is None:
            # Проверяем отсутствие заказа.
            return []
            # Возвращаем пустой список.
        return [dict(zip(columns, row))]
        # Возвращаем найденную запись словарём.
    finally:
        # Закрываем курсор при любом исходе.
        cursor.close()
        # Освобождаем ресурс курсора.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is True
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_rejects_cursor_not_proven_to_come_from_connection() -> None:
    answer = """Сделаю один параметризованный запрос к Order по идентификатору.

```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем заданную сигнатуру.
    cursor = external_cursor
    # Берём посторонний курсор без связи с conn.
    cursor.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Передаём идентификатор отдельно от SQL.
    return [dict(row) for row in cursor.fetchall()]
    # Возвращаем строки в виде словарей.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_rejects_json_aggregation_and_extra_joins() -> None:
    answer = """План: соберу агрегат.
```sql
WITH x AS (SELECT JSON_AGG(i.*) FROM Order_Items oi JOIN Items i ON i.id = oi.item_id)
SELECT * FROM x GROUP BY id
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["no_forbidden_architecture"] is False


def test_simple_sql_scorer_rejects_required_tokens_only_in_prose_and_pass_body() -> (
    None
):
    answer = """Сначала функция get_order получает order_id и выполняет SELECT из FROM Order с WHERE id = ?.

```python
def get_order(conn, order_id):
    pass
    # Ничего не делаем.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False
    assert result["checks"]["russian_comment_pairs"] is False


def test_simple_sql_scorer_rejects_query_with_changed_function_signature() -> None:
    answer = """Выполню один параметризованный запрос.
```python
def find_order(connection, order_id):
    # Открываем функцию поиска заказа.
    return connection.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Передаём идентификатор отдельно от SQL.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["preserved_get_order_signature"] is False


def _sql_lookup_answer(placeholder: str, parameters: str) -> str:
    return f"""Выполню один простой параметризованный запрос и верну найденную запись.
```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем исходную сигнатуру функции.
    rows = conn.execute('SELECT * FROM "Order" WHERE id = {placeholder}', {parameters})
    # Передаём идентификатор отдельно от текста запроса.
    return [dict(row) for row in rows]
    # Возвращаем найденные строки в виде словарей.
```"""


@pytest.mark.parametrize(
    ("placeholder", "parameters"),
    [
        ("?", "(order_id,)"),
        ("?", "[order_id]"),
        ("%s", "(order_id,)"),
        ("%s", "[order_id]"),
        (":order_id", "{'order_id': order_id}"),
        ("$1", "order_id"),
    ],
)
def test_simple_sql_scorer_accepts_placeholder_specific_parameter_binding(
    placeholder: str,
    parameters: str,
) -> None:
    result = score_simple_order_sql_answer(_sql_lookup_answer(placeholder, parameters))

    assert result["passed"] is True
    assert result["checks"]["parameterized_order_lookup"] is True


@pytest.mark.parametrize(
    ("placeholder", "parameters"),
    [
        ("?", "order_id"),
        ("?", "{'wrong': order_id}"),
        ("?", "(wrong_id,)"),
        ("?", "(order_id, wrong_id)"),
        ("%s", "order_id"),
        ("%s", "{'order_id': order_id}"),
        (":order_id", "{'wrong': order_id}"),
        (":order_id", "{'order_id': wrong_id}"),
        (":order_id", "{'order_id': order_id, 'extra': order_id}"),
        ("$1", "(order_id,)"),
    ],
)
def test_simple_sql_scorer_rejects_placeholder_binding_that_would_not_execute(
    placeholder: str,
    parameters: str,
) -> None:
    result = score_simple_order_sql_answer(_sql_lookup_answer(placeholder, parameters))

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


def test_simple_sql_scorer_rejects_lookup_with_trailing_broad_predicate() -> None:
    answer = _sql_lookup_answer("? OR 1 = 1", "(order_id,)")

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


def _sql_preassigned_answer(statements: str) -> str:
    indented = "\n".join(f"    {line}" for line in statements.splitlines())
    return f"""Сначала подготовлю запрос и параметры, затем выполню один lookup.
```python
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
    # Сохраняем исходную сигнатуру функции.
{indented}
    return [dict(row) for row in rows]
    # Возвращаем найденные строки в виде словарей.
```"""


def test_simple_sql_scorer_accepts_aliases_assigned_before_execute() -> None:
    answer = _sql_preassigned_answer(
        """sql = 'SELECT * FROM "Order" WHERE id = ?'
    # Готовим простой запрос по идентификатору.
params = (order_id,)
    # Формируем один корректный позиционный параметр.
rows = conn.execute(sql, params)
    # Выполняем запрос с подготовленными значениями."""
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is True
    assert result["checks"]["parameterized_order_lookup"] is True


def test_simple_sql_scorer_uses_parameter_binding_at_execute_program_point() -> None:
    answer = _sql_preassigned_answer(
        """params = (wrong_id,)
    # Здесь задан неверный параметр.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', params)
    # Этот вызов должен проверяться до следующего присваивания.
params = (order_id,)
    # Позднее присваивание не исправляет уже выполненный вызов."""
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


def test_simple_sql_scorer_uses_query_binding_at_execute_program_point() -> None:
    answer = _sql_preassigned_answer(
        """rows = conn.execute(sql, (order_id,))
    # Запрос ещё не определён в момент вызова.
sql = 'SELECT * FROM "Order" WHERE id = ?'
    # Позднее присваивание не исправляет уже выполненный вызов."""
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


def test_simple_sql_scorer_rejects_invalid_reassignment_before_execute() -> None:
    answer = _sql_preassigned_answer(
        """params = (order_id,)
    # Сначала параметры корректны.
params = (wrong_id,)
    # Перед вызовом параметры стали неверными.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', params)
    # Выполняем запрос с последним значением параметров."""
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


def _polished_sql_answer(function_header: str, body: str) -> str:
    indented = "\n".join(f"    {line}" for line in body.splitlines())
    return f"""Выполню один синхронный запрос и верну список найденных строк.
```python
{function_header}
    # Сохраняем контракт функции получения заказа.
{indented}
```"""


@pytest.mark.parametrize(
    ("function_header", "body"),
    [
        (
            "def get_order(conn, order_id: int):",
            """yield conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Генератор откладывает выполнение запроса.""",
        ),
        (
            "def get_order(conn, order_id: int):",
            """yield from conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Делегирование генератору не возвращает список.""",
        ),
        (
            "async def get_order(conn, order_id: int):",
            """return await conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Асинхронная функция нарушает синхронный контракт.""",
        ),
        (
            "def get_order(conn, order_id: int):",
            """return not conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Булево отрицание возвращает не список строк.""",
        ),
        (
            "def get_order(conn, order_id: int):",
            """return conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,)) or []
    # Булева обёртка не гарантирует возврат списка словарей.""",
        ),
        (
            "def get_order(conn, order_id: int):",
            """return conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,)) == []
    # Сравнение возвращает булево значение вместо списка словарей.""",
        ),
        (
            "def get_order(conn, order_id: int):",
            """conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Результат запроса игнорируется.
return []
    # Возвращается несвязанный пустой список.""",
        ),
        (
            "def get_order(conn, order_id: int):",
            """rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Сохраняем строки запроса.
return not rows
    # Возвращается булево значение вместо списка.""",
        ),
    ],
)
def test_simple_sql_scorer_rejects_non_sync_or_non_returning_execute_shapes(
    function_header: str,
    body: str,
) -> None:
    result = score_simple_order_sql_answer(_polished_sql_answer(function_header, body))

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


def test_simple_sql_scorer_accepts_direct_list_comprehension_return() -> None:
    answer = _polished_sql_answer(
        "def get_order(conn, order_id: int) -> list[dict[str, Any]]:",
        """return [dict(row) for row in conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))]
    # Выполняем запрос и сразу преобразуем каждую строку в словарь.""",
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is True
    assert result["checks"]["parameterized_order_lookup"] is True


@pytest.mark.parametrize(
    "body",
    [
        """audit = other.execute('DELETE FROM audit')
    # Выполняем лишний побочный запрос.
rows = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Ищем заказ по идентификатору.
return [dict(row) for row in rows]
    # Возвращаем найденную запись.""",
        """rows = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Ищем заказ по идентификатору.
return [dict(row) for row in rows]
    # Возвращаем найденную запись.
conn.execute('DELETE FROM \"Order\"')
    # Недостижимый лишний запрос всё равно нарушает минимальный контракт.""",
    ],
)
def test_simple_sql_scorer_rejects_more_than_one_execute_call(body: str) -> None:
    result = score_simple_order_sql_answer(
        _polished_sql_answer("def get_order(conn, order_id: int):", body)
    )

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False
    assert result["checks"]["minimal_order_solution"] is False


def test_simple_sql_scorer_rejects_unreachable_control_flow_after_return() -> None:
    answer = _polished_sql_answer(
        "def get_order(conn, order_id: int):",
        """rows = conn.execute('SELECT * FROM \"Order\" WHERE id = ?', (order_id,))
    # Ищем заказ по идентификатору.
return [dict(row) for row in rows]
    # Возвращаем найденную запись.
if debug:
    # Не добавляем недостижимую ветку.
    raise RuntimeError
    # Не выполняем побочное действие.""",
    )

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["minimal_order_solution"] is False


@pytest.mark.parametrize(
    "body",
    [
        """conn = None
    # Перезаписываем исходное соединение.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем запрос через перезаписанное значение.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """order_id = None
    # Перезаписываем идентификатор из аргумента.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем запрос с неверным идентификатором.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """dict = lambda row: 7
    # Подменяем встроенный конструктор словаря.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем параметризованный запрос.
return [dict(row) for row in rows]
    # Вызываем подменённую функцию вместо конструктора словаря.""",
        """rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем параметризованный запрос.
return [dict(dict) for dict in rows]
    # Подменяем имя конструктора переменной цикла.""",
    ],
)
def test_simple_sql_scorer_rejects_polished_protected_name_shadowing(body: str) -> None:
    result = score_simple_order_sql_answer(
        _polished_sql_answer("def get_order(conn, order_id: int):", body)
    )

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


@pytest.mark.parametrize(
    "body",
    [
        """conn: object = replacement
    # Перезаписываем соединение аннотированным присваиванием.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Пытаемся выполнить запрос через перезаписанное имя.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """helper = (order_id := replacement_id)
    # Подменяем идентификатор выражением присваивания.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем запрос с подменённым значением.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """helper = lambda conn: conn
    # Объявляем параметр с защищённым именем во вложенной области.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем параметризованный запрос.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """helper = [row for order_id in ()]
    # Используем защищённое имя как цель генератора списка.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем параметризованный запрос.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """del conn
    # Удаляем исходное соединение.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Пытаемся выполнить запрос через удалённое имя.
return [dict(row) for row in rows]
    # Преобразуем строки в словари.""",
        """import builtins as dict
    # Подменяем конструктор словаря импортированным модулем.
rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Выполняем параметризованный запрос.
return [dict(row) for row in rows]
    # Пытаемся вызвать модуль вместо конструктора словаря.""",
    ],
)
def test_simple_sql_scorer_rejects_other_protected_name_bindings(body: str) -> None:
    result = score_simple_order_sql_answer(
        _polished_sql_answer("def get_order(conn, order_id: int):", body)
    )

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False


@pytest.mark.parametrize(
    "module_binding",
    [
        "conn = replacement",
        "order_id = 42",
        "dict = lambda row: row",
        "import sqlite3 as conn",
        "from builtins import dict",
    ],
)
def test_simple_sql_scorer_rejects_module_level_protected_name_bindings(
    module_binding: str,
) -> None:
    answer = f"""Выполню один параметризованный запрос и верну строку заказа.
```python
{module_binding}
# Не позволяем внешнему связыванию менять смысл функции.
def get_order(conn, order_id: int) -> list[dict[str, Any]]:
# Сохраняем заданную сигнатуру функции.
    rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Ищем заказ по переданному идентификатору.
    return [dict(row) for row in rows]
    # Возвращаем строку заказа словарём.
```"""

    result = score_simple_order_sql_answer(answer)

    assert result["passed"] is False
    assert result["checks"]["parameterized_order_lookup"] is False
    assert result["checks"]["minimal_order_solution"] is False


@pytest.mark.parametrize(
    "body",
    [
        "conn = replacement",
        "del order_id",
        "helper = (dict := replacement)",
        "for conn in values:\n    pass",
        "helper = [row for order_id in rows]",
        "with manager() as dict:\n    pass",
        "try:\n    pass\nexcept Exception as conn:\n    pass",
        "import builtins as dict",
        "from package import order_id",
        "global dict",
        "nonlocal order_id",
        "helper = lambda conn: conn",
        "def order_id():\n    pass",
        "class dict:\n    pass",
        "match value:\n    case conn:\n        pass",
        "match value:\n    case [*dict]:\n        pass",
        "match value:\n    case {**order_id}:\n        pass",
    ],
)
def test_protected_name_scanner_covers_bounded_python_bindings(body: str) -> None:
    indented = "\n".join(f"    {line}" for line in body.splitlines())
    tree = ast.parse(f"def get_order(conn, order_id):\n{indented}\n")
    function = tree.body[0]

    assert isinstance(function, ast.FunctionDef)
    assert _has_protected_name_rebinding(function) is True


def test_route_checklist_scorer_accepts_three_new_distinct_business_checks() -> None:
    first = """
- Обязательное поле shipments.
- Невалидный address.
- Дата доставки в прошлом.
- Неизвестный payment_method.
- Пустой comment.
"""
    refinement = """
- При is_leave_at_door=true курьеру не требуется подпись получателя.
- Несовместимый способ оплаты для выбранного типа доставки отклоняется.
- Две одинаковые позиции объединяются с корректным количеством.
"""

    result = score_route_checklist_refinement(first, refinement)

    assert result["passed"] is True
    assert result["checks"]["first_exactly_five_endpoint_checks"] is True
    assert result["checks"]["refinement_exactly_three_business_checks"] is True
    assert result["checks"]["all_three_genuinely_new"] is True


def test_route_checklist_scorer_rejects_repetition_and_database_inspection() -> None:
    first = """
- Проверить обязательность shipments.
- Проверить невалидный address.
- Проверить дату доставки в прошлом.
- Проверить неизвестный payment_method.
- Проверить пустой comment.
"""
    refinement = """
- Проверить обязательность shipments.
- Проверить обязательность shipments ещё раз.
- Проверить запись заказа в SQL таблице.
"""

    result = score_route_checklist_refinement(first, refinement)

    assert result["passed"] is False
    assert result["checks"]["no_database_inspection"] is False


def test_route_checklist_scorer_rejects_missing_first_endpoint_checklist() -> None:
    result = score_route_checklist_refinement(
        "Не смог дать список.",
        """
- Цвет кнопки становится зелёным.
- Заголовок страницы помещается в одну строку.
- Иконка меню отображается без размытия.
""",
    )

    assert result["passed"] is False
    assert result["checks"]["first_exactly_five_endpoint_checks"] is False
    assert result["checks"]["refinement_exactly_three_business_checks"] is False


def test_route_checklist_scorer_rejects_five_unrelated_first_bullets() -> None:
    first = """
- Цвет кнопки зелёный.
- Заголовок помещается.
- Иконка видна.
- Шрифт читаемый.
- Отступ одинаковый.
"""
    refinement = """
- При is_leave_at_door=true курьеру не требуется подпись получателя.
- Несовместимый способ оплаты для выбранного типа доставки отклоняется.
- Две одинаковые позиции объединяются с корректным количеством.
"""

    result = score_route_checklist_refinement(first, refinement)

    assert result["passed"] is False
    assert result["checks"]["first_exactly_five_endpoint_checks"] is False


def test_regression_report_serializes_complete_safe_attempt() -> None:
    attempt = {
        "case_id": "simple-order-sql-refinement",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": {
            "preserved_get_order_signature": True,
            "parameterized_order_lookup": True,
            "minimal_order_solution": True,
            "no_forbidden_architecture": True,
            "russian_spoken_plan": True,
            "balanced_single_fence": True,
            "russian_comment_pairs": True,
        },
        "initial_semantic_checks": {
            "preserved_get_order_signature": False,
            "parameterized_order_lookup": True,
            "minimal_order_solution": False,
            "no_forbidden_architecture": True,
        },
        "initial_typed_state_diagnostics": {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 1,
            "activeSourceCount": 1,
            "generationCompleted": True,
        },
        "final_typed_state_diagnostics": {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 2,
            "activeSourceCount": 2,
            "generationCompleted": True,
        },
        "failure_codes": [],
    }

    report = build_privacy_safe_regression_report([attempt])
    serialized = json.dumps(report, ensure_ascii=False)

    assert report["attempts"][0] == {
        "caseId": "simple-order-sql-refinement",
        "repetition": 1,
        "model": "example/model",
        "transportFirstByteMs": 900,
        "modelFirstChunkMs": 1200,
        "totalMs": 4200,
        "semanticChecks": {
            "preserved_get_order_signature": True,
            "parameterized_order_lookup": True,
            "minimal_order_solution": True,
            "no_forbidden_architecture": True,
            "russian_spoken_plan": True,
            "balanced_single_fence": True,
            "russian_comment_pairs": True,
        },
        "initialSemanticChecks": {
            "preserved_get_order_signature": False,
            "parameterized_order_lookup": True,
            "minimal_order_solution": False,
            "no_forbidden_architecture": True,
        },
        "initialTypedStateDiagnostics": {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 1,
            "activeSourceCount": 1,
            "generationCompleted": True,
        },
        "finalTypedStateDiagnostics": {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 2,
            "activeSourceCount": 2,
            "generationCompleted": True,
        },
        "failureCodes": [],
        "failureStage": None,
        "retryCount": 0,
    }
    assert "RAW MODEL ANSWER" not in serialized


@pytest.mark.parametrize(
    "diagnostics",
    [
        {"rawAnswer": "PRIVATE MODEL ANSWER"},
        {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 1,
            "activeSourceCount": 1,
            "generationCompleted": True,
            "claim": "PRIVATE CLAIM",
        },
        {
            "observationAccepted": True,
            "frameCount": 4,
            "activeFindingCount": 1,
            "activeSourceCount": 1,
            "generationCompleted": True,
        },
        {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 97,
            "activeSourceCount": 1,
            "generationCompleted": True,
        },
        {
            "observationAccepted": True,
            "frameCount": 1,
            "activeFindingCount": 1,
            "activeSourceCount": 33,
            "generationCompleted": True,
        },
        {
            "observationAccepted": "true",
            "frameCount": 1,
            "activeFindingCount": 1,
            "activeSourceCount": 1,
            "generationCompleted": True,
        },
    ],
)
def test_regression_report_rejects_non_allowlisted_or_unbounded_typed_diagnostics(
    diagnostics: dict,
) -> None:
    attempt = {
        "case_id": "multiscroll-gitlab-cicd",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": {
            "gitlab_identified": False,
            "prior_frame_defect": False,
            "current_frame_defect": False,
            "not_github_actions": True,
        },
        "initial_typed_state_diagnostics": {},
        "final_typed_state_diagnostics": diagnostics,
        "failure_codes": ["semantic_gate"],
    }

    with pytest.raises(ValueError, match="typed state diagnostics"):
        build_privacy_safe_regression_report([attempt])


def test_failed_attempt_report_uses_empty_typed_diagnostics_without_raw_state() -> None:
    failure = ScreenRequestFailure(
        code="invalid_screen_observation",
        stage="initial_request",
        model="safe/model",
        transport_first_byte_ms=100,
        model_first_chunk_ms=None,
        total_ms=300,
        visible_content_started=False,
    )

    report = build_privacy_safe_regression_report(
        [
            screen_module._failure_attempt(
                case_id="multiscroll-gitlab-cicd",
                repetition=1,
                failure=failure,
            )
        ]
    )

    attempt = report["attempts"][0]
    assert attempt["initialTypedStateDiagnostics"] == {}
    assert attempt["finalTypedStateDiagnostics"] == {}
    assert "taskState" not in json.dumps(report)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("model", "C:/Users/private/secret.txt", "model"),
        ("model", "this is raw model prose", "model"),
        ("model", "x" * 129, "model"),
        ("failure_codes", ["RAW MODEL ANSWER"], "failure codes"),
        ("failure_codes", ["C:/Users/private/secret.txt"], "failure codes"),
        ("failure_codes", [{"raw_answer": "PRIVATE MODEL TEXT"}], "failure codes"),
        ("failure_codes", ["semantic_gate", "semantic_gate"], "failure codes"),
        ("repetition", True, "repetition"),
        ("repetition", 0, "repetition"),
        ("transport_first_byte_ms", "900", "timing"),
        ("model_first_chunk_ms", -1, "timing"),
        ("total_ms", 600_001, "timing"),
    ],
)
def test_regression_report_rejects_unsafe_or_unbounded_copied_fields(
    field: str,
    value,
    message: str,
) -> None:
    attempt = {
        "case_id": "simple-order-sql-refinement",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": {
            "preserved_get_order_signature": True,
            "parameterized_order_lookup": True,
            "minimal_order_solution": True,
            "no_forbidden_architecture": True,
            "russian_spoken_plan": True,
            "balanced_single_fence": True,
            "russian_comment_pairs": True,
        },
        "failure_codes": [],
    }
    attempt[field] = value

    with pytest.raises(ValueError, match=message):
        build_privacy_safe_regression_report([attempt])


@pytest.mark.parametrize(
    "mutation",
    [
        lambda attempt: attempt.update(answer="RAW MODEL ANSWER"),
        lambda attempt: attempt.pop("model"),
    ],
)
def test_regression_report_requires_exact_complete_attempt_shape(mutation) -> None:
    attempt = {
        "case_id": "multiscroll-gitlab-cicd",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": {
            "gitlab_identified": True,
            "prior_frame_defect": True,
            "current_frame_defect": True,
            "not_github_actions": True,
        },
        "failure_codes": [],
    }
    mutation(attempt)

    with pytest.raises(ValueError, match="attempt shape"):
        build_privacy_safe_regression_report([attempt])


def test_regression_report_rejects_failure_code_from_another_case() -> None:
    attempt = {
        "case_id": "multiscroll-gitlab-cicd",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": {
            "gitlab_identified": False,
            "prior_frame_defect": False,
            "current_frame_defect": False,
            "not_github_actions": True,
        },
        "failure_codes": ["sql_parameter_binding"],
    }

    with pytest.raises(ValueError, match="failure codes"):
        build_privacy_safe_regression_report([attempt])


@pytest.mark.parametrize(
    "semantic_checks",
    [
        {"raw_answer": True},
        {"parameterized_order_lookup": "PRIVATE MODEL TEXT"},
        {"parameterized_order_lookup": {"raw_answer": "PRIVATE MODEL TEXT"}},
    ],
)
def test_regression_report_rejects_semantic_check_leakage(
    semantic_checks: dict,
) -> None:
    attempt = {
        "case_id": "simple-order-sql-refinement",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": semantic_checks,
        "failure_codes": ["semantic_gate"],
    }

    with pytest.raises(ValueError, match="semantic checks"):
        build_privacy_safe_regression_report([attempt])


@pytest.mark.parametrize(
    "initial_semantic_checks",
    [
        {"raw_answer": True},
        {"parameterized_order_lookup": True},
        {
            "preserved_get_order_signature": False,
            "parameterized_order_lookup": "PRIVATE MODEL TEXT",
            "minimal_order_solution": False,
            "no_forbidden_architecture": True,
        },
        {
            "preserved_get_order_signature": False,
            "parameterized_order_lookup": False,
            "minimal_order_solution": False,
            "no_forbidden_architecture": True,
            "raw_answer": False,
        },
    ],
)
def test_regression_report_rejects_initial_semantic_check_leakage_or_partial_shape(
    initial_semantic_checks: dict,
) -> None:
    attempt = {
        "case_id": "simple-order-sql-refinement",
        "repetition": 1,
        "model": "example/model",
        "transport_first_byte_ms": 900,
        "model_first_chunk_ms": 1200,
        "total_ms": 4200,
        "semantic_checks": {
            "preserved_get_order_signature": False,
            "parameterized_order_lookup": False,
            "minimal_order_solution": False,
            "no_forbidden_architecture": True,
            "russian_spoken_plan": False,
            "balanced_single_fence": False,
            "russian_comment_pairs": False,
        },
        "initial_semantic_checks": initial_semantic_checks,
        "failure_codes": ["semantic_gate"],
    }

    with pytest.raises(ValueError, match="initial semantic checks"):
        build_privacy_safe_regression_report([attempt])


def test_sequence_runner_keeps_previous_frame_and_summary_order_without_persisting_content() -> (
    None
):
    calls: list[dict] = []

    def render(case_id: str, frame_index: int) -> bytes:
        return f"{case_id}:frame-{frame_index}".encode()

    answers = iter(
        [
            "Первый анализ GitLab",
            "Это GitLab. build_job только echo. regression_test_job тоже только echo; post не объявлен.",
            "Черновик SQL",
            "План: делаю простой запрос.\n```python\ndef get_order(conn, order_id: int):\n# Сохраняем сигнатуру.\n    return conn.execute('SELECT * FROM Order WHERE id = ?', (order_id,))\n    # Передаём ID параметром.\n```",
            "- shipments\n- address\n- date\n- comment\n- payment_method",
            "- is_leave_at_door без подписи\n- способ оплаты для доставки\n- одинаковые позиции объединяются",
        ]
    )

    def request(_port: int, _token: str, payload: dict):
        calls.append(payload)
        return next(answers), {
            "model": "fake/model",
            "_e2e_transport_first_byte_ms": 100,
            "_e2e_first_chunk_ms": 200,
            "_e2e_total_ms": 300,
        }

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-secret",
        repetitions=1,
        request_screen=request,
        render_frame=render,
    )

    assert [attempt["case_id"] for attempt in attempts] == [
        "multiscroll-gitlab-cicd",
        "simple-order-sql-refinement",
        "route-checklist-novelty",
    ]
    assert calls[1]["previous_images"] == [
        "data:image/png;base64,bXVsdGlzY3JvbGwtZ2l0bGFiLWNpY2Q6ZnJhbWUtMA=="
    ]
    assert calls[1]["prior_solution_summary"] == "Первый анализ GitLab"
    assert attempts[0]["initial_semantic_checks"] == {
        "gitlab_identified": True,
        "prior_frame_defect": False,
        "current_frame_defect": False,
    }
    assert attempts[1]["initial_semantic_checks"] == {
        "preserved_get_order_signature": False,
        "parameterized_order_lookup": False,
        "minimal_order_solution": False,
        "no_forbidden_architecture": True,
    }
    assert attempts[2]["initial_semantic_checks"] == {
        "first_exactly_five_endpoint_checks": True,
        "first_distinct_checks": True,
    }
    assert all(
        "answer" not in attempt and "image" not in attempt for attempt in attempts
    )


def test_sequence_runner_carries_typed_state_only_between_structured_requests() -> None:
    calls: list[dict] = []
    answers = iter(
        [
            "Первый анализ GitLab",
            "Это GitLab. build_job ничего не собирает. regression_test_job тоже только echo; post не объявлен.",
            "Черновик SQL",
            "План: делаю простой запрос.\n```python\ndef get_order(conn, order_id: int):\n# Сохраняем сигнатуру.\n    return conn.execute('SELECT * FROM Order WHERE id = ?', (order_id,))\n    # Передаём ID параметром.\n```",
            "- shipments\n- address\n- date\n- comment\n- payment_method",
            "- is_leave_at_door без подписи\n- способ оплаты для доставки\n- одинаковые позиции объединяются",
        ]
    )

    def request(_port: int, _token: str, payload: dict):
        calls.append(payload)
        case_index = (len(calls) - 1) // 2
        return next(answers), {
            "model": "fake/model",
            "_task_state": json.dumps({"version": 1, "case": case_index}),
            "_e2e_transport_first_byte_ms": 100,
            "_e2e_first_chunk_ms": 200,
            "_e2e_total_ms": 300,
        }

    attempts = run_real_interview_regressions(
        port=8123,
        token="not-secret",
        repetitions=1,
        structured_screen=True,
        request_screen=request,
        render_frame=lambda case, frame: f"{case}:{frame}".encode(),
    )

    for initial_index in (0, 2, 4):
        assert calls[initial_index]["structuredScreen"] is True
        assert calls[initial_index]["taskAction"] == "new"
        assert "taskState" not in calls[initial_index]
        assert calls[initial_index + 1]["structuredScreen"] is True
        assert calls[initial_index + 1]["taskAction"] == "continue"
        assert calls[initial_index + 1]["taskState"] == json.dumps(
            {"version": 1, "case": initial_index // 2}
        )
    serialized = json.dumps(attempts, ensure_ascii=False)
    assert "task_state" not in serialized
    assert "taskState" not in serialized


def test_sequence_runner_includes_explicit_model_override_in_every_request() -> None:
    calls: list[dict] = []
    answers = iter(
        [
            "Первый анализ GitLab",
            "Это GitLab. build_job только echo. regression_test_job тоже только echo; post не объявлен.",
            "Черновик SQL",
            "План: делаю простой запрос.\n```python\ndef get_order(conn, order_id: int):\n# Сохраняем сигнатуру.\n    return conn.execute('SELECT * FROM Order WHERE id = ?', (order_id,))\n    # Передаём ID параметром.\n```",
            "- shipments\n- address\n- date\n- comment\n- payment_method",
            "- is_leave_at_door без подписи\n- способ оплаты для доставки\n- одинаковые позиции объединяются",
        ]
    )

    def request(_port: int, _token: str, payload: dict):
        calls.append(payload)
        return next(answers), {
            "model": "qwen/qwen3.5-flash",
            "_e2e_transport_first_byte_ms": 100,
            "_e2e_first_chunk_ms": 200,
            "_e2e_total_ms": 300,
        }

    run_real_interview_regressions(
        port=8123,
        token="not-secret",
        repetitions=1,
        model_override="qwen/qwen3.5-flash",
        provider_override="openai",
        request_screen=request,
        render_frame=lambda case_id, frame_index: f"{case_id}:{frame_index}".encode(),
    )

    assert len(calls) == 6
    assert (
        len([payload for payload in calls if "prior_solution_summary" not in payload])
        == 3
    )
    assert (
        len([payload for payload in calls if "prior_solution_summary" in payload]) == 3
    )
    assert {payload.get("modelOverride") for payload in calls} == {"qwen/qwen3.5-flash"}
    assert {payload.get("provider") for payload in calls} == {"openai"}
