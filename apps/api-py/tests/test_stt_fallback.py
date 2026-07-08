"""Облачный STT-движок без ключа/гейтвея не «ломает» распознавание, а сигналит
диспетчеру откатиться на локальный Whisper (SttEngineUnavailable)."""

from __future__ import annotations

import pytest

from app.services.stt import deepgram_stream, speechkit_stream
from app.services.stt.base import SttEngineUnavailable


class _FakeWs:
    """Минимальный ws: не должен использоваться до отказа движка."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:  # pragma: no cover - страховка
        self.sent.append(payload)

    async def receive_bytes(self) -> bytes:  # pragma: no cover
        raise AssertionError("не должно вызываться при отказе движка")


@pytest.mark.asyncio
async def test_speechkit_without_key_or_gateway_raises_unavailable(monkeypatch):
    monkeypatch.setattr(speechkit_stream, "api_key", lambda: "")
    monkeypatch.setattr(speechkit_stream.get_settings(), "skillcue_gateway_url", "")
    ws = _FakeWs()
    with pytest.raises(SttEngineUnavailable):
        await speechkit_stream.run_speechkit_stream(ws, language="ru", sample_rate=16000)
    # Никакой error-простыни клиенту — только чистый откат.
    assert ws.sent == []


@pytest.mark.asyncio
async def test_deepgram_without_key_raises_unavailable(monkeypatch):
    monkeypatch.setattr(deepgram_stream, "api_key", lambda: "")
    ws = _FakeWs()
    with pytest.raises(SttEngineUnavailable):
        await deepgram_stream.run_deepgram_stream(ws, language="ru", sample_rate=16000)
    assert ws.sent == []
