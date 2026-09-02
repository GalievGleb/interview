import json

import pytest
from pydantic import ValidationError

from app.services.screen_task_state import (
    MAX_FRAME_FINDINGS,
    MAX_RETAINED_FRAMES,
    MAX_VISIBLE_TEXT_CHARS,
    ChecklistScope,
    CorrectionMode,
    FindingKind,
    FrameDigest,
    PythonShape,
    ScreenChecklistItem,
    ScreenCodeLanguage,
    ScreenFinding,
    ScreenFrame,
    ScreenLedgerEntry,
    ScreenResponseKind,
    ScreenSourceEntry,
    ScreenSourceFragment,
    ScreenSourceKind,
    ScreenTaskRequirements,
    ScreenTaskState,
    ScreenTaskTtl,
    SqlStatementKind,
    TaskKind,
    active_screen_findings,
    active_screen_sources,
    deserialize_screen_task_state,
    is_screen_task_state_expired,
    merge_screen_frame,
    render_screen_task_context,
    render_screen_task_findings,
    serialize_screen_task_state,
)


def _digest(index: int) -> FrameDigest:
    return FrameDigest(sha256=f"{index:064x}")


def _finding(
    finding_id: str,
    *,
    claim: str | None = None,
    supersedes: str | None = None,
) -> ScreenFinding:
    return ScreenFinding(
        id=finding_id,
        claim=claim or f"claim-{finding_id}",
        evidence=f"evidence-{finding_id}",
        kind=FindingKind.FACT,
        supersedes=supersedes,
    )


def _frame(index: int, *findings: ScreenFinding, text: str | None = None) -> ScreenFrame:
    return ScreenFrame(
        digest=_digest(index),
        captured_at_ms=index * 1_000,
        visible_text=text if text is not None else f"viewport-{index}",
        findings=list(findings),
    )


def _source(
    source_id: str,
    *,
    text: str | None = None,
    supersedes: str | None = None,
) -> ScreenSourceFragment:
    return ScreenSourceFragment(
        id=source_id,
        text=text or f"source-{source_id}",
        kind=ScreenSourceKind.CODE,
        supersedes=supersedes,
    )


def _state(
    *frames: ScreenFrame,
    task_kind: TaskKind = TaskKind.ANALYSIS,
    correction_mode: CorrectionMode = CorrectionMode.ACCUMULATE,
) -> ScreenTaskState:
    return ScreenTaskState(
        task_kind=task_kind,
        response_kind=ScreenResponseKind.ANALYSIS_FINDINGS,
        correction_mode=correction_mode,
        requirements=ScreenTaskRequirements(
            objective="Find every supported defect",
            public_contract=["Keep the visible API unchanged"],
            constraints=["Use only retained evidence"],
        ),
        frames=list(frames),
        ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000),
    )


def test_round_trip_contains_only_bounded_json_safe_state() -> None:
    state = _state(_frame(1, _finding("frame-1-fact")))

    encoded = serialize_screen_task_state(state)
    restored = deserialize_screen_task_state(encoded)

    assert restored == state
    assert json.loads(encoded)["frames"][0]["digest"] == {"sha256": f"{1:064x}"}
    assert "image" not in encoded.lower()


def test_source_ledger_survives_frame_eviction_and_is_rendered_with_provenance() -> None:
    first = _frame(1, _finding("fact-1"))
    first = first.model_copy(update={"sources": (_source("source-1", text="print(41 + 1)"),)})
    state = _state(first)

    for index in range(2, MAX_RETAINED_FRAMES + 2):
        frame = _frame(index, _finding(f"fact-{index}"))
        frame = frame.model_copy(
            update={"sources": (_source(f"source-{index}", text=f"code-{index}"),)}
        )
        state = merge_screen_frame(state, frame, now_ms=index * 1_000, ttl_ms=60_000)

    assert len(state.frames) == MAX_RETAINED_FRAMES
    assert state.frames[0].digest != _digest(1)
    assert [source.id for source in active_screen_sources(state)] == [
        *(f"source-{index}" for index in range(1, MAX_RETAINED_FRAMES + 2))
    ]
    rendered = render_screen_task_context(state)
    assert "[source-1] code" in rendered
    assert "print(41 + 1)" in rendered
    assert f"frame={_digest(1).sha256}" in rendered
    assert "data:image" not in rendered


def test_same_digest_source_revision_can_supersede_prior_source_without_self_collision() -> None:
    original = _frame(1, _finding("fact-1"))
    original = original.model_copy(
        update={"sources": (_source("source-old", text="SELECT * FROM orders"),)}
    )
    state = _state(original)
    corrected = _frame(1, _finding("fact-2"), text="SELECT id FROM orders")
    corrected = corrected.model_copy(
        update={
            "sources": (
                _source(
                    "source-new",
                    text="SELECT id FROM orders",
                    supersedes="source-old",
                ),
            )
        }
    )

    merged = merge_screen_frame(state, corrected, now_ms=2_000, ttl_ms=60_000)

    assert [source.id for source in active_screen_sources(merged)] == ["source-new"]
    assert merged.frames[-1].visible_text == "SELECT id FROM orders"
    assert merged.source_ledger == (
        ScreenSourceEntry(
            frame_digest=_digest(1),
            source=_source("source-old", text="SELECT * FROM orders").model_copy(
                update={"active": False}
            ),
        ),
        ScreenSourceEntry(
            frame_digest=_digest(1),
            source=_source(
                "source-new",
                text="SELECT id FROM orders",
                supersedes="source-old",
            ),
        ),
    )


@pytest.mark.parametrize(
    ("payload", "expected_location"),
    [
        ({"sha256": "not-a-sha256"}, "sha256"),
        ({"sha256": f"{1:064x}", "pixels": "secret"}, "pixels"),
        ({"sha256": f"{1:064x}", "unknown": True}, "unknown"),
    ],
)
def test_frame_digest_accepts_only_a_sha256(payload: dict, expected_location: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        FrameDigest.model_validate(payload)

    assert expected_location in str(exc_info.value)


@pytest.mark.parametrize(
    "unsafe_text",
    [
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        "A" * 300,
        "screenshot: " + "A" * 300,
        "A" * 258 + "-_",
        "\n".join(["A" * 76] * 4),
        "data:image/png;base64,\n" + "A" * 300,
    ],
)
def test_state_rejects_data_urls_and_base64_blobs(unsafe_text: str) -> None:
    payload = _state(_frame(1)).model_dump(mode="json")
    payload["frames"][0]["visible_text"] = unsafe_text

    with pytest.raises(ValidationError, match="binary payload"):
        serialize_screen_task_state(payload)


@pytest.mark.parametrize(
    "safe_text",
    [
        " ".join(["Это обычное длинное русское описание условия задачи."] * 80),
        " ".join(["This is a normal long interview task description with ordinary words."] * 80),
        "\n".join(
            [
                "def load(conn, order_id):",
                "    rows = conn.execute(query, (order_id,))",
                "    return rows.fetchall()",
            ]
            * 50
        ),
    ],
)
def test_state_keeps_long_normal_russian_and_code_text(safe_text: str) -> None:
    payload = _state(_frame(1)).model_dump(mode="json")
    payload["frames"][0]["visible_text"] = safe_text

    restored = deserialize_screen_task_state(serialize_screen_task_state(payload))

    assert restored.frames[0].visible_text == safe_text


def test_requirements_have_explicit_fail_closed_capabilities_and_structural_requirements() -> None:
    defaults = ScreenTaskRequirements(objective="Решить задачу")

    assert defaults.allow_join is False
    assert defaults.allow_cte is False
    assert defaults.allow_json is False
    assert defaults.allow_helper is False
    assert defaults.required_python_signatures == ()
    assert defaults.required_python_calls == ()
    assert defaults.required_sql_identifiers == ()
    assert defaults.required_sql_clauses == ()
    assert defaults.required_sql_bound_ids == ()
    assert defaults.required_literals == ()
    assert defaults.code_language == ScreenCodeLanguage.OTHER
    assert defaults.expected_sql_statement_kind is None

    explicit = ScreenTaskRequirements(
        objective="Решить задачу",
        allow_join=True,
        allow_cte=True,
        allow_json=True,
        allow_helper=True,
        code_language=ScreenCodeLanguage.SQL,
        expected_sql_statement_kind=SqlStatementKind.SELECT,
        required_sql_identifiers=["id", "orders"],
        required_sql_clauses=["select", "from"],
        required_literals=["active"],
    )

    assert explicit.required_sql_identifiers == ("id", "orders")
    assert explicit.required_sql_clauses == ("select", "from")
    assert explicit.required_literals == ("active",)
    assert explicit.expected_sql_statement_kind == SqlStatementKind.SELECT


def test_sql_statement_kind_requires_a_sql_capable_language() -> None:
    with pytest.raises(ValidationError, match="expected_sql_statement_kind"):
        ScreenTaskRequirements(
            objective="Решить задачу",
            code_language=ScreenCodeLanguage.OTHER,
            expected_sql_statement_kind=SqlStatementKind.SELECT,
        )
    with pytest.raises(ValidationError, match="expected_sql_statement_kind"):
        ScreenTaskRequirements(
            objective="Решить задачу",
            code_language=ScreenCodeLanguage.SQL,
        )


@pytest.mark.parametrize(
    ("field_name", "unsafe_value"),
    [
        ("required_python_signatures", "please keep load(args)"),
        ("required_python_calls", "os.system('boom')"),
        ("required_sql_identifiers", "users; DROP TABLE users"),
        ("required_sql_bound_ids", "order-id"),
        ("required_sql_clauses", "SELECT id FROM users"),
    ],
)
def test_structural_requirements_reject_prose_and_executable_fragments(
    field_name: str,
    unsafe_value: str,
) -> None:
    language_fields = {"code_language": ScreenCodeLanguage.PYTHON}
    if field_name.startswith("required_sql"):
        language_fields = {
            "code_language": ScreenCodeLanguage.SQL,
            "expected_sql_statement_kind": SqlStatementKind.SELECT,
        }

    with pytest.raises(ValidationError):
        ScreenTaskRequirements(
            objective="Решить задачу",
            **language_fields,
            **{field_name: [unsafe_value]},
        )


@pytest.mark.parametrize(
    "field_name",
    [
        "required_python_signatures",
        "required_python_calls",
        "required_sql_identifiers",
        "required_sql_clauses",
        "required_sql_bound_ids",
        "required_literals",
    ],
)
def test_structural_requirements_are_bounded(field_name: str) -> None:
    language_fields = {
        "code_language": ScreenCodeLanguage.PYTHON,
        "expected_sql_statement_kind": None,
    }
    if field_name.startswith("required_sql"):
        language_fields = {
            "code_language": ScreenCodeLanguage.SQL,
            "expected_sql_statement_kind": SqlStatementKind.SELECT,
        }
    with pytest.raises(ValidationError):
        ScreenTaskRequirements(
            objective="Решить задачу",
            **language_fields,
            **{field_name: [f"fragment-{index}" for index in range(17)]},
        )
    with pytest.raises(ValidationError):
        ScreenTaskRequirements(
            objective="Решить задачу",
            **language_fields,
            **{field_name: ["x" * 201]},
        )


def test_models_reject_unknown_fields() -> None:
    payload = _state(_frame(1)).model_dump(mode="json")
    payload["raw_image"] = "pixels"

    with pytest.raises(ValidationError, match="raw_image"):
        serialize_screen_task_state(payload)


def test_merge_keeps_findings_that_new_frame_omits() -> None:
    state = _state(_frame(1, _finding("old-a"), _finding("old-b")))

    merged = merge_screen_frame(
        state,
        _frame(2, _finding("new-c")),
        now_ms=2_000,
        ttl_ms=60_000,
    )

    assert [finding.id for finding in active_screen_findings(merged)] == [
        "old-a",
        "old-b",
        "new-c",
    ]


def test_explicit_supersedes_deactivates_only_the_named_finding() -> None:
    state = _state(_frame(1, _finding("old-a"), _finding("old-b")))

    merged = merge_screen_frame(
        state,
        _frame(2, _finding("replacement", supersedes="old-a")),
        now_ms=2_000,
        ttl_ms=60_000,
    )

    ledger = {finding.id: finding for frame in merged.frames for finding in frame.findings}
    assert ledger["old-a"].active is False
    assert ledger["old-b"].active is True
    assert ledger["replacement"].active is True
    assert [finding.id for finding in active_screen_findings(merged)] == [
        "old-b",
        "replacement",
    ]


def test_supersedes_requires_an_exact_active_target() -> None:
    state = _state(_frame(1, _finding("old-a")))

    with pytest.raises(ValueError, match="missing active finding"):
        merge_screen_frame(
            state,
            _frame(2, _finding("replacement", supersedes="not-there")),
            now_ms=2_000,
            ttl_ms=60_000,
        )


def test_merge_deduplicates_digest_and_finding_id_without_overwriting() -> None:
    state = _state(_frame(1, _finding("stable-id", claim="original")))

    duplicate_frame = merge_screen_frame(
        state,
        _frame(1, _finding("ignored", claim="must not enter ledger")),
        now_ms=2_000,
        ttl_ms=60_000,
    )
    merged = merge_screen_frame(
        duplicate_frame,
        _frame(2, _finding("stable-id", claim="must not overwrite"), _finding("new-id")),
        now_ms=3_000,
        ttl_ms=60_000,
    )

    assert len(merged.frames) == 2
    assert [finding.id for finding in active_screen_findings(merged)] == [
        "stable-id",
        "ignored",
        "new-id",
    ]
    assert active_screen_findings(merged)[0].claim == "original"


def test_merge_evicts_oldest_frame_and_refreshes_ttl_at_hard_bound() -> None:
    frames = [_frame(index, _finding(f"finding-{index}")) for index in range(1, 5)]
    state = _state(*frames[:MAX_RETAINED_FRAMES])

    merged = merge_screen_frame(
        state,
        frames[MAX_RETAINED_FRAMES],
        now_ms=9_000,
        ttl_ms=30_000,
    )

    assert len(merged.frames) == MAX_RETAINED_FRAMES
    assert [frame.digest for frame in merged.frames] == [frame.digest for frame in frames[1:]]
    assert merged.ttl.created_at_ms == 1_000
    assert merged.ttl.updated_at_ms == 9_000
    assert merged.ttl.expires_at_ms == 39_000


def test_frame_eviction_keeps_active_findings_in_the_independent_ledger() -> None:
    frames = [_frame(index, _finding(f"finding-{index}")) for index in range(1, 5)]
    state = _state(*frames[:MAX_RETAINED_FRAMES])

    merged = merge_screen_frame(
        state,
        frames[MAX_RETAINED_FRAMES],
        now_ms=9_000,
        ttl_ms=30_000,
    )

    assert _digest(1) not in [frame.digest for frame in merged.frames]
    assert [finding.id for finding in active_screen_findings(merged)] == [
        "finding-1",
        "finding-2",
        "finding-3",
        "finding-4",
    ]
    assert "claim-finding-1" in render_screen_task_context(merged)


def test_same_digest_retry_merges_unique_findings_and_exact_supersession() -> None:
    state = _state(_frame(1, _finding("old-a"), _finding("old-b")))

    merged = merge_screen_frame(
        state,
        _frame(
            1,
            _finding("old-b", claim="duplicate must not overwrite"),
            _finding("replacement", supersedes="old-a"),
            _finding("new-c"),
        ),
        now_ms=2_000,
        ttl_ms=60_000,
    )

    assert len(merged.frames) == 1
    assert [finding.id for finding in active_screen_findings(merged)] == [
        "old-b",
        "replacement",
        "new-c",
    ]
    assert (
        next(finding for finding in merged.ledger if finding.finding.id == "old-a").finding.active
        is False
    )
    assert (
        next(finding for finding in merged.ledger if finding.finding.id == "old-b").finding.claim
        == "claim-old-b"
    )


def test_merge_rejects_an_expired_state_instead_of_resurrecting_it() -> None:
    state = _state(_frame(1, _finding("old")))

    with pytest.raises(ValueError, match="expired"):
        merge_screen_frame(
            state,
            _frame(2, _finding("new")),
            now_ms=61_000,
            ttl_ms=60_000,
        )


def test_frame_text_and_finding_count_are_bounded() -> None:
    with pytest.raises(ValidationError):
        _frame(1, text="x" * (MAX_VISIBLE_TEXT_CHARS + 1))
    with pytest.raises(ValidationError):
        _frame(1, *[_finding(f"f-{index}") for index in range(MAX_FRAME_FINDINGS + 1)])


def test_state_is_deeply_immutable() -> None:
    state = _state(_frame(1, _finding("stable")))

    assert isinstance(state.frames, tuple)
    assert isinstance(state.frames[0].findings, tuple)
    assert isinstance(state.ledger, tuple)
    assert isinstance(state.requirements.public_contract, tuple)
    with pytest.raises(AttributeError):
        state.frames.append(_frame(2))
    with pytest.raises(ValidationError):
        state.frames[0].visible_text = "mutated"


def test_explicit_ledger_preserves_frame_provenance_after_frame_eviction() -> None:
    state = _state(_frame(1, _finding("stable")))

    assert state.ledger == (ScreenLedgerEntry(frame_digest=_digest(1), finding=_finding("stable")),)


@pytest.mark.parametrize("task_kind", [TaskKind.ANALYSIS, TaskKind.LIST, TaskKind.FIND_DEFECT])
def test_analysis_style_render_unifies_active_findings_from_every_frame(
    task_kind: TaskKind,
) -> None:
    state = _state(
        _frame(1, _finding("prior")),
        _frame(2, _finding("current")),
        task_kind=task_kind,
    )

    rendered = render_screen_task_context(state)

    assert [finding.id for finding in render_screen_task_findings(state)] == [
        "prior",
        "current",
    ]
    assert "claim-prior" in rendered
    assert "claim-current" in rendered
    assert "Keep the visible API unchanged" in rendered
    assert "Allowed constructs: none" in rendered


def test_exact_new_renders_latest_delta_but_keeps_full_active_ledger() -> None:
    state = _state(
        _frame(1, _finding("prior")),
        _frame(2, _finding("current")),
        correction_mode=CorrectionMode.EXACT_NEW,
    )

    assert [finding.id for finding in render_screen_task_findings(state)] == ["current"]
    assert [finding.id for finding in active_screen_findings(state)] == ["prior", "current"]


def test_ttl_metadata_is_validated_and_expiry_is_exact() -> None:
    state = _state(_frame(1))

    assert is_screen_task_state_expired(state, now_ms=60_999) is False
    assert is_screen_task_state_expired(state, now_ms=61_000) is True
    with pytest.raises(ValidationError, match="expires_at_ms"):
        ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=2_000, expires_at_ms=1_999)


def test_checklist_state_keeps_only_bounded_typed_unique_artifacts() -> None:
    state = ScreenTaskState(
        task_kind=TaskKind.LIST,
        response_kind=ScreenResponseKind.CHECKLIST,
        requirements=ScreenTaskRequirements(
            objective="Составить пять проверок",
            requested_item_count=5,
            checklist_scope=ChecklistScope.BUSINESS,
        ),
        checklist_items=[
            ScreenChecklistItem(id="check-1", text="Проверить успешный заказ"),
            ScreenChecklistItem(id="check-2", text="Проверить пустое поле"),
        ],
        ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000),
    )

    restored = deserialize_screen_task_state(serialize_screen_task_state(state))

    assert isinstance(restored.checklist_items, tuple)
    assert [item.text for item in restored.checklist_items] == [
        "Проверить успешный заказ",
        "Проверить пустое поле",
    ]


def test_checklist_state_rejects_missing_metadata_and_normalized_duplicates() -> None:
    ttl = ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000)
    with pytest.raises(ValidationError, match="requested_item_count"):
        ScreenTaskState(
            task_kind=TaskKind.LIST,
            response_kind=ScreenResponseKind.CHECKLIST,
            requirements=ScreenTaskRequirements(objective="Составить проверки"),
            ttl=ttl,
        )
    with pytest.raises(ValidationError, match="texts must be unique"):
        ScreenTaskState(
            task_kind=TaskKind.LIST,
            response_kind=ScreenResponseKind.CHECKLIST,
            requirements=ScreenTaskRequirements(
                objective="Составить проверки",
                requested_item_count=2,
                checklist_scope=ChecklistScope.BUSINESS,
            ),
            checklist_items=[
                ScreenChecklistItem(id="check-1", text="Проверить успешный заказ"),
                ScreenChecklistItem(id="check-2", text="  ПРОВЕРИТЬ   успешный заказ  "),
            ],
            ttl=ttl,
        )


def test_non_checklist_state_rejects_checklist_request_metadata() -> None:
    with pytest.raises(ValidationError, match="response_kind=checklist"):
        ScreenTaskState(
            task_kind=TaskKind.ANALYSIS,
            response_kind=ScreenResponseKind.ANALYSIS_FINDINGS,
            requirements=ScreenTaskRequirements(
                objective="Проанализировать код",
                requested_item_count=3,
                checklist_scope=ChecklistScope.TECHNICAL,
            ),
            ttl=ScreenTaskTtl(
                created_at_ms=1_000,
                updated_at_ms=1_000,
                expires_at_ms=61_000,
            ),
        )


def test_checklist_tracks_explicit_count_and_semantic_keys() -> None:
    state = ScreenTaskState(
        task_kind=TaskKind.LIST,
        response_kind=ScreenResponseKind.CHECKLIST,
        requirements=ScreenTaskRequirements(
            objective="Добавить варианты",
            requested_item_count=5,
            requested_item_count_explicit=False,
            checklist_scope=ChecklistScope.BUSINESS,
        ),
        checklist_items=(
            ScreenChecklistItem(
                id="check-one",
                text="Проверить создание заказа",
                semantic_key="order.create.success",
            ),
        ),
        ttl=ScreenTaskTtl(created_at_ms=1, updated_at_ms=1, expires_at_ms=2),
    )

    assert state.requirements.requested_item_count_explicit is False
    assert state.checklist_items[0].semantic_key == "order.create.success"

    duplicate = state.model_dump(mode="python")
    duplicate["checklist_items"] = (
        *state.checklist_items,
        ScreenChecklistItem(
            id="check-two",
            text="Совсем другой текст",
            semantic_key="order.create.success",
        ),
    )
    with pytest.raises(ValidationError, match="semantic keys"):
        ScreenTaskState.model_validate(duplicate)


def test_python_shape_is_explicit_and_non_python_cannot_claim_one() -> None:
    python_requirements = ScreenTaskRequirements(
        objective="Написать pytest-тесты",
        code_language=ScreenCodeLanguage.PYTHON,
        python_shape=PythonShape.PYTEST,
    )
    assert python_requirements.python_shape == PythonShape.PYTEST

    with pytest.raises(ValidationError, match="python_shape"):
        ScreenTaskRequirements(
            objective="SQL query",
            code_language=ScreenCodeLanguage.SQL,
            python_shape=PythonShape.SCRIPT,
            expected_sql_statement_kind=SqlStatementKind.SELECT,
        )


def test_python_embedded_sql_can_declare_expected_statement_kind() -> None:
    requirements = ScreenTaskRequirements(
        objective="Выполнить параметризованный UPDATE из Python",
        code_language=ScreenCodeLanguage.PYTHON,
        python_shape=PythonShape.FUNCTION,
        expected_sql_statement_kind=SqlStatementKind.UPDATE,
        required_python_signatures=("def deactivate(user_id):",),
        required_python_calls=("cursor.execute",),
        required_sql_identifiers=("users", "active", "id"),
        required_sql_bound_ids=("user_id",),
    )

    assert requirements.expected_sql_statement_kind == SqlStatementKind.UPDATE
