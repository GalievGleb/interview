import io
import json
import wave

import httpx
import pytest

from app.routers import stt as stt_router
from app.services.stt.openai_transcribe import (
    ANSWER_MODEL,
    OpenAiAnswerTranscriber,
    build_answer_request_data,
)


def _wav(
    *,
    sample_rate: int = 48_000,
    samples: int = 4_800,
    value: int = 900,
    channels: int = 1,
) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(value.to_bytes(2, "little", signed=True) * samples * channels)
    return output.getvalue()


def test_answer_request_uses_contextual_model_and_multilingual_hints():
    fields = build_answer_request_data(
        question="Что проверяете в API-ответе кроме 200?",
        hints=["API", "JSON", "schema"],
        language="ru",
    )

    assert fields == {
        "model": ANSWER_MODEL,
        "response_format": "json",
        "prompt": "Техническое интервью. Вопрос интервьюера: Что проверяете в API-ответе кроме 200?",
        "keywords": ["API", "JSON", "schema"],
        "languages": ["ru", "en"],
    }
    assert ANSWER_MODEL == "gpt-transcribe"


def test_answer_request_keeps_english_only_when_interview_is_english():
    fields = build_answer_request_data(
        question="How do you test an API response?",
        hints=["API", "JSON"],
        language="en",
    )

    assert fields["languages"] == ["en"]


def test_upload_limit_keeps_a_full_120_second_native_rate_answer():
    highest_allowed_pcm_bytes = 44 + (96_000 * 2 * 120)

    assert stt_router.MAX_ANSWER_AUDIO_BYTES >= highest_allowed_pcm_bytes


async def test_direct_answer_request_sends_official_context_fields_as_multipart():
    captured = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        captured["content_type"] = request.headers.get("content-type")
        captured["body"] = await request.aread()
        return httpx.Response(200, json={"text": "API, JSON и schema"})

    transcriber = OpenAiAnswerTranscriber()
    transcriber._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        text = await transcriber._transcribe_direct(
            _wav(),
            request_data=build_answer_request_data(
                question="Что проверяете кроме 200?",
                hints=["API", "JSON", "schema"],
                language="ru",
            ),
            key="openai-test-key",
        )
    finally:
        await transcriber.aclose()

    body = captured["body"]
    assert text == "API, JSON и schema"
    assert captured["authorization"] == "Bearer openai-test-key"
    assert captured["content_type"].startswith("multipart/form-data; boundary=")
    assert b'name="model"\r\n\r\ngpt-transcribe' in body
    assert body.count(b'name="keywords[]"') == 3
    assert b'name="languages[]"\r\n\r\nru' in body
    assert b'name="languages[]"\r\n\r\nen' in body
    assert b'name="file"; filename="answer.wav"' in body


def test_mock_answer_endpoint_forwards_one_complete_native_wav(client, monkeypatch):
    captured = {}

    class FakeAnswerTranscriber:
        async def transcribe(self, audio, *, question, hints, language):
            captured.update(
                audio=audio,
                question=question,
                hints=hints,
                language=language,
            )
            return "Проверяю JSON-тело, схему, заголовки и бизнес-данные."

    monkeypatch.setattr(stt_router, "get_answer_transcriber", lambda: FakeAnswerTranscriber())
    audio = _wav()
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", audio, "audio/wav")},
        data={
            "question": "Что проверяете в API-ответе кроме статус-кода 200?",
            "hints": json.dumps(["API", "JSON", "schema"]),
            "language": "ru",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "Проверяю JSON-тело, схему, заголовки и бизнес-данные.",
        "model": ANSWER_MODEL,
    }
    assert captured == {
        "audio": audio,
        "question": "Что проверяете в API-ответе кроме статус-кода 200?",
        "hints": ["API", "JSON", "schema"],
        "language": "ru",
    }


def test_mock_answer_endpoint_preserves_raw_transcript_words(client, monkeypatch):
    class FakeAnswerTranscriber:
        async def transcribe(self, _audio, **_kwargs):
            return "  Проверяю самскада и  JSON — как произнесено.  "

    monkeypatch.setattr(stt_router, "get_answer_transcriber", lambda: FakeAnswerTranscriber())
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", _wav(), "audio/wav")},
        data={"question": "Вопрос", "hints": "[]", "language": "ru"},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "Проверяю самскада и  JSON — как произнесено."


def test_mock_answer_endpoint_returns_retryable_error_when_provider_is_unavailable(client, monkeypatch):
    class UnavailableAnswerTranscriber:
        async def transcribe(self, _audio, **_kwargs):
            raise RuntimeError("upstream failed")

    monkeypatch.setattr(
        stt_router,
        "get_answer_transcriber",
        lambda: UnavailableAnswerTranscriber(),
    )
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", _wav(), "audio/wav")},
        data={"question": "Вопрос", "hints": "[]", "language": "ru"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "Распознавание временно недоступно. Запись можно отправить повторно."
    )


def test_mock_answer_endpoint_rejects_silence_without_calling_provider(client, monkeypatch):
    called = False

    class FakeAnswerTranscriber:
        async def transcribe(self, _audio, **_kwargs):
            nonlocal called
            called = True
            return "unexpected"

    monkeypatch.setattr(stt_router, "get_answer_transcriber", lambda: FakeAnswerTranscriber())
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", _wav(value=0), "audio/wav")},
        data={"question": "Вопрос", "hints": "[]", "language": "ru"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Речь не обнаружена в записи"
    assert called is False


def test_mock_answer_endpoint_rejects_unsafe_or_excessive_hints(client):
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", _wav(), "audio/wav")},
        data={
            "question": "Вопрос",
            "hints": json.dumps(["safe", "bad<hint>"]),
            "language": "ru",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Некорректные подсказки распознавания"


@pytest.mark.parametrize(
    "audio",
    [
        _wav(channels=2),
        _wav()[:-2],
        _wav(sample_rate=8_000, samples=8_000 * 121),
        bytes(bytearray(_wav())[:8] + b"NOPE" + bytearray(_wav())[12:]),
    ],
    ids=["stereo", "truncated-data", "over-120-seconds", "not-wave"],
)
def test_mock_answer_endpoint_rejects_unsupported_or_incomplete_wav(client, audio):
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", audio, "audio/wav")},
        data={"question": "Вопрос", "hints": "[]", "language": "ru"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Некорректная WAV-запись"
