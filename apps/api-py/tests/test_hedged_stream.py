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


async def _wait_for_close_flag(closed: list[bool]) -> None:
    while not closed:
        await asyncio.sleep(0)


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
    await asyncio.wait_for(_wait_for_close_flag(primary_closed), timeout=0.2)
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
    await asyncio.wait_for(_wait_for_close_flag(fallback_closed), timeout=0.2)
    assert fallback_closed == [True]


async def test_winner_is_returned_before_slow_loser_close_finishes():
    """Slow transport teardown must not delay the already available first token."""

    class ControlledStream:
        def __init__(self, chunk: str, *, blocked: bool = False):
            self.chunk = chunk
            self.blocked = blocked
            self.sent = False
            self.read_started = asyncio.Event()
            self.cancelled = asyncio.Event()
            self.close_started = asyncio.Event()
            self.allow_close = asyncio.Event()
            self.closed = asyncio.Event()

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.sent:
                raise StopAsyncIteration
            self.read_started.set()
            try:
                if self.blocked:
                    await asyncio.Event().wait()
                else:
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
            self.sent = True
            return self.chunk

        async def aclose(self):
            self.close_started.set()
            await self.allow_close.wait()
            self.closed.set()

    primary = ControlledStream("первый токен")
    fallback = ControlledStream("не должен победить", blocked=True)

    selection_task = asyncio.create_task(
        select_hedged_stream(
            primary_model="primary",
            fallback_model="fallback",
            stream_factory=lambda model: primary if model == "primary" else fallback,
            hedge_after_seconds=0.001,
        )
    )
    try:
        await asyncio.wait_for(fallback.close_started.wait(), timeout=0.2)
        await asyncio.sleep(0)

        assert selection_task.done(), "winner waited for the loser's slow aclose()"
        selected = selection_task.result()
        assert selected.model == "primary"
        assert selected.first_chunk == "первый токен"
        assert fallback.cancelled.is_set()
        assert not fallback.closed.is_set()
    finally:
        fallback.allow_close.set()
        await asyncio.gather(selection_task, return_exceptions=True)
        await asyncio.wait_for(fallback.closed.wait(), timeout=0.2)


async def test_fallback_factory_error_waits_for_primary_cleanup():
    """An exception before the race is formed must not orphan the primary stream."""

    class ControlledPrimary:
        def __init__(self):
            self.read_started = asyncio.Event()
            self.cancelled = asyncio.Event()
            self.close_started = asyncio.Event()
            self.allow_close = asyncio.Event()
            self.closed = asyncio.Event()

        def __aiter__(self):
            return self

        async def __anext__(self):
            self.read_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                raise

        async def aclose(self):
            self.close_started.set()
            await self.allow_close.wait()
            self.closed.set()

    primary = ControlledPrimary()
    fallback_requested = asyncio.Event()

    def factory(model: str):
        if model == "primary":
            return primary
        fallback_requested.set()
        raise RuntimeError("fallback factory failed")

    selection_task = asyncio.create_task(
        select_hedged_stream(
            primary_model="primary",
            fallback_model="fallback",
            stream_factory=factory,
            hedge_after_seconds=0.001,
        )
    )
    outcome: object | None = None
    try:
        await fallback_requested.wait()
        await asyncio.wait_for(primary.close_started.wait(), timeout=0.2)

        assert primary.cancelled.is_set()
        assert not selection_task.done(), "factory error escaped before primary cleanup"
    finally:
        primary.allow_close.set()
        if not primary.close_started.is_set():
            await primary.aclose()
        outcome = (await asyncio.gather(selection_task, return_exceptions=True))[0]

    assert isinstance(outcome, RuntimeError)
    assert str(outcome) == "fallback factory failed"
    assert primary.closed.is_set()


async def test_parent_cancellation_waits_for_both_streams_to_close():
    """Cancellation keeps deterministic ownership of both opened transports."""

    class ControlledStream:
        def __init__(self):
            self.read_started = asyncio.Event()
            self.close_started = asyncio.Event()
            self.allow_close = asyncio.Event()
            self.closed = asyncio.Event()

        def __aiter__(self):
            return self

        async def __anext__(self):
            self.read_started.set()
            await asyncio.Event().wait()

        async def aclose(self):
            self.close_started.set()
            await self.allow_close.wait()
            self.closed.set()

    primary = ControlledStream()
    fallback = ControlledStream()
    streams = {"primary": primary, "fallback": fallback}
    selection_task = asyncio.create_task(
        select_hedged_stream(
            primary_model="primary",
            fallback_model="fallback",
            stream_factory=streams.__getitem__,
            hedge_after_seconds=0.001,
        )
    )

    await asyncio.wait_for(fallback.read_started.wait(), timeout=0.2)
    selection_task.cancel()
    try:
        await asyncio.wait_for(primary.close_started.wait(), timeout=0.2)
        assert not selection_task.done()
        primary.allow_close.set()
        await asyncio.wait_for(fallback.close_started.wait(), timeout=0.2)
        assert not selection_task.done()
    finally:
        primary.allow_close.set()
        fallback.allow_close.set()

    with pytest.raises(asyncio.CancelledError):
        await selection_task
    assert primary.closed.is_set()
    assert fallback.closed.is_set()


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
