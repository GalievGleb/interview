import asyncio
import json
from types import SimpleNamespace

import numpy as np
import pytest

from app.config import Settings
from app.routers import stt as stt_router
from app.services.stt import openai_realtime_stream as realtime_stream
from app.services.stt.openai_realtime_stream import (
    Pcm16StreamResampler,
    run_openai_realtime_stream,
)


def test_realtime_is_the_default_after_real_audio_acceptance(monkeypatch):
    monkeypatch.delenv("SKILLCUE_REALTIME_STT", raising=False)
    assert Settings(_env_file=None).skillcue_realtime_stt is True


class _LocalWebSocket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.sent = []

    async def receive(self):
        return await self.messages.get()

    async def send_json(self, payload):
        self.sent.append(payload)


class _FakeGateway:
    def __init__(
        self, *, complete_on_commit: bool, complete_on_bind: bool = True,
        transcript: str = "Какие виды?",
    ):
        self.complete_on_commit = complete_on_commit
        self.complete_on_bind = complete_on_bind
        self.transcript = transcript
        self.incoming = asyncio.Queue()
        self.sent_audio = []
        self.sent_controls = []
        self._item = 0
        self._turn_by_item = {}
        self.connect_kwargs = None
        self.incoming.put_nowait(
            json.dumps(
                {
                    "type": "ready",
                    "engine": "openai-realtime",
                    "model": "gpt-4o-mini-transcribe",
                    "sample_rate": 24000,
                }
            )
        )

    def connect(self, _url, **kwargs):
        self.connect_kwargs = kwargs
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def recv(self):
        return await self.incoming.get()

    async def send(self, payload):
        if isinstance(payload, bytes):
            self.sent_audio.append(payload)
            return
        event = json.loads(payload)
        self.sent_controls.append(event)
        if event["type"] == "commit":
            self._item += 1
            item_id = f"item-{self._item}"
            turn_id = event["client_turn_id"]
            self._turn_by_item[item_id] = turn_id
            await self.incoming.put(
                json.dumps(
                    {
                        "type": "turn_committed",
                        "item_id": item_id,
                        "client_turn_id": turn_id,
                    }
                )
            )
            if self.complete_on_commit:
                await self.complete(item_id)
        elif event["type"] == "bind_force" and self.complete_on_bind:
            await self.complete("item-1", force_request_id=event["force_request_id"])

    async def complete(self, item_id, force_request_id=None):
        turn_id = self._turn_by_item[item_id]
        await self.incoming.put(
            json.dumps(
                {
                    "type": "transcript_delta",
                    "item_id": item_id,
                    "client_turn_id": turn_id,
                    "delta": "Какие ",
                }
            )
        )
        await self.incoming.put(
            json.dumps(
                {
                    "type": "transcript_completed",
                    "item_id": item_id,
                    "client_turn_id": turn_id,
                    "force_request_id": force_request_id,
                    "transcript": self.transcript,
                }
            )
        )


async def _wait_for_event(ws, event_type, timeout=1):
    async def _find():
        while True:
            match = next((event for event in ws.sent if event.get("type") == event_type), None)
            if match is not None:
                return match
            await asyncio.sleep(0)

    return await asyncio.wait_for(_find(), timeout=timeout)


def test_streaming_resampler_is_chunk_invariant_and_outputs_24khz():
    source = (np.sin(np.linspace(0, 40 * np.pi, 16000)) * 12000).astype(np.int16).tobytes()

    whole = Pcm16StreamResampler(16000, 24000).feed(source)
    chunked_resampler = Pcm16StreamResampler(16000, 24000)
    chunked = b"".join(
        chunked_resampler.feed(source[offset : offset + 640])
        for offset in range(0, len(source), 640)
    )

    assert chunked == whole
    assert 23998 <= len(whole) // 2 <= 24000


async def test_quiet_manual_question_is_streamed_then_completed_with_force_id():
    local = _LocalWebSocket()
    gateway = _FakeGateway(complete_on_commit=True)
    task = asyncio.create_task(
        run_openai_realtime_stream(
            local,
            language="ru",
            sample_rate=16000,
            gateway_url="https://skill-cue.ru",
            license_key="license-test",
            connect_factory=gateway.connect,
        )
    )
    ready = await _wait_for_event(local, "ready")
    assert ready["model"] == "gpt-4o-mini-transcribe"
    quiet_500ms = (100).to_bytes(2, "little", signed=True) * 8000
    await local.messages.put({"type": "websocket.receive", "bytes": quiet_500ms})
    await local.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-quiet"}),
        }
    )

    transcript = await _wait_for_event(local, "transcript")
    await local.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, timeout=1)

    assert gateway.sent_audio
    assert 11998 <= sum(map(len, gateway.sent_audio)) // 2 <= 12000
    assert gateway.sent_controls[0]["type"] == "commit"
    assert transcript["text"] == "Какие виды?"
    assert transcript["force_request_id"] == "force-quiet"
    assert any(event.get("type") == "utterance_end" for event in local.sent)
    assert gateway.connect_kwargs["additional_headers"] == {
        "Authorization": "Bearer license-test"
    }


async def test_ctrl_enter_binds_to_unresolved_automatic_turn_instead_of_returning_empty():
    local = _LocalWebSocket()
    gateway = _FakeGateway(complete_on_commit=False)
    task = asyncio.create_task(
        run_openai_realtime_stream(
            local,
            sample_rate=16000,
            gateway_url="https://skill-cue.ru/v1",
            license_key="license-test",
            connect_factory=gateway.connect,
        )
    )
    await _wait_for_event(local, "ready")
    voice_300ms = (1200).to_bytes(2, "little", signed=True) * 4800
    silence_100ms = b"\0\0" * 1600
    await local.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    for _ in range(7):
        await local.messages.put({"type": "websocket.receive", "bytes": silence_100ms})

    async def _auto_committed():
        while not any(event.get("type") == "commit" for event in gateway.sent_controls):
            await asyncio.sleep(0)

    await asyncio.wait_for(_auto_committed(), timeout=1)
    # The complete transition chunk plus 700 ms trailing silence reached OpenAI.
    assert 0.99 <= sum(map(len, gateway.sent_audio)) / (24000 * 2) <= 1.01
    await local.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-inflight"}),
        }
    )
    transcript = await _wait_for_event(local, "transcript")
    await local.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, timeout=1)

    assert [event["type"] for event in gateway.sent_controls] == ["commit", "bind_force"]
    assert transcript["force_request_id"] == "force-inflight"
    assert not any(event.get("type") == "force_empty" for event in local.sent)


async def _wait_for_controls(gateway, count):
    async def _wait():
        while len(gateway.sent_controls) < count:
            await asyncio.sleep(0)

    await asyncio.wait_for(_wait(), timeout=1)


async def _send_automatic_question_with_room_noise(local, gateway):
    await local.messages.put({"bytes": (1200).to_bytes(2, "little") * 4800})
    for _ in range(7):
        await local.messages.put({"bytes": (140).to_bytes(2, "little") * 1600})
    await _wait_for_controls(gateway, 1)


async def test_noise_tail_does_not_steal_force_from_current_automatic_question():
    """The real endpointer must not promote continuing room noise to a new turn."""
    local = _LocalWebSocket()
    gateway = _FakeGateway(
        complete_on_commit=False,
        transcript="Что вы делали с нестабильными автотестами в CI/CD пайплайне?",
    )
    task = asyncio.create_task(run_openai_realtime_stream(
        local, sample_rate=16000, gateway_url="https://skill-cue.ru/v1",
        license_key="license-test", connect_factory=gateway.connect,
    ))
    try:
        await _wait_for_event(local, "ready")
        await _send_automatic_question_with_room_noise(local, gateway)
        for amplitude in (140, 126, 136, 141, 167):
            await local.messages.put({"bytes": amplitude.to_bytes(2, "little") * 1600})
        await local.messages.put({"text": json.dumps({
            "type": "finalize", "request_id": "force-full-question",
        })})
        await _wait_for_controls(gateway, 2)

        assert [event["type"] for event in gateway.sent_controls] == ["commit", "bind_force"]
        transcript = await _wait_for_event(local, "transcript")
        assert transcript["text"] == "Что вы делали с нестабильными автотестами в CI/CD пайплайне?"
        assert transcript["force_request_id"] == "force-full-question"
        assert transcript["utterance_id"] == gateway.sent_controls[0]["client_turn_id"]
        assert not any(event["type"] in {"low_quality", "force_empty"} for event in local.sent)
    finally:
        await local.messages.put({"type": "websocket.disconnect"})
        await asyncio.wait_for(task, timeout=1)


@pytest.mark.parametrize("pause_ms, amplitude", [(100, 100), (0, 250), (0, 900)])
async def test_new_question_after_room_noise_gets_its_own_force_not_old_question(
    pause_ms, amplitude,
):
    """New quiet/loud speech must be kept, not retag the earlier in-flight turn."""
    local = _LocalWebSocket()
    gateway = _FakeGateway(complete_on_commit=False, complete_on_bind=False)
    task = asyncio.create_task(run_openai_realtime_stream(
        local, sample_rate=16000, gateway_url="https://skill-cue.ru/v1",
        license_key="license-test", connect_factory=gateway.connect,
    ))
    try:
        await _wait_for_event(local, "ready")
        await _send_automatic_question_with_room_noise(local, gateway)
        if pause_ms:
            await local.messages.put({"bytes": b"\0\0" * (16 * pause_ms)})
        await local.messages.put({"bytes": amplitude.to_bytes(2, "little") * 8000})
        await local.messages.put({"text": json.dumps({
            "type": "finalize", "request_id": "force-new-quiet",
        })})
        await _wait_for_controls(gateway, 2)
        assert [event["type"] for event in gateway.sent_controls] == ["commit", "commit"]
        await gateway.complete("item-2")
        transcript = await _wait_for_event(local, "transcript")
        assert transcript["force_request_id"] == "force-new-quiet"
        assert transcript["utterance_id"] == gateway.sent_controls[1]["client_turn_id"]
        # New speech plus the optional pause went to the upstream, too.
        expected_seconds = 1.5 + pause_ms / 1000
        assert abs(sum(map(len, gateway.sent_audio)) / (24000 * 2) - expected_seconds) < 0.01
        await gateway.complete("item-1")
        await _wait_for_event(local, "low_quality")
        owned = [event for event in local.sent if event.get("force_request_id") == "force-new-quiet"]
        assert {event["utterance_id"] for event in owned} == {transcript["utterance_id"]}
    finally:
        await local.messages.put({"type": "websocket.disconnect"})
        await asyncio.wait_for(task, timeout=1)


async def test_realtime_prompt_echo_is_rejected_instead_of_becoming_transcript():
    class _PromptEchoGateway(_FakeGateway):
        async def complete(self, item_id, force_request_id=None):
            turn_id = self._turn_by_item[item_id]
            await self.incoming.put(
                json.dumps(
                    {
                        "type": "transcript_completed",
                        "item_id": item_id,
                        "client_turn_id": turn_id,
                        "force_request_id": force_request_id,
                        "transcript": (
                            "Русское техническое собеседование по разработке и тестированию. "
                            "Термины: тест-дизайн, классы эквивалентности, граничные значения, "
                            "Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, "
                            "CI/CD, Kafka, Kubernetes."
                        ),
                    }
                )
            )

    local = _LocalWebSocket()
    gateway = _PromptEchoGateway(complete_on_commit=True)
    task = asyncio.create_task(
        run_openai_realtime_stream(
            local,
            sample_rate=16000,
            gateway_url="https://skill-cue.ru/v1",
            license_key="license-test",
            connect_factory=gateway.connect,
        )
    )
    await _wait_for_event(local, "ready")
    voice_300ms = (1200).to_bytes(2, "little", signed=True) * 4800
    silence_100ms = b"\0\0" * 1600
    await local.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    for _ in range(7):
        await local.messages.put({"type": "websocket.receive", "bytes": silence_100ms})

    low_quality = await _wait_for_event(local, "low_quality")
    await local.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, timeout=1)

    assert low_quality["text"] == ""
    assert not any(event.get("type") == "transcript" for event in local.sent)


async def test_realtime_keeps_a_question_together_across_a_600ms_natural_pause():
    local = _LocalWebSocket()
    gateway = _FakeGateway(complete_on_commit=True)
    task = asyncio.create_task(
        run_openai_realtime_stream(
            local,
            sample_rate=16000,
            gateway_url="https://skill-cue.ru/v1",
            license_key="license-test",
            connect_factory=gateway.connect,
        )
    )
    await _wait_for_event(local, "ready")
    voice_300ms = (1200).to_bytes(2, "little", signed=True) * 4800
    silence_100ms = b"\0\0" * 1600
    await local.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    for _ in range(6):
        await local.messages.put({"type": "websocket.receive", "bytes": silence_100ms})
    await asyncio.sleep(0)
    assert not any(event.get("type") == "commit" for event in gateway.sent_controls)

    await local.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    await local.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-joined"}),
        }
    )
    transcript = await _wait_for_event(local, "transcript")
    await local.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, timeout=1)

    assert [event["type"] for event in gateway.sent_controls] == ["commit"]
    assert transcript["force_request_id"] == "force-joined"


async def test_forced_turn_falls_back_to_buffered_wav_when_realtime_never_completes(
    monkeypatch,
):
    """Catch a silent upstream hang after Ctrl+Enter, not an explicit socket error."""

    class _FallbackProvider:
        def __init__(self):
            self.calls = []

        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        async def transcribe_audio_file(self, audio, *, language, sample_rate):
            self.calls.append((audio, language, sample_rate))
            return SimpleNamespace(text="Какие проверки строки поиска?", latency_ms=37)

        async def aclose(self):
            return None

    fallback = _FallbackProvider()
    monkeypatch.setattr(realtime_stream, "FORCED_TURN_TIMEOUT_S", 0.01, raising=False)
    monkeypatch.setattr(
        realtime_stream,
        "OpenAiMiniTranscribeProvider",
        lambda: fallback,
        raising=False,
    )
    local = _LocalWebSocket()
    gateway = _FakeGateway(complete_on_commit=False, complete_on_bind=False)
    task = asyncio.create_task(
        run_openai_realtime_stream(
            local,
            sample_rate=16000,
            gateway_url="https://skill-cue.ru/v1",
            license_key="license-test",
            connect_factory=gateway.connect,
        )
    )
    await _wait_for_event(local, "ready")
    voice_300ms = (1200).to_bytes(2, "little", signed=True) * 4800
    await local.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    await local.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-timeout"}),
        }
    )

    transcript = await _wait_for_event(local, "transcript")
    await local.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, timeout=1)

    assert transcript["text"] == "Какие проверки строки поиска?"
    assert transcript["force_request_id"] == "force-timeout"
    assert len(fallback.calls) == 1
    assert fallback.calls[0][1:] == ("ru", 16000)


async def test_forced_turn_falls_back_when_realtime_completes_with_empty_text(
    monkeypatch,
):
    """A fast empty Realtime final must not cancel the buffered-WAV recovery."""

    class _EmptyGateway(_FakeGateway):
        async def complete(self, item_id, force_request_id=None):
            turn_id = self._turn_by_item[item_id]
            await self.incoming.put(
                json.dumps(
                    {
                        "type": "transcript_completed",
                        "item_id": item_id,
                        "client_turn_id": turn_id,
                        "force_request_id": force_request_id,
                        # This is stripped as a live-prompt echo and becomes empty.
                        "transcript": (
                            "Русское техническое собеседование по разработке и тестированию. "
                            "Термины: тест-дизайн, классы эквивалентности, граничные значения, "
                            "Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, "
                            "CI/CD, Kafka, Kubernetes."
                        ),
                    }
                )
            )

    class _FallbackProvider:
        def __init__(self):
            self.calls = []

        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        async def transcribe_audio_file(self, audio, *, language, sample_rate):
            self.calls.append((audio, language, sample_rate))
            return SimpleNamespace(
                text="Что вы делали с нестабильными автотестами в CI/CD пайплайне?",
                latency_ms=41,
            )

        async def aclose(self):
            return None

    fallback = _FallbackProvider()
    monkeypatch.setattr(realtime_stream, "FORCED_TURN_TIMEOUT_S", 0.01, raising=False)
    monkeypatch.setattr(
        realtime_stream,
        "OpenAiMiniTranscribeProvider",
        lambda: fallback,
        raising=False,
    )
    local = _LocalWebSocket()
    gateway = _EmptyGateway(complete_on_commit=True)
    task = asyncio.create_task(
        run_openai_realtime_stream(
            local,
            sample_rate=16000,
            gateway_url="https://skill-cue.ru/v1",
            license_key="license-test",
            connect_factory=gateway.connect,
        )
    )
    await _wait_for_event(local, "ready")
    voice_300ms = (1200).to_bytes(2, "little", signed=True) * 4800
    await local.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    await local.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-empty"}),
        }
    )

    transcript = await _wait_for_event(local, "transcript")
    await local.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, timeout=1)

    assert transcript["text"].startswith("Что вы делали с нестабильными")
    assert transcript["force_request_id"] == "force-empty"
    assert len(fallback.calls) == 1
    assert not any(event.get("type") == "low_quality" for event in local.sent)


async def test_feature_flag_uses_realtime_and_falls_back_to_proven_stream(monkeypatch):
    calls = []

    async def broken_realtime(*_args, **_kwargs):
        calls.append("realtime")
        raise stt_router.RealtimeUnavailable("gateway down")

    async def legacy(*_args, **_kwargs):
        calls.append("legacy")

    monkeypatch.setattr(stt_router, "run_openai_realtime_stream", broken_realtime)
    monkeypatch.setattr(stt_router, "run_openai_mini_stream", legacy)
    monkeypatch.setattr(stt_router, "REALTIME_RECONNECT_DELAYS_S", (0, 0))

    await stt_router.run_configured_live_stream(
        object(),
        settings=SimpleNamespace(skillcue_realtime_stt=True),
        language="ru",
        sample_rate=16000,
    )

    assert calls == ["realtime", "realtime", "realtime", "legacy"]


async def test_realtime_reconnects_in_place_after_provider_lifetime_close(monkeypatch):
    """A provider lease ending after an hour must not downgrade the live interview."""

    calls = []

    async def realtime(*_args, **_kwargs):
        calls.append("realtime")
        if calls.count("realtime") == 1:
            raise stt_router.RealtimeUnavailable("provider session lifetime reached")

    async def legacy(*_args, **_kwargs):
        calls.append("legacy")

    monkeypatch.setattr(stt_router, "run_openai_realtime_stream", realtime)
    monkeypatch.setattr(stt_router, "run_openai_mini_stream", legacy)
    monkeypatch.setattr(
        stt_router,
        "REALTIME_RECONNECT_DELAYS_S",
        (0,),
        raising=False,
    )

    await stt_router.run_configured_live_stream(
        object(),
        settings=SimpleNamespace(skillcue_realtime_stt=True),
        language="ru",
        sample_rate=16000,
    )

    assert calls == ["realtime", "realtime"]
