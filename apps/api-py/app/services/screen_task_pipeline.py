"""Typed, bounded orchestration for opt-in screen assistance.

Pixels are used only by the observation call.  Every later step receives the
validated text ledger, so an omitted model draft cannot erase earlier evidence.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services import provider_adapter
from app.services.screen_answer_validator import (
    ScreenAnswerValidationInput,
    StableCoverageRequirement,
    validate_screen_answer,
)
from app.services.screen_task_state import (
    MAX_CHECKLIST_ITEM_CHARS,
    MAX_CHECKLIST_ITEMS,
    MAX_FRAME_FINDINGS,
    MAX_FRAME_SOURCES,
    MAX_OBJECTIVE_CHARS,
    MAX_REQUIREMENT_ITEM_CHARS,
    MAX_REQUIREMENT_ITEMS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_TTL_MS,
    MAX_TYPED_REQUIREMENT_CHARS,
    MAX_TYPED_REQUIREMENT_ITEMS,
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
    ScreenResponseKind,
    ScreenSourceFragment,
    ScreenSourceKind,
    ScreenTaskAction,
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
    normalize_screen_checklist_text,
    render_screen_task_context,
    serialize_screen_task_state,
)

CompleteCall = Callable[..., Awaitable[str]]
ObservedSqlClause = Literal[
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
]
ObservedPythonSignature = Annotated[
    str,
    Field(
        pattern=(
            r"^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\([^\r\n]*\)\s*"
            r"(?:->\s*[^:\r\n]+)?\s*:$"
        )
    ),
]
ObservedDottedIdentifier = Annotated[
    str,
    Field(pattern=r"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$"),
]
ObservedBoundIdentifier = Annotated[str, Field(pattern=r"^[A-Za-z_]\w*$")]
SCREEN_TASK_STATE_TTL_MS = MAX_TTL_MS
MAX_REPAIR_DRAFT_CHARS = 32_000
DEFAULT_CHECKLIST_ITEM_COUNT = 5
CHECKLIST_CROSS_GENERATION_MAX_SIMILARITY = 0.45
CHECKLIST_INTRA_GENERATION_MAX_SIMILARITY = 0.82

_SIMPLIFY_RE = re.compile(
    r"\b(?:упрост\w*|переработ\w*|передел\w*|перепиш\w*|сократ\w*|"
    r"simplif\w*|rewrite\w*|rework\w*|redo\w*)\b|"
    r"\b(?:лишн\w*\s+(?:сло\w*|оберт\w*)|too\s+(?:complex|complicated))\b",
    re.IGNORECASE,
)
_CHECKLIST_NUMBERING_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")
_NON_BUSINESS_CHECK_RE = re.compile(
    r"\b(?:бд|баз[а-яё]*\s+данн\w*|database|sql|таблиц\w*|индекс\w*|"
    r"репликац\w*|шард\w*|http|https|json|xml|api|endpoint|эндпоинт\w*|"
    r"кэш\w*|cache|очеред\w*|queue|протокол\w*|tcp|udp|bgp|ospf|"
    r"журнал\w*|лог(?:и|ов|ам|ами|ах)?|"
    r"header\w*|заголов\w*|status\s*code)\b",
    re.IGNORECASE | re.UNICODE,
)
_CHECKLIST_CONCEPT_STOP_WORDS = frozenset(
    {
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
)


def _checklist_concept_signature(text: str) -> frozenset[str]:
    tokens = re.findall(r"[a-zа-яё0-9_]+", text.casefold())
    return frozenset(
        token for token in tokens if len(token) > 2 and token not in _CHECKLIST_CONCEPT_STOP_WORDS
    )


def _concept_similarity(left: frozenset[str], right: frozenset[str]) -> float:
    if not left and not right:
        return 1.0
    return len(left & right) / max(1, len(left | right))


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _ObservedFinding(_StrictModel):
    claim: str = Field(min_length=1, max_length=800)
    evidence: str = Field(min_length=1, max_length=1_200)
    kind: FindingKind
    supersedes: str | None = Field(max_length=96)


class _ObservedSource(_StrictModel):
    text: str = Field(min_length=1, max_length=MAX_SOURCE_TEXT_CHARS)
    kind: ScreenSourceKind
    supersedes: str | None = Field(max_length=96)


class _ScreenObservation(_StrictModel):
    task_kind: TaskKind
    response_kind: ScreenResponseKind
    correction_mode: CorrectionMode
    objective: str = Field(min_length=1, max_length=MAX_OBJECTIVE_CHARS)
    public_contract: list[str] = Field(
        max_length=MAX_REQUIREMENT_ITEMS,
    )
    constraints: list[str] = Field(max_length=MAX_REQUIREMENT_ITEMS)
    allow_join: bool
    allow_cte: bool
    allow_json: bool
    allow_helper: bool
    required_python_signatures: list[ObservedPythonSignature] = Field(
        max_length=MAX_TYPED_REQUIREMENT_ITEMS
    )
    required_python_calls: list[ObservedDottedIdentifier] = Field(
        max_length=MAX_TYPED_REQUIREMENT_ITEMS
    )
    required_sql_identifiers: list[ObservedDottedIdentifier] = Field(
        max_length=MAX_TYPED_REQUIREMENT_ITEMS
    )
    required_sql_clauses: list[ObservedSqlClause] = Field(max_length=MAX_TYPED_REQUIREMENT_ITEMS)
    required_sql_bound_ids: list[ObservedBoundIdentifier] = Field(
        max_length=MAX_TYPED_REQUIREMENT_ITEMS
    )
    required_literals: list[str] = Field(max_length=MAX_TYPED_REQUIREMENT_ITEMS)
    code_language: ScreenCodeLanguage
    python_shape: PythonShape | None
    expected_sql_statement_kind: SqlStatementKind | None
    requested_item_count: int | None = Field(ge=1, le=20)
    requested_item_count_explicit: bool
    checklist_new_only: bool
    checklist_scope: ChecklistScope | None
    visible_text: str = Field(max_length=MAX_VISIBLE_TEXT_CHARS)
    findings: list[_ObservedFinding] = Field(min_length=1, max_length=MAX_FRAME_FINDINGS)
    sources: list[_ObservedSource] = Field(min_length=1, max_length=MAX_FRAME_SOURCES)

    @classmethod
    def validate_requirement_bounds(cls, values: Sequence[str]) -> None:
        if any(not value.strip() or len(value) > MAX_REQUIREMENT_ITEM_CHARS for value in values):
            raise ValueError("observation requirements are invalid")

    def checked(self) -> _ScreenObservation:
        if not self.objective.strip():
            raise ValueError("observation objective is blank")
        if any(not item.claim.strip() or not item.evidence.strip() for item in self.findings):
            raise ValueError("observation findings are blank")
        if self.task_kind == TaskKind.FIND_DEFECT and not any(
            item.kind == FindingKind.DEFECT for item in self.findings
        ):
            raise ValueError("find-defect observation contains no defect finding")
        if any(not item.text.strip() for item in self.sources):
            raise ValueError("observation sources are blank")
        self.validate_requirement_bounds(self.public_contract)
        self.validate_requirement_bounds(self.constraints)
        typed_requirements = (
            self.required_python_signatures,
            self.required_python_calls,
            self.required_sql_identifiers,
            self.required_sql_clauses,
            self.required_sql_bound_ids,
            self.required_literals,
        )
        if any(
            not value.strip() or len(value) > MAX_TYPED_REQUIREMENT_CHARS
            for values in typed_requirements
            for value in values
        ):
            raise ValueError("typed observation requirements are invalid")
        ScreenTaskRequirements(
            objective=self.objective,
            public_contract=tuple(self.public_contract),
            constraints=tuple(self.constraints),
            allow_join=self.allow_join,
            allow_cte=self.allow_cte,
            allow_json=self.allow_json,
            allow_helper=self.allow_helper,
            required_python_signatures=tuple(self.required_python_signatures),
            required_python_calls=tuple(self.required_python_calls),
            required_sql_identifiers=tuple(self.required_sql_identifiers),
            required_sql_clauses=tuple(self.required_sql_clauses),
            required_sql_bound_ids=tuple(self.required_sql_bound_ids),
            required_literals=tuple(self.required_literals),
            code_language=self.code_language,
            python_shape=self.python_shape,
            expected_sql_statement_kind=self.expected_sql_statement_kind,
            requested_item_count=self.requested_item_count,
            requested_item_count_explicit=self.requested_item_count_explicit,
            checklist_new_only=self.checklist_new_only,
            checklist_scope=self.checklist_scope,
        )
        if self.response_kind == ScreenResponseKind.CHECKLIST:
            if self.checklist_scope is None:
                raise ValueError("checklist observation metadata is incomplete")
            if self.requested_item_count_explicit != (self.requested_item_count is not None):
                raise ValueError("checklist count provenance is inconsistent")
        elif (
            self.requested_item_count is not None
            or self.requested_item_count_explicit
            or self.checklist_new_only
            or self.checklist_scope is not None
        ):
            raise ValueError("checklist metadata requires response_kind=checklist")
        return self


class _ChecklistDraftItem(_StrictModel):
    text: str = Field(min_length=1, max_length=MAX_CHECKLIST_ITEM_CHARS)
    semantic_key: str = Field(
        min_length=1,
        max_length=96,
        pattern=r"^[a-z0-9][a-z0-9._:-]*$",
    )


class _ChecklistDraft(_StrictModel):
    items: list[_ChecklistDraftItem] = Field(min_length=1, max_length=20)

    def checked(self) -> _ChecklistDraft:
        if any(
            not item.text.strip() or len(item.text.strip()) > MAX_CHECKLIST_ITEM_CHARS
            for item in self.items
        ):
            raise ValueError("checklist items are invalid")
        return self


class _GroundedTextItem(_StrictModel):
    text: str = Field(min_length=1, max_length=1_200)
    finding_ids: list[str] = Field(max_length=MAX_FRAME_FINDINGS * 3)
    source_ids: list[str] = Field(max_length=MAX_FRAME_SOURCES * 4)

    def checked(self) -> _GroundedTextItem:
        if not self.text.strip() or not (self.finding_ids or self.source_ids):
            raise ValueError("grounded text item is empty or ungrounded")
        if len(self.finding_ids) != len(set(self.finding_ids)):
            raise ValueError("grounded finding ids must be unique")
        if len(self.source_ids) != len(set(self.source_ids)):
            raise ValueError("grounded source ids must be unique")
        return self


class _AnalysisDraft(_StrictModel):
    items: list[_GroundedTextItem] = Field(min_length=1, max_length=64)

    def checked(self) -> _AnalysisDraft:
        for item in self.items:
            item.checked()
        return self


class _DirectAnswerDraft(_StrictModel):
    answer: str = Field(min_length=1, max_length=4_000)
    finding_ids: list[str] = Field(max_length=MAX_FRAME_FINDINGS * 3)
    source_ids: list[str] = Field(max_length=MAX_FRAME_SOURCES * 4)

    def checked(self) -> _DirectAnswerDraft:
        if not self.answer.strip() or not (self.finding_ids or self.source_ids):
            raise ValueError("direct answer is empty or ungrounded")
        if len(self.finding_ids) != len(set(self.finding_ids)):
            raise ValueError("direct finding ids must be unique")
        if len(self.source_ids) != len(set(self.source_ids)):
            raise ValueError("direct source ids must be unique")
        return self


class _ExecutionResultDraft(_StrictModel):
    status: Literal["success", "exception"]
    result_lines: list[str] = Field(max_length=32)
    exception: str | None = Field(max_length=300)
    explanation: str = Field(min_length=1, max_length=1_500)
    finding_ids: list[str] = Field(max_length=MAX_FRAME_FINDINGS * 3)
    source_ids: list[str] = Field(max_length=MAX_FRAME_SOURCES * 4)

    def checked(self) -> _ExecutionResultDraft:
        if any(len(line) > 500 for line in self.result_lines):
            raise ValueError("execution result lines are invalid")
        if not self.explanation.strip() or not (self.finding_ids or self.source_ids):
            raise ValueError("execution result is empty or ungrounded")
        if len(self.finding_ids) != len(set(self.finding_ids)):
            raise ValueError("execution finding ids must be unique")
        if len(self.source_ids) != len(set(self.source_ids)):
            raise ValueError("execution source ids must be unique")
        if self.exception is not None and not self.exception.strip():
            raise ValueError("execution exception is invalid")
        if self.status == "success" and self.exception is not None:
            raise ValueError("successful execution cannot contain an exception")
        if self.status == "exception" and self.exception is None:
            raise ValueError("exception execution requires an exception")
        return self


@dataclass(frozen=True, slots=True)
class ScreenTaskPipelineResult:
    answer: str
    serialized_task_state: str


class ScreenTaskPipelineError(Exception):
    """Stable public failure; never contains provider output or captured text."""

    def __init__(self, code: str, public_message: str):
        self.code = code
        self.public_message = public_message
        super().__init__(public_message)


def _observation_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "screen_task_observation",
            "strict": True,
            "schema": _ScreenObservation.model_json_schema(),
        },
    }


def _structured_response_format(name: str, model: type[BaseModel]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "strict": True,
            "schema": model.model_json_schema(),
        },
    }


def _frame_digest(image: str) -> str:
    return hashlib.sha256(image.encode("utf-8")).hexdigest()


def _load_state(
    payload: str | Mapping[str, Any] | None,
    *,
    task_action: ScreenTaskAction | str | None,
    now_ms: int,
) -> ScreenTaskState | None:
    if task_action is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_task_action",
            "Укажите, начинается новая экранная задача или продолжается текущая.",
        )
    try:
        action = (
            task_action
            if isinstance(task_action, ScreenTaskAction)
            else ScreenTaskAction(task_action)
        )
    except ValueError as exc:
        raise ScreenTaskPipelineError(
            "invalid_screen_task_action",
            "Укажите, начинается новая экранная задача или продолжается текущая.",
        ) from exc
    if action == ScreenTaskAction.NEW:
        if payload is not None:
            raise ScreenTaskPipelineError(
                "invalid_screen_task_action",
                "Новая экранная задача не может использовать старый контекст.",
            )
        return None
    if payload is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_task_action",
            "Для продолжения экранной задачи нужен сохранённый контекст.",
        )
    try:
        if isinstance(payload, str):
            state = deserialize_screen_task_state(payload)
        else:
            state = deserialize_screen_task_state(serialize_screen_task_state(payload))
    except (TypeError, ValueError, ValidationError) as exc:
        raise ScreenTaskPipelineError(
            "invalid_screen_task_state",
            "Сохранённый контекст экранной задачи повреждён. Повторите снимок.",
        ) from exc
    if is_screen_task_state_expired(state, now_ms=now_ms):
        raise ScreenTaskPipelineError(
            "screen_task_state_expired",
            "Контекст экранной задачи истёк. Начните новую экранную задачу.",
        )
    return state


def _observation_prompt(
    *,
    state: ScreenTaskState | None,
    latest_correction: str,
    context: str,
) -> str:
    state_context = render_screen_task_context(state) if state is not None else "[no prior state]"
    return (
        "Derive task-relevant grounded conclusions from only visible, supported evidence in "
        "this single viewport and return them in the strict "
        "JSON schema. Classify the task as analysis, list, find_defect, code, or other. "
        "Choose response_kind explicitly. Classify code_language explicitly; never infer SQL "
        "only because a Python signature is absent. For Python, classify python_shape as "
        "function, script, class, or pytest. Populate every capability boolean and every "
        "structural requirement list. SQL clauses must be individual canonical clause names, "
        "identifiers and literals must stay in their dedicated arrays. For pure SQL and for "
        "Python that executes SQL, set expected_sql_statement_kind from visible evidence. "
        "For response_kind=checklist, set the exact requested_item_count, whether only new "
        "items are requested, and checklist_scope. Set requested_item_count_explicit=true only "
        "when the exact number is visible or explicitly spoken; otherwise return null/false and "
        "the server will apply its bounded default. For every other response kind, set checklist "
        "count fields to null/false and new-only/scope to false/null. Extract at least one exact "
        "bounded task/code/schema/example source fragment; source text is what the answer stage "
        "will be grounded on. "
        "For every defect finding, name the exact visible subject identifier (component, "
        "job, function, field, or stage) and explicitly state the incorrect or missing "
        "behavior. Do not replace that identifier with a pronoun or generic label. Keep the "
        "supporting visible line or relationship in evidence instead of merely repeating it "
        "as the conclusion. For a find-defect task, general platform or structure facts do "
        "not substitute for defects: inspect every visible named unit and explicitly flag a "
        "placeholder/no-op body or a conflict with the declared structure. "
        "Omission never deletes an earlier finding. Set supersedes only to an exact prior "
        "finding id when this viewport directly contradicts it. Keep visible_text textual "
        "and bounded; never copy image data, base64, secrets, or hidden metadata.\n\n"
        f"LATEST CORRECTION:\n{latest_correction or '[none]'}\n\n"
        f"RECENT CONVERSATION:\n{context[-4_000:] or '[none]'}\n\n"
        f"VALIDATED PRIOR STATE:\n{state_context}"
    )


def _low_reasoning_effort(reasoning: dict | None) -> dict | None:
    if reasoning and reasoning.get("effort") in {"medium", "high", "xhigh", "max"}:
        return {**reasoning, "effort": "low"}
    return reasoning


_YAML_SCALAR_ECHO_JOB_RE = re.compile(
    r"(?ims)\b(?P<job>[a-z_][\w.-]*job[\w.-]*)\s*:\s*"
    r"(?:(?!\b[a-z_][\w.-]*job[\w.-]*\s*:).){0,300}?"
    r"\bscript\s*:\s*(?P<command>echo(?:[ \t]+[a-z0-9_.:/-]+)?)"
    r"[ \t]*(?:\#[^\r\n]*)?(?=\r?$|\r?\n)"
)


def _derive_scalar_echo_job_defects(observation: _ScreenObservation) -> _ScreenObservation:
    if observation.task_kind != TaskKind.FIND_DEFECT:
        return observation
    corpus = "\n".join((observation.visible_text, *(source.text for source in observation.sources)))
    findings = list(observation.findings)
    changed = False
    seen_jobs: set[str] = set()
    for match in _YAML_SCALAR_ECHO_JOB_RE.finditer(corpus):
        job_name = match.group("job")
        normalized_job = job_name.casefold()
        if normalized_job in seen_jobs:
            continue
        command = match.group("command").strip()
        related_index = next(
            (
                index
                for index, finding in enumerate(findings)
                if normalized_job in f"{finding.claim} {finding.evidence}".casefold()
                and "echo" in f"{finding.claim} {finding.evidence}".casefold()
            ),
            None,
        )
        canonical = _ObservedFinding(
            claim=f"{job_name} только {command}; реальная операция этого job не выполняется",
            evidence=f"{job_name}: script: {command}",
            kind=FindingKind.DEFECT,
            supersedes=(findings[related_index].supersedes if related_index is not None else None),
        )
        if related_index is not None:
            if findings[related_index] != canonical:
                findings[related_index] = canonical
                changed = True
        elif len(findings) < MAX_FRAME_FINDINGS:
            findings.append(canonical)
            changed = True
        seen_jobs.add(normalized_job)
        if len(findings) >= MAX_FRAME_FINDINGS:
            break
    if not changed:
        return observation
    return observation.model_copy(update={"findings": findings}).checked()


async def _extract_observation(
    *,
    image: str,
    state: ScreenTaskState | None,
    latest_correction: str,
    context: str,
    provider: str,
    model: str,
    reasoning: dict | None,
    complete: CompleteCall,
) -> _ScreenObservation:
    system_content = (
        "You are a strict visual evidence extractor. Return only schema-valid JSON. "
        "Do not write the final user answer. Derive task-relevant grounded facts, "
        "defects, and requirements from visible evidence when the task calls for them. "
        "Do not invent unsupported evidence or conclusions."
    )
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": system_content,
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": _observation_prompt(
                        state=state,
                        latest_correction=latest_correction,
                        context=context,
                    ),
                },
                {"type": "image_url", "image_url": {"url": image, "detail": "high"}},
            ],
        },
    ]
    # Extraction is a bounded schema/OCR step, not the final reasoning step.
    # GPT-5.6 officially supports low effort, which trims sequential latency.
    observation_reasoning = _low_reasoning_effort(reasoning)
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            raw = await complete(
                messages,
                provider,
                model,
                max_tokens=1_800,
                temperature=0.0,
                reasoning=observation_reasoning,
                response_format=_observation_response_format(),
                screen_workload_phase="observation",
            )
            observation = _ScreenObservation.model_validate_json(raw, strict=True).checked()
            return _derive_scalar_echo_job_defects(observation)
        except ScreenTaskPipelineError:
            raise
        except (TypeError, ValueError, ValidationError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt == 0:
                system_content += (
                    " The previous extraction did not satisfy the strict schema. Re-read the "
                    "same image and return a complete, schema-valid observation. Do not reuse "
                    "or quote the prior draft."
                )
                messages = [
                    {"role": "system", "content": system_content},
                    messages[1],
                ]
                continue
    raise ScreenTaskPipelineError(
        "invalid_screen_observation",
        "Не удалось надёжно прочитать экран. Повторите снимок.",
    ) from last_error


def _normalized_frame(
    observation: _ScreenObservation,
    *,
    digest: str,
    captured_at_ms: int,
    state: ScreenTaskState | None,
) -> ScreenFrame:
    active_ids = (
        {finding.id for finding in active_screen_findings(state)} if state is not None else set()
    )
    active_source_ids = (
        {source.id for source in active_screen_sources(state)} if state is not None else set()
    )
    existing_findings = (
        {entry.finding.id: entry.finding for entry in state.ledger} if state is not None else {}
    )
    existing_sources = (
        {entry.source.id: entry.source for entry in state.source_ledger}
        if state is not None
        else {}
    )

    def revision_id(
        prefix: str, index: int, content: Mapping[str, Any], existing: Mapping[str, Any]
    ) -> str:
        base = f"{prefix}-{digest[:16]}-{index}"
        current = existing.get(base)
        if current is None:
            return base
        comparable = current.model_dump(mode="json", exclude={"id", "active"})
        if comparable == dict(content):
            return base
        revision = hashlib.sha256(
            json.dumps(content, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:12]
        return f"{base}-{revision}"

    findings: list[ScreenFinding] = []
    for index, finding in enumerate(observation.findings, start=1):
        # The model never controls new ledger identifiers.  A supersession is
        # accepted only when it names a currently active server-issued id.
        supersedes = finding.supersedes if finding.supersedes in active_ids else None
        finding_content = {
            "claim": finding.claim.strip(),
            "evidence": finding.evidence.strip(),
            "kind": finding.kind.value,
            "supersedes": supersedes,
        }
        finding_id = revision_id("f", index, finding_content, existing_findings)
        findings.append(
            ScreenFinding(
                id=finding_id,
                claim=finding.claim.strip(),
                evidence=finding.evidence.strip(),
                kind=finding.kind,
                supersedes=supersedes,
            )
        )
    sources: list[ScreenSourceFragment] = []
    for index, source in enumerate(observation.sources, start=1):
        supersedes = source.supersedes if source.supersedes in active_source_ids else None
        source_content = {
            "text": source.text.strip(),
            "kind": source.kind.value,
            "supersedes": supersedes,
        }
        source_id = revision_id("s", index, source_content, existing_sources)
        sources.append(
            ScreenSourceFragment(
                id=source_id,
                text=source.text.strip(),
                kind=source.kind,
                supersedes=supersedes,
            )
        )
    return ScreenFrame(
        digest=FrameDigest(sha256=digest),
        captured_at_ms=captured_at_ms,
        visible_text=observation.visible_text.strip(),
        findings=tuple(findings),
        sources=tuple(sources),
    )


def _new_state(observation: _ScreenObservation, *, now_ms: int) -> ScreenTaskState:
    sql_identifiers = _normalized_observation_sql_identifiers(observation)
    return ScreenTaskState(
        task_kind=observation.task_kind,
        response_kind=observation.response_kind,
        correction_mode=observation.correction_mode,
        requirements=ScreenTaskRequirements(
            objective=observation.objective.strip(),
            public_contract=tuple(item.strip() for item in observation.public_contract),
            constraints=tuple(item.strip() for item in observation.constraints),
            allow_join=observation.allow_join,
            allow_cte=observation.allow_cte,
            allow_json=observation.allow_json,
            allow_helper=observation.allow_helper,
            required_python_signatures=tuple(
                item.strip() for item in observation.required_python_signatures
            ),
            required_python_calls=tuple(item.strip() for item in observation.required_python_calls),
            required_sql_identifiers=sql_identifiers,
            required_sql_clauses=tuple(item.strip() for item in observation.required_sql_clauses),
            required_sql_bound_ids=tuple(
                item.strip() for item in observation.required_sql_bound_ids
            ),
            required_literals=tuple(item.strip() for item in observation.required_literals),
            code_language=observation.code_language,
            python_shape=observation.python_shape,
            expected_sql_statement_kind=observation.expected_sql_statement_kind,
            requested_item_count=(
                observation.requested_item_count or DEFAULT_CHECKLIST_ITEM_COUNT
                if observation.response_kind == ScreenResponseKind.CHECKLIST
                else None
            ),
            requested_item_count_explicit=observation.requested_item_count_explicit,
            checklist_new_only=observation.checklist_new_only,
            checklist_scope=observation.checklist_scope,
        ),
        frames=(),
        ttl=ScreenTaskTtl(
            created_at_ms=now_ms,
            updated_at_ms=now_ms,
            expires_at_ms=now_ms + SCREEN_TASK_STATE_TTL_MS,
        ),
    )


def _normalized_observation_sql_identifiers(
    observation: _ScreenObservation,
) -> tuple[str, ...]:
    identifiers = tuple(item.strip() for item in observation.required_sql_identifiers)
    terminal_names = {identifier.rsplit(".", 1)[-1] for identifier in identifiers}
    redundant_bound_names = {
        bound_id
        for bound_id in observation.required_sql_bound_ids
        if bound_id.rsplit("_", 1)[-1] != bound_id and bound_id.rsplit("_", 1)[-1] in terminal_names
    }
    return tuple(
        identifier for identifier in identifiers if identifier not in redundant_bound_names
    )


def _refine_state_metadata(
    state: ScreenTaskState,
    observation: _ScreenObservation,
) -> ScreenTaskState:
    """Let the newest viewport clarify task type without deleting requirements."""

    def stable_union(
        previous: Sequence[str],
        current: Sequence[str],
        *,
        limit: int,
    ) -> tuple[str, ...]:
        merged = tuple(dict.fromkeys((*previous, *(item.strip() for item in current))))
        if len(merged) > limit:
            raise ScreenTaskPipelineError(
                "invalid_screen_observation",
                "На экране слишком много независимых требований. Уточните текущую задачу.",
            )
        return merged

    previous_language = state.requirements.code_language
    current_language = observation.code_language
    if previous_language == ScreenCodeLanguage.OTHER:
        code_language = current_language
    elif current_language == ScreenCodeLanguage.OTHER:
        code_language = previous_language
    elif previous_language != current_language:
        raise ScreenTaskPipelineError(
            "invalid_screen_observation",
            "Новый фрагмент противоречит языку сохранённой задачи. Начните новую задачу.",
        )
    else:
        code_language = previous_language

    previous_statement = state.requirements.expected_sql_statement_kind
    current_statement = observation.expected_sql_statement_kind
    replace_revocable = observation.correction_mode in {
        CorrectionMode.REFINE,
        CorrectionMode.EXACT_NEW,
    }
    if (
        not replace_revocable
        and previous_statement is not None
        and current_statement not in {None, previous_statement}
    ):
        raise ScreenTaskPipelineError(
            "invalid_screen_observation",
            "Новый фрагмент противоречит типу сохранённого SQL-запроса.",
        )
    expected_sql_statement_kind = current_statement or previous_statement

    def merge_requirement(previous: Sequence[str], current: Sequence[str]) -> tuple[str, ...]:
        if replace_revocable:
            return tuple(item.strip() for item in current)
        return stable_union(previous, current, limit=MAX_TYPED_REQUIREMENT_ITEMS)

    payload = state.model_dump(mode="python")
    if observation.task_kind != TaskKind.OTHER:
        payload["task_kind"] = observation.task_kind
    payload["response_kind"] = observation.response_kind
    payload["correction_mode"] = observation.correction_mode
    payload["requirements"] = ScreenTaskRequirements(
        objective=(
            observation.objective.strip() if replace_revocable else state.requirements.objective
        ),
        public_contract=stable_union(
            state.requirements.public_contract,
            observation.public_contract,
            limit=MAX_REQUIREMENT_ITEMS,
        ),
        constraints=(
            tuple(item.strip() for item in observation.constraints)
            if replace_revocable
            else stable_union(
                state.requirements.constraints,
                observation.constraints,
                limit=MAX_REQUIREMENT_ITEMS,
            )
        ),
        allow_join=observation.allow_join
        if replace_revocable
        else state.requirements.allow_join or observation.allow_join,
        allow_cte=observation.allow_cte
        if replace_revocable
        else state.requirements.allow_cte or observation.allow_cte,
        allow_json=observation.allow_json
        if replace_revocable
        else state.requirements.allow_json or observation.allow_json,
        allow_helper=observation.allow_helper
        if replace_revocable
        else state.requirements.allow_helper or observation.allow_helper,
        required_python_signatures=merge_requirement(
            state.requirements.required_python_signatures, observation.required_python_signatures
        ),
        required_python_calls=merge_requirement(
            state.requirements.required_python_calls, observation.required_python_calls
        ),
        required_sql_identifiers=merge_requirement(
            state.requirements.required_sql_identifiers,
            _normalized_observation_sql_identifiers(observation),
        ),
        required_sql_clauses=merge_requirement(
            state.requirements.required_sql_clauses, observation.required_sql_clauses
        ),
        required_sql_bound_ids=merge_requirement(
            state.requirements.required_sql_bound_ids, observation.required_sql_bound_ids
        ),
        required_literals=merge_requirement(
            state.requirements.required_literals, observation.required_literals
        ),
        code_language=code_language,
        python_shape=(
            observation.python_shape
            if code_language == ScreenCodeLanguage.PYTHON and observation.python_shape is not None
            else state.requirements.python_shape
            if code_language == ScreenCodeLanguage.PYTHON
            else None
        ),
        expected_sql_statement_kind=expected_sql_statement_kind,
        requested_item_count=(
            observation.requested_item_count or DEFAULT_CHECKLIST_ITEM_COUNT
            if observation.response_kind == ScreenResponseKind.CHECKLIST
            else None
        ),
        requested_item_count_explicit=observation.requested_item_count_explicit,
        checklist_new_only=observation.checklist_new_only,
        checklist_scope=observation.checklist_scope,
    )
    return ScreenTaskState.model_validate(payload)


def _render_unified_findings(state: ScreenTaskState) -> str:
    findings = active_screen_findings(state)
    lines = ["Единый результат по всем сохранённым фрагментам экрана:"]
    for finding in findings:
        lines.append(f"- {finding.claim} — {finding.evidence}")
    return "\n".join(lines)


def _render_grounded_analysis(state: ScreenTaskState, draft: _AnalysisDraft) -> str:
    lines = [
        _render_unified_findings(state),
        "",
        "Сводный анализ по сохранённым фактам:",
    ]
    lines.extend(f"- {' '.join(item.text.split())}" for item in draft.items)
    return "\n".join(lines)


def _grounding_issues(
    *,
    finding_ids: Sequence[str],
    source_ids: Sequence[str],
    state: ScreenTaskState,
    require_all: bool,
) -> tuple[str, ...]:
    active_findings = {finding.id for finding in active_screen_findings(state)}
    active_sources = {source.id for source in active_screen_sources(state)}
    supplied_findings = set(finding_ids)
    supplied_sources = set(source_ids)
    issues: list[str] = []
    if not supplied_findings and not supplied_sources:
        issues.append("grounding_missing")
    if not supplied_findings.issubset(active_findings) or not supplied_sources.issubset(
        active_sources
    ):
        issues.append("grounding_unknown")
    if require_all and (supplied_findings != active_findings or supplied_sources != active_sources):
        issues.append("grounding_incomplete")
    return tuple(issues)


def _grounding_terms(text: str) -> frozenset[str]:
    tokens = re.findall(r"[a-zа-яё][a-zа-яё0-9_]{2,}", text.casefold())
    return frozenset(token if "_" in token or len(token) <= 5 else token[:5] for token in tokens)


def _analysis_expresses_cited_findings(
    draft: _AnalysisDraft,
    *,
    state: ScreenTaskState,
) -> bool:
    for finding in active_screen_findings(state):
        expected_terms = _grounding_terms(f"{finding.claim} {finding.evidence}")
        cited_items = [item for item in draft.items if finding.id in item.finding_ids]
        if not expected_terms or not any(
            _grounding_terms(item.text) & expected_terms for item in cited_items
        ):
            return False
    return True


def _analysis_draft_issues(
    raw: str,
    *,
    state: ScreenTaskState,
) -> tuple[_AnalysisDraft | None, tuple[str, ...]]:
    try:
        draft = _AnalysisDraft.model_validate_json(raw, strict=True).checked()
    except (TypeError, ValueError, ValidationError, json.JSONDecodeError):
        return None, ("analysis_schema_invalid",)
    finding_ids = [finding_id for item in draft.items for finding_id in item.finding_ids]
    source_ids = [source_id for item in draft.items for source_id in item.source_ids]
    issues = list(
        _grounding_issues(
            finding_ids=finding_ids,
            source_ids=source_ids,
            state=state,
            require_all=True,
        )
    )
    if not _analysis_expresses_cited_findings(draft, state=state):
        issues.append("grounding_unexpressed")
    return draft, tuple(issues)


async def _generate_analysis_answer(
    *,
    state: ScreenTaskState,
    latest_correction: str,
    provider: str,
    model: str,
    max_tokens: int,
    reasoning: dict | None,
    complete: CompleteCall,
) -> str:
    prompt = (
        "Answer the latest correction directly by reasoning over every active typed finding "
        "and exact source fragment below. Return one unified analysis in the strict JSON "
        "schema. Every item must cite at least one active finding/source id, and the complete "
        "draft must cite every active id. The text itself, not merely its ids, must express "
        "the specific subject and conclusion of each cited finding. For a defect task, state "
        "the exact visible subject and the faulty or missing behavior; do not merely repeat a "
        "configuration line. If the question asks to identify a platform or system, name it "
        "explicitly when the sources support it. Do not invent facts outside the cited "
        "sources.\n\n"
        f"{render_screen_task_context(state, include_all_findings=True)}\n\n"
        f"LATEST CORRECTION (highest priority):\n{latest_correction or '[none]'}"
    )
    system_message = {
        "role": "system",
        "content": "You are a grounded technical-interview analysis assistant.",
    }
    response_format = _structured_response_format("screen_analysis", _AnalysisDraft)
    draft_raw = await complete(
        [system_message, {"role": "user", "content": prompt}],
        provider,
        model,
        max_tokens=max_tokens,
        temperature=0.0,
        reasoning=reasoning,
        response_format=response_format,
        screen_workload_phase="answer",
    )
    draft, issues = _analysis_draft_issues(draft_raw, state=state)
    if issues:
        repair_prompt = (
            f"{prompt}\n\nRepair the draft exactly once. Deterministic issue codes: "
            f"{', '.join(issues)}. Return the complete JSON object.\n\n"
            f"INVALID DRAFT:\n{draft_raw[:MAX_REPAIR_DRAFT_CHARS]}"
        )
        repaired_raw = await complete(
            [system_message, {"role": "user", "content": repair_prompt}],
            provider,
            model,
            max_tokens=max_tokens,
            temperature=0.0,
            reasoning=reasoning,
            response_format=response_format,
            screen_workload_phase="repair",
        )
        draft, issues = _analysis_draft_issues(repaired_raw, state=state)
    if issues or draft is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "Анализ не прошёл проверку полноты. Повторите запрос.",
        )
    # The immutable application-owned ledger stays first and can never be
    # replaced by model prose. The validated synthesis follows it so the model
    # can derive a useful cross-frame conclusion from every retained source.
    return _render_grounded_analysis(state, draft)


def _validation_input(
    answer: str,
    *,
    state: ScreenTaskState,
    latest_correction: str,
) -> ScreenAnswerValidationInput:
    typed = state.requirements
    if typed.code_language == ScreenCodeLanguage.OTHER:
        raise ScreenTaskPipelineError(
            "invalid_screen_observation",
            "Не удалось определить язык решения по экрану. Повторите снимок.",
        )
    code_language: Literal["python", "sql"] = (
        "python" if typed.code_language == ScreenCodeLanguage.PYTHON else "sql"
    )
    signatures = typed.required_python_signatures
    requirements = tuple(
        [
            StableCoverageRequirement(
                stable_id=f"required-python-signature-{index}",
                function_signatures=(value,),
            )
            for index, value in enumerate(signatures, start=1)
        ]
        + [
            StableCoverageRequirement(
                stable_id=f"required-python-call-{index}",
                python_calls=(value,),
            )
            for index, value in enumerate(typed.required_python_calls, start=1)
        ]
        + [
            StableCoverageRequirement(
                stable_id=f"required-sql-identifier-{index}",
                identifiers=(value,),
            )
            for index, value in enumerate(typed.required_sql_identifiers, start=1)
        ]
        + [
            StableCoverageRequirement(
                stable_id=f"required-sql-clause-{index}",
                sql_clauses=(value,),
            )
            for index, value in enumerate(typed.required_sql_clauses, start=1)
        ]
        + [
            StableCoverageRequirement(
                stable_id=f"required-literal-{index}",
                literals=(value,),
            )
            for index, value in enumerate(typed.required_literals, start=1)
        ]
    )
    return ScreenAnswerValidationInput(
        answer=answer,
        stable_requirements=requirements,
        visible_public_signature=signatures[0] if signatures else None,
        visible_literals=typed.required_literals,
        simplify=bool(_SIMPLIFY_RE.search(latest_correction)),
        allow_join=typed.allow_join,
        allow_cte=typed.allow_cte,
        allow_json=typed.allow_json,
        allow_helper=typed.allow_helper,
        required_sql_bound_ids=typed.required_sql_bound_ids,
        trusted_sql_receivers=("conn", "cursor"),
        require_russian_intro=True,
        require_russian_line_comments=True,
        code_language=code_language,
        python_shape=(typed.python_shape or PythonShape.FUNCTION).value,
        expected_sql_statement_kind=(
            typed.expected_sql_statement_kind.value
            if typed.expected_sql_statement_kind is not None
            else None
        ),
        required_sql_identifiers=typed.required_sql_identifiers,
        required_sql_clauses=typed.required_sql_clauses,
    )


def _answer_prompt(state: ScreenTaskState, latest_correction: str) -> str:
    return (
        "Solve the typed screen task below. Use only this validated text state; no pixels "
        "or raw prior answer are available. Return the smallest standard solution that "
        "preserves every explicit requirement. For code, first give a short natural Russian "
        "explanation, then exactly one fenced code block. Put a short Russian comment on the "
        "line immediately below every substantive code line, using # for Python and -- for "
        "SQL. Bind user-provided SQL values as parameters and keep required table/column "
        "identifiers exact. For the Python function profile, emit one straight-line target "
        "function with no extra definitions, decorators, setup calls, or imports except an "
        "exact visibly required typing import. Execute required SQL directly on the visible "
        "connection parameter, before the terminal return, unless a cursor is explicitly "
        "required. When the visible return contract is a list of row dictionaries and no "
        "extra shaping is required, use a terminal [dict(row) for row in rows] over the "
        "trusted execute result. Do not add helpers, JOIN, CTE, JSON conversion, cursor "
        "metadata, try/finally wrappers, or architecture unless the typed requirements "
        "explicitly require them.\n\n"
        f"{render_screen_task_context(state)}\n\n"
        f"LATEST CORRECTION (highest priority):\n{latest_correction or '[none]'}"
    )


def _deterministic_simple_select_answer(
    state: ScreenTaskState,
    *,
    latest_correction: str,
) -> str | None:
    """Compose the narrow one-function/one-id SELECT profile without model variance."""

    typed = state.requirements
    if not (
        typed.code_language == ScreenCodeLanguage.PYTHON
        and typed.python_shape == PythonShape.FUNCTION
        and typed.expected_sql_statement_kind == SqlStatementKind.SELECT
        and len(typed.required_python_signatures) == 1
        and len(typed.required_sql_bound_ids) == 1
        and len(typed.required_sql_identifiers) == 2
        and set(typed.required_sql_clauses) == {"select", "from", "where"}
        and not typed.required_python_calls
        and not any((typed.allow_join, typed.allow_cte, typed.allow_json, typed.allow_helper))
    ):
        return None
    signature = typed.required_python_signatures[0]
    bound_id = typed.required_sql_bound_ids[0]
    try:
        tree = ast.parse(f"{signature}\n    pass", mode="exec")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        return None
    function = tree.body[0]
    argument_names = [argument.arg for argument in function.args.args]
    if len(argument_names) != 2 or argument_names[0] != "conn" or bound_id not in argument_names:
        return None
    expected_column = bound_id.rsplit("_", 1)[-1]
    columns = [
        identifier
        for identifier in typed.required_sql_identifiers
        if identifier in {bound_id, expected_column}
    ]
    tables = [
        identifier for identifier in typed.required_sql_identifiers if identifier not in columns
    ]
    if len(columns) != 1 or len(tables) != 1 or "." in tables[0]:
        return None
    import_lines = (
        ["from typing import Any", "# Сохраняю видимую аннотацию результата.", ""]
        if re.search(r"\bAny\b", signature)
        else []
    )
    table = tables[0]
    column = columns[0]
    code_lines = [
        *import_lines,
        signature,
        "    # Сохраняю точную публичную сигнатуру.",
        (f"    rows = conn.execute('SELECT * FROM \"{table}\" WHERE {column} = ?', ({bound_id},))"),
        "    # Передаю идентификатор отдельно от текста SQL.",
        "    return [dict(row) for row in rows]",
        "    # Возвращаю найденные строки как список словарей.",
    ]
    candidate = (
        "Сначала выполню один параметризованный запрос по идентификатору, затем верну "
        "найденные строки как словари.\n\n```python\n" + "\n".join(code_lines) + "\n```"
    )
    validation = validate_screen_answer(
        _validation_input(candidate, state=state, latest_correction=latest_correction)
    )
    return candidate if validation.valid else None


async def _generate_code_answer(
    *,
    state: ScreenTaskState,
    latest_correction: str,
    provider: str,
    model: str,
    max_tokens: int,
    reasoning: dict | None,
    complete: CompleteCall,
) -> str:
    if (
        state.requirements.code_language == ScreenCodeLanguage.PYTHON
        and state.requirements.python_shape != PythonShape.FUNCTION
    ):
        raise ScreenTaskPipelineError(
            "unsupported_screen_python_profile",
            "Строгая проверка пока поддерживает только Python-задачи с одной функцией.",
        )
    deterministic = _deterministic_simple_select_answer(
        state,
        latest_correction=latest_correction,
    )
    if deterministic is not None:
        return deterministic
    base_messages = [
        {
            "role": "system",
            "content": "You are a precise technical interview coding assistant.",
        },
        {"role": "user", "content": _answer_prompt(state, latest_correction)},
    ]
    draft = await complete(
        base_messages,
        provider,
        model,
        max_tokens=max_tokens,
        temperature=0.0,
        reasoning=reasoning,
        screen_workload_phase="answer",
    )
    validation = validate_screen_answer(
        _validation_input(draft, state=state, latest_correction=latest_correction)
    )
    if validation.valid:
        return draft.strip()

    issue_codes = ", ".join(code.value for code in validation.issue_codes)
    repair_prompt = (
        f"{_answer_prompt(state, latest_correction)}\n\n"
        "Repair the draft exactly once. The deterministic validator returned only these "
        f"stable issue codes: {issue_codes}. Fix every listed issue without adding unrelated "
        "layers. Emit exactly one target function and no helper or setup layer. Keep the "
        "control and SQL dataflow straight-line: assign the single trusted execute result, "
        "bind each required scalar value separately (a one-element tuple for positional "
        "placeholders), then return the required result. Return the full answer, not a diff.\n\n"
        f"INVALID DRAFT:\n{draft[:MAX_REPAIR_DRAFT_CHARS]}"
    )
    repaired = await complete(
        [base_messages[0], {"role": "user", "content": repair_prompt}],
        provider,
        model,
        max_tokens=max_tokens,
        temperature=0.0,
        reasoning=reasoning,
        screen_workload_phase="repair",
    )
    repaired_validation = validate_screen_answer(
        _validation_input(repaired, state=state, latest_correction=latest_correction)
    )
    if not repaired_validation.valid:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "Ответ не прошёл проверку точности. Повторите запрос.",
        )
    return repaired.strip()


def _checklist_draft_issues(
    raw: str,
    *,
    state: ScreenTaskState,
) -> tuple[tuple[_ChecklistDraftItem, ...] | None, tuple[str, ...]]:
    try:
        draft = _ChecklistDraft.model_validate_json(raw, strict=True).checked()
    except (TypeError, ValueError, ValidationError, json.JSONDecodeError):
        return None, ("checklist_schema_invalid",)

    items = tuple(
        _ChecklistDraftItem(
            text=" ".join(item.text.strip().split()),
            semantic_key=item.semantic_key,
        )
        for item in draft.items
    )
    requested_count = state.requirements.requested_item_count
    issues: list[str] = []
    if requested_count is None or len(items) != requested_count:
        issues.append("checklist_count_mismatch")

    normalized_items = tuple(normalize_screen_checklist_text(item.text) for item in items)
    if len(normalized_items) != len(set(normalized_items)):
        issues.append("checklist_duplicate")
    # Preserve identifiers (e.g. payment_method) on both sides of concept comparisons.
    # Exact-text normalization above remains separate from concept tokenization.
    candidate_signatures = tuple(_checklist_concept_signature(item.text) for item in items)
    if any(
        left
        and right
        and _concept_similarity(left, right) > CHECKLIST_INTRA_GENERATION_MAX_SIMILARITY
        for index, left in enumerate(candidate_signatures)
        for right in candidate_signatures[index + 1 :]
    ):
        issues.append("checklist_duplicate")
        issues.append("checklist_semantic_duplicate")
    if state.requirements.checklist_new_only:
        prior_items = {normalize_screen_checklist_text(item.text) for item in state.checklist_items}
        if any(item in prior_items for item in normalized_items):
            issues.append("checklist_duplicate")
        prior_signatures = tuple(
            _checklist_concept_signature(item.text) for item in state.checklist_items
        )
        has_concept_duplicate = any(
            signature
            and any(
                _concept_similarity(signature, prior) > CHECKLIST_CROSS_GENERATION_MAX_SIMILARITY
                for prior in prior_signatures
            )
            for signature in candidate_signatures
        )
        if has_concept_duplicate:
            issues.append("checklist_duplicate")
            issues.append("checklist_semantic_duplicate")
        prior_semantic_keys = {
            item.semantic_key for item in state.checklist_items if item.semantic_key is not None
        }
        if any(item.semantic_key in prior_semantic_keys for item in items):
            issues.append("checklist_semantic_duplicate")
    semantic_keys = [item.semantic_key for item in items]
    if len(semantic_keys) != len(set(semantic_keys)):
        issues.append("checklist_semantic_duplicate")
    if any(_CHECKLIST_NUMBERING_RE.search(item.text) for item in items):
        issues.append("checklist_numbering")
    if state.requirements.checklist_scope == ChecklistScope.BUSINESS and any(
        _NON_BUSINESS_CHECK_RE.search(item.text) for item in items
    ):
        issues.append("checklist_non_business")
    return items, tuple(dict.fromkeys(issues))


def _checklist_draft_json(items: Sequence[_ChecklistDraftItem]) -> str:
    return json.dumps(
        {"items": [{"text": item.text, "semantic_key": item.semantic_key} for item in items]},
        ensure_ascii=False,
    )


def _salvage_checklist_items(
    *drafts: Sequence[_ChecklistDraftItem],
    state: ScreenTaskState,
) -> tuple[_ChecklistDraftItem, ...] | None:
    """Select an exact strict subset from already-paid answer and repair drafts."""

    requested_count = state.requirements.requested_item_count
    if requested_count is None:
        return None
    selected: list[_ChecklistDraftItem] = []
    seen: set[tuple[str, str]] = set()
    for draft in drafts:
        for item in draft:
            key = (normalize_screen_checklist_text(item.text), item.semantic_key)
            if key in seen:
                continue
            seen.add(key)
            candidate = (*selected, item)
            _, issues = _checklist_draft_issues(_checklist_draft_json(candidate), state=state)
            if any(issue != "checklist_count_mismatch" for issue in issues):
                continue
            selected.append(item)
            if len(selected) == requested_count:
                validated, final_issues = _checklist_draft_issues(
                    _checklist_draft_json(selected),
                    state=state,
                )
                return validated if not final_issues else None
    return None


def _checklist_prompt(state: ScreenTaskState, latest_correction: str) -> str:
    requirements = state.requirements
    if requirements.checklist_scope is None:
        scope_instruction = "Use only the explicitly typed scope."
    else:
        scope_instruction = {
            ChecklistScope.BUSINESS: (
                "Return only observable business-behaviour checks. Do not include databases, "
                "SQL, tables, indexes, storage, implementation, infrastructure, API, endpoint, "
                "HTTP, JSON, protocol, status code, headers, queues, caches, or logs."
            ),
            ChecklistScope.TECHNICAL: "Return only technical implementation-level checks.",
            ChecklistScope.MIXED: "Return a purposeful mix of business and technical checks.",
        }[requirements.checklist_scope]
    novelty_instruction = (
        "Every item must be new and must not repeat or paraphrase Generated checklist history."
        if requirements.checklist_new_only
        else "Generate the requested checklist from the typed evidence."
    )
    return (
        "Generate a bounded interview checklist from the validated typed state below. "
        f"Return exactly {requirements.requested_item_count} items in the JSON schema. "
        "Each array item must contain only the check text: no number, bullet, heading, or "
        "explanation, plus a stable lowercase semantic_key describing the scenario rather than "
        "its wording. Paraphrases of the same scenario must use the same semantic_key. Keep every "
        "check concrete and independently verifiable. "
        "Within one returned list, every item must test a different scenario, condition, or "
        "outcome; changing only wording does not make an item distinct. "
        f"{scope_instruction} {novelty_instruction}\n\n"
        f"{render_screen_task_context(state)}\n\n"
        f"LATEST CORRECTION (highest priority):\n{latest_correction or '[none]'}"
    )


def _state_with_checklist_items(
    state: ScreenTaskState,
    items: Sequence[_ChecklistDraftItem],
) -> ScreenTaskState:
    prior_artifacts = state.checklist_items if state.requirements.checklist_new_only else ()
    if len(prior_artifacts) + len(items) > MAX_CHECKLIST_ITEMS:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "История чек-листа достигла предела. Начните новую экранную задачу.",
        )
    new_artifacts = tuple(
        ScreenChecklistItem(
            id=(
                "check-"
                + hashlib.sha256(
                    normalize_screen_checklist_text(item.text).encode("utf-8")
                ).hexdigest()[:24]
            ),
            text=item.text,
            semantic_key=item.semantic_key,
        )
        for item in items
    )
    artifacts = (*prior_artifacts, *new_artifacts)
    payload = state.model_dump(mode="python")
    payload["checklist_items"] = artifacts
    try:
        return ScreenTaskState.model_validate(payload)
    except (TypeError, ValueError, ValidationError) as exc:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "Чек-лист не прошёл проверку точности. Повторите запрос.",
        ) from exc


async def _generate_checklist_answer(
    *,
    state: ScreenTaskState,
    latest_correction: str,
    provider: str,
    model: str,
    max_tokens: int,
    reasoning: dict | None,
    complete: CompleteCall,
) -> tuple[str, ScreenTaskState]:
    prompt = _checklist_prompt(state, latest_correction)
    checklist_reasoning = _low_reasoning_effort(reasoning)
    checklist_max_tokens = min(max_tokens, 1_600)
    system_message = {
        "role": "system",
        "content": "You are a precise technical-interview checklist assistant.",
    }
    response_format = _structured_response_format("screen_checklist", _ChecklistDraft)
    draft = await complete(
        [system_message, {"role": "user", "content": prompt}],
        provider,
        model,
        max_tokens=checklist_max_tokens,
        temperature=0.0,
        reasoning=checklist_reasoning,
        response_format=response_format,
        screen_workload_phase="answer",
    )
    items, issues = _checklist_draft_issues(draft, state=state)
    original_items = items or ()
    if issues:
        repair_prompt = (
            f"{prompt}\n\nRepair the draft exactly once. Deterministic issue codes: "
            f"{', '.join(issues)}. For checklist_duplicate or "
            "checklist_semantic_duplicate, replace the repeated scenario with a genuinely "
            "different subject, condition, and outcome and give it a truthful unique "
            "semantic_key. For checklist_non_business, remove implementation, protocol, "
            "API, storage, or database checks. Fix every issue and return the complete JSON "
            "object.\n\n"
            f"INVALID DRAFT:\n{draft[:MAX_REPAIR_DRAFT_CHARS]}"
        )
        repaired = await complete(
            [system_message, {"role": "user", "content": repair_prompt}],
            provider,
            model,
            max_tokens=checklist_max_tokens,
            temperature=0.0,
            reasoning=checklist_reasoning,
            response_format=response_format,
            screen_workload_phase="repair",
        )
        repaired_items, issues = _checklist_draft_issues(repaired, state=state)
        items = repaired_items
        if issues:
            salvaged = _salvage_checklist_items(
                repaired_items or (),
                original_items,
                state=state,
            )
            if salvaged is not None:
                items = salvaged
                issues = ()
    if issues or items is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "Чек-лист не прошёл проверку точности. Повторите запрос.",
        )

    updated_state = _state_with_checklist_items(state, items)
    heading = "Новые проверки:" if state.requirements.checklist_new_only else "Чек-лист:"
    answer = "\n".join(
        [heading, *(f"{index}. {item.text}" for index, item in enumerate(items, start=1))]
    )
    return answer, updated_state


def _required_literal_issues(text: str, state: ScreenTaskState) -> tuple[str, ...]:
    if any(literal not in text for literal in state.requirements.required_literals):
        return ("required_literal_missing",)
    return ()


async def _generate_direct_answer(
    *,
    state: ScreenTaskState,
    latest_correction: str,
    provider: str,
    model: str,
    max_tokens: int,
    reasoning: dict | None,
    complete: CompleteCall,
) -> str:
    prompt = (
        "Give a concise direct answer from only the validated typed state. Return the answer "
        "in the strict JSON schema; cite at least one active finding/source id and no unknown "
        "ids. Do not include markdown wrappers or hidden reasoning.\n\n"
        f"{render_screen_task_context(state)}\n\n"
        f"LATEST CORRECTION (highest priority):\n{latest_correction or '[none]'}"
    )
    system_message = {
        "role": "system",
        "content": "You are a precise technical interview answer assistant.",
    }
    response_format = _structured_response_format("screen_direct_answer", _DirectAnswerDraft)

    def parse_or_issues(raw: str) -> tuple[str | None, tuple[str, ...]]:
        try:
            parsed = _DirectAnswerDraft.model_validate_json(raw, strict=True).checked()
            answer = parsed.answer.strip()
        except (TypeError, ValueError, ValidationError, json.JSONDecodeError):
            return None, ("direct_schema_invalid",)
        return answer, (
            *_grounding_issues(
                finding_ids=parsed.finding_ids,
                source_ids=parsed.source_ids,
                state=state,
                require_all=False,
            ),
            *_required_literal_issues(answer, state),
        )

    draft = await complete(
        [system_message, {"role": "user", "content": prompt}],
        provider,
        model,
        max_tokens=max_tokens,
        temperature=0.0,
        reasoning=reasoning,
        response_format=response_format,
        screen_workload_phase="answer",
    )
    answer, issues = parse_or_issues(draft)
    if issues:
        repair_prompt = (
            f"{prompt}\n\nRepair the draft exactly once. Deterministic issue codes: "
            f"{', '.join(issues)}. Return the complete JSON object.\n\n"
            f"INVALID DRAFT:\n{draft[:MAX_REPAIR_DRAFT_CHARS]}"
        )
        repaired = await complete(
            [system_message, {"role": "user", "content": repair_prompt}],
            provider,
            model,
            max_tokens=max_tokens,
            temperature=0.0,
            reasoning=reasoning,
            response_format=response_format,
            screen_workload_phase="repair",
        )
        answer, issues = parse_or_issues(repaired)
    if issues or answer is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "Прямой ответ не прошёл проверку точности. Повторите запрос.",
        )
    return answer


def _render_execution_result(draft: _ExecutionResultDraft) -> str:
    lines: list[str] = []
    if draft.result_lines:
        lines.extend(("Результат:", *draft.result_lines))
    elif draft.status == "success":
        lines.append("Результат: программа завершилась без вывода.")
    if draft.exception is not None:
        lines.append(f"Исключение: {draft.exception.strip()}")
    lines.append(draft.explanation.strip())
    return "\n".join(lines)


async def _generate_execution_result(
    *,
    state: ScreenTaskState,
    latest_correction: str,
    provider: str,
    model: str,
    max_tokens: int,
    reasoning: dict | None,
    complete: CompleteCall,
) -> str:
    prompt = (
        "Compute the visible program or query result from only the validated typed state. "
        "Return ordered output lines, the exact exception or null, and a concise Russian "
        "explanation in the strict JSON schema. Cite at least one active finding/source id "
        "and no unknown ids. Do not invent execution output.\n\n"
        f"{render_screen_task_context(state)}\n\n"
        f"LATEST CORRECTION (highest priority):\n{latest_correction or '[none]'}"
    )
    system_message = {
        "role": "system",
        "content": "You are a deterministic technical interview execution assistant.",
    }
    response_format = _structured_response_format("screen_execution_result", _ExecutionResultDraft)

    def parse_or_issues(raw: str) -> tuple[str | None, tuple[str, ...]]:
        try:
            parsed = _ExecutionResultDraft.model_validate_json(raw, strict=True).checked()
            answer = _render_execution_result(parsed)
        except (TypeError, ValueError, ValidationError, json.JSONDecodeError):
            return None, ("execution_schema_invalid",)
        return answer, (
            *_grounding_issues(
                finding_ids=parsed.finding_ids,
                source_ids=parsed.source_ids,
                state=state,
                require_all=False,
            ),
            *_required_literal_issues(answer, state),
        )

    draft = await complete(
        [system_message, {"role": "user", "content": prompt}],
        provider,
        model,
        max_tokens=max_tokens,
        temperature=0.0,
        reasoning=reasoning,
        response_format=response_format,
        screen_workload_phase="answer",
    )
    answer, issues = parse_or_issues(draft)
    if issues:
        repair_prompt = (
            f"{prompt}\n\nRepair the draft exactly once. Deterministic issue codes: "
            f"{', '.join(issues)}. Return the complete JSON object.\n\n"
            f"INVALID DRAFT:\n{draft[:MAX_REPAIR_DRAFT_CHARS]}"
        )
        repaired = await complete(
            [system_message, {"role": "user", "content": repair_prompt}],
            provider,
            model,
            max_tokens=max_tokens,
            temperature=0.0,
            reasoning=reasoning,
            response_format=response_format,
            screen_workload_phase="repair",
        )
        answer, issues = parse_or_issues(repaired)
    if issues or answer is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_answer",
            "Результат выполнения не прошёл проверку точности. Повторите запрос.",
        )
    return answer


async def run_screen_task_pipeline(
    *,
    previous_images: Sequence[str],
    current_image: str,
    latest_correction: str,
    context: str,
    prior_solution_summary: str | None,
    task_action: ScreenTaskAction | str | None,
    task_state: str | Mapping[str, Any] | None,
    provider: str,
    model: str,
    max_tokens: int,
    reasoning: dict | None,
    now_ms: int | None = None,
    complete: CompleteCall = provider_adapter.complete,
) -> ScreenTaskPipelineResult:
    """Extract unseen frames, merge typed evidence, then answer without pixels."""

    del prior_solution_summary  # Raw prose is intentionally excluded from the typed path.
    timestamp = now_ms if now_ms is not None else int(time.time() * 1_000)
    state = _load_state(task_state, task_action=task_action, now_ms=timestamp)
    known_digests = (
        {
            *(frame.digest.sha256 for frame in state.frames),
            *(entry.frame_digest.sha256 for entry in state.ledger),
        }
        if state is not None
        else set()
    )

    images = (*previous_images, current_image)
    for offset, image in enumerate(images):
        digest = _frame_digest(image)
        refresh_current_for_correction = bool(
            state is not None and offset == len(images) - 1 and latest_correction.strip()
        )
        if digest in known_digests and not refresh_current_for_correction:
            continue
        observation = await _extract_observation(
            image=image,
            state=state,
            latest_correction=latest_correction,
            context=context,
            provider=provider,
            model=model,
            reasoning=reasoning,
            complete=complete,
        )
        try:
            if state is None:
                state = _new_state(observation, now_ms=timestamp)
            else:
                state = _refine_state_metadata(state, observation)
            frame = _normalized_frame(
                observation,
                digest=digest,
                captured_at_ms=timestamp + offset,
                state=state,
            )
            state = merge_screen_frame(
                state,
                frame,
                now_ms=timestamp + offset,
                ttl_ms=SCREEN_TASK_STATE_TTL_MS,
            )
        except ScreenTaskPipelineError:
            raise
        except (TypeError, ValueError, ValidationError) as exc:
            raise ScreenTaskPipelineError(
                "invalid_screen_observation",
                "Не удалось надёжно объединить фрагменты экрана. Повторите снимок.",
            ) from exc
        known_digests.add(digest)

    if state is None:
        raise ScreenTaskPipelineError(
            "invalid_screen_observation",
            "Не удалось прочитать экран. Повторите снимок.",
        )

    if state.response_kind == ScreenResponseKind.ANALYSIS_FINDINGS:
        answer = await _generate_analysis_answer(
            state=state,
            latest_correction=latest_correction,
            provider=provider,
            model=model,
            max_tokens=max_tokens,
            reasoning=reasoning,
            complete=complete,
        )
    elif state.response_kind == ScreenResponseKind.CODE_SOLUTION:
        answer = await _generate_code_answer(
            state=state,
            latest_correction=latest_correction,
            provider=provider,
            model=model,
            max_tokens=max_tokens,
            reasoning=reasoning,
            complete=complete,
        )
    elif state.response_kind == ScreenResponseKind.CHECKLIST:
        answer, state = await _generate_checklist_answer(
            state=state,
            latest_correction=latest_correction,
            provider=provider,
            model=model,
            max_tokens=max_tokens,
            reasoning=reasoning,
            complete=complete,
        )
    elif state.response_kind == ScreenResponseKind.DIRECT_ANSWER:
        answer = await _generate_direct_answer(
            state=state,
            latest_correction=latest_correction,
            provider=provider,
            model=model,
            max_tokens=max_tokens,
            reasoning=reasoning,
            complete=complete,
        )
    elif state.response_kind == ScreenResponseKind.EXECUTION_RESULT:
        answer = await _generate_execution_result(
            state=state,
            latest_correction=latest_correction,
            provider=provider,
            model=model,
            max_tokens=max_tokens,
            reasoning=reasoning,
            complete=complete,
        )
    else:  # pragma: no cover - exhaustive StrEnum dispatch
        raise ScreenTaskPipelineError(
            "invalid_screen_observation",
            "Не удалось определить формат ответа по экрану. Повторите снимок.",
        )
    return ScreenTaskPipelineResult(
        answer=answer,
        serialized_task_state=serialize_screen_task_state(state),
    )
