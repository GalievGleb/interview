from __future__ import annotations

import hashlib
import json

import pytest

from app.services.screen_answer_validator import validate_screen_answer
from app.services.screen_task_pipeline import (
    ScreenTaskPipelineError,
    _validation_input,
    run_screen_task_pipeline,
)
from app.services.screen_task_state import (
    ScreenCodeLanguage,
    ScreenResponseKind,
    ScreenTaskRequirements,
    ScreenTaskState,
    ScreenTaskTtl,
    SqlStatementKind,
    TaskKind,
    deserialize_screen_task_state,
    serialize_screen_task_state,
)


def _assert_every_json_object_is_openai_strict(schema: dict) -> None:
    if schema.get("type") == "object":
        properties = schema.get("properties", {})
        assert schema.get("additionalProperties") is False
        assert set(schema.get("required", [])) == set(properties)
    for value in schema.values():
        if isinstance(value, dict):
            _assert_every_json_object_is_openai_strict(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    _assert_every_json_object_is_openai_strict(item)


def _observation(
    *,
    task_kind: str,
    visible_text: str,
    claim: str,
    evidence: str,
    finding_kind: str = "defect",
    correction_mode: str = "accumulate",
    allow_join: bool = False,
    allow_cte: bool = False,
    allow_json: bool = False,
    allow_helper: bool = False,
    required_python_signatures: tuple[str, ...] = (),
    required_python_calls: tuple[str, ...] = (),
    required_sql_identifiers: tuple[str, ...] = (),
    required_sql_clauses: tuple[str, ...] = (),
    required_sql_bound_ids: tuple[str, ...] = (),
    required_literals: tuple[str, ...] = (),
    code_language: str = "other",
    expected_sql_statement_kind: str | None = None,
    response_kind: str = "analysis_findings",
    requested_item_count: int | None = None,
    checklist_new_only: bool = False,
    checklist_scope: str | None = None,
    requested_item_count_explicit: bool | None = None,
    python_shape: str | None = None,
    finding_supersedes: str | None = None,
    source_supersedes: str | None = None,
    public_contract: tuple[str, ...] = (),
    constraints: tuple[str, ...] = ("Не выдумывать отсутствующие требования",),
) -> str:
    return json.dumps(
        {
            "task_kind": task_kind,
            "response_kind": response_kind,
            "correction_mode": correction_mode,
            "objective": "Дать точный ответ по видимому заданию",
            "public_contract": list(public_contract),
            "constraints": list(constraints),
            "allow_join": allow_join,
            "allow_cte": allow_cte,
            "allow_json": allow_json,
            "allow_helper": allow_helper,
            "required_python_signatures": list(required_python_signatures),
            "required_python_calls": list(required_python_calls),
            "required_sql_identifiers": list(required_sql_identifiers),
            "required_sql_clauses": list(required_sql_clauses),
            "required_sql_bound_ids": list(required_sql_bound_ids),
            "required_literals": list(required_literals),
            "code_language": code_language,
            "python_shape": (
                python_shape
                if python_shape is not None
                else ("function" if code_language == "python" else None)
            ),
            "expected_sql_statement_kind": expected_sql_statement_kind,
            "requested_item_count": requested_item_count,
            "requested_item_count_explicit": (
                requested_item_count is not None
                if requested_item_count_explicit is None
                else requested_item_count_explicit
            ),
            "checklist_new_only": checklist_new_only,
            "checklist_scope": checklist_scope,
            "visible_text": visible_text,
            "findings": [
                {
                    "claim": claim,
                    "evidence": evidence,
                    "kind": finding_kind,
                    "supersedes": finding_supersedes,
                }
            ],
            "sources": [
                {
                    "text": visible_text,
                    "kind": "code" if code_language != "other" else "task_text",
                    "supersedes": source_supersedes,
                }
            ],
        },
        ensure_ascii=False,
    )


def _grounding_ids(image: str) -> tuple[str, str]:
    digest = hashlib.sha256(image.encode("utf-8")).hexdigest()[:16]
    return f"f-{digest}-1", f"s-{digest}-1"


def _analysis_draft(images: tuple[str, ...], *texts: str) -> str:
    finding_ids, source_ids = zip(*(_grounding_ids(image) for image in images), strict=True)
    return json.dumps(
        {
            "items": [
                {
                    "text": text,
                    "finding_ids": [finding_id],
                    "source_ids": [source_id],
                }
                for text, finding_id, source_id in zip(texts, finding_ids, source_ids, strict=True)
            ]
        },
        ensure_ascii=False,
    )


def _checklist_draft(*items: str, semantic_prefix: str = "scenario") -> str:
    return json.dumps(
        {
            "items": [
                {"text": item, "semantic_key": f"{semantic_prefix}.{index}"}
                for index, item in enumerate(items, start=1)
            ]
        },
        ensure_ascii=False,
    )


@pytest.mark.asyncio
async def test_analysis_result_unifies_prior_and_current_through_a_grounded_draft() -> None:
    images = (
        "data:image/jpeg;base64,cHJpb3I=",
        "data:image/jpeg;base64,Y3VycmVudA==",
    )
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text="Первый экран: отсутствует обработка ошибки сети",
                claim="Не обработана ошибка сети",
                evidence="В первом фрагменте вызов не защищён обработчиком",
            ),
            _observation(
                task_kind="find_defect",
                visible_text="Второй экран: пароль записан открытым текстом",
                claim="Секрет хранится открытым текстом",
                evidence="Во втором фрагменте виден строковый литерал секрета",
            ),
            _analysis_draft(
                images,
                "Ошибка сети на первом экране остаётся частью общего ответа.",
                "Открытый секрет на втором экране усиливает общий риск.",
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(images[0],),
        current_image=images[1],
        latest_correction="Найди все дефекты на обоих экранах.",
        context="",
        prior_solution_summary="Черновик модели упомянул только текущий дефект.",
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=4200,
        reasoning={"effort": "medium", "exclude": True},
        now_ms=1_000,
        complete=complete,
    )

    assert "Не обработана ошибка сети" in result.answer
    assert "Секрет хранится открытым текстом" in result.answer
    assert len(calls) == 3
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "observation",
        "answer",
    ]
    assert [call["reasoning"]["effort"] for call in calls] == ["low", "low", "medium"]
    assert all(call["response_format"]["type"] == "json_schema" for call in calls)
    schema = calls[0]["response_format"]["json_schema"]["schema"]
    _assert_every_json_object_is_openai_strict(schema)
    serialized_schema = json.dumps(schema, sort_keys=True).casefold()
    assert "base64" not in serialized_schema
    assert "cHJpb3I=" not in serialized_schema
    assert "Y3VycmVudA==" not in serialized_schema
    state = deserialize_screen_task_state(result.serialized_task_state)
    assert len(state.frames) == 2
    assert "data:image" not in result.serialized_task_state
    assert "cHJpb3I=" not in result.serialized_task_state
    assert "Y3VycmVudA==" not in result.serialized_task_state


@pytest.mark.asyncio
async def test_analysis_result_cannot_hide_prior_ledger_fact_behind_unrelated_citations() -> None:
    images = (
        "data:image/jpeg;base64,bG9zc2xlc3MtcHJpb3I=",
        "data:image/jpeg;base64,bG9zc2xlc3MtY3VycmVudA==",
    )
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text="build_job выполняет только echo build",
                claim="В build_job отсутствует реальная сборка",
                evidence="script содержит только echo build",
            ),
            _observation(
                task_kind="find_defect",
                visible_text="regression_test_job выполняет только echo regression",
                claim="Регрессионные тесты не запускаются",
                evidence="script содержит только echo regression",
            ),
            _analysis_draft(
                images,
                "Первый идентификатор формально учтён без повторения вывода.",
                "Текущий дефект требует внимания.",
            ),
            _analysis_draft(
                images,
                "build_job не выполняет реальную сборку.",
                "regression_test_job не запускает регрессионные тесты.",
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(images[0],),
        current_image=images[1],
        latest_correction="Определи платформу и перечисли дефекты на обоих экранах.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning={"effort": "medium", "exclude": True},
        now_ms=1_000,
        complete=complete,
    )

    assert "- В build_job отсутствует реальная сборка — script содержит только echo build" in (
        result.answer
    )
    assert "- Регрессионные тесты не запускаются — script содержит только echo regression" in (
        result.answer
    )
    assert "Сводный анализ по сохранённым фактам" in result.answer
    assert "Первый идентификатор формально учтён" not in result.answer
    assert "build_job не выполняет реальную сборку" in result.answer
    assert result.answer.count("Регрессионные тесты не запускаются") == 1
    assert len(calls) == 4
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "observation",
        "answer",
        "repair",
    ]


@pytest.mark.asyncio
async def test_observation_role_derives_grounded_task_facts_without_writing_final_answer() -> None:
    image = "data:image/jpeg;base64,b2JzZXJ2YXRpb24tcHJvbXB0"
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text="job запускает только echo",
                claim="Job не выполняет реальную работу",
                evidence="В script видна только команда echo",
            ),
            _analysis_draft((image,), "Job содержит подтверждённый дефект."),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Найди дефект.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    observation_system = calls[0]["messages"][0]["content"]
    observation_prompt = calls[0]["messages"][1]["content"][0]["text"]
    assert "Do not solve the task" not in observation_system
    assert "Do not write the final user answer" in observation_system
    assert "grounded facts, defects, and requirements" in observation_system
    assert "task-relevant grounded conclusions" in observation_prompt
    assert "exact visible subject identifier" in observation_prompt
    assert "explicitly state the incorrect or missing behavior" in observation_prompt
    assert "build_job" not in observation_prompt
    assert "GitLab" not in observation_prompt
    observation_schema = calls[0]["response_format"]["json_schema"]["schema"]
    signature_items = observation_schema["properties"]["required_python_signatures"]["items"]
    assert signature_items["pattern"].startswith("^(?:async")
    sql_clause_items = observation_schema["properties"]["required_sql_clauses"]["items"]
    assert set(sql_clause_items["enum"]) == {
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


@pytest.mark.asyncio
async def test_find_defect_observation_retries_when_it_returns_only_general_facts() -> None:
    image = "data:image/jpeg;base64,ZGVmZWN0LXJldHJ5"
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text="worker only prints a placeholder instead of doing its named work",
                claim="Конфигурация относится к worker",
                evidence="На экране виден именованный блок worker",
                finding_kind="fact",
            ),
            _observation(
                task_kind="find_defect",
                visible_text="worker only prints a placeholder instead of doing its named work",
                claim="Worker не выполняет заявленную работу",
                evidence="В теле виден только placeholder-вывод",
                finding_kind="defect",
            ),
            _analysis_draft((image,), "Worker не выполняет заявленную работу."),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Найди дефекты.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning={"effort": "medium", "exclude": True},
        now_ms=1_000,
        complete=complete,
    )

    assert len(calls) == 3
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "observation",
        "answer",
    ]
    assert "Worker не выполняет заявленную работу" in result.answer
    retry_system = calls[1]["messages"][0]["content"]
    assert "complete, schema-valid observation" in retry_system
    assert "build_job" not in retry_system


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("job_name", "command"),
    (("build_job", "echo build"), ("regression_test_job", "echo regression")),
)
async def test_find_defect_observation_derives_a_defect_for_scalar_echo_only_job(
    job_name: str,
    command: str,
) -> None:
    image = "data:image/jpeg;base64,eWFtbC1ub29wLWpvYg=="
    finding_id, source_id = _grounding_ids(image)
    visible = f"stages: [build, test]; {job_name}: stage: build; script: {command}"
    grounded_analysis = json.dumps(
        {
            "items": [
                {
                    "text": (f"{job_name} только {command}; реальная операция job не выполняется."),
                    "finding_ids": [finding_id],
                    "source_ids": [source_id],
                },
            ]
        },
        ensure_ascii=False,
    )
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text=visible,
                claim=f"{job_name} не использует отдельный файл сценария",
                evidence=f"В script видна команда {command}",
                finding_kind="defect",
            ),
            grounded_analysis,
            grounded_analysis,
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Найди дефекты конфигурации.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning={"effort": "medium"},
        now_ms=1_000,
        complete=complete,
    )

    assert f"{job_name} только {command}; реальная операция этого job не выполняется" in (
        result.answer
    )
    assert len(deserialize_screen_task_state(result.serialized_task_state).ledger) == 1


@pytest.mark.asyncio
async def test_find_defect_observation_does_not_treat_echo_plus_real_command_as_noop() -> None:
    image = "data:image/jpeg;base64,eWFtbC1yZWFsLWpvYg=="
    visible = """build_job:
  stage: build
  script: echo build && make build"""
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text=visible,
                claim="build_job требует проверки кода возврата make build",
                evidence="Команда make build выполняется после echo",
                finding_kind="defect",
            ),
            _analysis_draft((image,), "build_job должен проверять результат make build."),
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Найди дефекты конфигурации.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    state = deserialize_screen_task_state(result.serialized_task_state)
    assert len(state.ledger) == 1
    assert "только echo build" not in result.answer


@pytest.mark.asyncio
async def test_response_kind_is_explicitly_preserved_in_typed_state() -> None:
    responses = iter(
        [
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Составьте чек-лист проверки формы входа",
                claim="Нужен чек-лист формы входа",
                evidence="Формулировка видна на экране",
                finding_kind="requirement",
                requested_item_count=5,
                checklist_scope="business",
            ),
            _checklist_draft(
                "Проверить вход с корректными данными",
                "Проверить отказ при неверном пароле",
                "Проверить обязательность логина",
                "Проверить обязательность пароля",
                "Проверить сообщение заблокированному пользователю",
                semantic_prefix="login",
            ),
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0",
        latest_correction="Составь чек-лист.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    state = deserialize_screen_task_state(result.serialized_task_state)
    assert state.response_kind == ScreenResponseKind.CHECKLIST


@pytest.mark.asyncio
async def test_checklist_refinement_returns_exactly_three_new_business_checks_without_repeats() -> (
    None
):
    first_items = [
        "Проверить успешное создание заказа с валидными данными",
        "Проверить отказ при пустом обязательном поле",
        "Проверить недоступный товар",
        "Проверить превышение доступного остатка",
        "Проверить повторную отправку одинакового запроса",
    ]
    repaired_items = [
        "Проверить применение действующей скидки к заказу",
        "Проверить запрет заказа для заблокированного клиента",
        "Проверить расчёт итоговой суммы заказа",
    ]
    responses = iter(
        [
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Составьте первые пять бизнес-проверок endpoint создания заказа",
                claim="Нужны пять бизнес-проверок endpoint",
                evidence="Количество и область указаны в условии",
                finding_kind="requirement",
                requested_item_count=5,
                checklist_scope="business",
            ),
            _checklist_draft(*first_items, semantic_prefix="initial"),
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Составьте первые пять бизнес-проверок endpoint создания заказа",
                claim="Добавить ещё три бизнес-проверки",
                evidence="Интервьюер попросил три новых варианта",
                finding_kind="requirement",
                requested_item_count=3,
                checklist_new_only=True,
                checklist_scope="business",
            ),
            json.dumps(
                {
                    "items": [
                        {
                            "text": "Убедиться: успешное создание заказа с валидными данными",
                            "semantic_key": "creation.valid.payload",
                        },
                        {
                            "text": "Проверить протокол обмена с сервером",
                            "semantic_key": "protocol.exchange",
                        },
                        {
                            "text": repaired_items[0],
                            "semantic_key": "discount.applied",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            _checklist_draft(*repaired_items, semantic_prefix="refined"),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0",
        latest_correction="Дай первые пять бизнес-проверок.",
        context="",
        prior_solution_summary="RAW-FIRST-PROSE-MUST-NOT-BE-STORED",
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    refined = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0",
        latest_correction="Теперь дай ровно три новые бизнес-проверки без повторов.",
        context="",
        prior_solution_summary="RAW-SECOND-PROSE-MUST-NOT-BE-STORED",
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )

    assert first.answer.splitlines() == [
        "Чек-лист:",
        *[f"{index}. {item}" for index, item in enumerate(first_items, start=1)],
    ]
    assert refined.answer.splitlines() == [
        "Новые проверки:",
        *[f"{index}. {item}" for index, item in enumerate(repaired_items, start=1)],
    ]
    assert all(item not in refined.answer for item in first_items)
    assert "БД" not in refined.answer
    refined_state = deserialize_screen_task_state(refined.serialized_task_state)
    assert [item.text for item in refined_state.checklist_items] == [*first_items, *repaired_items]
    assert "RAW-FIRST-PROSE" not in refined.serialized_task_state
    assert "RAW-SECOND-PROSE" not in refined.serialized_task_state
    assert len(calls) == 5
    repair_prompt = calls[-1]["messages"][-1]["content"]
    assert isinstance(repair_prompt, str)
    assert "checklist_duplicate" in repair_prompt
    assert "checklist_semantic_duplicate" in repair_prompt
    assert "checklist_non_business" in repair_prompt


@pytest.mark.asyncio
async def test_checklist_refinement_repairs_identifier_paraphrase_with_renamed_key() -> None:
    first_items = [
        "Проверить выбор payment_method для оплаты заказа",
        "Проверить адрес получателя",
        "Проверить дату доставки",
        "Проверить длину комментария",
        "Проверить количество товара в заказе",
    ]
    repeated_item = "Проверить payment_method для оплаты заказа покупателем"
    new_items = [
        "Проверить доступность курьера вечером",
        "Проверить скидку на доставку",
        "Проверить отказ заблокированному получателю",
    ]
    responses = iter(
        [
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Составьте пять проверок создания заказа",
                claim="Нужны пять проверок заказа",
                evidence="Количество указано в условии",
                finding_kind="requirement",
                requested_item_count=5,
                checklist_scope="business",
            ),
            _checklist_draft(*first_items, semantic_prefix="initial"),
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Добавьте ровно три новые бизнес-проверки",
                claim="Нужны три новые проверки без повторов",
                evidence="Интервьюер уточнил количество и новизну",
                finding_kind="requirement",
                requested_item_count=3,
                checklist_new_only=True,
                checklist_scope="business",
            ),
            _checklist_draft(repeated_item, *new_items[:2], semantic_prefix="renamed"),
            _checklist_draft(*new_items, semantic_prefix="repaired"),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0",
        latest_correction="Дай первые пять проверок.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    refined = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0",
        latest_correction="Дай ровно три новые бизнес-проверки без повторов.",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )

    assert refined.answer.splitlines() == [
        "Новые проверки:",
        "1. Проверить доступность курьера вечером",
        "2. Проверить скидку на доставку",
        "3. Проверить отказ заблокированному получателю",
    ]
    refined_state = deserialize_screen_task_state(refined.serialized_task_state)
    assert [item.text for item in refined_state.checklist_items] == [*first_items, *new_items]
    assert len(calls) == 5
    assert calls[-1]["screen_workload_phase"] == "repair"
    assert "checklist_semantic_duplicate" in calls[-1]["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_initial_checklist_repairs_semantic_paraphrases_with_different_keys() -> None:
    responses = iter(
        [
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Нужно три бизнес-проверки создания заказа",
                claim="Составить три разные бизнес-проверки",
                evidence="На экране явно запрошены три разные проверки",
                finding_kind="requirement",
                requested_item_count=3,
                checklist_scope="business",
            ),
            _checklist_draft(
                "Проверить успешное создание заказа с валидными данными",
                "Убедиться: успешное создание заказа с валидными данными",
                "Проверить отказ при отсутствии адреса доставки",
                semantic_prefix="misleading-distinct-keys",
            ),
            _checklist_draft(
                "Проверить успешное создание заказа с валидными данными",
                "Проверить отказ при отсутствии адреса доставки",
                "Проверить выбор бесконтактной передачи курьером",
                semantic_prefix="repaired",
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0",
        latest_correction="Дай ровно три разные бизнес-проверки.",
        context="",
        prior_solution_summary="",
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=4200,
        reasoning={"effort": "medium", "exclude": True},
        now_ms=1_000,
        complete=complete,
    )

    assert "бесконтактной передачи" in result.answer
    assert len(calls) == 3
    assert [call["reasoning"]["effort"] for call in calls] == ["low", "low", "low"]
    assert [call["max_tokens"] for call in calls] == [1800, 1600, 1600]
    repair_prompt = calls[-1]["messages"][-1]["content"]
    assert "checklist_duplicate" in repair_prompt
    assert "checklist_semantic_duplicate" in repair_prompt


@pytest.mark.asyncio
async def test_checklist_refinement_salvages_only_valid_unique_items_from_both_drafts() -> None:
    first_items = [
        "Проверить успешное создание заказа с валидными данными",
        "Проверить отказ при пустом обязательном поле",
        "Проверить недоступный товар",
        "Проверить превышение доступного остатка",
        "Проверить повторную отправку одинакового запроса",
    ]
    responses = iter(
        [
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Нужны пять бизнес-проверок создания заказа",
                claim="Нужны пять бизнес-проверок",
                evidence="Количество и область видны на экране",
                finding_kind="requirement",
                requested_item_count=5,
                checklist_scope="business",
            ),
            _checklist_draft(*first_items, semantic_prefix="initial"),
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Добавьте три новые бизнес-проверки",
                claim="Нужны три новые бизнес-проверки",
                evidence="Требование уточнено интервьюером",
                finding_kind="requirement",
                requested_item_count=3,
                checklist_new_only=True,
                checklist_scope="business",
            ),
            json.dumps(
                {
                    "items": [
                        {
                            "text": "Проверить применение действующей скидки к заказу",
                            "semantic_key": "discount.applied",
                        },
                        {
                            "text": "Проверить запись заказа в базе данных",
                            "semantic_key": "database.write",
                        },
                        {
                            "text": first_items[0],
                            "semantic_key": "initial-1",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            json.dumps(
                {
                    "items": [
                        {
                            "text": "Проверить запрет заказа заблокированным клиентом",
                            "semantic_key": "customer.blocked",
                        },
                        {
                            "text": "Проверить перенос даты доставки на допустимый день",
                            "semantic_key": "delivery.reschedule",
                        },
                        {
                            "text": "Проверить HTTP 201 после создания заказа",
                            "semantic_key": "http.created",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0LXNhbHZhZ2U=",
        latest_correction="Дай пять бизнес-проверок.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    refined = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y2hlY2tsaXN0LXNhbHZhZ2U=",
        latest_correction="Дай ровно три новые бизнес-проверки.",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )

    assert refined.answer.splitlines() == [
        "Новые проверки:",
        "1. Проверить запрет заказа заблокированным клиентом",
        "2. Проверить перенос даты доставки на допустимый день",
        "3. Проверить применение действующей скидки к заказу",
    ]
    assert "базе данных" not in refined.answer
    assert "HTTP" not in refined.answer


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response_kind", "model_payload", "expected_answer"),
    [
        (
            "direct_answer",
            {
                "answer": "Идемпотентный DELETE при повторе сохраняет итоговое состояние.",
                "finding_ids": [_grounding_ids("data:image/jpeg;base64,dGV4dA==")[0]],
                "source_ids": [_grounding_ids("data:image/jpeg;base64,dGV4dA==")[1]],
            },
            "Идемпотентный DELETE при повторе сохраняет итоговое состояние.",
        ),
        (
            "execution_result",
            {
                "status": "exception",
                "result_lines": ["  start  ", "42"],
                "exception": "TypeError",
                "explanation": "После ошибки следующие строки не выполняются.",
                "finding_ids": [_grounding_ids("data:image/jpeg;base64,dGV4dA==")[0]],
                "source_ids": [_grounding_ids("data:image/jpeg;base64,dGV4dA==")[1]],
            },
            "Результат:\n  start  \n42\nИсключение: TypeError\nПосле ошибки следующие строки не выполняются.",
        ),
    ],
)
async def test_non_code_response_kinds_use_bounded_structured_text_paths(
    response_kind: str,
    model_payload: dict,
    expected_answer: str,
) -> None:
    responses = iter(
        [
            _observation(
                task_kind="other",
                response_kind=response_kind,
                visible_text="Текстовая задача",
                claim="Дать прямой ответ",
                evidence="Ответ требуется в условии",
                finding_kind="requirement",
            ),
            json.dumps(model_payload, ensure_ascii=False),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,dGV4dA==",
        latest_correction="Ответь точно.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == expected_answer
    assert len(calls) == 2
    assert calls[1]["response_format"]["type"] == "json_schema"


@pytest.mark.asyncio
async def test_checklist_without_explicit_count_uses_bounded_default_and_records_provenance() -> (
    None
):
    items = (
        "Проверить авторизацию запроса",
        "Проверить ограничение размера payload",
        "Проверить таймаут внешнего сервиса",
        "Проверить идемпотентность повторной команды",
        "Проверить конкурентное обновление ресурса",
    )
    responses = iter(
        [
            _observation(
                task_kind="list",
                response_kind="checklist",
                visible_text="Составьте технический чек-лист",
                claim="Нужен технический чек-лист",
                evidence="Количество в условии не указано",
                finding_kind="requirement",
                requested_item_count=None,
                requested_item_count_explicit=False,
                checklist_scope="technical",
            ),
            _checklist_draft(*items, semantic_prefix="technical"),
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,ZGVmYXVsdC1jaGVja2xpc3Q=",
        latest_correction="Составь чек-лист.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    state = deserialize_screen_task_state(result.serialized_task_state)
    assert state.requirements.requested_item_count == 5
    assert state.requirements.requested_item_count_explicit is False
    assert result.answer.count("\n") == 5


@pytest.mark.asyncio
async def test_direct_answer_repairs_unknown_grounding_and_strips_answer() -> None:
    image = "data:image/jpeg;base64,ZGlyZWN0LWdyb3VuZGluZw=="
    finding_id, source_id = _grounding_ids(image)
    responses = iter(
        [
            _observation(
                task_kind="other",
                response_kind="direct_answer",
                visible_text="Что означает идемпотентность?",
                claim="Нужно дать определение",
                evidence="Вопрос виден на экране",
                finding_kind="requirement",
            ),
            json.dumps(
                {
                    "answer": "Неверно заземлённый ответ",
                    "finding_ids": ["unknown-finding"],
                    "source_ids": [],
                },
                ensure_ascii=False,
            ),
            json.dumps(
                {
                    "answer": "  Повтор операции сохраняет то же итоговое состояние.  ",
                    "finding_ids": [finding_id],
                    "source_ids": [source_id],
                },
                ensure_ascii=False,
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Ответь кратко.",
        context="",
        prior_solution_summary="RAW PRIOR MUST NOT LEAK",
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == "Повтор операции сохраняет то же итоговое состояние."
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "answer",
        "repair",
    ]
    repair_prompt = calls[-1]["messages"][-1]["content"]
    assert "grounding_unknown" in repair_prompt
    assert "RAW PRIOR MUST NOT LEAK" not in repair_prompt


@pytest.mark.asyncio
async def test_execution_success_can_have_no_output_but_remains_grounded() -> None:
    image = "data:image/jpeg;base64,bm8tb3V0cHV0"
    finding_id, source_id = _grounding_ids(image)
    responses = iter(
        [
            _observation(
                task_kind="other",
                response_kind="execution_result",
                visible_text="x = 1",
                claim="Программа ничего не печатает",
                evidence="На экране нет print",
                finding_kind="fact",
            ),
            json.dumps(
                {
                    "status": "success",
                    "result_lines": [],
                    "exception": None,
                    "explanation": "В программе нет операции вывода.",
                    "finding_ids": [finding_id],
                    "source_ids": [source_id],
                },
                ensure_ascii=False,
            ),
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Что выведет код?",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == (
        "Результат: программа завершилась без вывода.\nВ программе нет операции вывода."
    )


@pytest.mark.asyncio
async def test_current_unseen_frame_can_refine_task_kind_without_dropping_prior_evidence() -> None:
    answer = """Сохраню сигнатуру и верну значение.

```python
def load(value):
    # Принимаю исходное значение.
    return value
    # Возвращаю его без изменения.
```"""
    responses = iter(
        [
            _observation(
                task_kind="analysis",
                visible_text="Верхняя часть условия",
                claim="Сохранить имя load",
                evidence="Имя указано в верхней части условия",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
            ),
            _observation(
                task_kind="code",
                visible_text="def load(value):",
                claim="Сохранить сигнатуру load",
                evidence="В текущем фрагменте видна def load(value):",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
                required_python_signatures=("def load(value):",),
            ),
            answer,
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=("data:image/jpeg;base64,cHJpb3I=",),
        current_image="data:image/jpeg;base64,Y3VycmVudA==",
        latest_correction="Напиши минимальное решение.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == answer
    state = deserialize_screen_task_state(result.serialized_task_state)
    assert state.task_kind.value == "code"
    assert len(state.ledger) == 2


@pytest.mark.asyncio
async def test_evicted_frame_digest_is_still_seen_in_the_independent_ledger() -> None:
    images = tuple(f"data:image/jpeg;base64,frame-{index}" for index in range(1, 5))
    responses = iter(
        [
            *(
                _observation(
                    task_kind="analysis",
                    visible_text=f"Фрагмент {index}",
                    claim=f"Факт {index}",
                    evidence=f"Доказательство {index}",
                    finding_kind="fact",
                )
                for index in range(1, 4)
            ),
            _analysis_draft(images[:3], "Факт 1", "Факт 2", "Факт 3"),
            _observation(
                task_kind="analysis",
                visible_text="Фрагмент 4",
                claim="Факт 4",
                evidence="Доказательство 4",
                finding_kind="fact",
            ),
            _analysis_draft(images, "Факт 1", "Факт 2", "Факт 3", "Факт 4"),
            _analysis_draft(images, "Факт 1", "Факт 2", "Факт 3", "Факт 4"),
        ]
    )
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=images[:2],
        current_image=images[2],
        latest_correction="Проанализируй все фрагменты.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    second = await run_screen_task_pipeline(
        previous_images=(),
        current_image=images[3],
        latest_correction="Продолжи анализ.",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )
    calls_after_four_unique_frames = calls

    replay = await run_screen_task_pipeline(
        previous_images=(),
        current_image=images[0],
        latest_correction="",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=second.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=3_000,
        complete=complete,
    )

    assert calls_after_four_unique_frames == 6
    assert calls == calls_after_four_unique_frames + 1
    assert "Факт 1" in replay.answer
    assert "Факт 4" in replay.answer


@pytest.mark.asyncio
async def test_code_answer_repairs_one_overcomplex_draft_using_stable_issue_codes() -> None:
    overcomplex = """Сначала выполню запрос и верну строки.

```python
def helper(value):
    # Добавляю лишний слой.
    return value
    # Возвращаю значение.
def load(conn, order_id):
    # Принимаю параметры.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю параметр отдельно.
    return helper(rows.fetchall())
    # Возвращаю строки через лишний слой.
```"""
    minimal = """Сначала выполню один параметризованный запрос и верну найденные строки.

```python
def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки.
```"""
    responses = iter(
        [
            _observation(
                task_kind="code",
                correction_mode="refine",
                visible_text=(
                    "def load(conn, order_id):\n"
                    "Нужен один параметризованный SELECT из orders по order_id."
                ),
                claim="Сохранить публичную сигнатуру load",
                evidence="На экране видна def load(conn, order_id):",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
                required_python_signatures=("def load(conn, order_id):",),
                required_sql_identifiers=("orders", "id"),
                required_sql_clauses=("select", "from", "where"),
                required_sql_bound_ids=("order_id",),
            ),
            overcomplex,
            minimal,
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,Y29kZQ==",
        latest_correction="Упрости решение и убери лишние слои.",
        context="Интервьюер просит сохранить сигнатуру.",
        prior_solution_summary="RAW-PRIOR-PROSE-MUST-NOT-BE-SENT",
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == minimal
    assert len(calls) == 3
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "answer",
        "repair",
    ]
    assert "response_format" in calls[0]
    assert "response_format" not in calls[1]
    assert "response_format" not in calls[2]
    generation_prompt = calls[1]["messages"][-1]["content"]
    assert isinstance(generation_prompt, str)
    assert "SCREEN TASK STATE" in generation_prompt
    assert "Упрости решение" in generation_prompt
    assert "RAW-PRIOR-PROSE-MUST-NOT-BE-SENT" not in generation_prompt
    assert "one straight-line target function" in generation_prompt
    assert "directly on the visible connection parameter" in generation_prompt
    assert "terminal [dict(row) for row in rows]" in generation_prompt
    assert "get_order" not in generation_prompt
    assert 'FROM "Order"' not in generation_prompt
    repair_prompt = calls[2]["messages"][-1]["content"]
    assert "extra_top_level_layer" in repair_prompt
    assert "exactly one target function" in repair_prompt
    assert "one-element tuple" in repair_prompt
    assert "straight-line" in repair_prompt
    assert all(
        isinstance(message["content"], str) for call in calls[1:] for message in call["messages"]
    )


@pytest.mark.asyncio
async def test_simple_typed_select_lookup_is_composed_and_validated_without_generation() -> None:
    signature = "def find_record(conn, record_id: int) -> list[dict[str, Any]]:"
    responses = iter(
        [
            _observation(
                task_kind="code",
                visible_text=f"{signature}\nReturn the row from table Record by id.",
                claim="Вернуть запись Record по record_id",
                evidence="Виден контракт одной функции и поиска по id",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
                python_shape="function",
                expected_sql_statement_kind="select",
                required_python_signatures=(signature,),
                required_sql_identifiers=("Record", "id"),
                required_sql_clauses=("select", "from", "where"),
                required_sql_bound_ids=("record_id",),
            )
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,c2ltcGxlLXNlbGVjdA==",
        latest_correction="Верни минимальный полный код.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=4200,
        reasoning={"effort": "medium", "exclude": True},
        now_ms=1_000,
        complete=complete,
    )

    assert len(calls) == 1
    assert 'SELECT * FROM "Record" WHERE id = ?' in result.answer
    assert "(record_id,)" in result.answer
    assert "return [dict(row) for row in rows]" in result.answer
    assert validate_screen_answer(
        _validation_input(
            result.answer,
            state=deserialize_screen_task_state(result.serialized_task_state),
            latest_correction="Верни минимальный полный код.",
        )
    ).valid


@pytest.mark.asyncio
async def test_simple_typed_select_lookup_ignores_redundant_bound_variable_identifier() -> None:
    signature = "def get_order(conn, order_id: int) -> list[dict[str, Any]]:"
    generated_fallback = f"""Сначала выполню один параметризованный запрос по идентификатору.

```python
from typing import Any
# Сохраняю видимую аннотацию результата.

{signature}
    # Сохраняю точную публичную сигнатуру.
    rows = conn.execute('SELECT * FROM "Order" WHERE id = ?', (order_id,))
    # Передаю идентификатор отдельно от текста SQL.
    return [dict(row) for row in rows]
    # Возвращаю найденные строки как список словарей.
```"""
    responses = iter(
        [
            _observation(
                task_kind="code",
                visible_text=f'{signature}\nSELECT * FROM "Order" WHERE id = ?',
                claim="Вернуть заказ по order_id",
                evidence="На экране видны таблица Order и столбец id",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
                python_shape="function",
                expected_sql_statement_kind="select",
                required_python_signatures=(signature,),
                required_sql_identifiers=("Order", "id", "order_id"),
                required_sql_clauses=("select", "from", "where"),
                required_sql_bound_ids=("order_id",),
            ),
            generated_fallback,
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,cmVkdW5kYW50LWlk",
        latest_correction="Верни минимальный полный код.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=4200,
        reasoning={"effort": "medium", "exclude": True},
        now_ms=1_000,
        complete=complete,
    )

    assert len(calls) == 1
    assert 'SELECT * FROM "Order" WHERE id = ?' in result.answer
    assert "(order_id,)" in result.answer
    assert "return [dict(row) for row in rows]" in result.answer
    assert deserialize_screen_task_state(
        result.serialized_task_state
    ).requirements.required_sql_identifiers == ("Order", "id")


@pytest.mark.asyncio
async def test_python_return_annotation_keeps_signature_and_identifier_validation() -> None:
    signature = "def get_order(conn, order_id: int) -> list[dict[str, Any]]:"
    answer = f"""Сначала выполню параметризованный запрос по идентификатору заказа.

```python
{signature}
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки.
```"""
    responses = iter(
        [
            _observation(
                task_kind="code",
                visible_text=f"{signature}\nНайти заказ по order_id.",
                claim="Сохранить аннотированную сигнатуру",
                evidence=f"В условии видна {signature}",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
                required_python_signatures=(signature,),
                required_sql_identifiers=("orders", "id"),
                required_sql_clauses=("select", "from", "where"),
                required_sql_bound_ids=("order_id",),
            ),
            answer,
        ]
    )
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,YW5ub3RhdGVk",
        latest_correction="Реши минимально.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == answer
    assert calls == 2


@pytest.mark.asyncio
async def test_explicit_pure_sql_task_validates_without_a_python_signature() -> None:
    answer = """Сначала проверю доступность соединения простым запросом.

```sql
SELECT 1;
-- Возвращаю константу без обращения к таблицам.
```"""
    responses = iter(
        [
            _observation(
                task_kind="code",
                response_kind="code_solution",
                code_language="sql",
                expected_sql_statement_kind="select",
                visible_text="Напишите запрос SELECT 1",
                claim="Выполнить SELECT 1",
                evidence="Точный запрос указан на экране",
                finding_kind="requirement",
                required_sql_clauses=("select",),
                required_literals=("1",),
            ),
            answer,
        ]
    )
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image="data:image/jpeg;base64,c3Fs",
        latest_correction="Напиши минимальный SQL-запрос.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == answer
    assert calls == 2


@pytest.mark.asyncio
async def test_second_invalid_code_draft_fails_without_returning_state() -> None:
    invalid = """Объясню решение.

```python
def wrong(value):
    return value
```"""
    responses = iter(
        [
            _observation(
                task_kind="code",
                visible_text="def load(conn, order_id):",
                claim="Сохранить сигнатуру",
                evidence="В условии видна def load(conn, order_id):",
                finding_kind="requirement",
                code_language="python",
                response_kind="code_solution",
                required_python_signatures=("def load(conn, order_id):",),
                required_sql_bound_ids=("order_id",),
            ),
            invalid,
            invalid,
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    with pytest.raises(ScreenTaskPipelineError) as exc_info:
        await run_screen_task_pipeline(
            previous_images=(),
            current_image="data:image/jpeg;base64,Y29kZQ==",
            latest_correction="Реши задачу.",
            context="",
            prior_solution_summary=None,
            task_action="new",
            task_state=None,
            provider="openai",
            model="safe/model",
            max_tokens=1200,
            reasoning=None,
            now_ms=1_000,
            complete=complete,
        )

    assert exc_info.value.code == "invalid_screen_answer"
    assert "wrong" not in exc_info.value.public_message


@pytest.mark.asyncio
async def test_requirement_capabilities_refine_monotonically_and_new_resets_them() -> None:
    first_image = "data:image/jpeg;base64,Zmlyc3Q="
    second_image = "data:image/jpeg;base64,c2Vjb25k"
    third_image = "data:image/jpeg;base64,dGhpcmQ="
    responses = iter(
        [
            _observation(
                task_kind="analysis",
                visible_text="SELECT id FROM orders JOIN users",
                claim="Требуется объединение таблиц",
                evidence="JOIN виден в условии",
                finding_kind="requirement",
                allow_join=True,
                code_language="sql",
                expected_sql_statement_kind="select",
                required_sql_identifiers=("id", "orders"),
                required_sql_clauses=("select", "from", "join"),
            ),
            _analysis_draft((first_image,), "Требуется объединение таблиц"),
            _observation(
                task_kind="analysis",
                visible_text="WHERE status = ?",
                claim="Требуется фильтр статуса",
                evidence="Фильтр виден на втором экране",
                code_language="sql",
                expected_sql_statement_kind="select",
                required_sql_identifiers=("status",),
                required_sql_clauses=("where",),
            ),
            _analysis_draft(
                (first_image, second_image),
                "Требуется объединение таблиц",
                "Требуется фильтр статуса",
            ),
            _observation(
                task_kind="analysis",
                visible_text="Новая независимая задача",
                claim="Новое условие",
                evidence="Открыта новая задача",
            ),
            _analysis_draft((third_image,), "Новое условие"),
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=(),
        current_image=first_image,
        latest_correction="Начни задачу.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    continued = await run_screen_task_pipeline(
        previous_images=(),
        current_image=second_image,
        latest_correction="Продолжи.",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )
    reset = await run_screen_task_pipeline(
        previous_images=(),
        current_image=third_image,
        latest_correction="Это новая задача.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=3_000,
        complete=complete,
    )

    continued_requirements = deserialize_screen_task_state(
        continued.serialized_task_state
    ).requirements
    reset_requirements = deserialize_screen_task_state(reset.serialized_task_state).requirements
    assert continued_requirements.allow_join is True
    assert continued_requirements.allow_cte is False
    assert continued_requirements.required_sql_identifiers == ("id", "orders", "status")
    assert continued_requirements.required_sql_clauses == ("select", "from", "join", "where")
    assert continued_requirements.code_language == ScreenCodeLanguage.SQL
    assert continued_requirements.expected_sql_statement_kind == SqlStatementKind.SELECT
    assert reset_requirements.allow_join is False
    assert reset_requirements.required_sql_identifiers == ()
    assert reset_requirements.required_sql_clauses == ()
    assert reset_requirements.code_language == ScreenCodeLanguage.OTHER


def test_validation_uses_only_typed_capability_flags_and_structural_requirements() -> None:
    state = ScreenTaskState(
        task_kind=TaskKind.CODE,
        requirements=ScreenTaskRequirements(
            objective="JOIN, CTE, JSON и helper упомянуты только как запрещённые слова",
            constraints=("Не использовать JOIN, CTE, JSON или helper",),
            allow_join=False,
            allow_cte=False,
            allow_json=False,
            allow_helper=False,
            required_sql_identifiers=("dual",),
            required_sql_clauses=("select", "from"),
            required_literals=("1",),
            code_language=ScreenCodeLanguage.SQL,
            expected_sql_statement_kind=SqlStatementKind.SELECT,
        ),
        response_kind=ScreenResponseKind.CODE_SOLUTION,
        ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000),
    )

    validation_input = _validation_input("draft", state=state, latest_correction="")

    assert validation_input.allow_join is False
    assert validation_input.allow_cte is False
    assert validation_input.allow_json is False
    assert validation_input.allow_helper is False
    assert validation_input.code_language == "sql"
    assert validation_input.expected_sql_statement_kind == "select"
    assert validation_input.required_sql_identifiers == ("dual",)
    assert validation_input.required_sql_clauses == ("select", "from")
    assert validation_input.visible_literals == ("1",)
    assert validation_input.require_russian_line_comments is True
    assert [item.stable_id for item in validation_input.stable_requirements] == [
        "required-sql-identifier-1",
        "required-sql-clause-1",
        "required-sql-clause-2",
        "required-literal-1",
    ]


def test_missing_python_signature_never_reclassifies_the_task_as_sql() -> None:
    state = ScreenTaskState(
        task_kind=TaskKind.CODE,
        response_kind=ScreenResponseKind.CODE_SOLUTION,
        requirements=ScreenTaskRequirements(
            objective="Написать короткий Python-скрипт без заданной сигнатуры",
            code_language=ScreenCodeLanguage.PYTHON,
        ),
        ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000),
    )

    validation_input = _validation_input("draft", state=state, latest_correction="")

    assert validation_input.code_language == "python"
    assert validation_input.python_shape == "function"
    assert validation_input.visible_public_signature is None
    assert validation_input.expected_sql_statement_kind is None


@pytest.mark.asyncio
async def test_unsupported_python_shape_fails_explicitly_before_answer_generation() -> None:
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        return _observation(
            task_kind="code",
            response_kind="code_solution",
            code_language="python",
            python_shape="script",
            visible_text="print('hello')",
            claim="Нужен исполняемый скрипт",
            evidence="На экране нет функции",
            finding_kind="requirement",
        )

    with pytest.raises(ScreenTaskPipelineError) as exc_info:
        await run_screen_task_pipeline(
            previous_images=(),
            current_image="data:image/jpeg;base64,cHl0aG9uLXNjcmlwdA==",
            latest_correction="Реши задачу.",
            context="",
            prior_solution_summary=None,
            task_action="new",
            task_state=None,
            provider="openai",
            model="safe/model",
            max_tokens=1200,
            reasoning=None,
            now_ms=1_000,
            complete=complete,
        )

    assert exc_info.value.code == "unsupported_screen_python_profile"
    assert calls == 1


@pytest.mark.asyncio
async def test_inconsistent_checklist_count_provenance_is_a_stable_observation_error() -> None:
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        return _observation(
            task_kind="list",
            response_kind="checklist",
            visible_text="Составьте несколько проверок",
            claim="Нужен чек-лист",
            evidence="Количество не указано",
            finding_kind="requirement",
            requested_item_count=3,
            requested_item_count_explicit=False,
            checklist_scope="business",
        )

    with pytest.raises(ScreenTaskPipelineError) as exc_info:
        await run_screen_task_pipeline(
            previous_images=(),
            current_image="data:image/jpeg;base64,aW52YWxpZC1jb3VudA==",
            latest_correction="Составь проверки.",
            context="",
            prior_solution_summary=None,
            task_action="new",
            task_state=None,
            provider="openai",
            model="safe/model",
            max_tokens=1200,
            reasoning=None,
            now_ms=1_000,
            complete=complete,
        )

    assert exc_info.value.code == "invalid_screen_observation"
    assert calls == 2


@pytest.mark.asyncio
async def test_invalid_observation_is_reextracted_once_without_reusing_raw_draft() -> None:
    image = "data:image/jpeg;base64,b2JzZXJ2YXRpb24tcmV0cnk="
    finding_id, source_id = _grounding_ids(image)
    responses = iter(
        [
            "not valid observation json",
            _observation(
                task_kind="other",
                response_kind="direct_answer",
                visible_text="Что означает идемпотентность?",
                claim="Нужно дать определение",
                evidence="Вопрос виден на экране",
                finding_kind="requirement",
            ),
            json.dumps(
                {
                    "answer": "Повтор сохраняет итоговое состояние.",
                    "finding_ids": [finding_id],
                    "source_ids": [source_id],
                },
                ensure_ascii=False,
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Ответь кратко.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert result.answer == "Повтор сохраняет итоговое состояние."
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "observation",
        "answer",
    ]
    assert "not valid observation json" not in json.dumps(calls[1]["messages"], ensure_ascii=False)


def _serialized_pipeline_state(*, expires_at_ms: int = 61_000) -> str:
    return serialize_screen_task_state(
        ScreenTaskState(
            task_kind=TaskKind.ANALYSIS,
            response_kind=ScreenResponseKind.ANALYSIS_FINDINGS,
            requirements=ScreenTaskRequirements(objective="Сохранённая задача"),
            ttl=ScreenTaskTtl(
                created_at_ms=1_000,
                updated_at_ms=1_000,
                expires_at_ms=expires_at_ms,
            ),
        )
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("task_action", "task_state", "now_ms", "expected_code"),
    [
        ("new", _serialized_pipeline_state(), 2_000, "invalid_screen_task_action"),
        ("continue", None, 2_000, "invalid_screen_task_action"),
        (
            "continue",
            _serialized_pipeline_state(expires_at_ms=2_000),
            2_000,
            "screen_task_state_expired",
        ),
        (None, None, 2_000, "invalid_screen_task_action"),
    ],
)
async def test_task_action_contract_fails_before_any_provider_call(
    task_action: str | None,
    task_state: str | None,
    now_ms: int,
    expected_code: str,
) -> None:
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("provider must not run for an invalid task action")

    with pytest.raises(ScreenTaskPipelineError) as exc_info:
        await run_screen_task_pipeline(
            previous_images=(),
            current_image="data:image/jpeg;base64,Y3VycmVudA==",
            latest_correction="Продолжи.",
            context="",
            prior_solution_summary=None,
            task_action=task_action,
            task_state=task_state,
            provider="openai",
            model="safe/model",
            max_tokens=1200,
            reasoning=None,
            now_ms=now_ms,
            complete=complete,
        )

    assert exc_info.value.code == expected_code
    assert calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("saved_requirements", "observation", "expected_message"),
    [
        (
            ScreenTaskRequirements(
                objective="Python-задача",
                code_language=ScreenCodeLanguage.PYTHON,
            ),
            _observation(
                task_kind="code",
                response_kind="code_solution",
                code_language="sql",
                expected_sql_statement_kind="select",
                visible_text="SELECT 1",
                claim="SQL-задача",
                evidence="На экране виден SELECT",
            ),
            "языку",
        ),
        (
            ScreenTaskRequirements(
                objective="SQL SELECT",
                code_language=ScreenCodeLanguage.SQL,
                expected_sql_statement_kind=SqlStatementKind.SELECT,
            ),
            _observation(
                task_kind="code",
                response_kind="code_solution",
                code_language="sql",
                expected_sql_statement_kind="update",
                visible_text="UPDATE users SET active = true",
                claim="SQL UPDATE",
                evidence="На экране виден UPDATE",
            ),
            "SQL",
        ),
    ],
)
async def test_continuation_rejects_conflicting_typed_code_metadata_without_answer_generation(
    saved_requirements: ScreenTaskRequirements,
    observation: str,
    expected_message: str,
) -> None:
    saved = serialize_screen_task_state(
        ScreenTaskState(
            task_kind=TaskKind.CODE,
            response_kind=ScreenResponseKind.CODE_SOLUTION,
            requirements=saved_requirements,
            ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000),
        )
    )
    calls = 0

    async def complete(messages, provider, model, **kwargs):
        nonlocal calls
        calls += 1
        return observation

    with pytest.raises(ScreenTaskPipelineError) as exc_info:
        await run_screen_task_pipeline(
            previous_images=(),
            current_image="data:image/jpeg;base64,bmV3LWZyYW1l",
            latest_correction="Продолжи задачу.",
            context="",
            prior_solution_summary=None,
            task_action="continue",
            task_state=saved,
            provider="openai",
            model="safe/model",
            max_tokens=1200,
            reasoning=None,
            now_ms=2_000,
            complete=complete,
        )

    assert exc_info.value.code == "invalid_screen_observation"
    assert expected_message in exc_info.value.public_message
    assert calls == 1


@pytest.mark.asyncio
async def test_same_digest_correction_reobserves_and_can_change_response_kind() -> None:
    image = "data:image/jpeg;base64,c2FtZS1jb250ZW50"
    old_finding_id, old_source_id = _grounding_ids(image)
    responses = iter(
        [
            _observation(
                task_kind="analysis",
                response_kind="analysis_findings",
                visible_text="Найти проблему",
                claim="Нужно найти проблему",
                evidence="Условие на экране",
            ),
            _analysis_draft((image,), "Проблема подтверждена исходным условием"),
            _observation(
                task_kind="list",
                response_kind="checklist",
                correction_mode="refine",
                visible_text="Найти проблему",
                claim="Теперь нужны три проверки",
                evidence="Это явная последняя правка",
                finding_kind="requirement",
                finding_supersedes=old_finding_id,
                source_supersedes=old_source_id,
                requested_item_count=3,
                checklist_new_only=True,
                checklist_scope="business",
            ),
            json.dumps(
                {
                    "items": [
                        {
                            "text": "Проверить успешный сценарий",
                            "semantic_key": "flow.success",
                        },
                        {
                            "text": "Проверить отказ при неверных данных",
                            "semantic_key": "flow.invalid-data",
                        },
                        {
                            "text": "Проверить повторную отправку",
                            "semantic_key": "flow.repeat",
                        },
                    ],
                },
                ensure_ascii=False,
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Проанализируй.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    refined = await run_screen_task_pipeline(
        previous_images=(),
        current_image=image,
        latest_correction="Теперь дай ровно три новые бизнес-проверки.",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )

    state = deserialize_screen_task_state(refined.serialized_task_state)
    assert len(calls) == 4
    assert state.response_kind == ScreenResponseKind.CHECKLIST
    assert [entry.finding.id for entry in state.ledger if entry.finding.active] != [old_finding_id]
    assert all(
        entry.source.id != old_source_id for entry in state.source_ledger if entry.source.active
    )
    assert refined.answer.startswith("Новые проверки:\n1.")


@pytest.mark.asyncio
async def test_refine_replaces_revocable_sql_requirements_but_keeps_public_contract() -> None:
    first_image = "data:image/jpeg;base64,c3FsLW9yaWdpbmFs"
    second_image = "data:image/jpeg;base64,c3FsLXJlZmluZWQ="
    original = """Сначала соединю таблицы по условию.

```sql
SELECT orders.id
-- Выбираю идентификатор заказа.
FROM orders JOIN users ON users.id = orders.user_id;
-- Соединяю заказы с пользователями.
```"""
    simplified = """Сделаю минимальный запрос без лишнего соединения.

```sql
SELECT orders.id
-- Выбираю идентификатор заказа.
FROM orders;
-- Читаю данные только из таблицы заказов.
```"""
    responses = iter(
        [
            _observation(
                task_kind="code",
                response_kind="code_solution",
                code_language="sql",
                expected_sql_statement_kind="select",
                visible_text="SELECT orders.id FROM orders JOIN users",
                claim="Вернуть идентификатор заказа",
                evidence="Публичный результат указан в условии",
                finding_kind="requirement",
                allow_join=True,
                required_sql_identifiers=("orders", "users", "id"),
                required_sql_clauses=("select", "from", "join"),
                public_contract=("Вернуть orders.id",),
            ),
            original,
            _observation(
                task_kind="code",
                response_kind="code_solution",
                correction_mode="refine",
                code_language="sql",
                expected_sql_statement_kind="select",
                visible_text="SELECT orders.id FROM orders",
                claim="Убрать JOIN и оставить тот же результат",
                evidence="Последняя правка требует упрощения",
                finding_kind="constraint",
                required_sql_identifiers=("orders", "id"),
                required_sql_clauses=("select", "from"),
                public_contract=("Вернуть orders.id",),
            ),
            simplified,
        ]
    )

    async def complete(messages, provider, model, **kwargs):
        return next(responses)

    first = await run_screen_task_pipeline(
        previous_images=(),
        current_image=first_image,
        latest_correction="Реши.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )
    refined = await run_screen_task_pipeline(
        previous_images=(),
        current_image=second_image,
        latest_correction="Упрости: JOIN больше не нужен.",
        context="",
        prior_solution_summary=None,
        task_action="continue",
        task_state=first.serialized_task_state,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=2_000,
        complete=complete,
    )

    requirements = deserialize_screen_task_state(refined.serialized_task_state).requirements
    assert requirements.public_contract == ("Вернуть orders.id",)
    assert requirements.required_sql_identifiers == ("orders", "id")
    assert requirements.required_sql_clauses == ("select", "from")
    assert requirements.allow_join is False
    assert "JOIN" not in refined.answer


@pytest.mark.asyncio
async def test_analysis_composition_keeps_every_ledger_fact_and_appends_grounded_synthesis() -> (
    None
):
    images = (
        "data:image/jpeg;base64,YW5hbHlzaXMtb25l",
        "data:image/jpeg;base64,YW5hbHlzaXMtdHdv",
    )
    responses = iter(
        [
            _observation(
                task_kind="find_defect",
                visible_text="exact source one",
                claim="fact one",
                evidence="frame one",
                finding_kind="defect",
            ),
            _observation(
                task_kind="find_defect",
                correction_mode="exact_new",
                visible_text="exact source two",
                claim="fact two",
                evidence="frame two",
                finding_kind="defect",
            ),
            _analysis_draft(
                images,
                "fact one влияет на ранний этап.",
                "fact two подтверждает общий риск.",
            ),
        ]
    )
    calls: list[dict] = []

    async def complete(messages, provider, model, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return next(responses)

    result = await run_screen_task_pipeline(
        previous_images=(images[0],),
        current_image=images[1],
        latest_correction="Найди дефекты.",
        context="",
        prior_solution_summary=None,
        task_action="new",
        task_state=None,
        provider="openai",
        model="safe/model",
        max_tokens=1200,
        reasoning=None,
        now_ms=1_000,
        complete=complete,
    )

    assert len(calls) == 3
    assert [call["screen_workload_phase"] for call in calls] == [
        "observation",
        "observation",
        "answer",
    ]
    assert result.answer.splitlines() == [
        "Единый результат по всем сохранённым фрагментам экрана:",
        "- fact one — frame one",
        "- fact two — frame two",
        "",
        "Сводный анализ по сохранённым фактам:",
        "- fact one влияет на ранний этап.",
        "- fact two подтверждает общий риск.",
    ]
