#!/usr/bin/env python3
"""Development-only real /chat/screen/stream check for a Python output task."""

from __future__ import annotations

import argparse
import ast
import base64
import binascii
import json
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from tools.dev_e2e_identity import seed_installed_gateway_identity
except ModuleNotFoundError:  # direct `python tools/verify_screen_code_task.py`
    from dev_e2e_identity import seed_installed_gateway_identity

try:
    from tools.backend_process import (
        OwnedProcessTree,
        remove_sqlite_artifacts,
        terminate_owned_process_tree,
    )
except ModuleNotFoundError:  # direct `python tools/verify_screen_code_task.py`
    from backend_process import (
        OwnedProcessTree,
        remove_sqlite_artifacts,
        terminate_owned_process_tree,
    )

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FONT = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
    "s": ("00000", "01111", "10000", "01110", "00001", "11110", "00000"),
    "p": ("00000", "11110", "10001", "11110", "10000", "10000", "10000"),
    "r": ("00000", "10110", "11001", "10000", "10000", "10000", "00000"),
    "i": ("00100", "00000", "01100", "00100", "00100", "00100", "01110"),
    "n": ("00000", "11110", "10001", "10001", "10001", "10001", "00000"),
    "t": ("01000", "01000", "11110", "01000", "01000", "00110", "00000"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "=": ("00000", "11111", "00000", "11111", "00000", "00000", "00000"),
    "(": ("00010", "00100", "01000", "01000", "01000", "00100", "00010"),
    ")": ("01000", "00100", "00010", "00010", "00010", "00100", "01000"),
    "[": ("01110", "01000", "01000", "01000", "01000", "01000", "01110"),
    "]": ("01110", "00010", "00010", "00010", "00010", "00010", "01110"),
    '"': ("01010", "01010", "00000", "00000", "00000", "00000", "00000"),
    " ": ("00000",) * 7,
}

LINES = ('s = "1234567890"', "print(s[6] == 7)", 's[0] = "H"', "print(s)")

FIXTURE_TRACE = [
    "session_fixture",
    "module_fixture",
    "autouse_fixture",
    "fixture_3",
    "fixture_4",
    "fixture_1",
    "fixture_2",
    "test_order",
    "fixture_4",
]

REAL_INTERVIEW_SCENARIO_IDS = {
    "candidate-cold-start-active-speech",
    "duplicate-screen-command",
    "screen-first-answer-at-26000ms",
    "multiscroll-gitlab-cicd",
    "simple-order-sql-refinement",
    "route-checklist-novelty",
    "truncated-code-stream",
    "long-session-95m",
}

_SCENARIO_FIELDS: dict[str, set[str]] = {
    "candidate-cold-start-active-speech": {
        "kind",
        "timeline",
        "expectedSelectedPhrase",
        "invariants",
    },
    "duplicate-screen-command": {
        "kind",
        "captureDelayMs",
        "streamChunks",
        "invariants",
    },
    "screen-first-answer-at-26000ms": {
        "kind",
        "watchdogMs",
        "transportCommentAtMs",
        "firstChunkAtMs",
        "invariants",
    },
    "multiscroll-gitlab-cicd": {
        "kind",
        "viewport",
        "frames",
        "questions",
        "requiredConceptGroups",
        "forbiddenConcepts",
        "budgets",
    },
    "simple-order-sql-refinement": {
        "kind",
        "screenText",
        "questions",
        "requiredConceptGroups",
        "forbiddenConcepts",
        "format",
        "budgets",
    },
    "route-checklist-novelty": {
        "kind",
        "screenText",
        "questions",
        "requiredNewConceptCount",
        "minimumNovelConceptCount",
        "maximumBulletJaccard",
        "forbiddenConcepts",
        "budgets",
    },
    "truncated-code-stream": {
        "kind",
        "providerText",
        "finishReason",
        "expectedSseTypes",
        "forbiddenSseTypes",
        "invariants",
    },
    "long-session-95m": {
        "kind",
        "durationMinutes",
        "voiceCheckpointMinutes",
        "screenCheckpointMinutes",
        "budgets",
        "forbiddenFailureCodes",
    },
}

_SCENARIO_KINDS = {
    "candidate-cold-start-active-speech": "desktop-sequence",
    "duplicate-screen-command": "desktop-sequence",
    "screen-first-answer-at-26000ms": "transport-sequence",
    "multiscroll-gitlab-cicd": "screen-sequence",
    "simple-order-sql-refinement": "screen-sequence",
    "route-checklist-novelty": "screen-sequence",
    "truncated-code-stream": "stream-sequence",
    "long-session-95m": "soak",
}

_SEMANTIC_CHECK_KEYS: dict[str, frozenset[str]] = {
    "multiscroll-gitlab-cicd": frozenset(
        {
            "gitlab_identified",
            "prior_frame_defect",
            "current_frame_defect",
            "not_github_actions",
        }
    ),
    "simple-order-sql-refinement": frozenset(
        {
            "preserved_get_order_signature",
            "parameterized_order_lookup",
            "minimal_order_solution",
            "no_forbidden_architecture",
            "russian_spoken_plan",
            "balanced_single_fence",
            "russian_comment_pairs",
        }
    ),
    "route-checklist-novelty": frozenset(
        {
            "first_exactly_five_endpoint_checks",
            "first_distinct_checks",
            "refinement_exactly_three_business_checks",
            "three_distinct_concepts",
            "all_three_genuinely_new",
            "no_near_duplicate_bullets",
            "no_database_inspection",
        }
    ),
}

_INITIAL_SEMANTIC_CHECK_KEYS: dict[str, frozenset[str]] = {
    "multiscroll-gitlab-cicd": frozenset(
        {
            "gitlab_identified",
            "prior_frame_defect",
            "current_frame_defect",
        }
    ),
    "simple-order-sql-refinement": frozenset(
        {
            "preserved_get_order_signature",
            "parameterized_order_lookup",
            "minimal_order_solution",
            "no_forbidden_architecture",
        }
    ),
    "route-checklist-novelty": frozenset(
        {
            "first_exactly_five_endpoint_checks",
            "first_distinct_checks",
        }
    ),
}

_SAFE_REGRESSION_ATTEMPT_FIELDS = {
    "case_id": "caseId",
    "repetition": "repetition",
    "model": "model",
    "transport_first_byte_ms": "transportFirstByteMs",
    "model_first_chunk_ms": "modelFirstChunkMs",
    "total_ms": "totalMs",
    "semantic_checks": "semanticChecks",
    "initial_semantic_checks": "initialSemanticChecks",
    "final_typed_state_diagnostics": "finalTypedStateDiagnostics",
    "initial_typed_state_diagnostics": "initialTypedStateDiagnostics",
    "failure_codes": "failureCodes",
    "failure_stage": "failureStage",
    "retry_count": "retryCount",
}

_TYPED_STATE_DIAGNOSTIC_FIELDS = frozenset(
    {
        "observationAccepted",
        "frameCount",
        "activeFindingCount",
        "activeSourceCount",
        "generationCompleted",
    }
)
_MAX_TYPED_DIAGNOSTIC_FRAMES = 3
_MAX_TYPED_DIAGNOSTIC_FINDINGS = 96
_MAX_TYPED_DIAGNOSTIC_SOURCES = 32

_TYPED_SCREEN_FAILURE_CODES = frozenset(
    {
        "invalid_screen_observation",
        "invalid_screen_answer",
        "unsupported_screen_python_profile",
        "invalid_screen_task_state",
        "invalid_screen_task_action",
        "screen_task_state_expired",
    }
)

_COMMON_FAILURE_CODES = (
    frozenset(
        {
            "semantic_gate",
            "transport_first_byte_budget",
            "model_first_chunk_budget",
            "total_time_budget",
            "backend_unreachable",
            "auth_failed",
            "quota_exceeded",
            "rate_limited",
            "provider_timeout",
            "provider_error",
            "provider_output_truncated",
            "malformed_protocol",
            "missing_done",
            "render_failed",
            "scorer_failed",
            "request_failed",
            "circuit_open",
        }
    )
    | _TYPED_SCREEN_FAILURE_CODES
)

_FAILURE_STAGES = frozenset(
    {"initial_request", "refinement_request", "render", "scorer", "circuit"}
)
_TRANSIENT_FAILURE_CODES = frozenset(
    {"backend_unreachable", "rate_limited", "provider_timeout", "provider_error"}
)
_RATE_LIMIT_RETRY_DELAY_SECONDS = 2.0
_TRANSIENT_RETRY_DELAY_SECONDS = 0.2
_MANAGED_DEV_GATEWAY_URL = "https://skill-cue.ru/v1"
_NULL_KEYRING_BACKEND = "keyring.backends.null.Keyring"

_CASE_FAILURE_CODES = {
    "multiscroll-gitlab-cicd": _COMMON_FAILURE_CODES | {"cross_viewport_semantics"},
    "simple-order-sql-refinement": _COMMON_FAILURE_CODES | {"sql_parameter_binding"},
    "route-checklist-novelty": _COMMON_FAILURE_CODES | {"checklist_semantics"},
}

_MODEL_IDENTIFIER = re.compile(
    r"(?:unknown|[a-z0-9][a-z0-9._+-]{0,127}|"
    r"[a-z0-9][a-z0-9._-]{0,31}/[a-z0-9][a-z0-9._+-]{0,94}"
    r"(?::[a-z0-9][a-z0-9._-]{0,31})?)",
    re.IGNORECASE,
)


def _safe_model_identifier(value: object) -> str:
    return (
        value
        if isinstance(value, str) and _MODEL_IDENTIFIER.fullmatch(value)
        else "unknown"
    )


def _scenario_path() -> Path:
    return (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "real-interview-overlay"
        / "scenarios.json"
    )


def _expect_exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")  # noqa: TRY004 - public validation API
    actual = set(value)
    if actual != keys:
        missing = sorted(keys - actual)
        unexpected = sorted(actual - keys)
        raise ValueError(
            f"{label} has invalid properties; missing required properties={missing}, "
            f"unexpected={unexpected}"
        )
    return value


def _expect_int(value: Any, label: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be an integer in [{minimum}, {maximum}]")
    return value


def _expect_number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if type(value) not in (int, float) or not minimum <= float(value) <= maximum:
        raise ValueError(f"{label} must be a number in [{minimum}, {maximum}]")
    return float(value)


_WINDOWS_ABSOLUTE_PATH = re.compile(r"(?:^|[\s\"'])[a-z]:[\\/]", re.IGNORECASE)
_POSIX_PRIVATE_PATH = re.compile(r"(?:^|\s)/(?:users|home|tmp|var|etc)/", re.IGNORECASE)
_RAW_BASE64 = re.compile(r"^[a-z0-9+/]{128,}={0,2}$", re.IGNORECASE)


def _expect_safe_string(
    value: Any,
    label: str,
    *,
    maximum: int = 10_000,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{label} must be a non-empty string")
    if len(value) > maximum:
        raise ValueError(f"{label} exceeds {maximum} characters")
    normalized = value.strip()
    if (
        _WINDOWS_ABSOLUTE_PATH.search(normalized)
        or normalized.startswith("\\\\")
        or "file://" in normalized.casefold()
        or _POSIX_PRIVATE_PATH.search(normalized)
        or re.search(r"data:[^\s;,]+;base64,", normalized, re.IGNORECASE)
        or _RAW_BASE64.fullmatch(normalized)
    ):
        raise ValueError(f"{label} contains a path or raw media/base64 content")
    return value


def _expect_string_list(
    value: Any,
    label: str,
    *,
    minimum: int = 1,
    maximum: int = 100,
    item_maximum: int = 2_000,
) -> list[str]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{label} must contain between {minimum} and {maximum} strings"
        )
    return [
        _expect_safe_string(item, f"{label}[{index}]", maximum=item_maximum)
        for index, item in enumerate(value)
    ]


def _validate_invariants(value: Any, label: str) -> None:
    invariants = _expect_string_list(value, label, maximum=20, item_maximum=80)
    if len(invariants) != len(set(invariants)):
        raise ValueError(f"{label} must not contain duplicates")
    if any(not re.fullmatch(r"[a-z0-9_]+", invariant) for invariant in invariants):
        raise ValueError(f"{label} must contain stable identifiers")


def _validate_budgets(value: Any, keys: set[str], label: str) -> None:
    budgets = _expect_exact_keys(value, keys, label)
    for key, budget in budgets.items():
        _expect_int(budget, f"{label}.{key}", 1, 600_000)


def _validate_alias_groups(value: Any, keys: set[str], label: str) -> None:
    groups = _expect_exact_keys(value, keys, label)
    for key, aliases in groups.items():
        _expect_string_list(aliases, f"{label}.{key}", maximum=20, item_maximum=160)


def _validate_questions(value: Any, label: str) -> None:
    questions = _expect_string_list(
        value, label, minimum=2, maximum=2, item_maximum=1_000
    )
    if questions[0] == questions[1]:
        raise ValueError(f"{label} must contain two distinct questions")


def _validate_timeline(value: Any, label: str) -> None:
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        raise ValueError(f"{label} must be a bounded list")
    event_keys = {
        "ipc-before-subscribe": {"atMs", "event"},
        "renderer-subscribe": {"atMs", "event"},
        "mic-final": {"atMs", "event", "text"},
        "candidate-hotkey": {"atMs", "event", "sourceSpeaking"},
        "request-final": {"atMs", "event", "text"},
    }
    times: list[int] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or not isinstance(item.get("event"), str):
            raise ValueError(  # noqa: TRY004 - public validation API
                f"{label}[{index}] must be an event object"
            )
        event = item["event"]
        if event not in event_keys:
            raise ValueError(f"{label}[{index}] has an unknown event")
        record = _expect_exact_keys(item, event_keys[event], f"{label}[{index}]")
        times.append(_expect_int(record["atMs"], f"{label}[{index}].atMs", 0, 120_000))
        if "text" in record:
            _expect_safe_string(record["text"], f"{label}[{index}].text", maximum=1_000)
        if "sourceSpeaking" in record and type(record["sourceSpeaking"]) is not bool:
            raise ValueError(f"{label}[{index}].sourceSpeaking must be boolean")
    if times != sorted(times) or len(times) != len(set(times)):
        raise ValueError(f"{label} timestamps must be strictly increasing")


def _validate_checkpoints(value: Any, label: str, duration: float) -> None:
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        raise ValueError(f"{label} must be a bounded list")
    checkpoints = [
        _expect_number(item, f"{label}[{index}]", 0, duration)
        for index, item in enumerate(value)
    ]
    if checkpoints != sorted(checkpoints) or len(checkpoints) != len(set(checkpoints)):
        raise ValueError(f"{label} must be strictly increasing")


def _validate_scenario(scenario_id: str, raw: dict[str, Any]) -> None:
    fields = _SCENARIO_FIELDS[scenario_id] | {"id"}
    scenario = _expect_exact_keys(raw, fields, f"scenario {scenario_id}")
    if scenario["kind"] != _SCENARIO_KINDS[scenario_id]:
        raise ValueError(f"scenario {scenario_id} has invalid kind")

    if scenario_id == "candidate-cold-start-active-speech":
        _validate_timeline(scenario["timeline"], f"scenario {scenario_id}.timeline")
        _expect_safe_string(
            scenario["expectedSelectedPhrase"],
            f"scenario {scenario_id}.expectedSelectedPhrase",
            maximum=1_000,
        )
        _validate_invariants(
            scenario["invariants"], f"scenario {scenario_id}.invariants"
        )
        return
    if scenario_id == "duplicate-screen-command":
        _expect_int(
            scenario["captureDelayMs"],
            f"scenario {scenario_id}.captureDelayMs",
            0,
            60_000,
        )
        _expect_string_list(
            scenario["streamChunks"], f"scenario {scenario_id}.streamChunks"
        )
        _validate_invariants(
            scenario["invariants"], f"scenario {scenario_id}.invariants"
        )
        return
    if scenario_id == "screen-first-answer-at-26000ms":
        watchdog = _expect_int(
            scenario["watchdogMs"], f"scenario {scenario_id}.watchdogMs", 1, 120_000
        )
        comments = scenario["transportCommentAtMs"]
        if not isinstance(comments, list) or not 1 <= len(comments) <= 20:
            raise ValueError(
                f"scenario {scenario_id}.transportCommentAtMs must be a bounded list"
            )
        comment_times = [
            _expect_int(
                value,
                f"scenario {scenario_id}.transportCommentAtMs[{index}]",
                1,
                120_000,
            )
            for index, value in enumerate(comments)
        ]
        first_chunk = _expect_int(
            scenario["firstChunkAtMs"],
            f"scenario {scenario_id}.firstChunkAtMs",
            1,
            120_000,
        )
        if comment_times != sorted(set(comment_times)) or any(
            value >= first_chunk for value in comment_times
        ):
            raise ValueError(
                f"scenario {scenario_id} transport comments must precede first chunk"
            )
        if watchdog >= first_chunk:
            raise ValueError(f"scenario {scenario_id} must exercise the watchdog edge")
        _validate_invariants(
            scenario["invariants"], f"scenario {scenario_id}.invariants"
        )
        return
    if scenario_id == "multiscroll-gitlab-cicd":
        viewport = _expect_exact_keys(
            scenario["viewport"],
            {"width", "height"},
            f"scenario {scenario_id}.viewport",
        )
        _expect_int(
            viewport["width"], f"scenario {scenario_id}.viewport.width", 320, 4096
        )
        _expect_int(
            viewport["height"], f"scenario {scenario_id}.viewport.height", 240, 2160
        )
        if not isinstance(scenario["frames"], list) or len(scenario["frames"]) != 2:
            raise ValueError(
                f"scenario {scenario_id}.frames must contain exactly two frames"
            )
        for index, frame in enumerate(scenario["frames"]):
            frame = _expect_exact_keys(
                frame, {"text"}, f"scenario {scenario_id}.frames[{index}]"
            )
            _expect_string_list(
                frame["text"], f"scenario {scenario_id}.frames[{index}].text"
            )
        _validate_questions(scenario["questions"], f"scenario {scenario_id}.questions")
        _validate_alias_groups(
            scenario["requiredConceptGroups"],
            {"gitlab_identified", "prior_frame_defect", "current_frame_defect"},
            f"scenario {scenario_id}.requiredConceptGroups",
        )
        _expect_string_list(
            scenario["forbiddenConcepts"], f"scenario {scenario_id}.forbiddenConcepts"
        )
        _validate_budgets(
            scenario["budgets"],
            {"transportFirstByteMs", "firstChunkMs", "totalMs"},
            f"scenario {scenario_id}.budgets",
        )
        return
    if scenario_id == "simple-order-sql-refinement":
        _expect_string_list(
            scenario["screenText"], f"scenario {scenario_id}.screenText"
        )
        _validate_questions(scenario["questions"], f"scenario {scenario_id}.questions")
        _validate_alias_groups(
            scenario["requiredConceptGroups"],
            {
                "get_order",
                "order_id",
                "select",
                "from",
                "where",
                "parameter_placeholder",
            },
            f"scenario {scenario_id}.requiredConceptGroups",
        )
        _expect_string_list(
            scenario["forbiddenConcepts"], f"scenario {scenario_id}.forbiddenConcepts"
        )
        format_contract = _expect_exact_keys(
            scenario["format"],
            {"language", "spokenPlanLanguage", "fencedCodeBlocks", "commentsBelowCode"},
            f"scenario {scenario_id}.format",
        )
        if format_contract != {
            "language": "python",
            "spokenPlanLanguage": "ru",
            "fencedCodeBlocks": 1,
            "commentsBelowCode": True,
        }:
            raise ValueError(
                f"scenario {scenario_id}.format does not match the strict contract"
            )
        _validate_budgets(
            scenario["budgets"],
            {"transportFirstByteMs", "firstChunkMs", "totalMs"},
            f"scenario {scenario_id}.budgets",
        )
        return
    if scenario_id == "route-checklist-novelty":
        _expect_string_list(
            scenario["screenText"], f"scenario {scenario_id}.screenText"
        )
        _validate_questions(scenario["questions"], f"scenario {scenario_id}.questions")
        if (
            _expect_int(
                scenario["requiredNewConceptCount"],
                f"scenario {scenario_id}.requiredNewConceptCount",
                1,
                10,
            )
            != 3
        ):
            raise ValueError(
                f"scenario {scenario_id} requires exactly three refinement checks"
            )
        _expect_int(
            scenario["minimumNovelConceptCount"],
            f"scenario {scenario_id}.minimumNovelConceptCount",
            0,
            3,
        )
        _expect_number(
            scenario["maximumBulletJaccard"],
            f"scenario {scenario_id}.maximumBulletJaccard",
            0,
            1,
        )
        _expect_string_list(
            scenario["forbiddenConcepts"], f"scenario {scenario_id}.forbiddenConcepts"
        )
        _validate_budgets(
            scenario["budgets"],
            {"transportFirstByteMs", "firstChunkMs", "totalMs"},
            f"scenario {scenario_id}.budgets",
        )
        return
    if scenario_id == "truncated-code-stream":
        _expect_safe_string(
            scenario["providerText"], f"scenario {scenario_id}.providerText"
        )
        if scenario["finishReason"] != "length":
            raise ValueError(f"scenario {scenario_id}.finishReason must be length")
        _expect_string_list(
            scenario["expectedSseTypes"], f"scenario {scenario_id}.expectedSseTypes"
        )
        _expect_string_list(
            scenario["forbiddenSseTypes"], f"scenario {scenario_id}.forbiddenSseTypes"
        )
        _validate_invariants(
            scenario["invariants"], f"scenario {scenario_id}.invariants"
        )
        return

    duration = _expect_number(
        scenario["durationMinutes"], f"scenario {scenario_id}.durationMinutes", 1, 180
    )
    _validate_checkpoints(
        scenario["voiceCheckpointMinutes"],
        f"scenario {scenario_id}.voiceCheckpointMinutes",
        duration,
    )
    _validate_checkpoints(
        scenario["screenCheckpointMinutes"],
        f"scenario {scenario_id}.screenCheckpointMinutes",
        duration,
    )
    _validate_budgets(
        scenario["budgets"],
        {
            "sttMs",
            "llmFirstChunkMs",
            "triggerToFirstAnswerMs",
            "screenTransportFirstByteMs",
            "screenFirstChunkMs",
            "screenTotalMs",
            "workingSetGrowthMiB",
        },
        f"scenario {scenario_id}.budgets",
    )
    _expect_string_list(
        scenario["forbiddenFailureCodes"],
        f"scenario {scenario_id}.forbiddenFailureCodes",
    )


def load_real_interview_scenarios(
    path: Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Load the shared sanitized contract after strict nested/privacy validation."""
    source = path or _scenario_path()
    document = json.loads(source.read_text("utf-8"))
    document = _expect_exact_keys(document, {"schemaVersion", "scenarios"}, "document")
    if document["schemaVersion"] != 1 or not isinstance(document["scenarios"], list):
        raise ValueError("invalid real-interview scenario document")
    scenarios: dict[str, dict[str, Any]] = {}
    for raw in document["scenarios"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise ValueError("scenario id is required")  # noqa: TRY004 - validation API
        scenario_id = raw["id"]
        if scenario_id in scenarios:
            raise ValueError(f"duplicate scenario id: {scenario_id}")
        if scenario_id not in _SCENARIO_FIELDS:
            raise ValueError(f"unexpected scenario id: {scenario_id}")
        _validate_scenario(scenario_id, raw)
        scenarios[scenario_id] = raw
    if set(scenarios) != REAL_INTERVIEW_SCENARIO_IDS:
        missing = sorted(REAL_INTERVIEW_SCENARIO_IDS - set(scenarios))
        raise ValueError(f"missing required scenarios: {', '.join(missing)}")
    return scenarios


def _contains_any(text: str, aliases: Sequence[str]) -> bool:
    normalized = text.casefold()
    return any(alias.casefold() in normalized for alias in aliases)


def _contains_uncontradicted_claim(text: str, aliases: Sequence[str]) -> bool:
    """Match a bounded natural-language claim, but not an explicit denial of it."""
    normalized = re.sub(r"[`*]+", "", text.casefold())
    # Russian speakers commonly strengthen a negative predicate with
    # ``ничего не`` ("does not build anything").  Collapse only that bounded
    # grammatical construction so an existing negative predicate alias still
    # matches; denial and quotation guards below continue to see their context.
    normalized = re.sub(r"\bничего\s+не\s+(?=[a-zа-яё])", "не ", normalized)
    denial_before = re.compile(
        r"(?:(?:неверно|неправда|ошибочно)\s*,?\s*"
        r"(?:считать\s*,?\s*)?(?:что\s+)?|(?:это\s+)?(?<![\w])не\s+)$"
        r"|(?:не\s+могу|нельзя)\s+(?:сказать|утверждать|считать)\s*,?\s*"
        r"(?:что\s+)?$"
    )
    scoped_denial_before = re.compile(
        r"(?:(?:неверно|неправда|ошибочно)\s*,?\s*"
        r"(?:считать\s*,?\s*)?(?:что\s+)?)[^.!?;\n]{0,160}$"
    )
    denial_after = re.compile(
        r"^\s*[»\"']?\s*(?:[-—,:]\s*)?"
        r"(?:(?:но|однако)\s+)?(?:не\s+(?:подтвержда\w*|явля\w*|"
        r"сохраня\w*|означа\w*)|"
        r"(?:это\s+)?(?:неверн\w*|неправд\w*|ошибочн\w*))"
        r"|^\s*\?\s*(?:нет|неверно)"
        r"(?:\s*[,;:—-]\s*|\s*[.!?]\s*|\s+)"
        r"(?:(?:он|она|оно|они|этап|stage)\s+)?"
        r"(?:вход\w*|объяв\w*|указ\w*|определ\w*|собира\w*|"
        r"выполня\w*|запуска\w*|очища\w*)"
    )
    quoted_or_attributed = re.compile(
        r"(?:фраз\w*|утвержден\w*|цитат\w*)[^.!?;\n]{0,32}$"
    )
    scoped_quote_before = re.compile(
        r"(?:фраз\w*|утвержден\w*|цитат\w*)[^.!?;\n]{0,32}"
        r"[«\"'][^»\"'\n]{0,160}$"
    )
    disclaimed_quote = re.compile(
        r"^[^.!?;\n]{0,96}(?:чуж\w*\s+пример\w*|не\s+мой\s+вывод|"
        r"из\s+(?:вопроса|ответа|документац\w*)[^.!?;\n]{0,24}"
        r"(?:неверн\w*|ошибочн\w*))"
    )
    direct_attribution = re.compile(
        r"(?:интервьюер|автор|пользователь)\s+"
        r"(?:сказал\w*|написал\w*|утверждал\w*|спросил\w*|отметил\w*)"
        r"\s*(?::|,?\s+что)?\s*[«\"']?\s*$"
    )
    for alias in aliases:
        needle = alias.casefold()
        start = 0
        while (index := normalized.find(needle, start)) >= 0:
            before = normalized[max(0, index - 192) : index]
            claim_end = index + len(needle)
            word_tail = re.match(r"[a-zа-яё]*", normalized[claim_end:])
            if word_tail is not None:
                claim_end += len(word_tail.group(0))
            after = normalized[claim_end : claim_end + 128]
            is_attributed_disclaimer = bool(
                (
                    quoted_or_attributed.search(before)
                    or scoped_quote_before.search(before)
                )
                and disclaimed_quote.search(after)
            )
            if (
                not denial_before.search(before)
                and not scoped_denial_before.search(before)
                and not denial_after.search(after)
                and not is_attributed_disclaimer
                and not direct_attribution.search(before)
            ):
                return True
            start = index + len(needle)
    return False


_GITLAB_PRIOR_DEFECT_PATTERNS = (
    re.compile(
        r"\bbuild_job\b[^.!?;\n]{0,96}\b(?:отсутств\w*[^.!?;\n]{0,32}"
        r"(?:реальн\w*\s+)?сборк\w*|(?:реальн\w*\s+)?сборк\w*"
        r"[^.!?;\n]{0,24}(?:нет|отсутств\w*))[^.!?;\n]{0,96}"
        r"\bscript\s*:?\s*(?:указ\w*\s+)?echo\s+build\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bbuild_job\b[^.!?;\n]{0,96}\bscript\s*:\s*echo\b"
        r"[^.!?;\n]{0,96}\b(?:реальн\w*\s+сборк\w*\s+"
        r"(?:нет|отсутств\w*)|сборк\w*\s+не\s+"
        r"(?:выполня\w*|запуска\w*|происход\w*))",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bbuild_job\b\s+(?:фактически\s+)?не\s+"
        r"(?:выполня\w*|производ\w*)[^.!?;\n]{0,48}\b"
        r"(?:операц\w*\s+)?сборк\w*",
        re.IGNORECASE,
    ),
)


_GITLAB_CURRENT_DEFECT_PATTERNS = (
    re.compile(
        r"\bregression_test_job\b[^.!?;\n]{0,96}\bscript\s*:\s*echo\b"
        r"[^.!?;\n]{0,96}\b(?:регрессионн\w*\s+)?тест\w*\s+не\s+"
        r"(?:запуска\w*|выполня\w*)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bstage\s*:\s*post\b[^.!?;\n]{0,96}\bне\s+вход\w*\s+в\s+"
        r"(?:объявлен\w*\s+)?(?:спис\w*\s+)?stages\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bpost_cleanup_job\b[^.!?;\n]{0,64}\bудал\w*"
        r"[^.!?;\n]{0,32}\b(?:тег\w*|tags?)\b[^.!?;\n]{0,64}"
        r"\b(?:хотя|но|однако)\b[^.!?;\n]{0,48}\bкомментар\w*\b"
        r"[^.!?;\n]{0,48}\b(?:обещ\w*|говор\w*|опис\w*)\b"
        r"[^.!?;\n]{0,32}\bочист\w*\s+(?:cache|кэш\w*)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bstage\s+post\b[^.!?;\n]{0,64}\bне\s+вход\w*\s+в\s+"
        r"(?:спис\w*\s+)?stages\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bstage\s+post\b[^.!?;\n]{0,64}\bне\s+"
        r"(?:указ\w*|определ\w*|добав\w*)[^.!?;\n]{0,32}\bstages\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bregression_test_job\b[^.!?;\n]{0,64}\b(?:лишь|только)\s+"
        r"(?:печата\w*\s+)?echo\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:\b(?:команд\w+\s+)?удал\w*[^.!?;\n]{0,48}\b(?:тег\w*|tags?)\b|"
        r"\b(?:тег\w*|tags?)\b[^.!?;\n]{0,32}\bудал\w*)"
        r"[^.!?;\n]{0,64}\bвместо\s+очист\w*\s+(?:cache|кэш\w*)\b",
        re.IGNORECASE,
    ),
)


def _contains_bounded_gitlab_prior_defect(text: str) -> bool:
    """Match one coherent prior-frame YAML defect with denial guards."""
    normalized = re.sub(r"[`*]+", "", text.casefold())
    for pattern in _GITLAB_PRIOR_DEFECT_PATTERNS:
        for match in pattern.finditer(normalized):
            if _contains_uncontradicted_claim(normalized, [match.group(0)]):
                return True
    return False


def _contains_bounded_gitlab_current_defect(text: str) -> bool:
    """Match one coherent current-frame defect, preserving denial guards."""
    normalized = re.sub(r"[`*]+", "", text.casefold())
    for pattern in _GITLAB_CURRENT_DEFECT_PATTERNS:
        for match in pattern.finditer(normalized):
            if _contains_uncontradicted_claim(normalized, [match.group(0)]):
                return True
    return False


def score_multiscroll_gitlab_answer(answer: str) -> dict[str, Any]:
    scenario = load_real_interview_scenarios()["multiscroll-gitlab-cicd"]
    groups = scenario["requiredConceptGroups"]
    forbidden = scenario["forbiddenConcepts"]
    checks = {
        "gitlab_identified": _contains_uncontradicted_claim(
            answer,
            groups["gitlab_identified"],
        ),
        "prior_frame_defect": _contains_uncontradicted_claim(
            answer,
            groups["prior_frame_defect"],
        )
        or _contains_bounded_gitlab_prior_defect(answer),
        "current_frame_defect": (
            _contains_uncontradicted_claim(
                answer,
                groups["current_frame_defect"],
            )
            or _contains_bounded_gitlab_current_defect(answer)
        ),
        "not_github_actions": not _contains_any(answer, forbidden),
    }
    return {"passed": all(checks.values()), "checks": checks}


def _balanced_fenced_block(answer: str) -> bool:
    return _single_fenced_code(answer) is not None


def _single_fenced_block(answer: str) -> tuple[str, str] | None:
    matches = list(
        re.finditer(
            r"```(?P<language>[a-zA-Z0-9_+-]*)[ \t]*\n(?P<code>.*?)```",
            answer,
            re.DOTALL,
        )
    )
    if answer.count("```") != 2 or len(matches) != 1:
        return None
    language = matches[0].group("language").casefold()
    code = matches[0].group("code")
    return (language, code) if code.strip() else None


def _single_fenced_code(answer: str) -> str | None:
    block = _single_fenced_block(answer)
    if block is None:
        return None
    language, code = block
    if language not in {"python", "py"}:
        return None
    return code


def _russian_plan_before_code(answer: str) -> bool:
    fence = answer.find("```")
    if fence <= 0:
        return False
    plan = answer[:fence].strip()
    return 0 < len(plan) <= 500 and bool(re.search(r"[а-яё]", plan, re.IGNORECASE))


def _russian_comment_pairs(code: str | None) -> bool:
    if not code:
        return False
    lines = [line.rstrip() for line in code.splitlines() if line.strip()]
    code_indexes = [
        index
        for index, line in enumerate(lines)
        if not line.lstrip().startswith(("#", "--", "//"))
    ]
    if not code_indexes:
        return False
    for index in code_indexes:
        if re.search(r"\S\s+(?:#|--|//)\s*\S", lines[index]):
            return False
        if index + 1 >= len(lines):
            return False
        comment = lines[index + 1]
        if not re.match(r"^\s*(?:#|--|//)\s*.*[а-яё]", comment, re.IGNORECASE):
            return False
    return True


_PROTECTED_GET_ORDER_NAMES = frozenset({"conn", "order_id", "dict"})


def _node_binds_any_name(node: ast.AST, names: frozenset[str]) -> bool:
    for candidate in ast.walk(node):
        if (
            isinstance(candidate, ast.Name)
            and isinstance(candidate.ctx, (ast.Store, ast.Del))
            and candidate.id in names
        ):
            return True
        if isinstance(candidate, ast.arg) and candidate.arg in names:
            return True
        if isinstance(candidate, ast.alias):
            bound_name = candidate.asname or candidate.name.partition(".")[0]
            if bound_name in names:
                return True
        if isinstance(candidate, ast.ExceptHandler) and candidate.name in names:
            return True
        if isinstance(candidate, (ast.Global, ast.Nonlocal)) and any(
            name in names for name in candidate.names
        ):
            return True
        if (
            isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and candidate.name in names
        ):
            return True
        if (
            isinstance(candidate, (ast.MatchAs, ast.MatchStar))
            and candidate.name in names
        ):
            return True
        if isinstance(candidate, ast.MatchMapping) and candidate.rest in names:
            return True
    return False


def _node_binds_protected_get_order_name(node: ast.AST) -> bool:
    return _node_binds_any_name(node, _PROTECTED_GET_ORDER_NAMES)


def _has_module_protected_name_rebinding(
    tree: ast.Module,
    function: ast.FunctionDef,
) -> bool:
    return any(
        statement is not function and _node_binds_protected_get_order_name(statement)
        for statement in tree.body
    )


def _is_name_annotation(node: ast.AST | None, name: str) -> bool:
    return isinstance(node, ast.Name) and node.id == name


def _is_expected_get_order_return_annotation(node: ast.AST | None) -> bool:
    if not (
        isinstance(node, ast.Subscript)
        and _is_name_annotation(node.value, "list")
        and isinstance(node.slice, ast.Subscript)
        and _is_name_annotation(node.slice.value, "dict")
        and isinstance(node.slice.slice, ast.Tuple)
        and len(node.slice.slice.elts) == 2
    ):
        return False
    key_type, value_type = node.slice.slice.elts
    return _is_name_annotation(key_type, "str") and _is_name_annotation(
        value_type, "Any"
    )


def _preserves_get_order_signature(code: str | None) -> bool:
    if not code:
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if len(functions) != 1 or not isinstance(functions[0], ast.FunctionDef):
        return False
    function = functions[0]
    arguments = function.args
    return (
        function.name == "get_order"
        and not _has_module_protected_name_rebinding(tree, function)
        and not function.decorator_list
        and not arguments.posonlyargs
        and [argument.arg for argument in arguments.args] == ["conn", "order_id"]
        and arguments.args[0].annotation is None
        and _is_name_annotation(arguments.args[1].annotation, "int")
        and _is_expected_get_order_return_annotation(function.returns)
        and not arguments.kwonlyargs
        and arguments.vararg is None
        and arguments.kwarg is None
        and not arguments.defaults
        and not any(
            isinstance(node, (ast.Yield, ast.YieldFrom, ast.Await))
            for node in ast.walk(function)
        )
    )


def _literal_string(node: ast.AST, assignments: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return assignments.get(node.id)
    return None


def _resolved_parameter_node(node: ast.AST, assignments: dict[str, ast.AST]) -> ast.AST:
    if isinstance(node, ast.Name) and node.id != "order_id":
        return assignments.get(node.id, node)
    return node


def _is_order_id(node: ast.AST) -> bool:
    return isinstance(node, ast.Name) and node.id == "order_id"


def _valid_placeholder_binding(
    placeholder: str,
    parameter: ast.AST,
    assignments: dict[str, ast.AST],
) -> bool:
    parameter = _resolved_parameter_node(parameter, assignments)
    if placeholder in {"?", "%s"}:
        return (
            isinstance(parameter, (ast.Tuple, ast.List))
            and len(parameter.elts) == 1
            and _is_order_id(parameter.elts[0])
        )
    if placeholder == ":order_id":
        return (
            isinstance(parameter, ast.Dict)
            and len(parameter.keys) == 1
            and isinstance(parameter.keys[0], ast.Constant)
            and parameter.keys[0].value == "order_id"
            and _is_order_id(parameter.values[0])
        )
    return placeholder == "$1" and _is_order_id(parameter)


def _is_execute_call(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "execute"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "conn"
    )


def _execute_calls(node: ast.AST) -> list[ast.Call]:
    return [candidate for candidate in ast.walk(node) if _is_execute_call(candidate)]


def _dict_rows_list_comprehension(
    node: ast.AST | None,
) -> tuple[ast.AST, str] | None:
    if not isinstance(node, ast.ListComp) or len(node.generators) != 1:
        return None
    generator = node.generators[0]
    if (
        generator.is_async
        or generator.ifs
        or not isinstance(generator.target, ast.Name)
    ):
        return None
    row_name = generator.target.id
    if not (
        isinstance(node.elt, ast.Call)
        and isinstance(node.elt.func, ast.Name)
        and node.elt.func.id == "dict"
        and len(node.elt.args) == 1
        and isinstance(node.elt.args[0], ast.Name)
        and node.elt.args[0].id == row_name
        and not node.elt.keywords
    ):
        return None
    return generator.iter, row_name


def _has_protected_name_rebinding(function: ast.FunctionDef) -> bool:
    """Reject bounded binding constructs without interpreting candidate code."""
    return any(
        _node_binds_protected_get_order_name(statement) for statement in function.body
    )


_SQL_IDENTIFIER = r'(?:[a-z_][a-z0-9_]*|"(?:[^"]|"")*"|`[^`]+`|\[[^\]]+\])'


def _is_row_retrieval_projection(projection: str) -> bool:
    projection = projection.strip()
    if re.fullmatch(rf"(?:{_SQL_IDENTIFIER}\s*\.\s*)?\*", projection, re.IGNORECASE):
        return True
    columns = [column.strip() for column in projection.split(",")]
    return bool(columns) and all(
        re.fullmatch(
            rf"(?:{_SQL_IDENTIFIER}\s*\.\s*)?{_SQL_IDENTIFIER}"
            rf"(?:\s+(?:as\s+)?{_SQL_IDENTIFIER})?",
            column,
            re.IGNORECASE,
        )
        for column in columns
    )


def _simple_assignment(statement: ast.stmt) -> tuple[str, ast.AST] | None:
    if isinstance(statement, ast.Assign):
        if len(statement.targets) != 1 or not isinstance(
            statement.targets[0], ast.Name
        ):
            return None
        return statement.targets[0].id, statement.value
    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
        if statement.value is None:
            return None
        return statement.target.id, statement.value
    return None


def _has_only_required_module_nodes(
    tree: ast.Module,
    function: ast.FunctionDef,
) -> bool:
    extras = [node for node in tree.body if node is not function]
    if not extras:
        return True
    if len(extras) != 1 or not isinstance(extras[0], ast.ImportFrom):
        return False
    imported = extras[0]
    return (
        imported.level == 0
        and imported.module == "typing"
        and len(imported.names) == 1
        and imported.names[0].name == "Any"
        and imported.names[0].asname is None
    )


def _has_minimal_order_solution(code: str | None) -> bool:
    if not code:
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if len(functions) != 1 or not isinstance(functions[0], ast.FunctionDef):
        return False
    function = functions[0]
    if not _has_only_required_module_nodes(tree, function):
        return False
    if not _preserves_get_order_signature(code):
        return False
    if _has_protected_name_rebinding(function):
        return False
    if (
        len(
            [
                node
                for node in ast.walk(function)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "execute"
            ]
        )
        != 1
    ):
        return False
    if any(
        isinstance(node, (ast.Yield, ast.YieldFrom, ast.Await))
        for node in ast.walk(function)
    ):
        return False
    string_assignments: dict[str, str] = {}
    parameter_assignments: dict[str, ast.AST] = {}
    query_pattern = re.compile(
        r"\s*select\s+(?P<projection>.+?)\s+from\s+(?:[\"`\[]?order[\"`\]]?)"
        r"(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+where\s+"
        r"(?:[a-z_][a-z0-9_]*\.)?(?:[\"`\[]?id[\"`\]]?)\s*=\s*"
        r"(?P<placeholder>\?|%s|:order_id|\$1)(?:\s+limit\s+1)?\s*;?\s*",
        re.IGNORECASE | re.DOTALL,
    )
    execute_count = 0
    execute_result_name: str | None = None
    valid_return = False
    supported_statements = (ast.Assign, ast.AnnAssign, ast.Expr, ast.Return)

    def valid_execute(call: ast.Call) -> bool:
        sql = _literal_string(call.args[0], string_assignments) if call.args else None
        match = query_pattern.fullmatch(sql) if sql is not None else None
        return (
            match is not None
            and _is_row_retrieval_projection(match.group("projection"))
            and len(call.args) == 2
            and not call.keywords
            and _valid_placeholder_binding(
                match.group("placeholder"),
                call.args[1],
                parameter_assignments,
            )
        )

    for statement_index, statement in enumerate(function.body):
        if not isinstance(statement, supported_statements):
            return False
        assignment = _simple_assignment(statement)
        statement_execute_calls = _execute_calls(statement)
        if assignment is not None and _is_execute_call(assignment[1]):
            if statement_execute_calls != [assignment[1]]:
                return False
            execute_count += 1
            if execute_count != 1 or not valid_execute(assignment[1]):
                return False
            execute_result_name = assignment[0]
        elif isinstance(statement, ast.Return):
            if statement_index != len(function.body) - 1:
                return False
            comprehension = _dict_rows_list_comprehension(statement.value)
            if comprehension is None:
                return False
            iterable, _row_name = comprehension
            if _is_execute_call(iterable):
                if statement_execute_calls != [iterable]:
                    return False
                execute_count += 1
                if execute_count != 1 or not valid_execute(iterable):
                    return False
            elif not (
                isinstance(iterable, ast.Name)
                and execute_result_name is not None
                and iterable.id == execute_result_name
                and not statement_execute_calls
            ):
                return False
            valid_return = True
            break
        elif statement_execute_calls:
            return False

        if assignment is not None:
            name, value_node = assignment
            if name == execute_result_name and not _is_execute_call(value_node):
                execute_result_name = None
            string_value = _literal_string(value_node, string_assignments)
            if string_value is None:
                string_assignments.pop(name, None)
            else:
                string_assignments[name] = string_value
            parameter_assignments[name] = _resolved_parameter_node(
                value_node,
                parameter_assignments,
            )
        elif (
            isinstance(statement, (ast.Assign, ast.AnnAssign))
            or isinstance(statement, ast.Expr)
            and not (
                isinstance(statement.value, ast.Constant)
                and isinstance(statement.value.value, str)
            )
        ):
            return False
    return execute_count == 1 and valid_return


def _is_named_method_call(node: ast.AST, receiver: str, method: str) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == method
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == receiver
        and not node.keywords
    )


def _cursor_columns_source(node: ast.AST, cursor_name: str) -> bool:
    if not isinstance(node, ast.ListComp) or len(node.generators) != 1:
        return False
    generator = node.generators[0]
    if (
        generator.is_async
        or generator.ifs
        or not isinstance(generator.target, ast.Name)
        or not isinstance(generator.iter, ast.Attribute)
        or not isinstance(generator.iter.value, ast.Name)
        or generator.iter.value.id != cursor_name
        or generator.iter.attr != "description"
    ):
        return False
    return (
        isinstance(node.elt, ast.Subscript)
        and isinstance(node.elt.value, ast.Name)
        and node.elt.value.id == generator.target.id
        and isinstance(node.elt.slice, ast.Constant)
        and node.elt.slice.value == 0
    )


def _is_row_presence_test(node: ast.AST, row_name: str) -> bool:
    if isinstance(node, ast.Name):
        return node.id == row_name
    return (
        isinstance(node, ast.Compare)
        and isinstance(node.left, ast.Name)
        and node.left.id == row_name
        and len(node.ops) == 1
        and isinstance(node.ops[0], ast.IsNot)
        and len(node.comparators) == 1
        and isinstance(node.comparators[0], ast.Constant)
        and node.comparators[0].value is None
    )


def _is_single_zipped_dict_list(
    node: ast.AST, columns_name: str, row_name: str
) -> bool:
    if not isinstance(node, ast.List) or len(node.elts) != 1:
        return False
    item = node.elts[0]
    if not (
        isinstance(item, ast.Call)
        and isinstance(item.func, ast.Name)
        and item.func.id == "dict"
        and len(item.args) == 1
        and not item.keywords
    ):
        return False
    zipped = item.args[0]
    return (
        isinstance(zipped, ast.Call)
        and isinstance(zipped.func, ast.Name)
        and zipped.func.id == "zip"
        and len(zipped.args) == 2
        and not zipped.keywords
        and isinstance(zipped.args[0], ast.Name)
        and zipped.args[0].id == columns_name
        and isinstance(zipped.args[1], ast.Name)
        and zipped.args[1].id == row_name
    )


def _is_zipped_dict_rows_list_comprehension(
    node: ast.AST,
    columns_name: str,
    rows_name: str,
) -> bool:
    if not isinstance(node, ast.ListComp) or len(node.generators) != 1:
        return False
    generator = node.generators[0]
    if (
        generator.is_async
        or generator.ifs
        or not isinstance(generator.target, ast.Name)
        or not isinstance(generator.iter, ast.Name)
        or generator.iter.id != rows_name
    ):
        return False
    row_name = generator.target.id
    item = node.elt
    if not (
        isinstance(item, ast.Call)
        and isinstance(item.func, ast.Name)
        and item.func.id == "dict"
        and len(item.args) == 1
        and not item.keywords
    ):
        return False
    zipped = item.args[0]
    return (
        isinstance(zipped, ast.Call)
        and isinstance(zipped.func, ast.Name)
        and zipped.func.id == "zip"
        and len(zipped.args) == 2
        and not zipped.keywords
        and isinstance(zipped.args[0], ast.Name)
        and zipped.args[0].id == columns_name
        and isinstance(zipped.args[1], ast.Name)
        and zipped.args[1].id == row_name
    )


def _is_safe_cursor_return(node: ast.AST, columns_name: str, row_name: str) -> bool:
    return (
        isinstance(node, ast.IfExp)
        and _is_row_presence_test(node.test, row_name)
        and _is_single_zipped_dict_list(node.body, columns_name, row_name)
        and isinstance(node.orelse, ast.List)
        and not node.orelse.elts
    )


def _is_explicit_empty_row_branch(node: ast.AST, row_name: str) -> bool:
    if not isinstance(node, ast.If) or node.orelse or len(node.body) != 1:
        return False
    test = node.test
    if not (
        isinstance(test, ast.Compare)
        and isinstance(test.left, ast.Name)
        and test.left.id == row_name
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.Is)
        and len(test.comparators) == 1
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value is None
    ):
        return False
    returned = node.body[0]
    return (
        isinstance(returned, ast.Return)
        and isinstance(returned.value, ast.List)
        and not returned.value.elts
    )


def _has_safe_cursor_order_lookup(code: str | None) -> bool:
    """Recognize one bounded DB-API cursor lookup without executing candidate code."""
    if not code:
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if (
        len(functions) != 1
        or not isinstance(functions[0], ast.FunctionDef)
        or not _preserves_get_order_signature(code)
    ):
        return False
    function = functions[0]
    if _has_protected_name_rebinding(function):
        return False

    body = list(function.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if len(body) != 2:
        return False

    cursor_assignment = _simple_assignment(body[0])
    if cursor_assignment is None:
        return False
    cursor_name, cursor_factory = cursor_assignment
    if cursor_name in _PROTECTED_GET_ORDER_NAMES or not (
        _is_named_method_call(cursor_factory, "conn", "cursor")
        and not cursor_factory.args
    ):
        return False

    guarded = body[1]
    if not isinstance(guarded, ast.Try) or guarded.handlers or guarded.orelse:
        return False
    if (
        len(guarded.finalbody) != 1
        or not isinstance(guarded.finalbody[0], ast.Expr)
        or not _is_named_method_call(guarded.finalbody[0].value, cursor_name, "close")
        or guarded.finalbody[0].value.args
    ):
        return False

    if len(guarded.body) not in {4, 5}:
        return False
    execute_statement, row_statement, columns_statement = guarded.body[:3]
    if not isinstance(execute_statement, ast.Expr):
        return False
    execute_call = execute_statement.value
    if not _is_named_method_call(execute_call, cursor_name, "execute"):
        return False
    query_pattern = re.compile(
        r"\s*select\s+(?P<projection>.+?)\s+from\s+(?:[\"`\[]?order[\"`\]]?)"
        r"(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+where\s+"
        r"(?:[a-z_][a-z0-9_]*\.)?(?:[\"`\[]?id[\"`\]]?)\s*=\s*"
        r"(?P<placeholder>\?|%s|:order_id|\$1)(?:\s+limit\s+1)?\s*;?\s*",
        re.IGNORECASE | re.DOTALL,
    )
    if len(execute_call.args) != 2:
        return False
    sql = _literal_string(execute_call.args[0], {})
    match = query_pattern.fullmatch(sql) if sql is not None else None
    if (
        match is None
        or not _is_row_retrieval_projection(match.group("projection"))
        or not _valid_placeholder_binding(
            match.group("placeholder"), execute_call.args[1], {}
        )
    ):
        return False

    row_assignment = _simple_assignment(row_statement)
    columns_assignment = _simple_assignment(columns_statement)
    if row_assignment is None or columns_assignment is None:
        return False
    row_name, row_source = row_assignment
    columns_name, columns_source = columns_assignment
    if (
        row_name == columns_name
        or row_name in _PROTECTED_GET_ORDER_NAMES
        or columns_name in _PROTECTED_GET_ORDER_NAMES
    ):
        return False
    if not (
        _is_named_method_call(row_source, cursor_name, "fetchone")
        and not row_source.args
        and _cursor_columns_source(columns_source, cursor_name)
    ):
        return False
    return_statements = guarded.body[3:]
    safe_return = False
    if len(return_statements) == 1 and isinstance(return_statements[0], ast.Return):
        safe_return = _is_safe_cursor_return(
            return_statements[0].value,
            columns_name,
            row_name,
        )
    elif (
        len(return_statements) == 2
        and _is_explicit_empty_row_branch(return_statements[0], row_name)
        and isinstance(return_statements[1], ast.Return)
    ):
        safe_return = _is_single_zipped_dict_list(
            return_statements[1].value,
            columns_name,
            row_name,
        )
    return (
        safe_return
        and len(
            [
                node
                for node in ast.walk(function)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "execute"
            ]
        )
        == 1
    )


def _has_bound_cursor_parameterized_lookup(code: str | None) -> bool:
    """Prove one trusted cursor query binding without scoring minimality.

    The AST is inspected only; candidate code is never imported or executed.
    """
    if not code:
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if (
        len(functions) != 1
        or not isinstance(functions[0], ast.FunctionDef)
        or not _preserves_get_order_signature(code)
    ):
        return False
    function = functions[0]
    execute_calls = [
        node
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "execute"
    ]
    if _has_protected_name_rebinding(function) or len(execute_calls) != 1:
        return False

    body = list(function.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if len(body) != 2:
        return False

    cursor_assignment = _simple_assignment(body[0])
    guarded = body[1]
    if cursor_assignment is None or not isinstance(guarded, ast.Try):
        return False
    cursor_name, cursor_factory = cursor_assignment
    if cursor_name in _PROTECTED_GET_ORDER_NAMES or not (
        _is_named_method_call(cursor_factory, "conn", "cursor")
        and not cursor_factory.args
    ):
        return False
    if _node_binds_any_name(guarded, frozenset({cursor_name})):
        return False
    if (
        guarded.handlers
        or guarded.orelse
        or not (
            len(guarded.finalbody) == 1
            and isinstance(guarded.finalbody[0], ast.Expr)
            and _is_named_method_call(guarded.finalbody[0].value, cursor_name, "close")
            and not guarded.finalbody[0].value.args
        )
    ):
        return False

    execute_indexes = [
        index
        for index, statement in enumerate(guarded.body)
        if isinstance(statement, ast.Expr)
        and _is_named_method_call(statement.value, cursor_name, "execute")
    ]
    if len(execute_indexes) != 1:
        return False
    execute_index = execute_indexes[0]
    execute_call = guarded.body[execute_index].value
    fetch_indexes = []
    for index, statement in enumerate(guarded.body):
        assignment = _simple_assignment(statement)
        if assignment is not None and _is_named_method_call(
            assignment[1], cursor_name, "fetchone"
        ):
            fetch_indexes.append(index)
    if len(fetch_indexes) != 1 or fetch_indexes[0] <= execute_index:
        return False

    query_pattern = re.compile(
        r"\s*select\s+(?P<projection>.+?)\s+from\s+(?:[\"`\[]?order[\"`\]]?)"
        r"(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+where\s+"
        r"(?:[a-z_][a-z0-9_]*\.)?(?:[\"`\[]?id[\"`\]]?)\s*=\s*"
        r"(?P<placeholder>\?|%s|:order_id|\$1)(?:\s+limit\s+1)?\s*;?\s*",
        re.IGNORECASE | re.DOTALL,
    )
    sql = _literal_string(execute_call.args[0], {}) if execute_call.args else None
    match = query_pattern.fullmatch(sql) if sql is not None else None
    return bool(
        match is not None
        and _is_row_retrieval_projection(match.group("projection"))
        and len(execute_call.args) == 2
        and not execute_call.keywords
        and _valid_placeholder_binding(
            match.group("placeholder"), execute_call.args[1], {}
        )
    )


def _is_single_dict_row_list(node: ast.AST, row_name: str) -> bool:
    if not isinstance(node, ast.List) or len(node.elts) != 1:
        return False
    item = node.elts[0]
    return (
        isinstance(item, ast.Call)
        and isinstance(item.func, ast.Name)
        and item.func.id == "dict"
        and len(item.args) == 1
        and isinstance(item.args[0], ast.Name)
        and item.args[0].id == row_name
        and not item.keywords
    )


def _has_direct_fetchone_parameterized_lookup(code: str | None) -> bool:
    """Recognize one bound lookup returned through direct ``conn.execute``.

    This proves parameter binding independently from the stricter minimal
    solution grammar.  Candidate code remains static data and is never run.
    """
    if not code:
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if (
        len(functions) != 1
        or not isinstance(functions[0], ast.FunctionDef)
        or not _preserves_get_order_signature(code)
    ):
        return False
    function = functions[0]
    if _has_protected_name_rebinding(function):
        return False
    if len(_execute_calls(function)) != 1:
        return False

    body = list(function.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if len(body) != 2:
        return False

    row_assignment = _simple_assignment(body[0])
    if row_assignment is None or not isinstance(body[1], ast.Return):
        return False
    row_name, fetch_call = row_assignment
    if row_name in _PROTECTED_GET_ORDER_NAMES or not (
        isinstance(fetch_call, ast.Call)
        and isinstance(fetch_call.func, ast.Attribute)
        and fetch_call.func.attr == "fetchone"
        and not fetch_call.args
        and not fetch_call.keywords
        and _is_execute_call(fetch_call.func.value)
    ):
        return False

    execute_call = fetch_call.func.value
    query_pattern = re.compile(
        r"\s*select\s+(?P<projection>.+?)\s+from\s+(?:[\"`\[]?order[\"`\]]?)"
        r"(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+where\s+"
        r"(?:[a-z_][a-z0-9_]*\.)?(?:[\"`\[]?id[\"`\]]?)\s*=\s*"
        r"(?P<placeholder>\?|%s|:order_id|\$1)(?:\s+limit\s+1)?\s*;?\s*",
        re.IGNORECASE | re.DOTALL,
    )
    sql = _literal_string(execute_call.args[0], {}) if execute_call.args else None
    match = query_pattern.fullmatch(sql) if sql is not None else None
    if not (
        match is not None
        and _is_row_retrieval_projection(match.group("projection"))
        and len(execute_call.args) == 2
        and not execute_call.keywords
        and _valid_placeholder_binding(
            match.group("placeholder"), execute_call.args[1], {}
        )
    ):
        return False

    returned = body[1].value
    return (
        isinstance(returned, ast.IfExp)
        and _is_row_presence_test(returned.test, row_name)
        and _is_single_dict_row_list(returned.body, row_name)
        and isinstance(returned.orelse, ast.List)
        and not returned.orelse.elts
    )


def _has_direct_fetchall_parameterized_lookup(code: str | None) -> bool:
    """Prove a bound direct lookup independently from result shaping cost.

    A common DB-API answer reads all rows and maps cursor metadata with
    ``dict(zip(...))``.  That shape is intentionally non-minimal, but its one
    SQL call can still prove correct parameter binding.  Candidate code is
    inspected as an AST only and is never imported or executed.
    """
    if not code:
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if (
        len(functions) != 1
        or not isinstance(functions[0], ast.FunctionDef)
        or not _preserves_get_order_signature(code)
    ):
        return False
    function = functions[0]
    if _has_protected_name_rebinding(function):
        return False
    all_execute_calls = [
        node
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "execute"
    ]
    if len(all_execute_calls) != 1 or not _is_execute_call(all_execute_calls[0]):
        return False

    body = list(function.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    execute_indexes: list[int] = []
    for index, statement in enumerate(body):
        assignment = _simple_assignment(statement)
        if assignment is not None and assignment[1] is all_execute_calls[0]:
            execute_indexes.append(index)
    if len(execute_indexes) != 1:
        return False
    execute_index = execute_indexes[0]
    execute_assignment = _simple_assignment(body[execute_index])
    if execute_assignment is None:
        return False
    cursor_name, execute_call = execute_assignment
    if cursor_name in _PROTECTED_GET_ORDER_NAMES:
        return False

    string_assignments: dict[str, str] = {}
    parameter_assignments: dict[str, ast.AST] = {}
    for statement in body[:execute_index]:
        assignment = _simple_assignment(statement)
        if assignment is None or any(
            isinstance(node, ast.Call) for node in ast.walk(statement)
        ):
            return False
        name, value_node = assignment
        string_value = _literal_string(value_node, string_assignments)
        if string_value is None:
            string_assignments.pop(name, None)
        else:
            string_assignments[name] = string_value
        parameter_assignments[name] = _resolved_parameter_node(
            value_node,
            parameter_assignments,
        )

    query_pattern = re.compile(
        r"\s*select\s+(?P<projection>.+?)\s+from\s+(?:[\"`\[]?order[\"`\]]?)"
        r"(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+where\s+"
        r"(?:[a-z_][a-z0-9_]*\.)?(?:[\"`\[]?id[\"`\]]?)\s*=\s*"
        r"(?P<placeholder>\?|%s|:order_id|\$1)(?:\s+limit\s+1)?\s*;?\s*",
        re.IGNORECASE | re.DOTALL,
    )
    sql = (
        _literal_string(execute_call.args[0], string_assignments)
        if execute_call.args
        else None
    )
    match = query_pattern.fullmatch(sql) if sql is not None else None
    if not (
        match is not None
        and _is_row_retrieval_projection(match.group("projection"))
        and len(execute_call.args) == 2
        and not execute_call.keywords
        and _valid_placeholder_binding(
            match.group("placeholder"),
            execute_call.args[1],
            parameter_assignments,
        )
    ):
        return False

    trailing = body[execute_index + 1 :]
    if len(trailing) != 3 or not isinstance(trailing[-1], ast.Return):
        return False
    columns_name: str | None = None
    rows_name: str | None = None
    for statement in trailing[:-1]:
        assignment = _simple_assignment(statement)
        if assignment is None:
            return False
        name, source = assignment
        if name in _PROTECTED_GET_ORDER_NAMES or name == cursor_name:
            return False
        if _cursor_columns_source(source, cursor_name):
            if columns_name is not None:
                return False
            columns_name = name
        elif _is_named_method_call(source, cursor_name, "fetchall") and not source.args:
            if rows_name is not None:
                return False
            rows_name = name
        else:
            return False
    return bool(
        columns_name is not None
        and rows_name is not None
        and columns_name != rows_name
        and _is_zipped_dict_rows_list_comprehension(
            trailing[-1].value,
            columns_name,
            rows_name,
        )
    )


def _has_parameterized_order_lookup(code: str | None) -> bool:
    return (
        _has_minimal_order_solution(code)
        or _has_safe_cursor_order_lookup(code)
        or _has_bound_cursor_parameterized_lookup(code)
        or _has_direct_fetchone_parameterized_lookup(code)
        or _has_direct_fetchall_parameterized_lookup(code)
    )


def score_simple_order_sql_answer(answer: str) -> dict[str, Any]:
    scenario = load_real_interview_scenarios()["simple-order-sql-refinement"]
    code = _single_fenced_code(answer)
    any_block = _single_fenced_block(answer)
    executable_text = any_block[1] if any_block else ""
    forbidden = _contains_any(executable_text, scenario["forbiddenConcepts"])
    checks = {
        "preserved_get_order_signature": _preserves_get_order_signature(code),
        "parameterized_order_lookup": _has_parameterized_order_lookup(code),
        "minimal_order_solution": _has_minimal_order_solution(code),
        "no_forbidden_architecture": not forbidden,
        "russian_spoken_plan": _russian_plan_before_code(answer),
        "balanced_single_fence": _balanced_fenced_block(answer),
        "russian_comment_pairs": _russian_comment_pairs(code),
    }
    return {"passed": all(checks.values()), "checks": checks}


def _bullets(text: str) -> list[str]:
    return [
        re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", line).strip()
        for line in text.splitlines()
        if re.match(r"^\s*(?:[-*•]|\d+[.)])\s+\S", line)
    ]


def _token_set(text: str) -> set[str]:
    return set(re.findall(r"[a-zа-яё0-9_]+", text.casefold()))


def _jaccard(left: str, right: str) -> float:
    a, b = _token_set(left), _token_set(right)
    if not a and not b:
        return 1.0
    return len(a & b) / max(1, len(a | b))


def _concept_signature(text: str) -> set[str]:
    tokens = _token_set(text)
    stop = {
        "проверить",
        "проверка",
        "корректный",
        "корректно",
        "невалидный",
        "значение",
        "что",
        "для",
        "при",
        "если",
        "или",
        "без",
        "ещё",
        "раз",
        "в",
    }
    return {token for token in tokens if token not in stop and len(token) > 2}


_ENDPOINT_CONCEPTS = {
    "post",
    "order",
    "shipments",
    "address",
    "date",
    "comment",
    "is_leave_at_door",
    "payment_method",
    "endpoint",
    "http",
    "request",
    "response",
    "payload",
    "status",
    "заказ",
    "отправк",
    "адрес",
    "дат",
    "коммент",
    "оплат",
    "запрос",
    "ответ",
    "статус",
    "пол",
}

_BUSINESS_CONCEPTS = _ENDPOINT_CONCEPTS | {
    "курьер",
    "достав",
    "подпис",
    "получател",
    "позиц",
    "количеств",
    "объедин",
    "стоимост",
    "товар",
}


def _contains_concept(text: str, concepts: set[str]) -> bool:
    normalized = text.casefold()
    return any(concept in normalized for concept in concepts)


def _all_distinct(items: Sequence[str], maximum_similarity: float) -> bool:
    return all(
        _jaccard(left, right) <= maximum_similarity
        for index, left in enumerate(items)
        for right in items[index + 1 :]
    )


def score_route_checklist_refinement(
    first_answer: str, refinement: str
) -> dict[str, Any]:
    scenario = load_real_interview_scenarios()["route-checklist-novelty"]
    first_bullets = _bullets(first_answer)
    refined_bullets = _bullets(refinement)
    refined_signatures = [_concept_signature(item) for item in refined_bullets]
    first_signatures = [_concept_signature(item) for item in first_bullets]
    novel = sum(
        1
        for signature in refined_signatures
        if signature
        and all(
            len(signature & prior) / max(1, len(signature | prior)) <= 0.45
            for prior in first_signatures
        )
    )
    threshold = scenario["maximumBulletJaccard"]
    first_is_endpoint_level = len(first_bullets) == 5 and all(
        _contains_concept(item, _ENDPOINT_CONCEPTS) for item in first_bullets
    )
    refinement_is_business_level = len(refined_bullets) == 3 and all(
        _contains_concept(item, _BUSINESS_CONCEPTS) for item in refined_bullets
    )
    no_database = not _contains_any(
        f"{first_answer}\n{refinement}", scenario["forbiddenConcepts"]
    )
    checks = {
        "first_exactly_five_endpoint_checks": first_is_endpoint_level,
        "first_distinct_checks": len(first_bullets) == 5
        and _all_distinct(first_bullets, threshold),
        "refinement_exactly_three_business_checks": refinement_is_business_level,
        "three_distinct_concepts": len(
            {frozenset(value) for value in refined_signatures if value}
        )
        == 3,
        "all_three_genuinely_new": novel == scenario["requiredNewConceptCount"],
        "no_near_duplicate_bullets": len(refined_bullets) == 3
        and _all_distinct(refined_bullets, threshold),
        "no_database_inspection": no_database,
    }
    return {"passed": all(checks.values()), "checks": checks}


def _validate_report_model(value: Any, index: int) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 128
        or _MODEL_IDENTIFIER.fullmatch(value) is None
    ):
        raise ValueError(f"attempt {index} has an invalid model identifier")
    return value


def _validate_report_timing(value: Any, field: str, index: int) -> int | float | None:
    if value is None:
        return None
    if type(value) not in (int, float) or not 0 <= value <= 600_000:
        raise ValueError(f"attempt {index} has an invalid timing in {field}")
    return value


def _validate_failure_codes(value: Any, case_id: str, index: int) -> list[str]:
    allowed = _CASE_FAILURE_CODES[case_id]
    if (
        not isinstance(value, list)
        or len(value) > len(allowed)
        or any(not isinstance(code, str) or code not in allowed for code in value)
    ):
        raise ValueError(f"attempt {index} has invalid failure codes")
    if len(value) != len(set(value)):
        raise ValueError(f"attempt {index} has invalid failure codes")
    return list(value)


def _validate_failure_stage(value: Any, index: int) -> str | None:
    if value is not None and value not in _FAILURE_STAGES:
        raise ValueError(f"attempt {index} has invalid failure stage")
    return value


def _validate_retry_count(value: Any, index: int) -> int:
    if type(value) is not int or not 0 <= value <= 1:
        raise ValueError(f"attempt {index} has invalid retry count")
    return value


def _validate_typed_state_diagnostics(
    value: Any,
    *,
    field: str,
    index: int,
) -> dict[str, bool | int]:
    if value == {}:
        return {}
    if not isinstance(value, dict) or set(value) != _TYPED_STATE_DIAGNOSTIC_FIELDS:
        raise ValueError(f"attempt {index} has invalid {field} typed state diagnostics")
    if (
        type(value["observationAccepted"]) is not bool
        or type(value["generationCompleted"]) is not bool
        or type(value["frameCount"]) is not int
        or type(value["activeFindingCount"]) is not int
        or type(value["activeSourceCount"]) is not int
        or not 0 <= value["frameCount"] <= _MAX_TYPED_DIAGNOSTIC_FRAMES
        or not 0 <= value["activeFindingCount"] <= _MAX_TYPED_DIAGNOSTIC_FINDINGS
        or not 0 <= value["activeSourceCount"] <= _MAX_TYPED_DIAGNOSTIC_SOURCES
    ):
        raise ValueError(f"attempt {index} has invalid {field} typed state diagnostics")
    return {
        "observationAccepted": value["observationAccepted"],
        "frameCount": value["frameCount"],
        "activeFindingCount": value["activeFindingCount"],
        "activeSourceCount": value["activeSourceCount"],
        "generationCompleted": value["generationCompleted"],
    }


def _derive_typed_state_diagnostics(
    state: object,
    *,
    generation_completed: bool,
) -> dict[str, bool | int]:
    """Read only bounded collection/activity metadata from transient typed state."""

    if not isinstance(state, dict):
        return {}
    frames = state.get("frames")
    ledger = state.get("ledger")
    source_ledger = state.get("source_ledger")
    if (
        not isinstance(frames, list)
        or not isinstance(ledger, list)
        or not isinstance(source_ledger, list)
        or not 1 <= len(frames) <= _MAX_TYPED_DIAGNOSTIC_FRAMES
        or len(ledger) > _MAX_TYPED_DIAGNOSTIC_FINDINGS
        or len(source_ledger) > _MAX_TYPED_DIAGNOSTIC_SOURCES
    ):
        return {}

    def count_active(entries: list[object], nested_key: str) -> int | None:
        count = 0
        for entry in entries:
            if not isinstance(entry, dict):
                return None
            nested = entry.get(nested_key)
            if not isinstance(nested, dict) or type(nested.get("active")) is not bool:
                return None
            count += int(nested["active"])
        return count

    active_findings = count_active(ledger, "finding")
    active_sources = count_active(source_ledger, "source")
    if active_findings is None or active_sources is None:
        return {}
    return {
        "observationAccepted": True,
        "frameCount": len(frames),
        "activeFindingCount": active_findings,
        "activeSourceCount": active_sources,
        "generationCompleted": generation_completed,
    }


def build_privacy_safe_regression_report(
    attempts: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Serialize only aggregate semantics/timings; raw content has no output path."""
    safe_attempts: list[dict[str, Any]] = []
    for index, attempt in enumerate(attempts):
        if not isinstance(attempt, dict):
            raise ValueError(  # noqa: TRY004 - public validation API
                f"attempt {index} must be an object"
            )
        # Existing callers can omit the new bounded diagnostics, but every
        # serialized attempt always receives the explicit safe defaults.
        expected_fields = set(_SAFE_REGRESSION_ATTEMPT_FIELDS)
        optional_fields = {
            "failure_stage",
            "retry_count",
            "initial_semantic_checks",
            "final_typed_state_diagnostics",
            "initial_typed_state_diagnostics",
        }
        required_fields = expected_fields - optional_fields
        if not required_fields.issubset(attempt) or not set(attempt).issubset(
            expected_fields
        ):
            raise ValueError(f"attempt {index} has an invalid attempt shape")
        case_id = attempt.get("case_id")
        if case_id not in _SEMANTIC_CHECK_KEYS:
            raise ValueError(f"attempt {index} has an invalid case id")
        repetition = attempt["repetition"]
        if type(repetition) is not int or not 1 <= repetition <= 1_000:
            raise ValueError(f"attempt {index} has an invalid repetition")
        model = _validate_report_model(attempt["model"], index)
        timings = {
            field: _validate_report_timing(attempt[field], field, index)
            for field in (
                "transport_first_byte_ms",
                "model_first_chunk_ms",
                "total_ms",
            )
        }
        failure_codes = _validate_failure_codes(
            attempt["failure_codes"], case_id, index
        )
        failure_stage = _validate_failure_stage(attempt.get("failure_stage"), index)
        retry_count = _validate_retry_count(attempt.get("retry_count", 0), index)
        semantic_checks = attempt.get("semantic_checks")
        allowed_checks = _SEMANTIC_CHECK_KEYS[case_id]
        if (
            not isinstance(semantic_checks, dict)
            or any(type(value) is not bool for value in semantic_checks.values())
            or set(semantic_checks) not in (set(), set(allowed_checks))
        ):
            raise ValueError(f"attempt {index} has invalid semantic checks")
        if not semantic_checks and not failure_codes:
            raise ValueError(f"attempt {index} has invalid semantic checks")
        if (
            semantic_checks
            and any(not value for value in semantic_checks.values())
            and "semantic_gate" not in failure_codes
        ):
            raise ValueError(f"attempt {index} has inconsistent semantic checks")
        initial_semantic_checks = attempt.get("initial_semantic_checks", {})
        allowed_initial_checks = _INITIAL_SEMANTIC_CHECK_KEYS[case_id]
        if (
            not isinstance(initial_semantic_checks, dict)
            or any(
                type(value) is not bool for value in initial_semantic_checks.values()
            )
            or set(initial_semantic_checks) not in (set(), set(allowed_initial_checks))
        ):
            raise ValueError(f"attempt {index} has invalid initial semantic checks")
        initial_typed_state_diagnostics = _validate_typed_state_diagnostics(
            attempt.get("initial_typed_state_diagnostics", {}),
            field="initial",
            index=index,
        )
        final_typed_state_diagnostics = _validate_typed_state_diagnostics(
            attempt.get("final_typed_state_diagnostics", {}),
            field="final",
            index=index,
        )
        safe_attempts.append(
            {
                "caseId": case_id,
                "repetition": repetition,
                "model": model,
                "transportFirstByteMs": timings["transport_first_byte_ms"],
                "modelFirstChunkMs": timings["model_first_chunk_ms"],
                "totalMs": timings["total_ms"],
                "semanticChecks": dict(semantic_checks),
                "initialSemanticChecks": dict(initial_semantic_checks),
                "initialTypedStateDiagnostics": initial_typed_state_diagnostics,
                "finalTypedStateDiagnostics": final_typed_state_diagnostics,
                "failureCodes": failure_codes,
                "failureStage": failure_stage,
                "retryCount": retry_count,
            }
        )
    failed = sum(bool(item.get("failureCodes")) for item in safe_attempts)
    return {
        "schemaVersion": 1,
        "suite": "sanitized-real-interview-screen-sequences",
        "createdAt": datetime.now(UTC).isoformat(),
        "summary": {
            "passed": bool(safe_attempts) and failed == 0,
            "attempts": len(safe_attempts),
            "failedAttempts": failed,
        },
        "attempts": safe_attempts,
    }


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return (
        struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body))
    )


def render_code_png() -> bytes:
    width, height, scale = 900, 420, 6
    pixels = bytearray([248, 250, 252] * width * height)

    def fill(x: int, y: int, color: tuple[int, int, int]) -> None:
        if not (0 <= x < width and 0 <= y < height):
            return
        offset = (y * width + x) * 3
        pixels[offset : offset + 3] = bytes(color)

    for line_index, text in enumerate(LINES):
        y0 = 55 + line_index * 78
        for char_index, char in enumerate(text):
            glyph = FONT[char]
            x0 = 55 + char_index * 6 * scale
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "0":
                        continue
                    for dy in range(scale):
                        for dx in range(scale):
                            fill(
                                x0 + gx * scale + dx, y0 + gy * scale + dy, (15, 23, 42)
                            )

    raw = b"".join(
        b"\x00" + pixels[y * width * 3 : (y + 1) * width * 3] for y in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )


def render_fixture_order_png() -> bytes:
    """Render the real pytest-order regression without adding GUI dependencies."""
    output = Path(tempfile.gettempdir()) / f"skillcue-fixture-{uuid.uuid4().hex}.png"
    escaped_output = str(output).replace("'", "''")
    script = rf"""
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 1600, 1200
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(24, 24, 27))
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$title = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Segoe UI', 20)
$codeFont = New-Object System.Drawing.Font('Consolas', 18)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$cyan = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(103, 232, 249))
$graphics.DrawString('14. Порядок выполнения фикстур', $title, $white, 58, 38)
$graphics.DrawString('Определите точную последовательность setup фикстур, выполнения теста и teardown после yield.', $body, $white, 58, 100)
$code = @'
order = []

@pytest.fixture(scope="session")
def session_fixture(): order.append("session_fixture")

@pytest.fixture(scope="module")
def module_fixture(): order.append("module_fixture")

@pytest.fixture
def fixture_1(fixture_3, fixture_4): order.append("fixture_1")

@pytest.fixture(scope="function")
def fixture_3(): order.append("fixture_3")

@pytest.fixture(autouse=True)
def autouse_fixture(): order.append("autouse_fixture")

@pytest.fixture
def fixture_2(): order.append("fixture_2")

@pytest.fixture
def fixture_4():
    yield
    order.append("fixture_4")

def test_order(fixture_1, module_fixture, fixture_2, session_fixture):
    pass
'@
$y = 150
foreach ($line in ($code -split "`n")) {{
  $graphics.DrawString($line.TrimEnd("`r"), $codeFont, $cyan, 70, $y)
  $y += 33
}}
$bitmap.Save('{escaped_output}', [System.Drawing.Imaging.ImageFormat]::Png)
$cyan.Dispose(); $white.Dispose(); $codeFont.Dispose(); $body.Dispose(); $title.Dispose()
$graphics.Dispose(); $bitmap.Dispose()
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        return output.read_bytes()
    finally:
        output.unlink(missing_ok=True)


def render_sql_solution_png(*, exact_gender_literals: bool = False) -> bytes:
    """Render a realistic SQL interview task that requires copyable code."""
    output = Path(tempfile.gettempdir()) / f"skillcue-sql-{uuid.uuid4().hex}.png"
    escaped_output = str(output).replace("'", "''")
    gender_rule = (
        "user_gender хранится только как 'Female' или 'F' — сохрани регистр литералов."
        if exact_gender_literals
        else "Сравнение пола должно быть без учёта регистра."
    ).replace("'", "''")
    script = rf"""
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 1400, 820
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$title = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Segoe UI', 22)
$codeFont = New-Object System.Drawing.Font('Consolas', 22)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 23, 42))
$blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(29, 78, 216))
$graphics.DrawString('SQL: доход от покупок женщин', $title, $dark, 58, 45)
$graphics.DrawString('Таблица Purchases:', $body, $dark, 58, 125)
$graphics.DrawString('price DECIMAL, items INT, user_gender TEXT', $codeFont, $blue, 80, 185)
$graphics.DrawString('Напишите запрос, который считает суммарный доход:', $body, $dark, 58, 285)
$graphics.DrawString('price * items только для user_gender = female', $codeFont, $blue, 80, 345)
$graphics.DrawString('{gender_rule}', $body, $dark, 58, 435)
$graphics.DrawString('Назовите результат income_from_female.', $body, $dark, 58, 500)
$bitmap.Save('{escaped_output}', [System.Drawing.Imaging.ImageFormat]::Png)
$blue.Dispose(); $dark.Dispose(); $codeFont.Dispose(); $body.Dispose(); $title.Dispose()
$graphics.Dispose(); $bitmap.Dispose()
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        return output.read_bytes()
    finally:
        output.unlink(missing_ok=True)


def sql_code_lines(answer: str) -> list[str]:
    match = re.search(r"```(?:sql)?\s*\n?(.*?)```", answer, re.IGNORECASE | re.DOTALL)
    if not match:
        return []
    return [line.strip() for line in match.group(1).splitlines() if line.strip()]


def has_short_spoken_summary_before_code(answer: str) -> bool:
    fence_index = answer.find("```")
    if fence_index <= 0:
        return False
    summary = answer[:fence_index].strip()
    if not summary or len(summary) > 500:
        return False
    sentences = [
        part for part in re.split(r"(?<=[.!?])\s+|\n+", summary) if part.strip()
    ]
    return 1 <= len(sentences) <= 3


def every_code_line_has_following_comment(lines: list[str], marker: str) -> bool:
    """Require code/comment pairs without accepting wide inline comments."""
    if not lines:
        return False
    code_indexes = [
        index
        for index, line in enumerate(lines)
        if not line.lstrip().startswith(marker)
    ]
    if not code_indexes:
        return False
    for index in code_indexes:
        if index + 1 >= len(lines):
            return False
        comment = lines[index + 1].lstrip()
        if not comment.startswith(marker) or not re.search(
            r"[а-яё]", comment, re.IGNORECASE
        ):
            return False
    return True


def fixture_trace(answer: str) -> list[str]:
    unique_names = list(dict.fromkeys(FIXTURE_TRACE))
    numbered_trace: list[str] = []
    for line in answer.lower().splitlines():
        if not re.match(r"^\s*\d+[.)]\s+", line):
            continue
        matches = [
            (match.start(), name)
            for name in unique_names
            if (match := re.search(rf"\b{re.escape(name)}\b", line))
        ]
        if matches:
            numbered_trace.append(min(matches)[1])
    if numbered_trace:
        return numbered_trace

    names = "|".join(re.escape(name) for name in unique_names)
    raw_trace = re.findall(names, answer.lower())
    collapsed_trace: list[str] = []
    for name in raw_trace:
        if not collapsed_trace or collapsed_trace[-1] != name:
            collapsed_trace.append(name)
    return collapsed_trace


def fixture_trace_is_valid(trace: list[str]) -> bool:
    setup_and_test = FIXTURE_TRACE[:-1]
    return (
        trace[: len(setup_and_test)] == setup_and_test
        and FIXTURE_TRACE[-1] in trace[len(setup_and_test) :]
    )


def _render_text_png(
    title: str, lines: Sequence[str], *, width: int = 1600, height: int = 900
) -> bytes:
    """Render a deterministic non-private interview screen using Windows text APIs."""
    output = Path(tempfile.gettempdir()) / f"skillcue-regression-{uuid.uuid4().hex}.png"
    escaped_output = str(output).replace("'", "''")
    escaped_title = title.replace("'", "''")
    escaped_lines = (line.replace("'", "''") for line in lines)
    line_literals = ",".join(f"'{line}'" for line in escaped_lines)
    script = rf"""
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap {width}, {height}
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$titleFont = New-Object System.Drawing.Font('Segoe UI', 28, [System.Drawing.FontStyle]::Bold)
$codeFont = New-Object System.Drawing.Font('Consolas', 20)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 23, 42))
$blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(29, 78, 216))
$graphics.DrawString('{escaped_title}', $titleFont, $dark, 52, 38)
$lines = @({line_literals})
$y = 115
foreach ($line in $lines) {{
  $graphics.DrawString($line, $codeFont, $blue, 62, $y)
  $y += 42
}}
$bitmap.Save('{escaped_output}', [System.Drawing.Imaging.ImageFormat]::Png)
$blue.Dispose(); $dark.Dispose(); $codeFont.Dispose(); $titleFont.Dispose()
$graphics.Dispose(); $bitmap.Dispose()
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        return output.read_bytes()
    finally:
        output.unlink(missing_ok=True)


def render_real_interview_frame(case_id: str, frame_index: int) -> bytes:
    scenario = load_real_interview_scenarios()[case_id]
    if case_id == "multiscroll-gitlab-cicd":
        frames = scenario["frames"]
        if frame_index >= len(frames):
            raise IndexError("screen frame index is outside scenario")
        return _render_text_png(
            f"GitLab CI/CD — viewport {frame_index + 1}",
            frames[frame_index]["text"],
            width=scenario["viewport"]["width"],
            height=scenario["viewport"]["height"],
        )
    if frame_index != 0:
        raise IndexError("single-frame scenario has only frame zero")
    return _render_text_png(case_id, scenario["screenText"])


def _data_url(image: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(image).decode("ascii")


@dataclass(frozen=True)
class ScreenRequestFailure(Exception):
    """A privacy-safe screen request failure suitable for deterministic reports."""

    code: str
    stage: str
    model: str
    transport_first_byte_ms: int | None
    model_first_chunk_ms: int | None
    total_ms: int | None
    visible_content_started: bool
    retry_count: int = 0

    def __str__(self) -> str:
        return f"screen request failed: {self.code}"

    @classmethod
    def from_sse_event(
        cls,
        event: object,
        *,
        stage: str,
        transport_first_byte_ms: int | None,
        model_first_chunk_ms: int | None,
        total_ms: int | None,
        visible_content_started: bool,
    ) -> ScreenRequestFailure:
        data = event if isinstance(event, dict) else {}
        raw_code = data.get("code")
        if isinstance(raw_code, str) and raw_code in _TYPED_SCREEN_FAILURE_CODES:
            code = raw_code
        elif isinstance(raw_code, str):
            code = {
                "invalid_api_key": "auth_failed",
                "missing_api_key": "auth_failed",
                "invalid_license": "auth_failed",
                "auth_failed": "auth_failed",
                "insufficient_credits": "quota_exceeded",
                "token_quota_exceeded": "quota_exceeded",
                "quota_exceeded": "quota_exceeded",
                "rate_limited": "rate_limited",
                "provider_timeout": "provider_timeout",
                "provider_error": "provider_error",
                "model_unavailable": "provider_error",
                "model_not_allowed": "provider_error",
                "gateway_unconfigured": "provider_error",
                "provider_output_truncated": "provider_output_truncated",
            }.get(raw_code, "request_failed")
        else:
            code = "request_failed"
        model = _safe_model_identifier(data.get("model"))
        return cls(
            code=code,
            stage=stage,
            model=model,
            transport_first_byte_ms=transport_first_byte_ms,
            model_first_chunk_ms=model_first_chunk_ms,
            total_ms=total_ms,
            visible_content_started=visible_content_started,
        )

    def with_total(self, total_ms: int) -> ScreenRequestFailure:
        return replace(self, total_ms=total_ms)


def _score_initial_semantic_checks(case_id: str, answer: str) -> dict[str, bool]:
    """Return only the exact allowlisted first-stage booleans, never raw content."""
    try:
        if case_id == "multiscroll-gitlab-cicd":
            score = score_multiscroll_gitlab_answer(answer)
        elif case_id == "simple-order-sql-refinement":
            score = score_simple_order_sql_answer(answer)
        elif case_id == "route-checklist-novelty":
            score = score_route_checklist_refinement(answer, "")
        else:
            return {}
        checks = score.get("checks")
        allowed = _INITIAL_SEMANTIC_CHECK_KEYS[case_id]
        if not isinstance(checks, dict) or any(
            key not in checks or type(checks[key]) is not bool for key in allowed
        ):
            return {}
        return {key: checks[key] for key in allowed}
    except Exception:  # noqa: BLE001 - diagnostics cannot break the scenario
        return {}


def _safe_attempt(
    *,
    case_id: str,
    repetition: int,
    done: dict[str, Any],
    score: dict[str, Any],
    initial_semantic_checks: dict[str, bool],
    budgets: dict[str, int],
    incident: ScreenRequestFailure | None = None,
    initial_typed_state_diagnostics: dict[str, bool | int] | None = None,
) -> dict[str, Any]:
    raw_typed_state_diagnostics = done.get("_typed_state_diagnostics")
    typed_state_diagnostics = (
        dict(raw_typed_state_diagnostics)
        if isinstance(raw_typed_state_diagnostics, dict)
        else {}
    )
    failure_codes = [] if score["passed"] else ["semantic_gate"]
    for field, budget_key, failure_code in (
        (
            "_e2e_transport_first_byte_ms",
            "transportFirstByteMs",
            "transport_first_byte_budget",
        ),
        ("_e2e_first_chunk_ms", "firstChunkMs", "model_first_chunk_budget"),
        ("_e2e_total_ms", "totalMs", "total_time_budget"),
    ):
        value = done.get(field)
        if not isinstance(value, (int, float)) or value > budgets[budget_key]:
            failure_codes.append(failure_code)
    if incident is not None:
        failure_codes.append(incident.code)
    return {
        "case_id": case_id,
        "repetition": repetition,
        "model": _safe_model_identifier(done.get("model")),
        "transport_first_byte_ms": done.get("_e2e_transport_first_byte_ms"),
        "model_first_chunk_ms": done.get("_e2e_first_chunk_ms"),
        "total_ms": done.get("_e2e_total_ms"),
        "semantic_checks": score["checks"],
        "initial_semantic_checks": dict(initial_semantic_checks),
        "initial_typed_state_diagnostics": dict(initial_typed_state_diagnostics or {}),
        "final_typed_state_diagnostics": typed_state_diagnostics,
        "failure_codes": list(dict.fromkeys(failure_codes)),
        "failure_stage": incident.stage if incident else None,
        "retry_count": incident.retry_count if incident else 0,
    }


def _failure_attempt(
    *,
    case_id: str,
    repetition: int,
    failure: ScreenRequestFailure,
    recovered_incident: ScreenRequestFailure | None = None,
    initial_semantic_checks: dict[str, bool] | None = None,
    initial_typed_state_diagnostics: dict[str, bool | int] | None = None,
    final_typed_state_diagnostics: dict[str, bool | int] | None = None,
) -> dict[str, Any]:
    failure_codes = [failure.code]
    if recovered_incident is not None and recovered_incident.code != failure.code:
        failure_codes.insert(0, recovered_incident.code)
    return {
        "case_id": case_id,
        "repetition": repetition,
        "model": failure.model
        if failure.model != "unknown"
        else (recovered_incident.model if recovered_incident else "unknown"),
        "transport_first_byte_ms": failure.transport_first_byte_ms,
        "model_first_chunk_ms": failure.model_first_chunk_ms,
        "total_ms": failure.total_ms,
        "semantic_checks": {},
        "initial_semantic_checks": dict(initial_semantic_checks or {}),
        "initial_typed_state_diagnostics": dict(initial_typed_state_diagnostics or {}),
        "final_typed_state_diagnostics": dict(final_typed_state_diagnostics or {}),
        "failure_codes": failure_codes,
        "failure_stage": failure.stage,
        "retry_count": max(
            failure.retry_count,
            recovered_incident.retry_count if recovered_incident else 0,
        ),
    }


def _is_retryable_screen_failure(failure: ScreenRequestFailure) -> bool:
    return (
        failure.code in _TRANSIENT_FAILURE_CODES
        and not failure.visible_content_started
        and failure.retry_count == 0
    )


def _request_with_one_retry(
    request: Callable[[int, str, dict], tuple[str, dict]],
    *,
    port: int,
    token: str,
    payload: dict,
    stage: str,
    sleep: Callable[[float], None],
    retry_available: bool,
) -> tuple[str, dict, ScreenRequestFailure | None, bool]:
    try:
        return (*request(port, token, payload), None, False)
    except ScreenRequestFailure as first:
        if (
            not retry_available
            or first.stage != stage
            or not _is_retryable_screen_failure(first)
        ):
            raise
        sleep(
            _RATE_LIMIT_RETRY_DELAY_SECONDS
            if first.code == "rate_limited"
            else _TRANSIENT_RETRY_DELAY_SECONDS
        )
        try:
            answer, done = request(port, token, payload)
        except ScreenRequestFailure as second:
            raise replace(second, retry_count=1) from None
        return answer, done, replace(first, retry_count=1), True


def run_real_interview_regressions(
    *,
    port: int,
    token: str,
    repetitions: int,
    model_override: str | None = None,
    provider_override: str | None = None,
    structured_screen: bool = False,
    request_screen=None,
    render_frame=None,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """Run three isolated sanitized screen sequences; never return raw model/pixel data."""
    if repetitions <= 0:
        raise ValueError("repetitions must be positive")
    request = request_screen or _request_screen
    render = render_frame or render_real_interview_frame
    scenarios = load_real_interview_scenarios()
    attempts: list[dict[str, Any]] = []
    consecutive_terminal_transients = 0

    for repetition in range(1, repetitions + 1):
        for case_id in (
            "multiscroll-gitlab-cicd",
            "simple-order-sql-refinement",
            "route-checklist-novelty",
        ):
            scenario = scenarios[case_id]
            if consecutive_terminal_transients >= 2:
                attempts.append(
                    _failure_attempt(
                        case_id=case_id,
                        repetition=repetition,
                        failure=ScreenRequestFailure(
                            code="circuit_open",
                            stage="circuit",
                            model="unknown",
                            transport_first_byte_ms=None,
                            model_first_chunk_ms=None,
                            total_ms=None,
                            visible_content_started=False,
                        ),
                    )
                )
                continue
            try:
                first_image = _data_url(render(case_id, 0))
            except Exception:  # noqa: BLE001 - renderer bytes never enter a report
                attempts.append(
                    _failure_attempt(
                        case_id=case_id,
                        repetition=repetition,
                        failure=ScreenRequestFailure(
                            "render_failed",
                            "render",
                            "unknown",
                            None,
                            None,
                            None,
                            False,
                        ),
                    )
                )
                consecutive_terminal_transients = 0
                continue
            recovered_incident: ScreenRequestFailure | None = None
            initial_typed_state_diagnostics: dict[str, bool | int] = {}
            retry_used = False
            try:
                first_answer, first_done, initial_incident, retry_used = (
                    _request_with_one_retry(
                        request,
                        port=port,
                        token=token,
                        payload={
                            "image": first_image,
                            "question": scenario["questions"][0],
                            "context": "Санитизированная регрессионная задача технического интервью.",
                            "mode": "deep",
                            "answer_language": "ru",
                            **(
                                {"structuredScreen": True, "taskAction": "new"}
                                if structured_screen
                                else {}
                            ),
                            **(
                                {"provider": provider_override}
                                if provider_override
                                else {}
                            ),
                            **(
                                {"modelOverride": model_override}
                                if model_override
                                else {}
                            ),
                        },
                        stage="initial_request",
                        sleep=sleep,
                        retry_available=True,
                    )
                )
                typed_task_state = first_done.get("_task_state")
                if structured_screen and not isinstance(typed_task_state, str):
                    raise ScreenRequestFailure(
                        code="malformed_protocol",
                        stage="initial_request",
                        model=_safe_model_identifier(first_done.get("model")),
                        transport_first_byte_ms=first_done.get(
                            "_e2e_transport_first_byte_ms"
                        ),
                        model_first_chunk_ms=first_done.get("_e2e_first_chunk_ms"),
                        total_ms=first_done.get("_e2e_total_ms"),
                        visible_content_started=bool(first_answer),
                    )
                raw_initial_diagnostics = first_done.get("_typed_state_diagnostics")
                if isinstance(raw_initial_diagnostics, dict):
                    initial_typed_state_diagnostics = dict(raw_initial_diagnostics)
                recovered_incident = initial_incident
            except ScreenRequestFailure as failure:
                attempts.append(
                    _failure_attempt(
                        case_id=case_id,
                        repetition=repetition,
                        failure=failure,
                    )
                )
                consecutive_terminal_transients = (
                    consecutive_terminal_transients + 1
                    if failure.code in _TRANSIENT_FAILURE_CODES
                    else 0
                )
                continue
            initial_semantic_checks = _score_initial_semantic_checks(
                case_id,
                first_answer,
            )
            try:
                current_image = (
                    _data_url(render(case_id, 1))
                    if case_id == "multiscroll-gitlab-cicd"
                    else first_image
                )
            except Exception:  # noqa: BLE001 - renderer bytes never enter a report
                attempts.append(
                    _failure_attempt(
                        case_id=case_id,
                        repetition=repetition,
                        failure=ScreenRequestFailure(
                            "render_failed",
                            "render",
                            "unknown",
                            None,
                            None,
                            None,
                            False,
                        ),
                        recovered_incident=recovered_incident,
                        initial_semantic_checks=initial_semantic_checks,
                        initial_typed_state_diagnostics=initial_typed_state_diagnostics,
                    )
                )
                consecutive_terminal_transients = 0
                continue
            previous_images = [first_image] if current_image != first_image else []
            try:
                final_answer, done, refinement_incident, _refinement_retry_used = (
                    _request_with_one_retry(
                        request,
                        port=port,
                        token=token,
                        payload={
                            "image": current_image,
                            "previous_images": previous_images,
                            "prior_solution_summary": first_answer,
                            "question": scenario["questions"][1],
                            "context": "Последнее уточнение интервьюера приоритетно; сохрани рабочие части.",
                            "mode": "deep",
                            "answer_language": "ru",
                            **(
                                {
                                    "structuredScreen": True,
                                    "taskAction": "continue",
                                    "taskState": typed_task_state,
                                }
                                if structured_screen
                                else {}
                            ),
                            **(
                                {"provider": provider_override}
                                if provider_override
                                else {}
                            ),
                            **(
                                {"modelOverride": model_override}
                                if model_override
                                else {}
                            ),
                        },
                        stage="refinement_request",
                        sleep=sleep,
                        retry_available=not retry_used,
                    )
                )
                recovered_incident = recovered_incident or refinement_incident
            except ScreenRequestFailure as failure:
                attempts.append(
                    _failure_attempt(
                        case_id=case_id,
                        repetition=repetition,
                        failure=failure,
                        recovered_incident=recovered_incident,
                        initial_semantic_checks=initial_semantic_checks,
                        initial_typed_state_diagnostics=initial_typed_state_diagnostics,
                    )
                )
                consecutive_terminal_transients = (
                    consecutive_terminal_transients + 1
                    if failure.code in _TRANSIENT_FAILURE_CODES
                    else 0
                )
                continue
            try:
                if case_id == "multiscroll-gitlab-cicd":
                    score = score_multiscroll_gitlab_answer(final_answer)
                elif case_id == "simple-order-sql-refinement":
                    score = score_simple_order_sql_answer(final_answer)
                else:
                    score = score_route_checklist_refinement(first_answer, final_answer)
            except Exception:  # noqa: BLE001 - convert to a stable safe code
                attempts.append(
                    _failure_attempt(
                        case_id=case_id,
                        repetition=repetition,
                        failure=ScreenRequestFailure(
                            "scorer_failed",
                            "scorer",
                            _safe_model_identifier(done.get("model")),
                            done.get("_e2e_transport_first_byte_ms"),
                            done.get("_e2e_first_chunk_ms"),
                            done.get("_e2e_total_ms"),
                            True,
                        ),
                        recovered_incident=recovered_incident,
                        initial_semantic_checks=initial_semantic_checks,
                        initial_typed_state_diagnostics=initial_typed_state_diagnostics,
                        final_typed_state_diagnostics=(
                            done.get("_typed_state_diagnostics")
                            if isinstance(done.get("_typed_state_diagnostics"), dict)
                            else {}
                        ),
                    )
                )
                consecutive_terminal_transients = 0
                continue
            attempts.append(
                _safe_attempt(
                    case_id=case_id,
                    repetition=repetition,
                    done=done,
                    score=score,
                    initial_semantic_checks=initial_semantic_checks,
                    budgets=scenario["budgets"],
                    incident=recovered_incident,
                    initial_typed_state_diagnostics=initial_typed_state_diagnostics,
                )
            )
            consecutive_terminal_transients = 0
    return attempts


def _wait_for_health(port: int) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError("backend health timeout")


def _cleanup_screen_backend(
    process: subprocess.Popen | None,
    process_tree: OwnedProcessTree | None,
    db_path: Path,
) -> None:
    """Best effort cleanup that cannot replace the verifier's primary error."""
    if process is not None:
        try:
            terminate_owned_process_tree(process, process_tree)
        except Exception:  # noqa: BLE001 - cleanup must not replace the verifier result
            print("WARN: backend process cleanup is deferred", flush=True)
    try:
        removed = remove_sqlite_artifacts(db_path)
    except Exception:  # noqa: BLE001 - cleanup must not replace the verifier result
        print("WARN: temporary screen database cleanup is deferred", flush=True)
    else:
        if not removed:
            print("WARN: temporary screen database cleanup is deferred", flush=True)


def _request_screen(port: int, token: str, payload: dict) -> tuple[str, dict]:
    """Read a screen SSE response without retaining untrusted diagnostics."""
    started = time.monotonic()
    transport_first_byte_ms: int | None = None
    first_chunk_ms: int | None = None
    stage = (
        "refinement_request"
        if payload.get("taskAction") == "continue"
        or isinstance(payload.get("prior_solution_summary"), str)
        else "initial_request"
    )

    def elapsed_ms() -> int:
        return round((time.monotonic() - started) * 1000)

    def failure(
        code: str, *, model: str = "unknown", visible: bool = False
    ) -> ScreenRequestFailure:
        return ScreenRequestFailure(
            code=code,
            stage=stage,
            model=_safe_model_identifier(model),
            transport_first_byte_ms=transport_first_byte_ms,
            model_first_chunk_ms=first_chunk_ms,
            total_ms=elapsed_ms(),
            visible_content_started=visible,
        )

    chunks: list[str] = []
    done: dict | None = None
    try:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/chat/screen/stream",
            data=body,
            headers={"Content-Type": "application/json", "X-SkillCue-Token": token},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            for raw_line in response:
                if transport_first_byte_ms is None:
                    transport_first_byte_ms = elapsed_ms()
                try:
                    line = raw_line.decode("utf-8").strip()
                except UnicodeDecodeError:
                    raise failure("malformed_protocol", visible=bool(chunks)) from None
                if not line.startswith("data: "):
                    continue
                try:
                    event = json.loads(line[6:])
                except json.JSONDecodeError:
                    raise failure("malformed_protocol", visible=bool(chunks)) from None
                if not isinstance(event, dict) or not isinstance(
                    event.get("type"), str
                ):
                    raise failure("malformed_protocol", visible=bool(chunks))
                if event["type"] == "chunk":
                    text = event.get("text")
                    if not isinstance(text, str):
                        raise failure("malformed_protocol", visible=bool(chunks))
                    if text and first_chunk_ms is None:
                        first_chunk_ms = elapsed_ms()
                    if text:
                        chunks.append(text)
                elif event["type"] == "done":
                    raw_model = event.get("model")
                    done = {"model": _safe_model_identifier(raw_model)}
                    if payload.get("structuredScreen") is True:
                        raw_task_state = event.get("task_state")
                        if (
                            not isinstance(raw_task_state, str)
                            or not raw_task_state
                            or len(raw_task_state) > 400_000
                        ):
                            raise failure("malformed_protocol", visible=bool(chunks))
                        try:
                            parsed_task_state = json.loads(raw_task_state)
                        except json.JSONDecodeError:
                            raise failure(
                                "malformed_protocol", visible=bool(chunks)
                            ) from None
                        if not isinstance(parsed_task_state, dict):
                            raise failure("malformed_protocol", visible=bool(chunks))
                        done["_task_state"] = raw_task_state
                        done["_typed_state_diagnostics"] = (
                            _derive_typed_state_diagnostics(
                                parsed_task_state,
                                generation_completed=bool(chunks),
                            )
                        )
                elif event["type"] == "error":
                    raise ScreenRequestFailure.from_sse_event(
                        event,
                        stage=stage,
                        transport_first_byte_ms=transport_first_byte_ms,
                        model_first_chunk_ms=first_chunk_ms,
                        total_ms=elapsed_ms(),
                        visible_content_started=bool(chunks),
                    )
                else:
                    raise failure("malformed_protocol", visible=bool(chunks))
        if done is None:
            raise failure("missing_done", visible=bool(chunks))
        done["_e2e_first_chunk_ms"] = first_chunk_ms
        done["_e2e_transport_first_byte_ms"] = transport_first_byte_ms
        done["_e2e_total_ms"] = elapsed_ms()
        return "".join(chunks), done
    except ScreenRequestFailure:
        raise
    except urllib.error.HTTPError as exc:
        status = exc.code if type(exc.code) is int else 0
        code = {
            401: "auth_failed",
            402: "quota_exceeded",
            429: "rate_limited",
        }.get(status, "request_failed")
        if 500 <= status <= 599:
            code = "provider_timeout"
        raise failure(code, visible=bool(chunks)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise failure("backend_unreachable", visible=bool(chunks)) from None
    except Exception:  # noqa: BLE001 - never serialize exception text
        raise failure("request_failed", visible=bool(chunks)) from None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-backend", action="store_true")
    parser.add_argument("--channel", choices=("dev", "alpha"))
    parser.add_argument(
        "--provider", help="explicit provider for source-backend comparisons"
    )
    parser.add_argument("--model", help="explicit screen model override for comparison")
    parser.add_argument(
        "--structured-screen",
        action="store_true",
        help="exercise the typed new/taskState/continue screen pipeline",
    )
    scenario = parser.add_mutually_exclusive_group()
    scenario.add_argument(
        "--fixture-order",
        action="store_true",
        help="verify the real visible pytest fixture setup/test/teardown task",
    )
    scenario.add_argument(
        "--sql-format",
        action="store_true",
        help="verify fenced SQL with a short Russian explanation on every code line",
    )
    scenario.add_argument(
        "--sql-exact-literals",
        action="store_true",
        help="verify exact case-sensitive Female/F literals from a visible SQL task",
    )
    scenario.add_argument(
        "--real-interview-regressions",
        action="store_true",
        help="run the three sanitized sequential real-interview regressions",
    )
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    channel = args.channel or ("alpha" if args.structured_screen else "dev")

    root = Path(__file__).resolve().parent.parent
    api_root = root / "apps" / "api-py"
    installed = (
        Path(os.environ["LOCALAPPDATA"])
        / "Programs"
        / f"skillcue-{channel}"
        / "resources"
        / "backend"
        / "skillcue-backend.exe"
    )
    if not args.source_backend and not installed.exists():
        raise RuntimeError(f"Installed Dev backend not found: {installed}")

    port = _free_port()
    token = uuid.uuid4().hex
    db_path = Path(tempfile.gettempdir()) / f"skillcue-screen-{token}.sqlite"
    env = {
        **os.environ,
        "SKILLCUE_PORT": str(port),
        "SKILLCUE_API_TOKEN": token,
        "SKILLCUE_BUILD_CHANNEL": channel,
        "SKILLCUE_GATEWAY_URL": _MANAGED_DEV_GATEWAY_URL,
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
    }
    command = [str(installed)]
    cwd = None
    if args.source_backend:
        direct_openai = args.provider == "openai"
        env.update(
            {
                "OPENAI_API_KEY": env.get("OPENAI_API_KEY", "")
                if direct_openai
                else "",
                "OPENROUTER_API_KEY": "",
                "PYTHON_KEYRING_BACKEND": _NULL_KEYRING_BACKEND,
                "SKILLCUE_GATEWAY_URL": ""
                if direct_openai
                else _MANAGED_DEV_GATEWAY_URL,
            }
        )
        command = [
            str(api_root / ".venv" / "Scripts" / "python.exe"),
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ]
        cwd = api_root

    process: subprocess.Popen | None = None
    process_tree: OwnedProcessTree | None = None
    try:
        seed_installed_gateway_identity(db_path)
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if os.name == "nt":
            process_tree = OwnedProcessTree.capture(process.pid)
        _wait_for_health(port)
        if args.real_interview_regressions:
            attempts = run_real_interview_regressions(
                port=port,
                token=token,
                repetitions=args.repetitions,
                model_override=args.model,
                provider_override=args.provider,
                structured_screen=args.structured_screen,
            )
            report = build_privacy_safe_regression_report(attempts)
            report_path = args.report or (
                root
                / "output"
                / "verification"
                / "real-interview-overlay"
                / "screen-live.json"
            )
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                "utf-8",
            )
            for attempt in report["attempts"]:
                status = "PASS" if not attempt["failureCodes"] else "FAIL"
                print(
                    f"{status} {attempt['caseId']} repetition={attempt['repetition']} "
                    f"first={attempt['modelFirstChunkMs']}ms total={attempt['totalMs']}ms "
                    f"failures={attempt['failureCodes']}",
                    flush=True,
                )
            print(
                f"SCREEN REGRESSION SUITE {'PASS' if report['summary']['passed'] else 'FAIL'} "
                f"attempts={report['summary']['attempts']} "
                f"failed={report['summary']['failedAttempts']} report={report_path}",
                flush=True,
            )
            return 0 if report["summary"]["passed"] else 1
        if args.fixture_order:
            image_bytes = render_fixture_order_png()
        elif args.sql_format:
            image_bytes = render_sql_solution_png()
        elif args.sql_exact_literals:
            image_bytes = render_sql_solution_png(exact_gender_literals=True)
        else:
            image_bytes = render_code_png()
        image = base64.b64encode(image_bytes).decode("ascii")
        question = "Что выведет этот код?"
        context = "Интервьюер просит решить видимый Python-код."
        mode = "fast"
        if args.fixture_order:
            question = (
                "Реши задание на экране. Перечисли точный порядок setup всех фикстур, "
                "выполнения test_order и teardown после yield."
            )
            context = "Интервьюер просит определить порядок выполнения pytest-фикстур."
            mode = "deep"
        elif args.sql_format:
            question = (
                "Реши SQL-задачу на экране. Дай готовый запрос: один блок кода без пустых строк, "
                "а напротив каждой строки добавь короткий комментарий на русском, что она делает."
            )
            context = "Интервьюер просит написать SQL и вслух объяснить каждую строку."
            mode = "deep"
        elif args.sql_exact_literals:
            question = (
                "Реши SQL-задачу на экране. Сохрани точные имена, операторы и регистр "
                "строковых литералов из условия."
            )
            context = "Интервьюер проверяет точность SQL-условия по видимым данным."
            mode = "deep"
        payload = {
            "image": f"data:image/png;base64,{image}",
            "question": question,
            "context": context,
            "mode": mode,
            "answer_language": "ru",
        }
        if args.provider:
            payload["provider"] = args.provider
        if args.model:
            payload["modelOverride"] = args.model
        answer, done = _request_screen(port, token, payload)
        if args.sql_exact_literals:
            code_lines = sql_code_lines(answer)
            code = "\n".join(code_lines)
            required = {
                "full_query": all(
                    term in code.lower()
                    for term in ("select", "from purchases", "where")
                ),
                "exact_female": "'Female'" in code,
                "exact_short_literal": "'F'" in code,
                "both_literals": bool(
                    re.search(r"\bIN\s*\(\s*'Female'\s*,\s*'F'\s*\)", code)
                    or (
                        re.search(r"=\s*'Female'", code)
                        and re.search(r"=\s*'F'", code)
                        and re.search(r"\bOR\b", code, re.IGNORECASE)
                    )
                ),
                "no_lowercase_substitution": "'female'" not in code
                and "'f'" not in code,
            }
            if not all(required.values()):
                raise RuntimeError(
                    f"sql exact-literal assertions failed: done={done}, required={required}\n{answer}"
                )
            print(answer)
            print(
                "VISION SQL EXACT LITERALS PASS: "
                f"model={done.get('model')} first={done.get('_e2e_first_chunk_ms')}ms "
                f"total={done.get('_e2e_total_ms')}ms required={required}"
            )
            return 0
        if args.sql_format:
            code_lines = sql_code_lines(answer)
            lowered_code = "\n".join(code_lines).lower()
            every_line_explained = every_code_line_has_following_comment(
                code_lines, "--"
            )
            required = {
                "spoken_summary_before_code": has_short_spoken_summary_before_code(
                    answer
                ),
                "fenced_code": len(code_lines) >= 3,
                "select_sum": "select" in lowered_code and "sum" in lowered_code,
                "from_purchases": "from purchases" in lowered_code,
                "case_insensitive_filter": "lower" in lowered_code
                and "female" in lowered_code,
                "russian_comment_every_line": every_line_explained,
            }
            if not done or not all(required.values()):
                raise RuntimeError(
                    f"sql-format vision assertions failed: done={done}, required={required}\n{answer}"
                )
            print(answer)
            print(
                f"VISION SQL FORMAT PASS: model={done.get('model')} required={required}"
            )

            follow_up_question = (
                "Теперь доработай предыдущий SQL: не удаляй фильтр по полу и добавь условие "
                "items > 0. Верни полный обновлённый запрос с русским комментарием на каждой строке."
            )
            follow_up_context = (
                "[ПРЕДЫДУЩАЯ ЗАДАЧА НА ЭКРАНЕ]\n"
                f"Вопрос: {question}\n"
                f"Последний ответ SkillCue:\n{answer}\n"
                "[ТЕКУЩЕЕ УТОЧНЕНИЕ]\n"
                f"{follow_up_question}"
            )
            follow_up_answer, follow_up_done = _request_screen(
                port,
                token,
                {
                    **payload,
                    "question": follow_up_question,
                    "context": follow_up_context,
                },
            )
            follow_up_lines = sql_code_lines(follow_up_answer)
            follow_up_code = "\n".join(follow_up_lines).lower()
            follow_up_required = {
                "spoken_summary_before_code": has_short_spoken_summary_before_code(
                    follow_up_answer
                ),
                "full_query": all(
                    term in follow_up_code
                    for term in ("select", "from purchases", "where")
                ),
                "preserved_gender_filter": "lower" in follow_up_code
                and "female" in follow_up_code,
                "added_items_filter": bool(re.search(r"items\s*>\s*0", follow_up_code)),
                "russian_comment_every_line": every_code_line_has_following_comment(
                    follow_up_lines, "--"
                ),
            }
            if not follow_up_done or not all(follow_up_required.values()):
                raise RuntimeError(
                    "sql follow-up assertions failed: "
                    f"done={follow_up_done}, required={follow_up_required}\n{follow_up_answer}"
                )
            print(follow_up_answer)
            print(
                "VISION SQL FOLLOW-UP PASS: "
                f"model={follow_up_done.get('model')} required={follow_up_required}"
            )
            return 0
        if args.fixture_order:
            trace = fixture_trace(answer)
            rewrote_source = (
                "@pytest.fixture" in answer or "def session_fixture" in answer
            )
            if not done or not fixture_trace_is_valid(trace) or rewrote_source:
                raise RuntimeError(
                    "fixture-order vision assertions failed: "
                    f"done={done}, trace={trace}, expected={FIXTURE_TRACE}, "
                    f"rewrote_source={rewrote_source}\n{answer}"
                )
            print(answer)
            print(f"VISION FIXTURE PASS: model={done.get('model')} trace={trace}")
            return 0

        lowered = answer.lower()
        required = {
            "False": "false" in lowered or "лож" in lowered,
            "TypeError": "typeerror" in lowered,
            "immutability": "неизмен" in lowered or "immutable" in lowered,
        }
        if not done or not all(required.values()):
            raise RuntimeError(
                f"vision assertions failed: done={done}, required={required}\n{answer}"
            )
        print(answer)
        print(f"VISION PASS: model={done.get('model')} required={required}")
        return 0
    finally:
        try:
            _cleanup_screen_backend(process, process_tree, db_path)
        except Exception:  # noqa: BLE001 - cleanup must not replace the verifier result
            print("WARN: screen verifier cleanup is deferred", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
