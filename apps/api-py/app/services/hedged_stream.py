"""Select the first responsive stream while preserving the quality-first primary."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from dataclasses import dataclass

StreamFactory = Callable[[str], AsyncIterator[str]]


@dataclass(slots=True)
class HedgedStreamSelection:
    """A stream whose first non-empty chunk has already been consumed."""

    model: str
    first_chunk: str
    remainder: AsyncIterator[str]
    hedge_started: bool
    primary_failed: bool = False


class _EmptyStreamError(RuntimeError):
    pass


async def _first_nonempty(stream: AsyncIterator[str]) -> str:
    async for chunk in stream:
        if chunk:
            return chunk
    raise _EmptyStreamError("provider stream ended before the first chunk")


async def _close_stream(stream: AsyncIterator[str]) -> None:
    close = getattr(stream, "aclose", None)
    if callable(close):
        with suppress(Exception):
            await close()


async def _stop_loser(task: asyncio.Task[str], stream: AsyncIterator[str]) -> None:
    if not task.done():
        task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await _close_stream(stream)


async def select_first_stream(
    *,
    model: str,
    stream_factory: StreamFactory,
) -> HedgedStreamSelection:
    stream = stream_factory(model)
    try:
        first = await _first_nonempty(stream)
    except Exception:
        await _close_stream(stream)
        raise
    return HedgedStreamSelection(
        model=model,
        first_chunk=first,
        remainder=stream,
        hedge_started=False,
    )


async def select_hedged_stream(
    *,
    primary_model: str,
    fallback_model: str,
    stream_factory: StreamFactory,
    hedge_after_seconds: float,
) -> HedgedStreamSelection:
    """Return the first stream to produce content.

    The fallback is not opened while the primary responds within the latency
    budget. Once the hedge starts both streams race; the loser is cancelled and
    closed so its HTTP response cannot keep consuming tokens in the background.
    """

    primary_stream = stream_factory(primary_model)
    primary_task = asyncio.create_task(_first_nonempty(primary_stream))
    fallback_stream: AsyncIterator[str] | None = None
    fallback_task: asyncio.Task[str] | None = None
    primary_error: Exception | None = None

    try:
        done, _ = await asyncio.wait(
            {primary_task},
            timeout=max(0.0, hedge_after_seconds),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if primary_task in done:
            try:
                first = primary_task.result()
            except Exception as exc:  # provider failed before producing content
                primary_error = exc
                await _close_stream(primary_stream)
            else:
                return HedgedStreamSelection(
                    model=primary_model,
                    first_chunk=first,
                    remainder=primary_stream,
                    hedge_started=False,
                )

        fallback_stream = stream_factory(fallback_model)
        fallback_task = asyncio.create_task(_first_nonempty(fallback_stream))
        candidates: dict[asyncio.Task[str], tuple[str, AsyncIterator[str]]] = {
            fallback_task: (fallback_model, fallback_stream),
        }
        if not primary_task.done():
            candidates[primary_task] = (primary_model, primary_stream)

        errors: dict[str, Exception] = {}
        if primary_error is not None:
            errors[primary_model] = primary_error

        while candidates:
            ready, _ = await asyncio.wait(candidates, return_when=asyncio.FIRST_COMPLETED)
            # Prefer the quality-first primary if both became ready in the same
            # event-loop turn.
            ordered = sorted(
                ready,
                key=lambda task: 0 if candidates[task][0] == primary_model else 1,
            )
            for winner_task in ordered:
                winner_model, winner_stream = candidates.pop(winner_task)
                try:
                    first = winner_task.result()
                except Exception as exc:
                    errors[winner_model] = exc
                    await _close_stream(winner_stream)
                    continue

                for loser_task, (_, loser_stream) in list(candidates.items()):
                    await _stop_loser(loser_task, loser_stream)
                return HedgedStreamSelection(
                    model=winner_model,
                    first_chunk=first,
                    remainder=winner_stream,
                    hedge_started=True,
                    primary_failed=primary_model in errors,
                )

        if primary_model in errors:
            raise errors[primary_model]
        raise next(iter(errors.values()))
    except asyncio.CancelledError:
        await _stop_loser(primary_task, primary_stream)
        if fallback_task is not None and fallback_stream is not None:
            await _stop_loser(fallback_task, fallback_stream)
        raise
