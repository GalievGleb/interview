import asyncio
import json

import pytest

from app.services.stt import openai_mini_stream as stream_module
from app.services.stt.base import TranscriptResult
from app.services.stt.openai_mini_stream import run_openai_mini_stream
from app.services.stt.openai_transcribe import MINI_MODEL


class _Clock:
    def __init__(self) -> None:
        self.monotonic_seconds = 100.0
        self.epoch_ms = 1_800_000_000_000

    def monotonic(self) -> float:
        return self.monotonic_seconds

    def time(self) -> float:
        return self.epoch_ms / 1000

    def advance(self, seconds: float) -> None:
        self.monotonic_seconds += seconds
        self.epoch_ms += round(seconds * 1000)


class _WebSocketTransport:
    def __init__(self) -> None:
        self.incoming: asyncio.Queue[dict] = asyncio.Queue()
        self.sent: list[dict] = []
        self.received_count = 0
        self._received = asyncio.Condition()

    async def receive(self) -> dict:
        message = await self.incoming.get()
        async with self._received:
            self.received_count += 1
            self._received.notify_all()
        return message

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def wait_until_received(self, count: int) -> None:
        async with self._received:
            await asyncio.wait_for(
                self._received.wait_for(lambda: self.received_count >= count),
                timeout=1,
            )


class _BlockedManagedProvider:
    def __init__(self) -> None:
        self.starts = 0
        self.first_started = asyncio.Event()
        self.release_first = asyncio.Event()

    def is_available(self) -> bool:
        return True

    async def prepare_async(self) -> None:
        return None

    def _active_model(self) -> str:
        return MINI_MODEL

    async def transcribe_audio_file(self, _audio: bytes, **_kwargs) -> TranscriptResult:
        self.starts += 1
        call_number = self.starts
        if call_number == 1:
            self.first_started.set()
            await self.release_first.wait()
            text = "Как устроена очередь распознавания речи?"
        else:
            text = "Hücum"
        return TranscriptResult(
            text=text,
            latency_ms=50,
            provider_id="openai-gpt-4o-mini-transcribe",
            model=MINI_MODEL,
        )


async def _put_vad_turn(transport: _WebSocketTransport) -> None:
    voice_300_ms = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
    silence_100_ms = b"\0\0" * 1600
    await transport.incoming.put({"type": "websocket.receive", "bytes": voice_300_ms})
    for _ in range(5):
        await transport.incoming.put({"type": "websocket.receive", "bytes": silence_100_ms})


async def _wait_for_event(
    transport: _WebSocketTransport,
    event_type: str,
    *,
    count: int = 1,
) -> list[dict]:
    async def find() -> list[dict]:
        while True:
            events = [event for event in transport.sent if event.get("type") == event_type]
            if len(events) >= count:
                return events
            await asyncio.sleep(0)

    return await asyncio.wait_for(find(), timeout=1)


@pytest.mark.asyncio
async def test_adversarial_session_bounds_stt_force_and_stop(monkeypatch: pytest.MonkeyPatch):
    """A blocked gateway may own one active and one coalesced forced pending turn only."""
    clock = _Clock()
    monkeypatch.setattr(stream_module.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(stream_module.time, "time", clock.time)
    transport = _WebSocketTransport()
    provider = _BlockedManagedProvider()

    await _put_vad_turn(transport)
    stream = asyncio.create_task(run_openai_mini_stream(transport, provider=provider))
    await asyncio.wait_for(provider.first_started.wait(), timeout=1)

    for _ in range(3):
        clock.advance(0.1)
        await _put_vad_turn(transport)
    await transport.wait_until_received(24)
    await transport.incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-screen-1"}),
        }
    )
    await transport.wait_until_received(25)
    await asyncio.sleep(0)

    # Four VAD turns plus Ctrl+Enter cannot start a second provider while the first is blocked.
    assert provider.starts == 1

    clock.advance(21)
    provider.release_first.set()
    forced_final = (await _wait_for_event(transport, "transcript", count=2))[1]
    assert provider.starts == 2
    assert forced_final["text"] == "Hücum"
    assert forced_final["force_request_id"] == "force-screen-1"
    assert forced_final["queueDepth"] == 1
    assert forced_final["queueWaitMs"] >= 21_000
    assert forced_final["captured_at_ms"] == 1_800_000_000_300

    # Stop is authoritative even if more complete VAD turns are already waiting behind it.
    await transport.incoming.put({"type": "websocket.disconnect"})
    await _put_vad_turn(transport)
    await asyncio.wait_for(stream, timeout=1)
    starts_at_stop = provider.starts
    await asyncio.sleep(0)
    assert starts_at_stop == 2
    assert provider.starts == starts_at_stop


@pytest.mark.asyncio
async def test_forced_coalesced_turn_keeps_oldest_pcm_capture_time(
    monkeypatch: pytest.MonkeyPatch,
):
    """New audio cannot make old PCM look fresh to the desktop freshness gate."""
    clock = _Clock()
    monkeypatch.setattr(stream_module.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(stream_module.time, "time", clock.time)
    transport = _WebSocketTransport()
    provider = _BlockedManagedProvider()

    await _put_vad_turn(transport)
    stream = asyncio.create_task(run_openai_mini_stream(transport, provider=provider))
    await asyncio.wait_for(provider.first_started.wait(), timeout=1)

    clock.advance(0.1)
    await _put_vad_turn(transport)
    await transport.wait_until_received(12)
    oldest_pending_capture_ms = 1_800_000_000_100

    clock.advance(21)
    await _put_vad_turn(transport)
    await transport.wait_until_received(18)
    await transport.incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-stale-pcm"}),
        }
    )
    await transport.wait_until_received(19)
    assert provider.starts == 1

    provider.release_first.set()
    forced_final = (await _wait_for_event(transport, "transcript", count=2))[1]
    await transport.incoming.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(stream, timeout=1)

    assert forced_final["force_request_id"] == "force-stale-pcm"
    assert forced_final["queueDepth"] == 1
    assert forced_final["queueWaitMs"] >= 21_000
    assert forced_final["captured_at_ms"] == oldest_pending_capture_ms
