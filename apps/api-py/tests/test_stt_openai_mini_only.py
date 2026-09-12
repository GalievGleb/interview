import asyncio
import io
import json
import wave

import httpx
import pytest

from app.services.stt import openai_mini_stream as openai_mini_stream_module
from app.services.stt import openai_transcribe
from app.services.stt.base import TranscriptResult
from app.services.stt.openai_mini_stream import (
    Endpointer,
    quality_gate,
    run_openai_mini_stream,
)
from app.services.stt.openai_transcribe import (
    LIVE_RU_PROMPT,
    MINI_MODEL,
    REALTIME_RU_PROMPT,
    OpenAiMiniTranscribeProvider,
    build_request_data,
    strip_live_prompt_echo,
)
from app.services.stt.pcm_audio import pcm16_mono_wav
from app.services.stt.registry import all_providers, diagnostics, resolve_default_provider
from app.services.stt.settings_store import SttSettings


class _QueuedWebSocket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.sent = []
        self.received_count = 0
        self._received = asyncio.Condition()

    async def receive(self):
        message = await self.messages.get()
        async with self._received:
            self.received_count += 1
            self._received.notify_all()
        return message

    async def send_json(self, payload):
        self.sent.append(payload)

    async def wait_until_received(self, count: int) -> None:
        async with self._received:
            await asyncio.wait_for(
                self._received.wait_for(lambda: self.received_count >= count),
                timeout=1,
            )


async def _wait_for_sent(ws: _QueuedWebSocket, event_type: str, count: int = 1):
    async def find_events():
        while True:
            matching = [event for event in ws.sent if event.get("type") == event_type]
            if len(matching) >= count:
                return matching
            await asyncio.sleep(0)

    return await asyncio.wait_for(find_events(), timeout=1)


async def _put_auto_turn(ws: _QueuedWebSocket) -> None:
    voice_300ms = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
    silence_100ms = b"\0\0" * 1600
    await ws.messages.put({"type": "websocket.receive", "bytes": voice_300ms})
    for _ in range(5):
        await ws.messages.put({"type": "websocket.receive", "bytes": silence_100ms})


async def _disconnect(ws: _QueuedWebSocket, stream_task: asyncio.Task) -> None:
    await ws.messages.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(stream_task, timeout=1)


class _BlockingProvider:
    def __init__(self, texts: list[str]):
        self.texts = texts
        self.audio = []
        self.first_started = asyncio.Event()
        self.release_first = asyncio.Event()

    def is_available(self):
        return True

    async def prepare_async(self):
        return None

    def _active_model(self):
        return MINI_MODEL

    async def transcribe_audio_file(self, audio, **_kwargs):
        self.audio.append(audio)
        call_index = len(self.audio) - 1
        if call_index == 0:
            self.first_started.set()
            await self.release_first.wait()
        return TranscriptResult(
            text=self.texts[call_index],
            latency_ms=50,
            provider_id="openai-gpt-4o-mini-transcribe",
            model=MINI_MODEL,
        )


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


def test_openai_mini_request_anchors_russian_technical_interview():
    payload = build_request_data(language="ru")

    assert payload["model"] == MINI_MODEL
    assert payload["response_format"] == "json"
    assert payload["language"] == "ru"
    assert "русск" in payload["prompt"].lower()
    assert "pytest" in payload["prompt"].lower()
    assert "docker" in payload["prompt"].lower()


def test_openai_mini_accepts_successful_2xx_gateway_response():
    response = httpx.Response(
        201,
        json={"text": "Как вы тестировали API?"},
        request=httpx.Request("POST", "https://skill-cue.ru/gateway/stt/transcribe"),
    )

    assert OpenAiMiniTranscribeProvider._response_text(response) == "Как вы тестировали API?"


def test_live_stt_removes_prompt_echo_without_touching_the_question():
    question = "Какие проверки вы предложите для строки поиска?"
    observed_prompt_echo = (
        "Техническое собеседование. Распознавай русскую речь по-русски и сохраняй "
        "технические термины: Python, pytest, fixture, autouse, scope, yield, Docker, "
        "REST API, HTTP, JSON, SQL, Playwright, CI/CD, Kafka, Kubernetes, lambda."
    )

    assert strip_live_prompt_echo(f"{question} {LIVE_RU_PROMPT}") == question
    assert strip_live_prompt_echo(LIVE_RU_PROMPT) == ""
    assert strip_live_prompt_echo(observed_prompt_echo) == ""
    assert strip_live_prompt_echo(f"{observed_prompt_echo} {question}") == question
    assert strip_live_prompt_echo("Как вы используете pytest и Docker?") == (
        "Как вы используете pytest и Docker?"
    )


def test_live_stt_removes_the_realtime_gateway_prompt_echo():
    realtime_prompt_echo = (
        "Русское техническое собеседование по разработке и тестированию. "
        "Термины: тест-дизайн, классы эквивалентности, граничные значения, "
        "Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, CI/CD, "
        "Kafka, Kubernetes."
    )
    observed_without_locale = realtime_prompt_echo.removeprefix("Русское ")

    assert strip_live_prompt_echo(realtime_prompt_echo) == ""
    assert strip_live_prompt_echo(observed_without_locale) == ""
    assert strip_live_prompt_echo(REALTIME_RU_PROMPT) == ""
    assert strip_live_prompt_echo(f"{REALTIME_RU_PROMPT}.") == ""


def test_live_stt_rejects_capitalized_vocabulary_hallucination_from_silent_mic():
    observed_silent_mic_hallucination = (
        "Тест-дизайн, тест-дизайна, классы эквивалентности, граничные значения, "
        "Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, CI/CD, Kafka, "
        "Kubernetes"
    )

    assert strip_live_prompt_echo(observed_silent_mic_hallucination) == ""


def test_live_stt_removes_mutated_partial_vocabulary_echo_from_real_session():
    observed_session_echo = (
        "формы, тест-дизайна, классы эквивалентности, граничные значения, "
        "Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, CI/CD, "
        "Kafka, Kubernetes."
    )
    question = (
        "Чем отличаются list, tuple, set и dict? Почему set обычно быстрее "
        "списка при проверке x in collection?"
    )

    assert strip_live_prompt_echo(observed_session_echo) == ""
    assert strip_live_prompt_echo(f"{observed_session_echo} {question}") == question


def test_gateway_response_cannot_forward_live_prompt_echo():
    question = "Что проверите в форме поиска?"
    response = httpx.Response(
        200,
        json={"text": f"{question} {LIVE_RU_PROMPT}"},
        request=httpx.Request("POST", "https://skill-cue.ru/gateway/stt/transcribe"),
    )

    assert OpenAiMiniTranscribeProvider._response_text(response) == question


async def test_openai_mini_retries_transient_500_before_returning(monkeypatch):
    attempts = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            return httpx.Response(500, json={"message": "Internal server error"})
        return httpx.Response(200, json={"text": "API transcript"})

    async def no_wait(_delay: float) -> None:
        return None

    monkeypatch.setattr(openai_transcribe.asyncio, "sleep", no_wait)
    provider = OpenAiMiniTranscribeProvider()
    provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        text = await provider._transcribe_direct(
            b"RIFF mock WAVE audio",
            language="ru",
            key="openai-test-key",
        )
    finally:
        await provider.aclose()

    assert attempts == 3
    assert text == "API transcript"


async def test_openai_mini_retries_cloudflare_530_before_returning(monkeypatch):
    attempts = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(530, text="temporary Cloudflare origin error")
        return httpx.Response(200, json={"text": "Вопрос про pytest"})

    async def no_wait(_delay: float) -> None:
        return None

    monkeypatch.setattr(openai_transcribe.asyncio, "sleep", no_wait)
    provider = OpenAiMiniTranscribeProvider()
    provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        text = await provider._transcribe_direct(
            b"RIFF mock WAVE audio",
            language="ru",
            key="openai-test-key",
        )
    finally:
        await provider.aclose()

    assert attempts == 2
    assert text == "Вопрос про pytest"


async def test_managed_live_utterances_have_no_obsolete_client_side_spacing(monkeypatch):
    delays: list[float] = []

    async def record_sleep(delay: float) -> None:
        delays.append(delay)

    async def license_key() -> str:
        return "signed-test-license"

    class Settings:
        skillcue_gateway_url = "https://skill-cue.ru"

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "Быстрый вопрос"})

    monkeypatch.setattr(openai_transcribe.asyncio, "sleep", record_sleep)
    monkeypatch.setattr(openai_transcribe, "_gateway_license_key", license_key)
    monkeypatch.setattr(openai_transcribe, "get_settings", lambda: Settings())
    provider = OpenAiMiniTranscribeProvider()
    provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        first = await provider._transcribe_via_gateway(
            b"RIFF first WAVE audio",
            language="ru",
        )
        second = await provider._transcribe_via_gateway(
            b"RIFF second WAVE audio",
            language="ru",
        )
    finally:
        await provider.aclose()

    assert [first, second] == ["Быстрый вопрос", "Быстрый вопрос"]
    assert delays == []


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


def test_endpointer_does_not_promote_automatic_question_noise_tail_to_manual_speech():
    endpointer = Endpointer(sample_rate=16000, silence_hang_ms=700)
    endpointer.feed((1200).to_bytes(2, "little") * 4800)
    for _ in range(7):
        committed = endpointer.feed((140).to_bytes(2, "little") * 1600)
    assert committed is True
    endpointer.take_utterance()
    tail = b"".join(amplitude.to_bytes(2, "little") * 1600 for amplitude in (140, 126, 136, 141, 167))
    endpointer.feed(tail)

    assert endpointer.has_pending_audio() is False
    # Classification must not erase potentially meaningful quiet PCM.
    assert endpointer.take_utterance(forced=True) == tail


def test_endpointer_keeps_new_loud_speech_after_automatic_question_noise_tail():
    endpointer = Endpointer(sample_rate=16000, silence_hang_ms=700)
    endpointer.feed((1200).to_bytes(2, "little") * 4800)
    for _ in range(7):
        endpointer.feed((140).to_bytes(2, "little") * 1600)
    endpointer.take_utterance()
    tail = (140).to_bytes(2, "little") * 6400
    question = (900).to_bytes(2, "little") * 8000
    endpointer.feed(tail)
    endpointer.feed(question)

    assert endpointer.has_pending_audio() is True
    assert endpointer.take_utterance(forced=True) == tail + question


def test_quality_gate_does_not_rewrite_transcript():
    transcript = "гейммикс си ди докер"

    accepted, reason = quality_gate(transcript, "")

    assert accepted is True
    assert reason == "ok"


async def test_live_stream_finalizes_pending_audio_on_control_message():
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

    ws = _QueuedWebSocket()
    voice = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
    await ws.messages.put({"type": "websocket.receive", "bytes": voice})
    await ws.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-1"}),
        }
    )
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=FakeProvider()))
    await _wait_for_sent(ws, "utterance_end")
    await _disconnect(ws, stream_task)

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


async def test_forced_finalize_accepts_a_short_explicit_question():
    class FakeProvider:
        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, _audio, **_kwargs):
            return TranscriptResult(
                text="Which types?",
                latency_ms=25,
                provider_id="openai-gpt-4o-mini-transcribe",
                model=MINI_MODEL,
            )

    ws = _QueuedWebSocket()
    voice = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
    await ws.messages.put({"type": "websocket.receive", "bytes": voice})
    await ws.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-short"}),
        }
    )
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=FakeProvider()))
    await _wait_for_sent(ws, "utterance_end")
    await _disconnect(ws, stream_task)

    assert any(
        event.get("type") == "transcript"
        and event.get("text") == "Which types?"
        and event.get("force_request_id") == "force-short"
        for event in ws.sent
    )
    assert not any(
        event.get("type") == "low_quality" and event.get("force_request_id") == "force-short"
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


async def test_transient_provider_failure_keeps_live_stream_recoverable():
    class FailingProvider:
        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, _audio, **_kwargs):
            raise RuntimeError("OpenAI Mini STT 500: Internal server error")

    ws = _QueuedWebSocket()
    voice = (1200).to_bytes(2, byteorder="little", signed=True) * 4800
    await ws.messages.put({"type": "websocket.receive", "bytes": voice})
    await ws.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-error"}),
        }
    )
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=FailingProvider()))
    await _wait_for_sent(ws, "force_empty")
    await _disconnect(ws, stream_task)

    assert any(event.get("type") == "transcription_error" for event in ws.sent)
    assert any(
        event.get("type") == "force_empty" and event.get("force_request_id") == "force-error"
        for event in ws.sent
    )
    assert not any(event.get("type") == "error" for event in ws.sent)


async def test_first_blocked_call_coalesces_three_later_turns_into_one_pending_call(monkeypatch):
    provider_started = asyncio.Event()
    allow_provider_finish = asyncio.Event()
    utterance_ids = iter(["turn-1", "turn-2", "turn-3", "turn-4"])

    class FakeUuid:
        def __init__(self, value):
            self.hex = value

    monkeypatch.setattr(
        openai_mini_stream_module.uuid,
        "uuid4",
        lambda: FakeUuid(next(utterance_ids)),
    )

    class FakeProvider:
        def __init__(self):
            self.audio = []

        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, audio, **_kwargs):
            self.audio.append(audio)
            if len(self.audio) == 1:
                provider_started.set()
                await allow_provider_finish.wait()
            return TranscriptResult(
                text=f"Как вы тестировали API вызов номер {len(self.audio)}?",
                latency_ms=50,
                provider_id="openai-gpt-4o-mini-transcribe",
                model=MINI_MODEL,
            )

    ws = _QueuedWebSocket()
    provider = FakeProvider()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=provider))
    await asyncio.wait_for(provider_started.wait(), timeout=1)
    for _ in range(3):
        await _put_auto_turn(ws)
    await ws.wait_until_received(24)

    assert len(provider.audio) == 1

    allow_provider_finish.set()
    await _wait_for_sent(ws, "utterance_end", count=2)
    await asyncio.sleep(0.02)
    await _disconnect(ws, stream_task)

    assert len(provider.audio) == 2
    with wave.open(io.BytesIO(provider.audio[1]), "rb") as wav:
        assert wav.getnframes() == 41600
    utterance_ends = [event for event in ws.sent if event.get("type") == "utterance_end"]
    assert utterance_ends[1]["utterance_id"] == "turn-4"
    assert utterance_ends[1]["queueDepth"] == 1


async def test_disconnect_cancels_active_call_and_discards_pending_turn():
    provider_started = asyncio.Event()
    provider_cancelled = asyncio.Event()
    allow_provider_finish = asyncio.Event()

    class FakeProvider:
        def __init__(self):
            self.starts = 0

        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, _audio, **_kwargs):
            self.starts += 1
            if self.starts == 1:
                provider_started.set()
                try:
                    await allow_provider_finish.wait()
                except asyncio.CancelledError:
                    provider_cancelled.set()
                    raise
            return TranscriptResult(
                text="Как вы тестировали отмену активного запроса?",
                latency_ms=50,
                provider_id="openai-gpt-4o-mini-transcribe",
                model=MINI_MODEL,
            )

    ws = _QueuedWebSocket()
    provider = FakeProvider()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=provider))
    await asyncio.wait_for(provider_started.wait(), timeout=1)
    await _put_auto_turn(ws)
    await ws.wait_until_received(12)
    await ws.messages.put({"type": "websocket.disconnect"})

    try:
        await asyncio.wait_for(asyncio.shield(stream_task), timeout=0.2)
    except TimeoutError:
        allow_provider_finish.set()
        await asyncio.wait_for(stream_task, timeout=1)
        pytest.fail("disconnect waited for and drained provider work")

    assert provider_cancelled.is_set()
    assert provider.starts == 1


async def test_force_during_auto_inference_does_not_retag_active_transcript():
    provider_started = asyncio.Event()
    allow_provider_finish = asyncio.Event()

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

    ws = _QueuedWebSocket()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=FakeProvider()))
    await asyncio.wait_for(provider_started.wait(), timeout=1)
    await ws.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-inflight"}),
        }
    )
    await ws.wait_until_received(7)
    allow_provider_finish.set()
    transcripts = await _wait_for_sent(ws, "transcript")
    await _disconnect(ws, stream_task)

    assert any(
        event.get("type") == "force_empty" and event.get("force_request_id") == "force-inflight"
        for event in ws.sent
    )
    assert transcripts[0].get("force_request_id") is None


async def test_transcript_utterance_end_and_low_quality_expose_stable_metadata():
    class FakeProvider:
        def __init__(self):
            self.calls = 0

        def is_available(self):
            return True

        async def prepare_async(self):
            return None

        def _active_model(self):
            return MINI_MODEL

        async def transcribe_audio_file(self, _audio, **_kwargs):
            self.calls += 1
            text = "Как вы тестировали API кроме статуса 200?" if self.calls == 1 else "Нет"
            return TranscriptResult(
                text=text,
                latency_ms=50,
                provider_id="openai-gpt-4o-mini-transcribe",
                model=MINI_MODEL,
            )

    ws = _QueuedWebSocket()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=FakeProvider()))
    transcript = (await _wait_for_sent(ws, "transcript"))[0]
    utterance_end = (await _wait_for_sent(ws, "utterance_end"))[0]
    await _put_auto_turn(ws)
    low_quality = (await _wait_for_sent(ws, "low_quality"))[0]
    await _disconnect(ws, stream_task)

    assert transcript["utterance_id"] == utterance_end["utterance_id"]
    assert transcript["captured_at_ms"] == utterance_end["captured_at_ms"]
    for event in (transcript, utterance_end, low_quality):
        assert isinstance(event["utterance_id"], str) and event["utterance_id"]
        assert isinstance(event["captured_at_ms"], int) and event["captured_at_ms"] > 0
        assert event["queueDepth"] == 0
        assert isinstance(event["queueWaitMs"], int) and event["queueWaitMs"] >= 0
        assert isinstance(event["speechEndToFinalMs"], int)
        assert isinstance(event["openaiInferenceMs"], int)


async def test_normal_turn_after_forced_pending_supersedes_it_in_the_single_slot(monkeypatch):
    utterance_ids = iter(["active-turn", "forced-turn", "later-normal-turn"])

    class FakeUuid:
        def __init__(self, value):
            self.hex = value

    monkeypatch.setattr(
        openai_mini_stream_module.uuid,
        "uuid4",
        lambda: FakeUuid(next(utterance_ids)),
    )
    provider = _BlockingProvider(
        [
            "Как вы тестировали API кроме статуса 200?",
            "Нет",
            "Нет",
        ]
    )
    ws = _QueuedWebSocket()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=provider))
    await asyncio.wait_for(provider.first_started.wait(), timeout=1)
    await _put_auto_turn(ws)
    await ws.wait_until_received(12)
    await ws.messages.put(
        {
            "type": "websocket.receive",
            "text": json.dumps({"type": "finalize", "request_id": "force-frozen"}),
        }
    )
    await ws.wait_until_received(13)
    await _put_auto_turn(ws)
    await ws.wait_until_received(19)
    await asyncio.sleep(0)
    displaced_force_completed = any(
        event.get("type") == "force_empty" and event.get("force_request_id") == "force-frozen"
        for event in ws.sent
    )

    provider.release_first.set()
    await _wait_for_sent(ws, "low_quality")
    await asyncio.sleep(0.02)
    await _disconnect(ws, stream_task)

    assert displaced_force_completed is True
    assert len(provider.audio) == 2
    assert not any(
        event.get("type") == "transcript" and event.get("force_request_id") == "force-frozen"
        for event in ws.sent
    )
    later_normal = next(
        event
        for event in ws.sent
        if event.get("type") == "low_quality" and event.get("utterance_id") == "later-normal-turn"
    )
    assert later_normal.get("force_request_id") is None


async def test_repeated_finalize_completes_superseded_ids_and_resolves_the_latest():
    provider = _BlockingProvider(
        [
            "Как вы тестировали API кроме статуса 200?",
            "Какие виды?",
        ]
    )
    ws = _QueuedWebSocket()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=provider))
    await asyncio.wait_for(provider.first_started.wait(), timeout=1)
    await _put_auto_turn(ws)
    await ws.wait_until_received(12)
    for request_id in ("force-1", "force-2", "force-3"):
        await ws.messages.put(
            {
                "type": "websocket.receive",
                "text": json.dumps({"type": "finalize", "request_id": request_id}),
            }
        )
    await ws.wait_until_received(15)
    await asyncio.sleep(0)
    completed_before_release = {
        event.get("force_request_id") for event in ws.sent if event.get("type") == "force_empty"
    }

    provider.release_first.set()
    await _wait_for_sent(ws, "utterance_end", count=2)
    await _disconnect(ws, stream_task)

    assert completed_before_release == {"force-1", "force-2"}
    assert any(
        event.get("type") == "transcript" and event.get("force_request_id") == "force-3"
        for event in ws.sent
    )


async def test_coalesced_pending_audio_is_capped_to_thirty_seconds():
    provider = _BlockingProvider(
        [
            "Как вы тестировали API кроме статуса 200?",
            "Как ограничивается очередь аудио при перегрузке?",
        ]
    )
    ws = _QueuedWebSocket()
    await _put_auto_turn(ws)
    stream_task = asyncio.create_task(run_openai_mini_stream(ws, provider=provider))
    await asyncio.wait_for(provider.first_started.wait(), timeout=1)
    for _ in range(34):
        await _put_auto_turn(ws)
    await ws.wait_until_received(210)

    provider.release_first.set()
    await _wait_for_sent(ws, "utterance_end", count=2)
    await _disconnect(ws, stream_task)

    assert len(provider.audio) == 2
    with wave.open(io.BytesIO(provider.audio[1]), "rb") as wav:
        assert wav.getnframes() == 480000
