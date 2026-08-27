"""First-token hedging for latency-sensitive live interview answers."""

import asyncio

import pytest

from app.services.hedged_stream import select_first_stream, select_hedged_stream


def _stream(chunks: list[str], *, first_delay: float = 0.0, closed: list[bool] | None = None):
    async def iterator():
        try:
            if first_delay:
                await asyncio.sleep(first_delay)
            for chunk in chunks:
                yield chunk
        finally:
            if closed is not None:
                closed.append(True)

    return iterator()


async def test_fast_primary_does_not_start_fallback():
    calls: list[str] = []

    def factory(model: str):
        calls.append(model)
        return _stream(["основной ", "ответ"])

    selected = await select_hedged_stream(
        primary_model="mini",
        fallback_model="nano",
        stream_factory=factory,
        hedge_after_seconds=0.05,
    )

    assert selected.model == "mini"
    assert selected.first_chunk == "основной "
    assert [chunk async for chunk in selected.remainder] == ["ответ"]
    assert calls == ["mini"]
    assert selected.hedge_started is False


async def test_faster_fallback_wins_and_closes_slow_primary():
    primary_closed: list[bool] = []

    def factory(model: str):
        if model == "mini":
            return _stream(["медленно"], first_delay=0.08, closed=primary_closed)
        return _stream(["быстро", " готово"], first_delay=0.001)

    selected = await select_hedged_stream(
        primary_model="mini",
        fallback_model="nano",
        stream_factory=factory,
        hedge_after_seconds=0.005,
    )

    assert selected.model == "nano"
    assert selected.first_chunk == "быстро"
    assert [chunk async for chunk in selected.remainder] == [" готово"]
    assert selected.hedge_started is True
    assert primary_closed == [True]


async def test_primary_can_still_win_after_hedge_started():
    fallback_closed: list[bool] = []

    def factory(model: str):
        if model == "mini":
            return _stream(["качественный"], first_delay=0.012)
        return _stream(["резерв"], first_delay=0.04, closed=fallback_closed)

    selected = await select_hedged_stream(
        primary_model="mini",
        fallback_model="nano",
        stream_factory=factory,
        hedge_after_seconds=0.005,
    )

    assert selected.model == "mini"
    assert selected.first_chunk == "качественный"
    assert selected.hedge_started is True
    assert fallback_closed == [True]


async def test_fallback_recovers_when_primary_fails_before_first_chunk():
    async def failing_stream():
        raise RuntimeError("primary unavailable")
        yield "unreachable"

    def factory(model: str):
        return failing_stream() if model == "mini" else _stream(["резерв"])

    selected = await select_hedged_stream(
        primary_model="mini",
        fallback_model="nano",
        stream_factory=factory,
        hedge_after_seconds=0.05,
    )

    assert selected.model == "nano"
    assert selected.first_chunk == "резерв"
    assert selected.hedge_started is True


async def test_raises_when_both_streams_fail_before_first_chunk():
    async def failing_stream(model: str):
        raise RuntimeError(model)
        yield "unreachable"

    with pytest.raises(RuntimeError, match="mini"):
        await select_hedged_stream(
            primary_model="mini",
            fallback_model="nano",
            stream_factory=failing_stream,
            hedge_after_seconds=0.001,
        )


async def test_select_first_stream_rejects_an_empty_provider_completion():
    with pytest.raises(RuntimeError, match="ended before the first chunk"):
        await select_first_stream(
            model="mini",
            stream_factory=lambda _model: _stream([]),
        )
