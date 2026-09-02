import asyncio
import json

import pytest

from app.db.models import ApiUsage
from app.routers import chat as chat_router
from app.services import provider_adapter
from app.services.screen_task_pipeline import (
    ScreenTaskPipelineError,
    ScreenTaskPipelineResult,
)
from app.services.screen_task_state import (
    FindingKind,
    FrameDigest,
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
    TaskKind,
    serialize_screen_task_state,
)


def _events(response) -> list[dict]:
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def _large_valid_cyrillic_state() -> str:
    digests = tuple(FrameDigest(sha256=f"{index + 1:064x}") for index in range(3))
    ledger = tuple(
        ScreenLedgerEntry(
            frame_digest=digests[index % len(digests)],
            finding=ScreenFinding(
                id=f"finding-{index}",
                claim=f"Подтверждённый вывод {index}: " + "я" * 700,
                evidence=f"Видимое доказательство {index}: " + "ю" * 1_000,
                kind=FindingKind.FACT,
            ),
        )
        for index in range(96)
    )
    sources = tuple(
        ScreenSourceEntry(
            frame_digest=digests[index % len(digests)],
            source=ScreenSourceFragment(
                id=f"source-{index}",
                text=f"Точный видимый фрагмент {index}: " + "э" * 3_000,
                kind=ScreenSourceKind.TASK_TEXT,
            ),
        )
        for index in range(32)
    )
    frames = tuple(
        ScreenFrame(
            digest=digest,
            captured_at_ms=(index + 1) * 1_000,
            visible_text="Видимый текст текущего окна: " + "ж" * 7_900,
        )
        for index, digest in enumerate(digests)
    )
    state = ScreenTaskState(
        task_kind=TaskKind.ANALYSIS,
        response_kind=ScreenResponseKind.ANALYSIS_FINDINGS,
        requirements=ScreenTaskRequirements(objective="Объединить все видимые выводы"),
        frames=frames,
        ledger=ledger,
        source_ledger=sources,
        ttl=ScreenTaskTtl(created_at_ms=1_000, updated_at_ms=1_000, expires_at_ms=61_000),
    )
    return serialize_screen_task_state(state)


@pytest.mark.parametrize(
    ("build_channel", "client_opt_in", "expected_path"),
    [
        ("alpha", True, "structured"),
        ("dev", True, "legacy"),
        ("dev", False, "legacy"),
        ("stable", True, "legacy"),
        ("production", True, "legacy"),
        ("", True, "legacy"),
    ],
)
def test_structured_screen_requires_both_alpha_channel_and_client_opt_in(
    client,
    monkeypatch,
    build_channel: str,
    client_opt_in: bool,
    expected_path: str,
) -> None:
    calls: list[str] = []

    async def fake_structured_stream(**_kwargs):
        calls.append("structured")
        yield 'data: {"type":"chunk","text":"typed"}\n\n'
        yield 'data: {"type":"done","task_state":"{}"}\n\n'

    async def fake_legacy_stream(*_args, **_kwargs):
        calls.append("legacy")
        yield "legacy"

    async def forbidden_complete(*_args, **_kwargs):
        raise AssertionError("the route stub must own the structured response")

    if build_channel:
        monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", build_channel)
    else:
        monkeypatch.delenv("SKILLCUE_BUILD_CHANNEL", raising=False)
    monkeypatch.setattr(chat_router, "_structured_screen_event_stream", fake_structured_stream)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_legacy_stream)
    monkeypatch.setattr(provider_adapter, "complete", forbidden_complete)

    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Read the visible task",
            "structuredScreen": client_opt_in,
            **({"taskAction": "new"} if client_opt_in else {}),
        },
    )

    assert response.status_code == 200, response.text
    assert calls == [expected_path]
    assert _events(response)[0]["text"] == ("typed" if expected_path == "structured" else "legacy")


def test_largest_normal_structured_continuation_reaches_the_dev_endpoint(
    client, monkeypatch
) -> None:
    calls = 0

    async def fake_structured_stream(**_kwargs):
        nonlocal calls
        calls += 1
        yield 'data: {"type":"chunk","text":"typed"}\n\n'
        yield 'data: {"type":"done","task_state":"{}"}\n\n'

    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "alpha")
    monkeypatch.setattr(chat_router, "_structured_screen_event_stream", fake_structured_stream)
    state = _large_valid_cyrillic_state()
    payload = {
        "image": "data:image/jpeg;base64," + "A" * (1_500_000 - 23),
        "previous_images": [
            "data:image/jpeg;base64," + "B" * (300_000 - 23),
            "data:image/jpeg;base64," + "C" * (300_000 - 23),
        ],
        "question": "Продолжи типизированную задачу",
        "structuredScreen": True,
        "taskAction": "continue",
        "taskState": state,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert len(body) > 2_200_000

    response = client.post(
        "/chat/screen/stream",
        content=body,
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 200, response.text
    assert calls == 1
    assert _events(response)[0]["text"] == "typed"


def test_structured_route_does_not_persist_a_preliminary_usage_estimate(
    client, db_session, monkeypatch
) -> None:
    async def fake_structured_stream(**_kwargs):
        yield 'data: {"type":"chunk","text":"typed"}\n\n'
        yield 'data: {"type":"done","task_state":"{}"}\n\n'

    monkeypatch.setenv("SKILLCUE_BUILD_CHANNEL", "alpha")
    monkeypatch.setattr(chat_router, "_structured_screen_event_stream", fake_structured_stream)

    response = client.post(
        "/chat/screen/stream",
        json={
            "image": "data:image/jpeg;base64,QUJD",
            "question": "Read the visible task",
            "structuredScreen": True,
            "taskAction": "new",
        },
    )

    assert response.status_code == 200, response.text
    assert db_session.query(ApiUsage).count() == 0


def test_structured_stream_persists_exact_sum_for_each_completed_pipeline_call(
    db_session, monkeypatch
) -> None:
    usages = iter(
        [
            ({"prompt_tokens": 10, "completion_tokens": 2}, "observation"),
            ({"prompt_tokens": 20, "completion_tokens": 3}, "answer"),
            ({"prompt_tokens": 30, "completion_tokens": 4}, "repair"),
        ]
    )

    async def fake_complete(messages, provider, model, **kwargs):
        usage, expected_phase = next(usages)
        assert kwargs["screen_workload_phase"] == expected_phase
        provider_adapter._last_usage.set(usage)
        return "result"

    async def fake_pipeline(*, complete, **_kwargs):
        for phase in ("observation", "answer", "repair"):
            await complete(
                [{"role": "user", "content": phase}],
                "openrouter",
                "openai/gpt-5.6-sol",
                screen_workload_phase=phase,
            )
        return ScreenTaskPipelineResult(answer="typed", serialized_task_state="{}")

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    monkeypatch.setattr(chat_router, "run_screen_task_pipeline", fake_pipeline)
    payload = chat_router.ScreenAssistPayload(
        image="data:image/jpeg;base64,QUJD",
        question="Read",
        structuredScreen=True,
        taskAction="new",
    )

    async def collect() -> list[str]:
        return [
            event
            async for event in chat_router._structured_screen_event_stream(
                payload=payload,
                image=payload.image,
                previous_images=[],
                provider="openrouter",
                model="openai/gpt-5.6-sol",
                model_source="explicit",
                max_tokens=3_200,
                reasoning={"effort": "medium"},
                db=db_session,
            )
        ]

    events = asyncio.run(collect())
    rows = db_session.query(ApiUsage).all()
    assert any('"type": "done"' in event for event in events)
    assert len(rows) == 1
    assert (rows[0].tokens_in, rows[0].tokens_out) == (60, 9)


def test_structured_stream_persists_completed_usage_before_pipeline_failure(
    db_session, monkeypatch
) -> None:
    async def fake_complete(messages, provider, model, **kwargs):
        provider_adapter._last_usage.set({"prompt_tokens": 12, "completion_tokens": 5})
        return "observation"

    async def fake_pipeline(*, complete, **_kwargs):
        await complete(
            [{"role": "user", "content": "observation"}],
            "openrouter",
            "openai/gpt-5.6-sol",
            screen_workload_phase="observation",
        )
        raise ScreenTaskPipelineError("invalid_screen_answer", "safe")

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    monkeypatch.setattr(chat_router, "run_screen_task_pipeline", fake_pipeline)
    payload = chat_router.ScreenAssistPayload(
        image="data:image/jpeg;base64,QUJD",
        question="Read",
        structuredScreen=True,
        taskAction="new",
    )

    async def collect() -> list[str]:
        return [
            event
            async for event in chat_router._structured_screen_event_stream(
                payload=payload,
                image=payload.image,
                previous_images=[],
                provider="openrouter",
                model="openai/gpt-5.6-sol",
                model_source="explicit",
                max_tokens=3_200,
                reasoning={"effort": "medium"},
                db=db_session,
            )
        ]

    events = asyncio.run(collect())
    rows = db_session.query(ApiUsage).all()
    assert any("invalid_screen_answer" in event for event in events)
    assert len(rows) == 1
    assert (rows[0].tokens_in, rows[0].tokens_out) == (12, 5)
