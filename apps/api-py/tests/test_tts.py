from types import SimpleNamespace

import httpx
import pytest

from app.services import tts


class FakeClient:
    def __init__(self, response: httpx.Response):
        self.response = response
        self.calls: list[dict] = []

    async def post(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.response


def test_tts_endpoint_returns_wav(client, monkeypatch):
    async def fake_synthesize(input_text: str, language: str) -> bytes:
        assert input_text == "Что такое API?"
        assert language == "ru"
        return b"RIFF" + b"\x00" * 40

    monkeypatch.setattr(tts, "synthesize_speech", fake_synthesize)
    response = client.post("/tts/speech", json={"input": "Что такое API?", "language": "ru"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["cache-control"] == "private, max-age=86400"
    assert response.content.startswith(b"RIFF")


def test_tts_endpoint_rejects_empty_or_oversized_text(client):
    assert client.post("/tts/speech", json={"input": "", "language": "ru"}).status_code == 422
    assert (
        client.post("/tts/speech", json={"input": "x" * 801, "language": "ru"}).status_code == 422
    )


@pytest.mark.asyncio
async def test_direct_tts_uses_fixed_natural_openai_voice(monkeypatch):
    fake = FakeClient(httpx.Response(200, content=b"RIFF-direct"))
    monkeypatch.setattr(tts.secrets, "get_secret", lambda name: "own-openai-key")
    monkeypatch.setattr(tts.provider_adapter, "get_client", lambda: fake)

    audio = await tts.synthesize_speech(" Что  такое API? ", "ru")

    assert audio == b"RIFF-direct"
    assert fake.calls[0]["url"] == "https://api.openai.com/v1/audio/speech"
    assert fake.calls[0]["headers"]["Authorization"] == "Bearer own-openai-key"
    assert fake.calls[0]["json"] == {
        "model": "gpt-4o-mini-tts",
        "voice": "marin",
        "input": "Что такое API?",
        "response_format": "wav",
        "instructions": (
            "Говори естественно, спокойно и доброжелательно, как живой интервьюер. "
            "Без дикторской манеры."
        ),
    }


@pytest.mark.asyncio
async def test_managed_tts_uses_gateway_license_without_exposing_provider(monkeypatch):
    fake = FakeClient(httpx.Response(200, content=b"RIFF-managed"))
    monkeypatch.setattr(tts.secrets, "get_secret", lambda name: "")
    monkeypatch.setattr(
        tts,
        "get_settings",
        lambda: SimpleNamespace(skillcue_gateway_url="https://skill-cue.ru/v1"),
    )
    monkeypatch.setattr(tts, "_gateway_license_key", lambda: "license-key")
    monkeypatch.setattr(tts.provider_adapter, "get_client", lambda: fake)

    audio = await tts.synthesize_speech("What is API?", "en")

    assert audio == b"RIFF-managed"
    assert fake.calls[0]["url"] == "https://skill-cue.ru/gateway/tts/speech"
    assert fake.calls[0]["headers"]["Authorization"] == "Bearer license-key"
    assert fake.calls[0]["json"] == {"input": "What is API?", "language": "en"}


@pytest.mark.asyncio
async def test_tts_maps_gateway_error_to_safe_app_error(monkeypatch):
    fake = FakeClient(
        httpx.Response(
            429,
            json={
                "error": {
                    "message": "Слишком много запросов озвучки — подождите минуту.",
                    "code": "rate_limited",
                }
            },
        )
    )
    monkeypatch.setattr(tts.secrets, "get_secret", lambda name: "")
    monkeypatch.setattr(
        tts,
        "get_settings",
        lambda: SimpleNamespace(skillcue_gateway_url="https://skill-cue.ru"),
    )
    monkeypatch.setattr(tts, "_gateway_license_key", lambda: "license-key")
    monkeypatch.setattr(tts.provider_adapter, "get_client", lambda: fake)

    with pytest.raises(Exception) as captured:
        await tts.synthesize_speech("Что такое API?", "ru")

    error = captured.value
    assert getattr(error, "status_code", None) == 429
    assert getattr(error, "code", None) == "rate_limited"
    assert "подождите минуту" in getattr(error, "message", "")
