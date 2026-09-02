from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import sys
from pathlib import Path

import pytest

from app.core.errors import AppError
from app.routers import chat as chat_router
from app.services import provider_adapter
from app.services.screen_task_state import (
    ScreenResponseKind,
    ScreenTaskRequirements,
    ScreenTaskState,
    ScreenTaskTtl,
    TaskKind,
    serialize_screen_task_state,
)

SCENARIOS_PATH = (
    Path(__file__).resolve().parents[3] / "tests" / "real-interview-overlay" / "scenarios.json"
)


@pytest.fixture(autouse=True)
def _alpha_build_channel(monkeypatch) -> None:
    """This module exercises both the Alpha opt-in and legacy-off path."""

    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "alpha")


def _scenario(scenario_id: str) -> dict:
    document = json.loads(SCENARIOS_PATH.read_text("utf-8"))
    return next(item for item in document["scenarios"] if item["id"] == scenario_id)


def _events(response) -> list[dict]:
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def _structured_observation(
    *,
    task_kind: str,
    visible_text: str,
    claim: str,
    evidence: str,
    finding_kind: str = "defect",
    correction_mode: str = "accumulate",
    response_kind: str = "analysis_findings",
    code_language: str = "other",
    expected_sql_statement_kind: str | None = None,
    required_python_signatures: tuple[str, ...] = (),
    required_python_calls: tuple[str, ...] = (),
    required_sql_identifiers: tuple[str, ...] = (),
    required_sql_clauses: tuple[str, ...] = (),
    required_sql_bound_ids: tuple[str, ...] = (),
    required_literals: tuple[str, ...] = (),
    requested_item_count: int | None = None,
    checklist_new_only: bool = False,
    checklist_scope: str | None = None,
    python_shape: str | None = None,
) -> str:
    return json.dumps(
        {
            "task_kind": task_kind,
            "response_kind": response_kind,
            "correction_mode": correction_mode,
            "objective": "Дать точный ответ по видимому заданию",
            "public_contract": [],
            "constraints": ["Не добавлять отсутствующие требования"],
            "allow_join": False,
            "allow_cte": False,
            "allow_json": False,
            "allow_helper": False,
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
            "requested_item_count_explicit": requested_item_count is not None,
            "checklist_new_only": checklist_new_only,
            "checklist_scope": checklist_scope,
            "visible_text": visible_text,
            "findings": [
                {
                    "claim": claim,
                    "evidence": evidence,
                    "kind": finding_kind,
                    "supersedes": None,
                }
            ],
            "sources": [
                {
                    "text": visible_text,
                    "kind": "code" if code_language != "other" else "task_text",
                    "supersedes": None,
                }
            ],
        },
        ensure_ascii=False,
    )


def _structured_analysis_draft(images: tuple[str, ...], *texts: str) -> str:
    digests = tuple(hashlib.sha256(image.encode("utf-8")).hexdigest()[:16] for image in images)
    return json.dumps(
        {
            "items": [
                {
                    "text": text,
                    "finding_ids": [f"f-{digest}-1"],
                    "source_ids": [f"s-{digest}-1"],
                }
                for text, digest in zip(texts, digests, strict=True)
            ]
        },
        ensure_ascii=False,
    )


def _expired_structured_state() -> str:
    return serialize_screen_task_state(
        ScreenTaskState(
            task_kind=TaskKind.ANALYSIS,
            response_kind=ScreenResponseKind.ANALYSIS_FINDINGS,
            requirements=ScreenTaskRequirements(objective="Сохранённая задача"),
            ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=2_000),
        )
    )


def test_slow_first_screen_delta_emits_transport_comments_then_chunk_done(client, monkeypatch):
    contract = _scenario("screen-first-answer-at-26000ms")

    async def slow_stream(*args, **kwargs):
        await asyncio.sleep(0.035)
        yield "answer"

    monkeypatch.setattr(provider_adapter, "stream_chat", slow_stream)
    monkeypatch.setattr(chat_router, "SCREEN_STREAM_KEEPALIVE_SECONDS", 0.01)

    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Read screen"},
    )

    assert response.status_code == 200, response.text
    assert response.text.split("\n\n").count(": keepalive") >= len(contract["transportCommentAtMs"])
    assert [event["type"] for event in _events(response)] == ["chunk", "done"]


def test_previous_frames_and_latest_correction_are_separately_labelled_and_ordered(
    client, monkeypatch
):
    captured: dict = {}
    contract = _scenario("multiscroll-gitlab-cicd")

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    correction = contract["questions"][1]
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": [
                "data:image/jpeg;base64,previous-1",
                "data:image/jpeg;base64,previous-2",
            ],
            "prior_solution_summary": "First viewport diagnosis",
            "question": correction,
        },
    )

    assert response.status_code == 200, response.text
    images = [
        part["image_url"]["url"] for part in captured["content"] if part["type"] == "image_url"
    ]
    assert images == [
        "data:image/jpeg;base64,previous-1",
        "data:image/jpeg;base64,previous-2",
        "data:image/jpeg;base64,current",
    ]
    prompt = captured["content"][0]["text"]
    assert "PRIOR SOLUTION SUMMARY" in prompt
    assert "First viewport diagnosis" in prompt
    assert "LATEST INTERVIEWER CORRECTION" in prompt
    assert correction in prompt
    assert "current viewport overrides prior context only where an actual conflict exists" in prompt


def test_current_viewport_is_new_evidence_not_unconditionally_authoritative(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": ["data:image/jpeg;base64,previous"],
            "question": "Продолжи анализ после прокрутки.",
        },
    )

    assert response.status_code == 200, response.text
    content = captured["content"]
    current_image_index = next(
        index
        for index, part in enumerate(content)
        if part.get("type") == "image_url"
        and part["image_url"]["url"] == "data:image/jpeg;base64,current"
    )
    current_label = content[current_image_index - 1]["text"].casefold()
    assert "current viewport" in current_label
    assert "new evidence" in current_label
    assert "authoritative only on an actual direct conflict" in current_label
    assert current_label != "current viewport (authoritative):"


def test_final_screen_decision_barrier_follows_images_and_repeats_latest_correction(
    client, monkeypatch
):
    captured: dict = {}
    correction = "Упрости решение, сохрани только видимый интерфейс."

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": ["data:image/jpeg;base64,previous"],
            "prior_solution_summary": "Диагностический черновик прошлой попытки.",
            "question": correction,
        },
    )

    assert response.status_code == 200, response.text
    final_part = captured["content"][-1]
    assert final_part["type"] == "text"
    final_text = final_part["text"]
    lowered = final_text.casefold()
    assert captured["content"][-2]["type"] == "image_url"
    assert "final screen decision" in lowered
    assert correction in final_text
    assert "silent evidence ledger for every retained viewport frame" in lowered
    assert "consolidate every non-conflicting finding" in lowered
    assert "prior answer is diagnostic evidence only" in lowered
    assert (
        "preserve only the public interface and output semantics that are visible "
        "or explicitly requested"
    ) in lowered
    for fixture_term in ("gitlab", "build_job", "cursor", "description", "zip"):
        assert fixture_term not in lowered


def test_multiview_analysis_final_barrier_requires_one_unified_per_frame_result(
    client, monkeypatch
):
    captured: dict = {}

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": [
                "data:image/jpeg;base64,previous-1",
                "data:image/jpeg;base64,previous-2",
            ],
            "prior_solution_summary": "Первичный анализ предыдущих кадров.",
            "question": "Продолжи анализ после прокрутки и найди дефекты.",
        },
    )

    assert response.status_code == 200, response.text
    content = captured["content"]
    assert content[-2]["type"] == "image_url"
    assert content[-1]["type"] == "text"
    final_text = content[-1]["text"].casefold()
    assert "analysis/list/find-defect task" in final_text
    assert "only the current/new delta is invalid" in final_text
    assert "at least one supported finding from each retained previous frame" in final_text
    assert "at least one supported finding from the current frame" in final_text
    assert "one unified list" in final_text
    for fixture_term in ("gitlab", "build_job", "regression_test_job", "post_cleanup_job"):
        assert fixture_term not in final_text


def test_multiview_code_change_does_not_force_an_analysis_findings_list(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": ["data:image/jpeg;base64,previous"],
            "question": "Добавь параметр в функцию и верни полный код.",
            "context": "Ранее интервьюер просил найти дефекты и перечислить проблемы.",
        },
    )

    assert response.status_code == 200, response.text
    final_text = captured["content"][-1]["text"].casefold()
    assert "analysis/list/find-defect task" not in final_text


def test_latest_screen_correction_is_bounded_before_both_provider_insertions(client, monkeypatch):
    captured: dict = {}
    correction = "уточнение-" * 2_000

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "prior_solution_summary": "Диагностический черновик.",
            "question": correction,
        },
    )

    assert response.status_code == 200, response.text
    provider_text = "\n".join(
        part["text"] for part in captured["content"] if part.get("type") == "text"
    )
    limit = chat_router.SCREEN_LATEST_CORRECTION_CONTEXT_CHARS
    bounded = correction[:limit]
    assert correction not in provider_text
    assert provider_text.count(bounded) == 2


def test_previous_frames_add_generic_multi_viewport_synthesis_contract_at_provider_boundary(
    client, monkeypatch
):
    captured: dict = {}
    expected_contract = (
        "MULTI-VIEWPORT SYNTHESIS CONTRACT: When the task spans scrolled or multiple "
        "viewports, retain and synthesize every non-conflicting finding from all previous "
        "viewport frames and the prior solution context. Never drop a valid earlier finding "
        "only because it is absent from the current viewport. The current viewport overrides "
        "prior context only where an actual conflict exists. The latest interviewer correction "
        "remains authoritative."
    )

    async def fake_stream(messages, *args, **kwargs):
        captured["messages"] = messages
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": ["data:image/jpeg;base64,previous"],
            "prior_solution_summary": "An earlier non-conflicting finding.",
            "question": "Continue the review after scrolling.",
        },
    )

    assert response.status_code == 200, response.text
    provider_prompt = captured["messages"][-1]["content"][0]["text"]
    assert expected_contract in provider_prompt
    lowered_prompt = provider_prompt.casefold()
    for fixture_text in ("gitlab", "build_job", "echo build", "реальная сборка"):
        assert fixture_text not in lowered_prompt


def test_multi_viewport_synthesis_contract_is_absent_without_previous_frames(client, monkeypatch):
    captured: dict = {}

    async def fake_stream(messages, *args, **kwargs):
        captured["messages"] = messages
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "prior_solution_summary": "A prior answer without a retained viewport.",
            "question": "Review the current screen.",
        },
    )

    assert response.status_code == 200, response.text
    provider_prompt = captured["messages"][-1]["content"][0]["text"]
    assert "MULTI-VIEWPORT SYNTHESIS CONTRACT" not in provider_prompt


def test_latest_simplification_correction_discards_unneeded_prior_scaffolding(client, monkeypatch):
    captured: dict = {}
    contract = _scenario("simple-order-sql-refinement")

    async def fake_stream(messages, *args, **kwargs):
        captured["prompt"] = f"{messages[0]['content']}\n{messages[-1]['content'][0]['text']}"
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "prior_solution_summary": (
                "cursor = conn.cursor()\ntry:\n    cursor.execute(query, params)\n"
                "finally:\n    cursor.close()"
            ),
            "question": contract["questions"][1],
        },
    )

    assert response.status_code == 200, response.text
    prompt = captured["prompt"].casefold()
    assert "упрости всё решение целиком" in prompt
    assert "не сохраняй ненужные обёртки" in prompt
    assert "сохрани только публичный интерфейс" in prompt
    assert "обязательную семантику результата" in prompt
    assert "не шаблон для копирования" in prompt
    assert 'select * from "order"' not in prompt
    assert "conn.execute" not in prompt


def test_latest_simplification_omits_prior_answer_body_after_preservation_context(
    client, monkeypatch
):
    captured: dict = {}
    prior_marker = "UNIQUE_PRIOR_IMPLEMENTATION_MARKER"

    async def fake_stream(messages, *args, **kwargs):
        captured["provider_user_prompt"] = messages[-1]["content"][0]["text"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "prior_solution_summary": prior_marker,
            "question": "Сделай решение проще и оставь только обязательное.",
            "context": "Сохрани рабочие части предыдущего решения.",
        },
    )

    assert response.status_code == 200, response.text
    lowered = captured["provider_user_prompt"].casefold()
    assert prior_marker.casefold() not in lowered
    assert "prior solution summary omitted by refinement policy" in lowered
    assert "preserve unchanged code" not in lowered
    assert "generic preservation instructions" in lowered
    assert "сохрани только публичный интерфейс" in lowered
    assert "обязательную семантику результата" in lowered
    assert lowered.rfind("generic preservation instructions") > lowered.find(
        "сохрани рабочие части"
    )
    for fixture_term in ("gitlab", "build_job", "cursor", "description", "zip"):
        assert fixture_term not in lowered


@pytest.mark.parametrize(
    "correction",
    [
        "Переработай решение целиком и убери лишние слои.",
        "Решение слишком сложное; оставь только обязательное.",
        "Rewrite the solution and remove unnecessary wrappers.",
        "This implementation is too complicated; keep only the required behavior.",
    ],
)
def test_explicit_rework_requests_omit_prior_solution_body(client, monkeypatch, correction: str):
    captured: dict = {}
    prior_marker = "UNIQUE_PRIOR_BODY_MARKER"

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": ["data:image/jpeg;base64,previous"],
            "prior_solution_summary": prior_marker,
            "question": correction,
            "context": "Preserve all working parts from the previous answer.",
        },
    )

    assert response.status_code == 200, response.text
    content = captured["content"]
    provider_text = "\n".join(part["text"] for part in content if part.get("type") == "text")
    assert prior_marker not in provider_text
    assert "PRIOR SOLUTION SUMMARY OMITTED BY REFINEMENT POLICY" in provider_text
    assert content[-2]["type"] == "image_url"
    assert correction in content[-1]["text"]
    assert "overrides any generic request to preserve working parts" in content[-1]["text"]


def test_non_rework_follow_up_still_carries_prior_solution_body(client, monkeypatch):
    captured: dict = {}
    prior_marker = "UNIQUE_NON_REWORK_PRIOR_MARKER"

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "previous_images": ["data:image/jpeg;base64,previous"],
            "prior_solution_summary": prior_marker,
            "question": "Продолжи анализ и учти новый кадр.",
        },
    )

    assert response.status_code == 200, response.text
    provider_text = "\n".join(
        part["text"] for part in captured["content"] if part.get("type") == "text"
    )
    assert prior_marker in provider_text
    assert "PRIOR SOLUTION SUMMARY OMITTED BY REFINEMENT POLICY" not in provider_text


def test_question_comparing_what_is_simpler_does_not_discard_prior_solution(client, monkeypatch):
    captured: dict = {}
    prior_marker = "UNIQUE_COMPARISON_PRIOR_MARKER"

    async def fake_stream(messages, *args, **kwargs):
        captured["content"] = messages[-1]["content"]
        yield "updated"

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,current",
            "prior_solution_summary": prior_marker,
            "question": "Что проще объяснить: первый вариант или второй?",
        },
    )

    assert response.status_code == 200, response.text
    provider_text = "\n".join(
        part["text"] for part in captured["content"] if part.get("type") == "text"
    )
    assert prior_marker in provider_text
    assert "PRIOR SOLUTION SUMMARY OMITTED BY REFINEMENT POLICY" not in provider_text


def test_truncated_provider_output_is_chunk_error_never_done(client, monkeypatch):
    contract = _scenario("truncated-code-stream")

    async def truncated(*args, **kwargs):
        yield contract["providerText"]
        raise AppError("Неполное решение.", 502, "provider_output_truncated")

    monkeypatch.setattr(provider_adapter, "stream_chat", truncated)
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Solve"},
    )

    assert response.status_code == 200, response.text
    events = _events(response)
    assert [event["type"] for event in events] == contract["expectedSseTypes"]
    assert not any(event["type"] in contract["forbiddenSseTypes"] for event in events)
    assert events[0]["text"] == contract["providerText"]


def test_screen_error_keeps_message_and_exposes_only_allowlisted_diagnostics(client, monkeypatch):
    async def rejected(*_args, **_kwargs):
        raise AppError("Retry later", 429, "rate_limited")
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", rejected)
    monkeypatch.setattr(
        chat_router,
        "_resolve_chat",
        lambda *_args, **_kwargs: ("test-provider", "openai/gpt-4o-mini", "configured"),
    )
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Solve"},
    )

    error = _events(response)[0]
    assert error == {
        "type": "error",
        "message": "Превышен лимит запросов. Подождите и повторите.",
        "code": "rate_limited",
        "status": 429,
        "model": "openai/gpt-4o-mini",
    }


def test_screen_unknown_exception_does_not_leak_attributes(client, monkeypatch):
    class UnsafeError(RuntimeError):
        message = "C:/Users/private/response.json"
        code = "provider_error"
        status_code = 418

    async def broken(*_args, **_kwargs):
        raise UnsafeError("PRIVATE BODY")
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", broken)
    monkeypatch.setattr(
        chat_router,
        "_resolve_chat",
        lambda *_args, **_kwargs: ("test-provider", "openai/gpt-4o-mini", "configured"),
    )
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Solve"},
    )

    error = _events(response)[0]
    assert error == {
        "type": "error",
        "message": "Internal server error",
        "code": "internal_error",
        "status": 500,
        "model": "openai/gpt-4o-mini",
    }


def test_screen_allowlisted_provider_code_never_leaks_its_message(client, monkeypatch):
    async def broken(*_args, **_kwargs):
        raise AppError("C:/Users/private/token=PRIVATE", 502, "provider_error")
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", broken)
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Solve"},
    )

    error = _events(response)[0]
    assert error["code"] == "provider_error"
    assert error["message"] == "Провайдер вернул ошибку. Повторите запрос позже."
    assert "private" not in response.text.casefold()


def test_screen_error_normalizes_an_unsafe_selected_model(client, monkeypatch):
    async def rejected(*_args, **_kwargs):
        raise AppError("Retry later", 429, "rate_limited")
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", rejected)
    monkeypatch.setattr(
        chat_router,
        "_resolve_chat",
        lambda *_args, **_kwargs: ("test-provider", "C:/Users/private/model", "configured"),
    )
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Solve"},
    )

    assert _events(response)[0]["model"] == "unknown"
    assert "private" not in response.text.casefold()


@pytest.mark.parametrize(
    ("gateway_code", "expected_code", "expected_status", "expected_message"),
    [
        (
            "token_quota_exceeded",
            "quota_exceeded",
            402,
            "Недостаточно кредитов провайдера. Пополните баланс.",
        ),
        ("invalid_license", "auth_failed", 401, "Неверный API key. Проверьте ключ в настройках."),
        (
            "model_not_allowed",
            "model_unavailable",
            403,
            "Выбранная модель недоступна. Выберите другую или Auto Select.",
        ),
        (
            "gateway_unconfigured",
            "provider_error",
            503,
            "Провайдер вернул ошибку. Повторите запрос позже.",
        ),
    ],
)
def test_screen_gateway_error_normalizes_to_safe_public_diagnostics(
    client,
    monkeypatch,
    gateway_code: str,
    expected_code: str,
    expected_status: int,
    expected_message: str,
):
    async def rejected(*_args, **_kwargs):
        raise AppError("C:/Users/private/gateway-body", 418, gateway_code)
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "stream_chat", rejected)
    monkeypatch.setattr(
        chat_router,
        "_resolve_chat",
        lambda *_args, **_kwargs: ("test-provider", "safe/model", "configured"),
    )
    response = client.post(
        "/chat/screen/stream",
        json={"image": "data:image/jpeg;base64,QUJD", "question": "Solve"},
    )

    assert _events(response)[0] == {
        "type": "error",
        "message": expected_message,
        "code": expected_code,
        "status": expected_status,
        "model": "safe/model",
    }
    assert "private" not in response.text.casefold()


def test_true_live_correction_uses_one_provider_call_and_unrelated_topic_omits_task(
    client, monkeypatch
):
    captured: list[list[dict]] = []

    async def fake_stream(messages, *args, **kwargs):
        captured.append(messages)
        yield "answer"

    async def forbidden_complete(*args, **kwargs):
        raise AssertionError("active screen context must not add a resolver call")

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    monkeypatch.setattr(provider_adapter, "complete", forbidden_complete)
    active_task = {
        "root_question": "Реализуй LRU cache.",
        "current_question": "Добавь eviction.",
        "latest_answer": "class LruCache: ...",
        "updated_at_ms": 1_777_777,
    }

    correction = client.post(
        "/chat/interview/stream",
        json={
            "question": "Теперь добавь TTL.",
            "fast_answer": True,
            "active_screen_task": active_task,
        },
    )
    unrelated = client.post(
        "/chat/interview/stream",
        json={"question": "Что такое DNS?", "fast_answer": True},
    )

    assert correction.status_code == unrelated.status_code == 200
    assert len(captured) == 2
    correction_prompt = captured[0][-1]["content"]
    unrelated_prompt = captured[1][-1]["content"]
    assert "ACTIVE SCREEN TASK" in correction_prompt
    assert "Реализуй LRU cache." in correction_prompt
    assert "ACTIVE SCREEN TASK" not in unrelated_prompt
    assert "Реализуй LRU cache." not in unrelated_prompt


def test_legacy_screen_path_still_streams_without_complete(client, monkeypatch) -> None:
    async def fake_stream(*_args, **_kwargs):
        yield "legacy-answer"

    async def forbidden_complete(*_args, **_kwargs):
        raise AssertionError("legacy screen path must not use complete")

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    monkeypatch.setattr(provider_adapter, "complete", forbidden_complete)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,bGVnYWN5",
            "question": "Read screen",
            "structured_screen": False,
        },
    )

    assert response.status_code == 200, response.text
    assert [event["type"] for event in _events(response)] == ["chunk", "done"]
    assert _events(response)[0]["text"] == "legacy-answer"


def test_structured_analysis_merges_every_frame_and_commits_pixel_free_state(
    client, monkeypatch
) -> None:
    images = (
        "data:image/jpeg;base64,cHJpb3I=",
        "data:image/jpeg;base64,Y3VycmVudA==",
    )
    responses = iter(
        [
            _structured_observation(
                task_kind="find_defect",
                visible_text="Первый фрагмент",
                claim="Первый подтверждённый дефект",
                evidence="Доказательство на первом фрагменте",
            ),
            _structured_observation(
                task_kind="find_defect",
                visible_text="Второй фрагмент",
                claim="Второй подтверждённый дефект",
                evidence="Доказательство на втором фрагменте",
            ),
            _structured_analysis_draft(
                images,
                "Первый подтверждённый дефект",
                "Второй подтверждённый дефект",
            ),
        ]
    )

    async def fake_complete(*_args, **_kwargs):
        await asyncio.sleep(0.02)
        return next(responses)

    async def forbidden_stream(*_args, **_kwargs):
        raise AssertionError("structured screen path must not use stream_chat")
        yield "unreachable"

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    monkeypatch.setattr(provider_adapter, "stream_chat", forbidden_stream)
    monkeypatch.setattr(chat_router, "SCREEN_STREAM_KEEPALIVE_SECONDS", 0.005)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": images[1],
            "previous_images": [images[0]],
            "question": "Найди все дефекты.",
            "prior_solution_summary": "Черновик упомянул только второй дефект.",
            "structured_screen": True,
            "taskAction": "new",
        },
    )

    assert response.status_code == 200, response.text
    assert ": keepalive" in response.text
    events = _events(response)
    assert [event["type"] for event in events] == ["chunk", "done"]
    assert "Первый подтверждённый дефект" in events[0]["text"]
    assert "Второй подтверждённый дефект" in events[0]["text"]
    serialized = events[1]["task_state"]
    assert "data:image" not in serialized
    assert "cHJpb3I=" not in serialized
    assert "Y3VycmVudA==" not in serialized
    assert len(json.loads(serialized)["ledger"]) == 2


def test_structured_sql_code_repairs_overcomplex_draft_before_done(client, monkeypatch) -> None:
    overcomplex = """Сначала выполню запрос.

```python
def helper(value):
    # Добавляю лишний слой.
    return value
    # Возвращаю значение.
def load(conn, order_id):
    # Принимаю параметры.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно.
    return helper(rows.fetchall())
    # Возвращаю строки через лишний слой.
```"""
    repaired = """Сначала выполню один параметризованный запрос и верну строки.

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
            _structured_observation(
                task_kind="code",
                correction_mode="refine",
                visible_text=(
                    "def load(conn, order_id):\n"
                    "Нужен один параметризованный SELECT из orders по order_id."
                ),
                claim="Сохранить сигнатуру load",
                evidence="На экране видна def load(conn, order_id):",
                finding_kind="requirement",
                response_kind="code_solution",
                code_language="python",
                required_python_signatures=("def load(conn, order_id):",),
                required_sql_identifiers=("orders", "id"),
                required_sql_clauses=("select", "from", "where"),
                required_sql_bound_ids=("order_id",),
            ),
            overcomplex,
            repaired,
        ]
    )
    captured: list[list[dict]] = []

    async def fake_complete(messages, *_args, **_kwargs):
        captured.append(messages)
        return next(responses)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,Y29kZQ==",
            "question": "Упрости решение и убери лишний слой.",
            "prior_solution_summary": "RAW-PRIOR-MUST-NOT-REACH-GENERATION",
            "structured_screen": True,
            "taskAction": "new",
        },
    )

    events = _events(response)
    assert [event["type"] for event in events] == ["chunk", "done"]
    assert events[0]["text"] == repaired
    assert "extra_top_level_layer" in captured[2][-1]["content"]
    assert "RAW-PRIOR-MUST-NOT-REACH-GENERATION" not in captured[1][-1]["content"]


def test_structured_typed_order_answer_satisfies_product_validator_and_acceptance_scorer(
    client,
    monkeypatch,
) -> None:
    responses = iter(
        [
            _structured_observation(
                task_kind="code",
                visible_text=(
                    "def get_order(conn, order_id: int) -> list[dict[str, Any]]:\n"
                    'SELECT * FROM "Order" WHERE id = ?'
                ),
                claim="Сохранить типизированную сигнатуру и выполнить один SELECT",
                evidence="На экране видны сигнатура и запрос по order_id",
                finding_kind="requirement",
                response_kind="code_solution",
                code_language="python",
                expected_sql_statement_kind="select",
                required_python_signatures=(
                    "def get_order(conn, order_id: int) -> list[dict[str, Any]]:",
                ),
                required_sql_identifiers=("Order", "id"),
                required_sql_clauses=("select", "from", "where"),
                required_sql_bound_ids=("order_id",),
            ),
        ]
    )
    calls = 0

    async def fake_complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,Y29kZQ==",
            "question": "Реши задачу с точной типизированной сигнатурой.",
            "structured_screen": True,
            "taskAction": "new",
        },
    )

    events = _events(response)
    assert [event["type"] for event in events] == ["chunk", "done"]
    assert calls == 1
    generated_answer = events[0]["text"]
    assert "from typing import Any" in generated_answer

    root_tools = Path(__file__).resolve().parents[3] / "tools"
    sys.path.insert(0, str(root_tools))
    try:
        scorer = importlib.import_module("verify_screen_code_task")
    finally:
        sys.path.pop(0)
    assert scorer.score_simple_order_sql_answer(generated_answer)["passed"] is True


def test_structured_second_invalid_code_answer_emits_error_without_done_or_state(
    client, monkeypatch
) -> None:
    invalid = """Объясню решение.

```python
def wrong(value):
    return value
```"""
    responses = iter(
        [
            _structured_observation(
                task_kind="code",
                visible_text="def load(conn, order_id):",
                claim="Сохранить сигнатуру",
                evidence="На экране видна def load(conn, order_id):",
                finding_kind="requirement",
                response_kind="code_solution",
                code_language="python",
                required_python_signatures=("def load(conn, order_id):",),
                required_sql_bound_ids=("order_id",),
            ),
            invalid,
            invalid,
        ]
    )

    async def fake_complete(*_args, **_kwargs):
        return next(responses)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,Y29kZQ==",
            "question": "Реши задачу.",
            "structured_screen": True,
            "taskAction": "new",
        },
    )

    events = _events(response)
    assert [event["type"] for event in events] == ["error"]
    assert events[0]["code"] == "invalid_screen_answer"
    assert "task_state" not in events[0]
    assert "wrong" not in response.text


@pytest.mark.parametrize(
    ("contract_fields", "expected_code"),
    [
        ({}, "invalid_screen_task_action"),
        (
            {"taskAction": "new", "taskState": _expired_structured_state()},
            "invalid_screen_task_action",
        ),
        ({"taskAction": "continue"}, "invalid_screen_task_action"),
        (
            {"taskAction": "continue", "taskState": _expired_structured_state()},
            "screen_task_state_expired",
        ),
    ],
)
def test_structured_task_action_errors_are_stable_and_never_call_provider_or_emit_done(
    client,
    monkeypatch,
    contract_fields: dict,
    expected_code: str,
) -> None:
    calls = 0

    async def forbidden_complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("provider must not run for an invalid task action")

    monkeypatch.setattr(provider_adapter, "complete", forbidden_complete)
    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,Y3VycmVudA==",
            "question": "Продолжи задачу.",
            "structuredScreen": True,
            **contract_fields,
        },
    )

    assert response.status_code == 200, response.text
    events = _events(response)
    assert [event["type"] for event in events] == ["error"]
    assert events[0]["code"] == expected_code
    assert events[0]["status"] == 422
    assert "task_state" not in events[0]
    assert calls == 0
