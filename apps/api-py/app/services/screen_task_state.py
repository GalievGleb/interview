"""Pure, bounded, transient state for multi-viewport screen tasks.

Raw pixels never enter this model, but OCR ``visible_text`` and finding evidence
are still sensitive interview data.  Keep instances only in short-lived memory;
the serialized form is for ephemeral trusted-process transfer and must never be
logged or persisted.  This module intentionally has no cache or global registry.
"""

from __future__ import annotations

import ast
import json
import re
from collections.abc import Mapping
from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_RETAINED_FRAMES = 3
MAX_FRAME_FINDINGS = 16
MAX_LEDGER_FINDINGS = 96
MAX_FRAME_SOURCES = 8
MAX_SOURCE_LEDGER_ITEMS = 32
MAX_SOURCE_TEXT_CHARS = 4_000
MAX_VISIBLE_TEXT_CHARS = 8_000
MAX_TOTAL_VISIBLE_TEXT_CHARS = MAX_RETAINED_FRAMES * MAX_VISIBLE_TEXT_CHARS
MAX_REQUIREMENT_ITEMS = 12
MAX_REQUIREMENT_ITEM_CHARS = 600
MAX_TYPED_REQUIREMENT_ITEMS = 16
MAX_TYPED_REQUIREMENT_CHARS = 200
MAX_CHECKLIST_ITEMS = 64
MAX_CHECKLIST_ITEM_CHARS = 300
MAX_REQUESTED_CHECKLIST_ITEMS = 20
MAX_OBJECTIVE_CHARS = 1_200
MAX_FINDING_ID_CHARS = 96
MAX_FINDING_CLAIM_CHARS = 800
MAX_FINDING_EVIDENCE_CHARS = 1_200
MAX_TTL_MS = 7_200_000
MAX_SERIALIZED_STATE_CHARS = 400_000

_DATA_URL_RE = re.compile(r"data:[^\s,]{0,160},", re.IGNORECASE)
_BASE64_ALPHABET_RE = re.compile(r"[A-Za-z0-9+/_-]{256,}={0,2}")
_DOTTED_IDENTIFIER_RE = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
_CHECKLIST_NORMALIZE_RE = re.compile(r"[\W_]+", re.UNICODE)
_SQL_CLAUSE_ALLOWLIST = frozenset(
    {
        "select",
        "from",
        "where",
        "group by",
        "having",
        "order by",
        "limit",
        "join",
        "with",
        "values",
        "set",
        "returning",
    }
)


def _is_python_function_signature(value: str) -> bool:
    if "\n" in value or "\r" in value:
        return False
    try:
        tree = ast.parse(f"{value.rstrip()}\n    pass", mode="exec")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return False
    if len(tree.body) != 1 or not isinstance(tree.body[0], (ast.FunctionDef, ast.AsyncFunctionDef)):
        return False
    return not tree.body[0].decorator_list


FindingId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=MAX_FINDING_ID_CHARS,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
    ),
]
RequirementText = Annotated[str, Field(min_length=1, max_length=MAX_REQUIREMENT_ITEM_CHARS)]
TypedRequirement = Annotated[
    str,
    Field(min_length=1, max_length=MAX_TYPED_REQUIREMENT_CHARS),
]
ChecklistText = Annotated[str, Field(min_length=1, max_length=MAX_CHECKLIST_ITEM_CHARS)]


def _contains_binary_payload(value: Any) -> bool:
    if isinstance(value, str):
        stripped = value.strip()
        whitespace_unwrapped = re.sub(r"\s+", "", stripped)
        return bool(
            _DATA_URL_RE.search(stripped)
            or "base64," in stripped.lower()
            or _DATA_URL_RE.search(whitespace_unwrapped)
            or "base64," in whitespace_unwrapped.lower()
            or _BASE64_ALPHABET_RE.search(whitespace_unwrapped)
        )
    if isinstance(value, Mapping):
        return any(_contains_binary_payload(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_contains_binary_payload(item) for item in value)
    return False


def normalize_screen_checklist_text(value: str) -> str:
    return " ".join(_CHECKLIST_NORMALIZE_RE.sub(" ", value.casefold()).split())


class _StrictJsonModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    @model_validator(mode="before")
    @classmethod
    def reject_binary_payloads(cls, value: Any) -> Any:
        if _contains_binary_payload(value):
            raise ValueError("binary payloads, data URLs, and base64 blobs are forbidden")
        return value


class TaskKind(StrEnum):
    ANALYSIS = "analysis"
    LIST = "list"
    FIND_DEFECT = "find_defect"
    CODE = "code"
    OTHER = "other"


class ScreenResponseKind(StrEnum):
    ANALYSIS_FINDINGS = "analysis_findings"
    CODE_SOLUTION = "code_solution"
    CHECKLIST = "checklist"
    DIRECT_ANSWER = "direct_answer"
    EXECUTION_RESULT = "execution_result"


class ScreenCodeLanguage(StrEnum):
    PYTHON = "python"
    SQL = "sql"
    OTHER = "other"


class PythonShape(StrEnum):
    FUNCTION = "function"
    SCRIPT = "script"
    CLASS = "class"
    PYTEST = "pytest"


class SqlStatementKind(StrEnum):
    SELECT = "select"
    INSERT = "insert"
    UPDATE = "update"
    DELETE = "delete"


class ScreenTaskAction(StrEnum):
    NEW = "new"
    CONTINUE = "continue"


class ChecklistScope(StrEnum):
    BUSINESS = "business"
    TECHNICAL = "technical"
    MIXED = "mixed"


class ScreenSourceKind(StrEnum):
    TASK_TEXT = "task_text"
    CODE = "code"
    SCHEMA = "schema"
    EXAMPLE = "example"
    OTHER = "other"


class CorrectionMode(StrEnum):
    ACCUMULATE = "accumulate"
    REFINE = "refine"
    EXACT_NEW = "exact_new"


class FindingKind(StrEnum):
    FACT = "fact"
    REQUIREMENT = "requirement"
    CONSTRAINT = "constraint"
    DEFECT = "defect"
    SOLUTION = "solution"


class FrameDigest(_StrictJsonModel):
    """Content identity only; raw frames and pixels can never enter the ledger."""

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ScreenTaskRequirements(_StrictJsonModel):
    objective: str = Field(min_length=1, max_length=MAX_OBJECTIVE_CHARS)
    public_contract: tuple[RequirementText, ...] = Field(
        default_factory=tuple,
        max_length=MAX_REQUIREMENT_ITEMS,
    )
    constraints: tuple[RequirementText, ...] = Field(
        default_factory=tuple,
        max_length=MAX_REQUIREMENT_ITEMS,
    )
    allow_join: bool = False
    allow_cte: bool = False
    allow_json: bool = False
    allow_helper: bool = False
    required_python_signatures: tuple[TypedRequirement, ...] = Field(
        default_factory=tuple,
        max_length=MAX_TYPED_REQUIREMENT_ITEMS,
    )
    required_python_calls: tuple[TypedRequirement, ...] = Field(
        default_factory=tuple,
        max_length=MAX_TYPED_REQUIREMENT_ITEMS,
    )
    required_sql_identifiers: tuple[TypedRequirement, ...] = Field(
        default_factory=tuple,
        max_length=MAX_TYPED_REQUIREMENT_ITEMS,
    )
    required_sql_clauses: tuple[TypedRequirement, ...] = Field(
        default_factory=tuple,
        max_length=MAX_TYPED_REQUIREMENT_ITEMS,
    )
    required_sql_bound_ids: tuple[TypedRequirement, ...] = Field(
        default_factory=tuple,
        max_length=MAX_TYPED_REQUIREMENT_ITEMS,
    )
    required_literals: tuple[TypedRequirement, ...] = Field(
        default_factory=tuple,
        max_length=MAX_TYPED_REQUIREMENT_ITEMS,
    )
    code_language: ScreenCodeLanguage = ScreenCodeLanguage.OTHER
    python_shape: PythonShape | None = None
    expected_sql_statement_kind: SqlStatementKind | None = None
    requested_item_count: int | None = Field(
        default=None,
        ge=1,
        le=MAX_REQUESTED_CHECKLIST_ITEMS,
    )
    requested_item_count_explicit: bool = False
    checklist_new_only: bool = False
    checklist_scope: ChecklistScope | None = None

    @field_validator(
        "public_contract",
        "constraints",
        "required_python_signatures",
        "required_python_calls",
        "required_sql_identifiers",
        "required_sql_clauses",
        "required_sql_bound_ids",
        "required_literals",
        mode="before",
    )
    @classmethod
    def freeze_items(cls, value: Any) -> Any:
        return tuple(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def validate_sql_statement_kind(self) -> ScreenTaskRequirements:
        if self.code_language == ScreenCodeLanguage.SQL:
            if self.expected_sql_statement_kind is None:
                raise ValueError("expected_sql_statement_kind is required for code_language=sql")
        elif (
            self.code_language == ScreenCodeLanguage.OTHER
            and self.expected_sql_statement_kind is not None
        ):
            raise ValueError(
                "expected_sql_statement_kind requires code_language=python or code_language=sql"
            )
        if self.code_language == ScreenCodeLanguage.PYTHON:
            if self.python_shape is None:
                object.__setattr__(self, "python_shape", PythonShape.FUNCTION)
        elif self.python_shape is not None:
            raise ValueError("python_shape requires code_language=python")
        if self.code_language != ScreenCodeLanguage.PYTHON and (
            self.required_python_signatures or self.required_python_calls
        ):
            raise ValueError("Python requirements require code_language=python")
        if self.code_language not in {ScreenCodeLanguage.PYTHON, ScreenCodeLanguage.SQL} and (
            self.required_sql_identifiers
            or self.required_sql_clauses
            or self.required_sql_bound_ids
        ):
            raise ValueError("SQL requirements require a Python or SQL code language")
        if any(
            not _is_python_function_signature(value) for value in self.required_python_signatures
        ):
            raise ValueError("required_python_signatures must contain exact function headers")
        if any(
            _DOTTED_IDENTIFIER_RE.fullmatch(value) is None for value in self.required_python_calls
        ):
            raise ValueError("required_python_calls must contain static dotted call names")
        if any(
            _DOTTED_IDENTIFIER_RE.fullmatch(value) is None
            for value in self.required_sql_identifiers
        ):
            raise ValueError("required_sql_identifiers must contain static dotted identifiers")
        if any(not value.isidentifier() for value in self.required_sql_bound_ids):
            raise ValueError("required_sql_bound_ids must contain Python identifiers")
        if any(value not in _SQL_CLAUSE_ALLOWLIST for value in self.required_sql_clauses):
            raise ValueError("required_sql_clauses contains an unsupported clause")
        return self


class ScreenFinding(_StrictJsonModel):
    id: FindingId
    claim: str = Field(min_length=1, max_length=MAX_FINDING_CLAIM_CHARS)
    evidence: str = Field(min_length=1, max_length=MAX_FINDING_EVIDENCE_CHARS)
    kind: FindingKind
    active: bool = True
    supersedes: FindingId | None = None

    @model_validator(mode="after")
    def validate_supersession(self) -> ScreenFinding:
        if self.supersedes == self.id:
            raise ValueError("a finding cannot supersede itself")
        if self.supersedes is not None and not self.active:
            raise ValueError("a superseding finding must be active")
        return self


class ScreenFrame(_StrictJsonModel):
    """One retained viewport; ``visible_text`` is sensitive transient OCR."""

    digest: FrameDigest
    captured_at_ms: int = Field(ge=0)
    visible_text: str = Field(default="", max_length=MAX_VISIBLE_TEXT_CHARS)
    findings: tuple[ScreenFinding, ...] = Field(
        default_factory=tuple,
        max_length=MAX_FRAME_FINDINGS,
    )
    sources: tuple[ScreenSourceFragment, ...] = Field(
        default_factory=tuple,
        max_length=MAX_FRAME_SOURCES,
    )

    @field_validator("findings", "sources", mode="before")
    @classmethod
    def freeze_findings(cls, value: Any) -> Any:
        return tuple(value) if isinstance(value, list) else value


class ScreenSourceFragment(_StrictJsonModel):
    """Exact bounded source text; never pixels or provider prose."""

    id: FindingId
    text: str = Field(min_length=1, max_length=MAX_SOURCE_TEXT_CHARS)
    kind: ScreenSourceKind
    active: bool = True
    supersedes: FindingId | None = None

    @model_validator(mode="after")
    def validate_supersession(self) -> ScreenSourceFragment:
        if self.supersedes == self.id:
            raise ValueError("a source cannot supersede itself")
        if self.supersedes is not None and not self.active:
            raise ValueError("a superseding source must be active")
        return self


class ScreenLedgerEntry(_StrictJsonModel):
    """A finding plus immutable provenance, independent of retained frame eviction."""

    frame_digest: FrameDigest
    finding: ScreenFinding


class ScreenSourceEntry(_StrictJsonModel):
    frame_digest: FrameDigest
    source: ScreenSourceFragment


class ScreenChecklistItem(_StrictJsonModel):
    """One bounded generated checklist artifact; never stores surrounding model prose."""

    id: FindingId
    text: ChecklistText
    semantic_key: (
        Annotated[
            str,
            Field(max_length=96, pattern=r"^[a-z0-9][a-z0-9._:-]*$"),
        ]
        | None
    ) = None


class ScreenTaskTtl(_StrictJsonModel):
    created_at_ms: int = Field(ge=0)
    updated_at_ms: int = Field(ge=0)
    expires_at_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_order(self) -> ScreenTaskTtl:
        if self.updated_at_ms < self.created_at_ms:
            raise ValueError("updated_at_ms must not precede created_at_ms")
        if self.expires_at_ms < self.updated_at_ms:
            raise ValueError("expires_at_ms must not precede updated_at_ms")
        if self.expires_at_ms - self.updated_at_ms > MAX_TTL_MS:
            raise ValueError("TTL exceeds the maximum")
        return self


class ScreenTaskState(_StrictJsonModel):
    version: int = Field(default=1, ge=1, le=1)
    task_kind: TaskKind
    response_kind: ScreenResponseKind
    correction_mode: CorrectionMode = CorrectionMode.ACCUMULATE
    requirements: ScreenTaskRequirements
    frames: tuple[ScreenFrame, ...] = Field(
        default_factory=tuple,
        max_length=MAX_RETAINED_FRAMES,
    )
    ledger: tuple[ScreenLedgerEntry, ...] = Field(
        default_factory=tuple,
        max_length=MAX_LEDGER_FINDINGS,
    )
    source_ledger: tuple[ScreenSourceEntry, ...] = Field(
        default_factory=tuple,
        max_length=MAX_SOURCE_LEDGER_ITEMS,
    )
    checklist_items: tuple[ScreenChecklistItem, ...] = Field(
        default_factory=tuple,
        max_length=MAX_CHECKLIST_ITEMS,
    )
    ttl: ScreenTaskTtl

    @field_validator("frames", "ledger", "source_ledger", "checklist_items", mode="before")
    @classmethod
    def freeze_collections(cls, value: Any) -> Any:
        return tuple(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def validate_ledger_bounds(self) -> ScreenTaskState:
        if not self.ledger and any(frame.findings for frame in self.frames):
            object.__setattr__(
                self,
                "ledger",
                tuple(
                    ScreenLedgerEntry(frame_digest=frame.digest, finding=finding)
                    for frame in self.frames
                    for finding in frame.findings
                ),
            )
        if not self.source_ledger and any(frame.sources for frame in self.frames):
            object.__setattr__(
                self,
                "source_ledger",
                tuple(
                    ScreenSourceEntry(frame_digest=frame.digest, source=source)
                    for frame in self.frames
                    for source in frame.sources
                ),
            )

        digests = [frame.digest.sha256 for frame in self.frames]
        if len(digests) != len(set(digests)):
            raise ValueError("frame digests must be unique")

        finding_ids = [entry.finding.id for entry in self.ledger]
        if len(finding_ids) != len(set(finding_ids)):
            raise ValueError("finding ids must be unique")
        if len(finding_ids) > MAX_LEDGER_FINDINGS:
            raise ValueError("too many findings")

        ledger_by_origin = {
            (entry.frame_digest.sha256, entry.finding.id): entry.finding for entry in self.ledger
        }
        for frame in self.frames:
            for finding in frame.findings:
                if ledger_by_origin.get((frame.digest.sha256, finding.id)) != finding:
                    raise ValueError("retained frame findings must match the independent ledger")
        source_ids = [entry.source.id for entry in self.source_ledger]
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("source ids must be unique")
        source_by_origin = {
            (entry.frame_digest.sha256, entry.source.id): entry.source
            for entry in self.source_ledger
        }
        for frame in self.frames:
            for source in frame.sources:
                if source_by_origin.get((frame.digest.sha256, source.id)) != source:
                    raise ValueError("retained frame sources must match the independent ledger")
        if sum(len(frame.visible_text) for frame in self.frames) > MAX_TOTAL_VISIBLE_TEXT_CHARS:
            raise ValueError("visible text exceeds the total bound")
        checklist_ids = [item.id for item in self.checklist_items]
        normalized_checklist = [
            normalize_screen_checklist_text(item.text) for item in self.checklist_items
        ]
        if len(checklist_ids) != len(set(checklist_ids)):
            raise ValueError("checklist item ids must be unique")
        if len(normalized_checklist) != len(set(normalized_checklist)):
            raise ValueError("checklist item texts must be unique")
        semantic_keys = [
            item.semantic_key for item in self.checklist_items if item.semantic_key is not None
        ]
        if len(semantic_keys) != len(set(semantic_keys)):
            raise ValueError("checklist item semantic keys must be unique")
        if self.response_kind == ScreenResponseKind.CHECKLIST:
            if self.requirements.requested_item_count is None:
                raise ValueError("checklist response requires requested_item_count")
            if self.requirements.checklist_scope is None:
                raise ValueError("checklist response requires checklist_scope")
        elif (
            self.requirements.requested_item_count is not None
            or self.requirements.requested_item_count_explicit
            or self.requirements.checklist_new_only
            or self.requirements.checklist_scope is not None
        ):
            raise ValueError("checklist request metadata requires response_kind=checklist")
        return self


def active_screen_findings(state: ScreenTaskState) -> list[ScreenFinding]:
    """Return the full active ledger in stable frame/finding order."""

    return [entry.finding for entry in state.ledger if entry.finding.active]


def active_screen_sources(state: ScreenTaskState) -> list[ScreenSourceFragment]:
    return [entry.source for entry in state.source_ledger if entry.source.active]


def render_screen_task_findings(state: ScreenTaskState) -> list[ScreenFinding]:
    """Select prompt findings without mutating or truncating the underlying ledger."""

    if state.correction_mode == CorrectionMode.EXACT_NEW and state.frames:
        latest_digest = state.frames[-1].digest
        return [
            entry.finding
            for entry in state.ledger
            if entry.frame_digest == latest_digest and entry.finding.active
        ]
    return active_screen_findings(state)


def render_screen_task_context(
    state: ScreenTaskState,
    *,
    include_all_findings: bool = False,
) -> str:
    """Render a deterministic, text-only model context from the typed state."""

    findings = (
        active_screen_findings(state)
        if include_all_findings
        else render_screen_task_findings(state)
    )
    scope = (
        "unified"
        if include_all_findings or state.correction_mode != CorrectionMode.EXACT_NEW
        else "latest-frame delta"
    )
    allowed_constructs = (
        ", ".join(
            name
            for name, allowed in (
                ("join", state.requirements.allow_join),
                ("cte", state.requirements.allow_cte),
                ("json", state.requirements.allow_json),
                ("helper", state.requirements.allow_helper),
            )
            if allowed
        )
        or "none"
    )
    lines = [
        "SCREEN TASK STATE",
        f"Task kind: {state.task_kind.value}",
        f"Response kind: {state.response_kind.value}",
        f"Correction mode: {state.correction_mode.value}",
        f"Objective: {state.requirements.objective}",
        f"Code language: {state.requirements.code_language.value}",
        "Expected SQL statement: "
        + (
            state.requirements.expected_sql_statement_kind.value
            if state.requirements.expected_sql_statement_kind is not None
            else "none"
        ),
        f"Allowed constructs: {allowed_constructs}",
        "Checklist request count: "
        + (
            str(state.requirements.requested_item_count)
            if state.requirements.requested_item_count is not None
            else "none"
        ),
        f"Checklist count explicit: {str(state.requirements.requested_item_count_explicit).lower()}",
        f"Checklist new only: {str(state.requirements.checklist_new_only).lower()}",
        "Checklist scope: "
        + (
            state.requirements.checklist_scope.value
            if state.requirements.checklist_scope is not None
            else "none"
        ),
        "Public contract:",
    ]
    lines.extend(f"- {item}" for item in state.requirements.public_contract)
    lines.append("Constraints:")
    lines.extend(f"- {item}" for item in state.requirements.constraints)
    lines.append("Required Python signatures:")
    lines.extend(f"- {item}" for item in state.requirements.required_python_signatures)
    lines.append("Required Python calls:")
    lines.extend(f"- {item}" for item in state.requirements.required_python_calls)
    lines.append("Required SQL identifiers:")
    lines.extend(f"- {item}" for item in state.requirements.required_sql_identifiers)
    lines.append("Required SQL clauses:")
    lines.extend(f"- {item}" for item in state.requirements.required_sql_clauses)
    lines.append("Required SQL bound identifiers:")
    lines.extend(f"- {item}" for item in state.requirements.required_sql_bound_ids)
    lines.append("Required literals:")
    lines.extend(f"- {item}" for item in state.requirements.required_literals)
    lines.append("Generated checklist history:")
    lines.extend(f"- [{item.id}] {item.text}" for item in state.checklist_items)
    lines.append("Active exact source fragments:")
    for entry in state.source_ledger:
        if entry.source.active:
            lines.append(
                f"- [{entry.source.id}] {entry.source.kind.value} "
                f"frame={entry.frame_digest.sha256}: {entry.source.text}"
            )
    lines.append(f"Active findings ({scope}):")
    for finding in findings:
        lines.extend(
            [
                f"- [{finding.id}] {finding.kind.value}: {finding.claim}",
                f"  Evidence: {finding.evidence}",
            ]
        )
    return "\n".join(lines)


def merge_screen_frame(
    state: ScreenTaskState,
    frame: ScreenFrame,
    *,
    now_ms: int,
    ttl_ms: int,
) -> ScreenTaskState:
    """Pure deterministic merge; omissions never imply deletion."""

    if now_ms < state.ttl.updated_at_ms:
        raise ValueError("now_ms must not precede the current state update")
    if is_screen_task_state_expired(state, now_ms=now_ms):
        raise ValueError("screen task state is expired; create an explicit new state")
    if ttl_ms < 1 or ttl_ms > MAX_TTL_MS:
        raise ValueError("ttl_ms is outside the allowed bound")

    ledger = list(state.ledger)
    existing_ids = {entry.finding.id for entry in ledger}
    for finding in frame.findings:
        if finding.id in existing_ids:
            continue
        if finding.supersedes is not None:
            target_index = next(
                (
                    index
                    for index, entry in enumerate(ledger)
                    if entry.finding.id == finding.supersedes and entry.finding.active
                ),
                None,
            )
            if target_index is None:
                raise ValueError(
                    f"supersedes references missing active finding: {finding.supersedes}"
                )
            target = ledger[target_index]
            target_payload = target.finding.model_dump(mode="python")
            target_payload["active"] = False
            ledger[target_index] = ScreenLedgerEntry(
                frame_digest=target.frame_digest,
                finding=ScreenFinding.model_validate(target_payload),
            )
        ledger.append(ScreenLedgerEntry(frame_digest=frame.digest, finding=finding))
        existing_ids.add(finding.id)

    if len(ledger) > MAX_LEDGER_FINDINGS:
        excess = len(ledger) - MAX_LEDGER_FINDINGS
        inactive_indexes = {index for index, entry in enumerate(ledger) if not entry.finding.active}
        removable = sorted(inactive_indexes)[:excess]
        if len(removable) != excess:
            raise ValueError("active finding ledger capacity exceeded")
        remove_indexes = set(removable)
        ledger = [entry for index, entry in enumerate(ledger) if index not in remove_indexes]

    source_ledger = list(state.source_ledger)
    existing_source_ids = {entry.source.id for entry in source_ledger}
    for source in frame.sources:
        if source.id in existing_source_ids:
            continue
        if source.supersedes is not None:
            target_index = next(
                (
                    index
                    for index, entry in enumerate(source_ledger)
                    if entry.source.id == source.supersedes and entry.source.active
                ),
                None,
            )
            if target_index is None:
                raise ValueError(
                    f"supersedes references missing active source: {source.supersedes}"
                )
            source_target = source_ledger[target_index]
            source_payload = source_target.source.model_dump(mode="python")
            source_payload["active"] = False
            source_ledger[target_index] = ScreenSourceEntry(
                frame_digest=source_target.frame_digest,
                source=ScreenSourceFragment.model_validate(source_payload),
            )
        source_ledger.append(ScreenSourceEntry(frame_digest=frame.digest, source=source))
        existing_source_ids.add(source.id)
    if len(source_ledger) > MAX_SOURCE_LEDGER_ITEMS:
        excess = len(source_ledger) - MAX_SOURCE_LEDGER_ITEMS
        inactive_indexes = {
            index for index, entry in enumerate(source_ledger) if not entry.source.active
        }
        removable = sorted(inactive_indexes)[:excess]
        if len(removable) != excess:
            raise ValueError("active source ledger capacity exceeded")
        remove_indexes = set(removable)
        source_ledger = [
            entry for index, entry in enumerate(source_ledger) if index not in remove_indexes
        ]

    retained_frames = list(state.frames)
    existing_frame_index = next(
        (
            index
            for index, existing in enumerate(retained_frames)
            if existing.digest == frame.digest
        ),
        None,
    )
    if existing_frame_index is None:
        retained_frames.append(
            ScreenFrame(
                digest=frame.digest,
                captured_at_ms=frame.captured_at_ms,
                visible_text=frame.visible_text,
                findings=(),
                sources=(),
            )
        )
        retained_frames = retained_frames[-MAX_RETAINED_FRAMES:]
    else:
        retained_frames[existing_frame_index] = ScreenFrame(
            digest=frame.digest,
            captured_at_ms=frame.captured_at_ms,
            visible_text=frame.visible_text,
            findings=(),
            sources=(),
        )

    rebuilt_frames: list[ScreenFrame] = []
    for retained in retained_frames:
        findings = tuple(entry.finding for entry in ledger if entry.frame_digest == retained.digest)
        sources = tuple(
            entry.source for entry in source_ledger if entry.frame_digest == retained.digest
        )
        rebuilt_frames.append(
            ScreenFrame(
                digest=retained.digest,
                captured_at_ms=retained.captured_at_ms,
                visible_text=retained.visible_text,
                findings=findings,
                sources=sources,
            )
        )

    payload = state.model_dump(mode="python")
    payload["frames"] = tuple(rebuilt_frames)
    payload["ledger"] = tuple(ledger)
    payload["source_ledger"] = tuple(source_ledger)
    payload["ttl"] = {
        "created_at_ms": state.ttl.created_at_ms,
        "updated_at_ms": now_ms,
        "expires_at_ms": now_ms + ttl_ms,
    }
    return ScreenTaskState.model_validate(payload)


def is_screen_task_state_expired(state: ScreenTaskState, *, now_ms: int) -> bool:
    return now_ms >= state.ttl.expires_at_ms


def serialize_screen_task_state(state: ScreenTaskState | Mapping[str, Any]) -> str:
    """Validate at the serialization boundary, including values built unsafely."""

    if isinstance(state, ScreenTaskState):
        raw = state.model_dump_json()
    else:
        raw = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > MAX_SERIALIZED_STATE_CHARS:
        raise ValueError("serialized screen state is too large")
    validated = ScreenTaskState.model_validate_json(raw, strict=True)
    return validated.model_dump_json()


def deserialize_screen_task_state(payload: str | bytes) -> ScreenTaskState:
    if len(payload) > MAX_SERIALIZED_STATE_CHARS:
        raise ValueError("serialized screen state is too large")
    return ScreenTaskState.model_validate_json(payload, strict=True)
