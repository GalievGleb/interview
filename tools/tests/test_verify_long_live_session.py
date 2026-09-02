import asyncio
import base64
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

import tools.verify_long_live_session as soak_module
from tools.verify_long_live_session import (
    OwnedProcessTree,
    _terminate_owned_process_tree,
    _working_set_bytes,
    backend_launch_spec,
    evaluate_screen_probe,
    memory_growth_bytes,
    parse_checkpoint_minutes,
    remove_sqlite_artifacts,
    validate_memory_growth,
)


def test_checkpoint_parser_keeps_literal_post_hour_probes():
    assert parse_checkpoint_minutes("0,30,61,91", duration_minutes=95) == (
        0.0,
        30.0,
        61.0,
        91.0,
    )


@pytest.mark.parametrize(
    "raw",
    ("", "0,0", "-1,30", "0,96", "zero,30"),
)
def test_checkpoint_parser_rejects_a_soak_that_cannot_prove_the_requested_window(raw):
    with pytest.raises(ValueError):
        parse_checkpoint_minutes(raw, duration_minutes=95)


def test_verifier_can_be_invoked_by_its_script_path():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(root / "tools" / "verify_long_live_session.py"), "--help"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_source_backend_launch_uses_workspace_uvicorn() -> None:
    root = Path(__file__).resolve().parents[2]

    command, cwd = backend_launch_spec(source_backend=True, port=8765, root=root)

    assert command[1:4] == ["-m", "uvicorn", "app.main:app"]
    assert command[-2:] == ["--port", "8765"]
    assert cwd == root / "apps" / "api-py"


def test_working_set_growth_uses_first_non_null_to_maximum() -> None:
    assert memory_growth_bytes([None, 100, 120, 95, 140]) == 40
    assert memory_growth_bytes([None, None]) is None


@pytest.mark.skipif(sys.platform != "win32", reason="Windows working-set probe")
def test_working_set_probe_reads_the_live_backend_process() -> None:
    sample = _working_set_bytes(os.getpid())

    assert isinstance(sample, int)
    assert sample > 0


@pytest.mark.skipif(sys.platform != "win32", reason="Windows process-tree probe")
def test_owned_process_tree_measures_growing_child_and_terminates_same_tree(
    tmp_path: Path,
) -> None:
    ready = tmp_path / "ready"
    grow = tmp_path / "grow"
    grown = tmp_path / "grown"
    child_pid_file = tmp_path / "child-pid"
    child_script = tmp_path / "memory_child.py"
    launcher_script = tmp_path / "launcher.py"
    child_script.write_text(
        """
import os
import sys
import time
from pathlib import Path

ready, grow, grown, pid_file = map(Path, sys.argv[1:])
blocks = [bytearray(b'x' * (1024 * 1024)) for _ in range(4)]
pid_file.write_text(str(os.getpid()), encoding='ascii')
ready.write_text('ready', encoding='ascii')
while not grow.exists():
    time.sleep(0.01)
blocks.extend(bytearray(b'y' * (1024 * 1024)) for _ in range(64))
grown.write_text(str(len(blocks)), encoding='ascii')
while True:
    time.sleep(1)
""".strip(),
        encoding="utf-8",
    )
    launcher_script.write_text(
        """
import subprocess
import sys

child = subprocess.Popen([sys.executable, sys.argv[1], *sys.argv[2:]])
raise SystemExit(child.wait())
""".strip(),
        encoding="utf-8",
    )
    launcher = subprocess.Popen(
        [
            sys.executable,
            str(launcher_script),
            str(child_script),
            str(ready),
            str(grow),
            str(grown),
            str(child_pid_file),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    tree = None

    try:
        tree = OwnedProcessTree.capture(launcher.pid)
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert ready.exists(), "child fixture did not become ready"

        baseline = tree.working_set_bytes()
        launcher_only = _working_set_bytes(launcher.pid)
        assert isinstance(baseline, int)
        assert isinstance(launcher_only, int)
        assert baseline > launcher_only

        grow.write_text("grow", encoding="ascii")
        deadline = time.monotonic() + 10
        while not grown.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert grown.exists(), "child fixture did not allocate memory"

        expanded = baseline
        while expanded < baseline + 32 * 1024 * 1024 and time.monotonic() < deadline:
            time.sleep(0.05)
            expanded = tree.working_set_bytes() or 0
        assert expanded >= baseline + 32 * 1024 * 1024
    finally:
        child_pid = (
            int(child_pid_file.read_text("ascii")) if child_pid_file.exists() else None
        )
        if tree is not None:
            _terminate_owned_process_tree(launcher, tree)
        elif launcher.poll() is None:
            launcher.kill()
            launcher.wait(timeout=5)

    assert launcher.poll() is not None
    if child_pid is not None:
        assert _working_set_bytes(child_pid) is None


def test_sqlite_cleanup_removes_companion_files(tmp_path: Path) -> None:
    database = tmp_path / "soak.sqlite"
    for target in (database, Path(f"{database}-wal"), Path(f"{database}-shm")):
        target.write_bytes(b"fixture")

    remove_sqlite_artifacts(database, attempts=1)

    assert not database.exists()
    assert not Path(f"{database}-wal").exists()
    assert not Path(f"{database}-shm").exists()


def test_sqlite_cleanup_reports_a_permanent_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "soak.sqlite"

    def locked_unlink(_path: Path, *, missing_ok: bool = False) -> None:
        raise PermissionError("fixture lock")

    monkeypatch.setattr(Path, "unlink", locked_unlink)

    with pytest.raises(RuntimeError, match="temporary soak database cleanup failed"):
        remove_sqlite_artifacts(database, attempts=1)


def test_generated_screen_probe_scorers_are_distinct_and_semantic() -> None:
    python_probe = evaluate_screen_probe(
        0,
        "Получим False, затем TypeError: строки неизменяемы.",
    )
    fixture_probe = evaluate_screen_probe(
        1,
        "1. session_fixture\n2. module_fixture\n3. autouse_fixture\n4. fixture_3\n"
        "5. fixture_4\n6. fixture_1\n7. fixture_2\n8. test_order\n9. fixture_4",
    )
    sql_probe = evaluate_screen_probe(
        2,
        "```sql\nSELECT * FROM Purchases WHERE user_gender IN ('Female', 'F')\n```",
    )

    assert python_probe["passed"] is True
    assert fixture_probe["passed"] is True
    assert sql_probe["passed"] is True
    assert (
        len(
            {
                tuple(result["matched_keys"])
                for result in (python_probe, fixture_probe, sql_probe)
            }
        )
        == 3
    )


@pytest.mark.parametrize(
    "answer",
    (
        "Получим False, затем исключение: строки в Python нельзя менять.",
        "Сравнение вернёт ложь, затем присваивание элементу str запрещено.",
        (
            "Сначала выводится False. Затем Python выбросит исключение: "
            "str не поддерживает присваивание по индексу."
        ),
        "False, then TypeError: str object does not support item assignment.",
    ),
)
def test_python_screen_probe_accepts_natural_assignment_rejection(answer: str) -> None:
    result = evaluate_screen_probe(0, answer)

    assert result["passed"] is True
    assert result["checks"] == {
        "false_result": True,
        "type_error": True,
        "string_assignment_rejected": True,
    }
    assert result["missing_keys"] == []


def test_python_screen_probe_rejects_generic_error_without_a_real_exception() -> None:
    result = evaluate_screen_probe(
        0,
        "Получим False, потом произойдёт ошибка. Строки неизменяемы.",
    )

    assert result["passed"] is False
    assert result["checks"]["type_error"] is False
    assert result["missing_keys"] == ["type_error"]


def test_failed_screen_probe_returns_only_safe_aggregate_evidence() -> None:
    record = soak_module._exercise_screen_checkpoint(
        index=0,
        port=8765,
        token="DO_NOT_PERSIST",
        elapsed_minutes=0.25,
        request_screen=lambda *_args, **_kwargs: (
            "False. Потом ошибка.",
            {
                "model": "fixture-model",
                "_e2e_transport_first_byte_ms": 100,
                "_e2e_first_chunk_ms": 200,
                "_e2e_total_ms": 300,
            },
        ),
        renderers=(lambda: b"private-pixels",),
    )

    assert record == {
        "elapsed_minutes": 0.25,
        "case": "generated-screen-1",
        "transport_first_byte_ms": 100,
        "first_chunk_ms": 200,
        "total_ms": 300,
        "model": "fixture-model",
        "semantic_checks": {
            "false_result": True,
            "type_error": False,
            "string_assignment_rejected": False,
        },
        "matched_screen_concepts": ["false_result"],
        "missing_screen_concepts": ["type_error", "string_assignment_rejected"],
        "failure_codes": ["screen_semantics"],
    }
    serialized = str(record).casefold()
    for forbidden in (
        "do_not_persist",
        "private-pixels",
        "base64",
        "answer",
        "cookie",
        "request_id",
        "c:\\\\users",
        "/users/",
    ):
        assert forbidden not in serialized


def test_screen_provider_failure_is_reduced_to_a_stable_safe_code() -> None:
    def fail_with_private_message(*_args, **_kwargs):
        raise RuntimeError("PRIVATE upstream payload C:\\Users\\private\\screen.png")

    record = soak_module._exercise_screen_checkpoint(
        index=0,
        port=8765,
        token="DO_NOT_PERSIST",
        elapsed_minutes=0.25,
        request_screen=fail_with_private_message,
        renderers=(lambda: b"private-pixels",),
    )

    assert record["failure_codes"] == ["screen_request_failed"]
    assert record["semantic_checks"] == {
        "false_result": False,
        "type_error": False,
        "string_assignment_rejected": False,
    }
    serialized = str(record).casefold()
    for forbidden in ("private", "do_not_persist", "screen.png", "base64"):
        assert forbidden not in serialized


def test_cli_persists_safe_partial_report_when_a_screen_probe_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report_path = tmp_path / "soak-failed.json"
    partial = {
        "ok": False,
        "requested_duration_minutes": 1.5,
        "actual_duration_minutes": 0.25,
        "checkpoints": [],
        "screen_probes": [
            {
                "case": "generated-screen-1",
                "model": "fixture-model",
                "transport_first_byte_ms": 100,
                "first_chunk_ms": 200,
                "total_ms": 300,
                "semantic_checks": {"false_result": True, "type_error": False},
                "missing_screen_concepts": ["type_error"],
                "failure_codes": ["screen_semantics"],
            }
        ],
        "failure_codes": ["screen_semantics"],
    }

    class FakeProcess:
        pid = os.getpid()

        def poll(self):
            return None

        def terminate(self):
            return None

        def wait(self, timeout=None):
            return 0

        def kill(self):
            return None

    async def fail_soak(**_kwargs):
        raise soak_module.SoakRunFailure(partial)

    monkeypatch.setattr(
        soak_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        soak_module.subprocess, "Popen", lambda *_args, **_kwargs: FakeProcess()
    )
    monkeypatch.setattr(
        soak_module.OwnedProcessTree,
        "capture",
        classmethod(lambda _cls, _pid: object()),
    )
    monkeypatch.setattr(
        soak_module,
        "_terminate_owned_process_tree",
        lambda _process, _tree: None,
    )
    monkeypatch.setattr(soak_module, "_wait_for_health", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(soak_module, "_run_soak", fail_soak)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_long_live_session.py",
            "--source-backend",
            "--duration-minutes",
            "1.5",
            "--checkpoint-minutes",
            "0,0.5,1.1",
            "--screen-checkpoint-minutes",
            "0.25,1.25",
            "--report",
            str(report_path),
        ],
    )

    assert soak_module.main() == 1
    report = report_path.read_text("utf-8").casefold()
    assert '"ok": false' in report
    assert '"screen_semantics"' in report
    for forbidden in ("answer", "image", "base64", "token", "credential", "cookie"):
        assert forbidden not in report


def test_memory_growth_gate_rejects_more_than_256_mib() -> None:
    limit = 256 * 1024 * 1024

    assert validate_memory_growth([100, 100 + limit])["passed"] is True
    assert validate_memory_growth([100, 101 + limit]) == {
        "passed": False,
        "growth_bytes": limit + 1,
        "limit_bytes": limit,
    }


def test_source_backend_environment_blocks_local_byok_but_keeps_direct_openai(
    tmp_path: Path,
) -> None:
    env = soak_module.build_backend_environment(
        base_env={
            "OPENAI_API_KEY": "DIRECT_OPENAI_IN_MEMORY",
            "OPENROUTER_API_KEY": "DEPLETED_LOCAL_BYOK",
            "PYTHON_KEYRING_BACKEND": "unsafe.backend",
        },
        port=8765,
        token="LOCAL_API_TOKEN",
        database=tmp_path / "soak.sqlite",
        source_backend=True,
    )

    assert env["OPENAI_API_KEY"] == "DIRECT_OPENAI_IN_MEMORY"
    assert env["OPENROUTER_API_KEY"] == ""
    assert env["PYTHON_KEYRING_BACKEND"] == "keyring.backends.null.Keyring"
    assert env["SKILLCUE_GATEWAY_URL"] == "https://skill-cue.ru/v1"


def test_cli_keeps_voice_model_auto_and_accepts_explicit_screen_route() -> None:
    args = soak_module.build_cli_parser().parse_args(
        [
            "--voice-provider",
            "openrouter",
            "--screen-provider",
            "openai",
            "--screen-model",
            "openai/gpt-5.6-sol",
        ]
    )

    assert args.voice_provider == "openrouter"
    assert args.voice_model is None
    assert args.screen_provider == "openai"
    assert args.screen_model == "openai/gpt-5.6-sol"


def test_pcm_fixture_is_paced_at_real_wall_clock_frame_duration() -> None:
    now = 100.0

    class FakeSocket:
        def __init__(self) -> None:
            self.frames: list[bytes] = []

        async def send(self, frame: bytes) -> None:
            self.frames.append(frame)

    delays: list[float] = []

    async def record_sleep(delay: float) -> None:
        nonlocal now
        delays.append(delay)
        now += delay

    def monotonic() -> float:
        return now

    socket = FakeSocket()
    asyncio.run(
        soak_module._send_pcm(
            socket,
            b"\x01\x00" * 2_400,
            16_000,
            sleep=record_sleep,
            monotonic=monotonic,
        )
    )

    assert [len(frame) for frame in socket.frames] == [3_200, 1_600]
    assert delays == pytest.approx([0.1, 0.05])


def test_pcm_pacing_uses_absolute_deadline_instead_of_accumulating_send_latency() -> (
    None
):
    now = 200.0

    class SlowSocket:
        async def send(self, _frame: bytes) -> None:
            nonlocal now
            now += 0.03

    delays: list[float] = []

    async def advance(delay: float) -> None:
        nonlocal now
        delays.append(delay)
        now += delay

    asyncio.run(
        soak_module._send_pcm(
            SlowSocket(),
            b"\x01\x00" * 2_400,
            16_000,
            sleep=advance,
            monotonic=lambda: now,
        )
    )

    assert delays == pytest.approx([0.07, 0.02])


def test_voice_checkpoint_ignores_stale_final_and_keeps_one_session_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSocket:
        def __init__(self) -> None:
            self.controls: list[str] = []

        async def send(self, value) -> None:
            if isinstance(value, str):
                self.controls.append(value)

    case = {
        "id": "owned-final",
        "audioFile": "unused.wav",
        "requiredTranscriptKeywords": [
            {"key": "alpha", "aliases": ["alpha"]},
            {"key": "beta", "aliases": ["beta"]},
            {"key": "gamma", "aliases": ["gamma"]},
        ],
    }
    captured: dict = {}

    def ask_overlay(port, token, question, selected_case, **kwargs):
        captured.update(
            {
                "port": port,
                "token": token,
                "question": question,
                "case": selected_case,
                **kwargs,
            }
        )
        return {
            "first_chunk_ms": 1,
            "total_ms": 2,
            "model": "PRIVATE C:\\Users\\person\\model",
            "matched_answer_concepts": ["one", "two", "three"],
        }

    async def no_wait(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(soak_module, "_read_pcm", lambda _path: (16_000, b"\0\0"))
    queue: asyncio.Queue[dict] = asyncio.Queue()
    queue.put_nowait(
        {
            "type": "transcript",
            "text": "wrong stale transcript",
            "force_request_id": "older-request",
        }
    )
    queue.put_nowait(
        {
            "type": "transcript",
            "text": "alpha beta gamma",
            "force_request_id": "owned-request",
            "openaiInferenceMs": "PRIVATE C:\\Users\\person\\audio.wav",
        }
    )

    result = asyncio.run(
        soak_module._exercise_checkpoint(
            FakeSocket(),
            queue,
            case=case,
            port=8765,
            token="LOCAL_TOKEN",
            elapsed_minutes=61.0,
            provider="openrouter",
            model_override=None,
            session_id="stable-session",
            active_screen_task={
                "root_question": "Synthetic root",
                "current_question": "Synthetic refinement",
                "latest_answer": "Synthetic answer",
                "updated_at_ms": 1,
            },
            ask_overlay=ask_overlay,
            request_id_factory=lambda: "owned-request",
            sleep=no_wait,
        )
    )

    assert captured["question"] == "alpha beta gamma"
    assert captured["provider"] == "openrouter"
    assert captured["model_override"] is None
    assert captured["session_id"] == "stable-session"
    assert captured["active_screen_task"]["root_question"] == "Synthetic root"
    assert result["active_screen_context_injected"] is True
    assert result["stt_upstream_ms"] is None
    assert result["model"] == "unknown"
    serialized = str(result).casefold()
    assert "private" not in serialized
    assert "c:\\users" not in serialized


@pytest.mark.parametrize(
    "unsafe_model",
    (
        "C:/Users/person/private-model",
        "sk-proj-deadbeef",
    ),
)
def test_model_identifier_rejects_paths_and_secret_like_values(
    unsafe_model: str,
) -> None:
    assert soak_module._safe_model_identifier(unsafe_model) == "unknown"
    assert soak_module._safe_model_identifier("openai/gpt-5.6-sol") == (
        "openai/gpt-5.6-sol"
    )


def test_ready_events_consumed_inside_checkpoint_increment_global_count() -> None:
    assert (
        soak_module._count_checkpoint_ready_events(
            2,
            {"ready_events_during_probe": 3},
        )
        == 5
    )
    assert (
        soak_module._count_checkpoint_ready_events(
            2,
            {"ready_events_during_probe": "PRIVATE"},
        )
        == 2
    )


def test_ready_events_report_upstream_reconnects_separately_from_local_socket() -> None:
    report = soak_module._safe_runtime_failure_report(
        duration_minutes=95,
        stage="soak",
        progress={
            "ready_events": 3,
            "stt_socket_established": True,
            "stt_socket_interrupted": False,
        },
    )

    assert report["ready_events"] == 3
    assert report["stt_reconnect_count"] == 2
    assert report["local_socket_reconnect_count"] == 0
    assert report["upstream_stt_ready_events"] == 3
    assert report["upstream_stt_reconnect_count"] == 2


def test_pending_screen_checkpoint_events_preserve_ready_and_transport_state() -> None:
    queue: asyncio.Queue[dict] = asyncio.Queue()
    queue.put_nowait({"type": "ready"})
    queue.put_nowait({"type": "transport_closed"})

    ready_events, failure_codes = soak_module._drain_pending_stt_events(queue, 2)

    assert ready_events == 3
    assert failure_codes == ["stt_transport_interrupted"]


@pytest.mark.parametrize(
    ("established", "interrupted", "expected"),
    (
        (False, False, "not_established"),
        (True, False, "continuous_socket"),
        (True, True, "interrupted"),
    ),
)
def test_stt_continuity_status_reflects_socket_lifecycle(
    established: bool,
    interrupted: bool,
    expected: str,
) -> None:
    assert (
        soak_module.stt_continuity_status(
            established=established,
            interrupted=interrupted,
        )
        == expected
    )


def test_three_screen_checkpoints_carry_bounded_continuity_context() -> None:
    state = soak_module.ScreenContinuityState()
    payloads: list[dict] = []
    answers = (
        (
            "```sql\nSELECT SUM(price * items) AS income_from_female "
            "FROM Purchases WHERE user_gender IN ('Female', 'F')\n```"
        ),
        (
            "```sql\nSELECT SUM(price * COALESCE(items, 0)) AS income_from_female "
            "FROM Purchases WHERE user_gender IN ('Female', 'F')\n```"
        ),
        (
            "```sql\nSELECT SUM(price * COALESCE(items, 0)) AS income_from_female "
            "FROM Purchases WHERE user_gender IN ('Female', 'F') "
            "AND status <> 'refunded'\n```"
        ),
    )

    def request_screen(_port: int, _token: str, payload: dict):
        payloads.append(payload)
        return answers[len(payloads) - 1], {
            "model": "gpt-5.6-sol",
            "_e2e_transport_first_byte_ms": 10,
            "_e2e_first_chunk_ms": 20,
            "_e2e_total_ms": 30,
        }

    renderers = (lambda: b"frame-1", lambda: b"frame-2", lambda: b"frame-3")
    for index in range(3):
        record = soak_module._exercise_screen_checkpoint(
            index=index,
            port=8765,
            token="LOCAL_TOKEN",
            elapsed_minutes=float(index),
            request_screen=request_screen,
            renderers=renderers,
            continuity_state=state,
            provider="openai",
            model_override="openai/gpt-5.6-sol",
        )
        assert record["failure_codes"] == []

    encoded = [
        f"data:image/png;base64,{base64.b64encode(frame).decode('ascii')}"
        for frame in (b"frame-1", b"frame-2", b"frame-3")
    ]
    assert payloads[0].get("previous_images") in (None, [])
    assert payloads[0].get("prior_solution_summary") in (None, "")
    assert payloads[1]["previous_images"] == [encoded[0]]
    assert payloads[1]["prior_solution_summary"] == answers[0]
    assert payloads[2]["previous_images"] == encoded[:2]
    assert payloads[2]["prior_solution_summary"] == answers[1]
    assert payloads[2]["provider"] == "openai"
    assert payloads[2]["modelOverride"] == "openai/gpt-5.6-sol"
    assert state.frames == encoded[1:]


def test_continuity_views_are_sequential_instead_of_cosmetic_duplicates() -> None:
    views = [soak_module._continuity_screen_view(index) for index in range(3)]
    rendered_text = ["\n".join((title, *lines)) for title, lines in views]

    assert len(set(rendered_text)) == 3
    assert "Purchases" in rendered_text[0]
    assert "Purchases" not in rendered_text[1]
    assert "Purchases" not in rendered_text[2]
    assert "NULL" in rendered_text[1]
    assert "refunded" in rendered_text[2]


def test_checkpoint_two_fails_when_previous_screen_facts_are_ignored() -> None:
    current_view_only = "Использую COALESCE(items, 0), чтобы считать NULL как ноль."
    complete = (
        "```sql\nSELECT SUM(price * COALESCE(items, 0)) AS income_from_female "
        "FROM Purchases WHERE user_gender IN ('Female', 'F')\n```"
    )

    ignored = soak_module.evaluate_continuity_screen_probe(1, current_view_only)
    carried = soak_module.evaluate_continuity_screen_probe(1, complete)

    assert ignored["passed"] is False
    assert "purchases_table" in ignored["missing_keys"]
    assert "exact_gender_literals" in ignored["missing_keys"]
    assert carried["passed"] is True


def test_checkpoint_three_requires_prior_solution_and_current_correction() -> None:
    current_view_only = "Добавляю AND status <> 'refunded'."
    complete = (
        "```sql\nSELECT SUM(price * COALESCE(items, 0)) AS income_from_female "
        "FROM Purchases WHERE user_gender IN ('Female', 'F') "
        "AND status <> 'refunded'\n```"
    )

    ignored = soak_module.evaluate_continuity_screen_probe(2, current_view_only)
    carried = soak_module.evaluate_continuity_screen_probe(2, complete)

    assert ignored["passed"] is False
    assert "null_items_as_zero" in ignored["missing_keys"]
    assert "income_alias" in ignored["missing_keys"]
    assert carried["passed"] is True


def test_runtime_continuity_frames_are_deterministic_and_pairwise_distinct() -> None:
    first = [soak_module.render_continuity_screen_frame(index) for index in range(3)]
    second = [soak_module.render_continuity_screen_frame(index) for index in range(3)]

    assert first == second
    assert len(set(first)) == 3
    assert all(frame.startswith(b"\x89PNG\r\n\x1a\n") for frame in first)


def test_cli_turns_unexpected_private_failure_into_safe_partial_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report_path = tmp_path / "safe-catch-all.json"

    class FakeProcess:
        pid = os.getpid()

        def poll(self):
            return None

        def terminate(self):
            return None

        def wait(self, timeout=None):
            return 0

        def kill(self):
            return None

    async def crash_soak(**_kwargs):
        _kwargs["progress"]["checkpoints"].append(
            {
                "case": "safe-checkpoint-before-failure",
                "stt_ms": 321,
                "failure_codes": [],
            }
        )
        raise RuntimeError("PRIVATE transcript C:\\Users\\person\\audio.wav")

    monkeypatch.setattr(
        soak_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        soak_module.subprocess, "Popen", lambda *_args, **_kwargs: FakeProcess()
    )
    monkeypatch.setattr(
        soak_module.OwnedProcessTree,
        "capture",
        classmethod(lambda _cls, _pid: object()),
    )
    monkeypatch.setattr(
        soak_module, "_terminate_owned_process_tree", lambda *_args: None
    )
    monkeypatch.setattr(soak_module, "_wait_for_health", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(soak_module, "_run_soak", crash_soak)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_long_live_session.py",
            "--source-backend",
            "--duration-minutes",
            "1.5",
            "--checkpoint-minutes",
            "0,0.5,1.1",
            "--screen-checkpoint-minutes",
            "0.25,1.25",
            "--report",
            str(report_path),
        ],
    )

    assert soak_module.main() == 1
    report = report_path.read_text("utf-8").casefold()
    assert '"ok": false' in report
    assert '"failure_codes": [' in report
    assert '"soak_failed"' in report
    assert '"safe-checkpoint-before-failure"' in report
    for forbidden in ("private", "audio.wav", "c:\\users", "transcript"):
        assert forbidden not in report


def test_cleanup_attempts_every_resource_and_preserves_primary_failure_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report_path = tmp_path / "cleanup-safe-report.json"
    cleanup_calls: list[str] = []

    class FakeProcess:
        pid = os.getpid()

        def poll(self):
            return None

    async def crash_soak(**_kwargs):
        raise RuntimeError("PRIVATE primary failure")

    def fail_process_cleanup(*_args) -> None:
        cleanup_calls.append("process")
        raise RuntimeError("PRIVATE process cleanup")

    def fail_database_cleanup(*_args) -> None:
        cleanup_calls.append("database")
        raise RuntimeError("PRIVATE database cleanup")

    monkeypatch.setattr(
        soak_module, "seed_installed_gateway_identity", lambda _path: None
    )
    monkeypatch.setattr(
        soak_module.subprocess, "Popen", lambda *_args, **_kwargs: FakeProcess()
    )
    monkeypatch.setattr(
        soak_module.OwnedProcessTree,
        "capture",
        classmethod(lambda _cls, _pid: object()),
    )
    monkeypatch.setattr(soak_module, "_wait_for_health", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(soak_module, "_run_soak", crash_soak)
    monkeypatch.setattr(
        soak_module, "_terminate_owned_process_tree", fail_process_cleanup
    )
    monkeypatch.setattr(soak_module, "remove_sqlite_artifacts", fail_database_cleanup)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_long_live_session.py",
            "--source-backend",
            "--duration-minutes",
            "1.5",
            "--checkpoint-minutes",
            "0,0.5,1.1",
            "--screen-checkpoint-minutes",
            "0.25,1.25",
            "--report",
            str(report_path),
        ],
    )

    assert soak_module.main() == 1
    assert cleanup_calls == ["process", "database"]
    report = report_path.read_text("utf-8").casefold()
    assert '"soak_failed"' in report
    assert '"cleanup_failure_codes"' in report
    assert '"process_cleanup_failed"' in report
    assert '"database_cleanup_failed"' in report
    assert "private" not in report


def test_cli_help_documents_hybrid_route_and_backend_hotkey_boundary() -> None:
    help_text = soak_module.build_cli_parser().format_help().casefold()

    assert "--voice-provider openrouter" in help_text
    assert "--screen-provider openai" in help_text
    assert "--screen-model openai/gpt-5.6-sol" in help_text
    assert "backend finalize ownership" in help_text
    assert "does not press or verify the os/global hotkey" in help_text
