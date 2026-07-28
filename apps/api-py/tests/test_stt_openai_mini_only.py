import asyncio
import io
import json
import wave

import httpx

from app.services.stt.base import TranscriptResult
from app.services.stt.openai_mini_stream import (
    Endpointer,
    quality_gate,
    run_openai_mini_stream,
)
from app.services.stt.openai_transcribe import (
    MINI_MODEL,
    OpenAiMiniTranscribeProvider,
    build_request_data,
)
from app.services.stt.pcm_audio import pcm16_mono_wav
from app.services.stt.registry import all_providers, diagnostics, resolve_default_provider
from app.services.stt.settings_store import SttSettings


def test_legacy_stt_settings_are_forced_to_openai_mini():
    settings = SttSettings.model_validate(
        {
            "engine": "whisper",
            "local_model": "max",
            "device": "gpu",
        }
    ).sanitized()

    assert settings.model_dump() == {
        "engine": "openai-mini",
        "model": MINI_MODEL,
    }


def test_registry_exposes_only_openai_mini():
    providers = all_providers()

    assert [provider.id for provider in providers] == ["openai-gpt-4o-mini-transcribe"]
    assert resolve_default_provider().id == "openai-gpt-4o-mini-transcribe"
    assert diagnostics()["engine"] == "openai-mini"


def test_openai_mini_request_has_no_prompt_or_glossary():
    payload = build_request_data(language="ru")

    assert payload == {
        "model": MINI_MODEL,
        "response_format": "json",
        "language": "ru",
    }
    assert "prompt" not in payload


def test_openai_mini_accepts_successful_2xx_gateway_response():
    response = httpx.Response(
        201,
        json={"text": "Как вы тестировали API?"},
        request=httpx.Request("POST", "https://skill-cue.ru/gateway/stt/transcribe"),
    )

    assert OpenAiMiniTranscribeProvider._response_text(response) == "Как вы тестировали API?"


def test_provider_model_cannot_be_changed():
    provider = OpenAiMiniTranscribeProvider()

    assert provider._active_model() == MINI_MODEL


def test_pcm_is_wrapped_as_mono_wav_without_conversion():
    pcm = (1000).to_bytes(2, byteorder="little", signed=True) * 160

    audio = pcm16_mono_wav(pcm, sample_rate=16000)

    with wave.open(io.BytesIO(audio), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 16000
        assert wav.readframes(wav.getnframes()) == pcm


def test_endpointer_finalizes_after_short_silence():
    endpointer = Endpointer(sample_rate=16000)
    voice_100ms = (1200).to_bytes(2, byteorder="little", signed=True) * 1600
    silence_100ms = b"\0\0" * 1600

    assert endpointer.feed(voice_100ms) is False
    assert endpointer.feed(voice_100ms) is False
    assert endpointer.feed(voice_100ms) is False
    finalized = any(endpointer.feed(silence_100ms) for _ in range(6))

    assert finalized is True
    assert endpointer.has_pending_speech() is True
    assert endpointer.take_utterance()


def test_endpointer_keeps_quiet_audio_for_manual_finalize():
    endpointer = Endpointer(sample_rate=16000)
    quiet_500ms = (100).to_bytes(2, byteorder="little", signed=True) * 8000

    assert endpointer.feed(quiet_500ms) is False
    assert endpointer.in_speech is False
    assert endpointer.has_pending_audio() is True
    assert endpointer.take_utterance(forced=True) == quiet_500ms


def test_endpointer_manual_finalize_keeps_quiet_start_before_loud_speech():
    endpointer = Endpointer(sample_rate=16000)
    quiet_500ms = (100).to_bytes(2, byteorder="little", signed=True) * 8000
    loud_300ms = (1200).to_bytes(2, byteorder="little", signed=True) * 4800

    endpointer.feed(quiet_500ms)
    endpointer.feed(loud_300ms)

    assert endpointer.in_speech is True
    assert endpointer.take_utterance(forced=True) == quiet_500ms + loud_300ms


def test_endpointer_does_not_treat_silence_as_manual_audio():
    endpointer = Endpointer(sample_rate=16000)
    silence_500ms = b"\0\0" * 8000

    endpointer.feed(silence_500ms)

    assert endpointer.has_pending_audio() is False


def test_endpointer_detects_quiet_speech_after_long_silence():
    endpointer = Endpointer(sample_rate=16000)
    silence_10s = b"\0\0" * 160000
    quiet_500ms = (100).to_bytes(2, byteorder="little", signed=True) * 8000

    endpointer.feed(silence_10s)
    endpointer.feed(quiet_500ms)

    assert endpointer.has_pending_audio() is True


def test_quality_gate_does_not_rewrite_transcript():
    transcript = "гейммикс си ди докер"

    accepted, reason = quality_gate(transcript, "")

    assert accepted is True
    assert reason == "ok"


async def test_live_stream_finalizes_pending_audio_on_control_message():
    class FakeWebSocket:
        def __init__(self):
            voice = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
            self.messages = [
                {"type": "websocket.receive", "bytes": voice},
                {
                    "type": "websocket.receive",
                    "text": json.dumps({"type": "finalize", "request_id": "force-1"}),
                },
                {"type": "websocket.disconnect"},
            ]
            self.sent = []

        async def receive(self):
            return self.messages.pop(0)

        async def send_json(self, payload):
            self.sent.append(payload)

    class FakeProvider:
        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, audio, **_kwargs):
            assert audio[:4] == b"RIFF"
            return TranscriptResult(
                text="Как вы тестировали API кроме статуса 200?",
                latency_ms=50,
                provider_id="openai-gpt-4o-mini-transcribe",
                model=MINI_MODEL,
            )

    ws = FakeWebSocket()
    await run_openai_mini_stream(ws, provider=FakeProvider())

    assert any(
        event.get("type") == "transcript"
        and event.get("text") == "Как вы тестировали API кроме статуса 200?"
        and event.get("force_request_id") == "force-1"
        for event in ws.sent
    )
    assert any(
        event.get("type") == "utterance_end" and event.get("force_request_id") == "force-1"
        for event in ws.sent
    )


async def test_live_stream_reports_empty_manual_finalize():
    class FakeWebSocket:
        def __init__(self):
            self.messages = [
                {
                    "type": "websocket.receive",
                    "text": json.dumps({"type": "finalize", "request_id": "force-empty"}),
                },
                {"type": "websocket.disconnect"},
            ]
            self.sent = []

        async def receive(self):
            return self.messages.pop(0)

        async def send_json(self, payload):
            self.sent.append(payload)

    class FakeProvider:
        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

    ws = FakeWebSocket()
    await run_openai_mini_stream(ws, provider=FakeProvider())

    assert any(
        event.get("type") == "force_empty" and event.get("force_request_id") == "force-empty"
        for event in ws.sent
    )


async def test_force_during_auto_inference_binds_to_inflight_transcript():
    provider_started = asyncio.Event()
    allow_provider_finish = asyncio.Event()

    class FakeWebSocket:
        def __init__(self):
            self.messages = asyncio.Queue()
            self.sent = []

        async def receive(self):
            return await self.messages.get()

        async def send_json(self, payload):
            self.sent.append(payload)

    class FakeProvider:
        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, _audio, **_kwargs):
            provider_started.set()
            await allow_provider_finish.wait()
            return TranscriptResult(
                text="Как вы тестировали API кроме статуса 200?",
                latency_ms=50,
                provider_id="openai-gpt-4o-mini-transcribe",
                model=MINI_MODEL,
            )

    ws = FakeWebSocket()
    voice_300ms = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
    silence_100ms = b"\0\0" * 1600
    await ws.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    for _ in range(6):
        await ws.messages.put({"type": "websocket.receive", "bytes": silence_100ms})

    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=FakeProvider()))
    await asyncio.wait_for(provider_started.wait(), timeout=1)
    await ws.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-inflight"}),
        }
    )
    await asyncio.sleep(0.01)
    allow_provider_finish.set()
    await ws.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(stream_task, timeout=1)

    assert any(
        event.get("type") == "transcript" and event.get("force_request_id") == "force-inflight"
        for event in ws.sent
    )
    assert not any(
        event.get("type") == "force_empty" and event.get("force_request_id") == "force-inflight"
        for event in ws.sent
    )
