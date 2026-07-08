"""Облачные STT-движки: настройка engine, диагностика, перевод событий Deepgram."""

import json

import pytest

from app.services.stt import registry
from app.services.stt.deepgram_stream import DeepgramProvider, build_ws_url, parse_deepgram_event
from app.services.stt.settings_store import SttSettings


def test_engine_setting_sanitized():
    assert SttSettings(engine="deepgram").sanitized().engine == "deepgram"
    assert SttSettings(engine="speechkit").sanitized().engine == "speechkit"
    assert SttSettings(engine="nonsense").sanitized().engine == "whisper"
    assert SttSettings().sanitized().engine == "whisper"


def test_stt_settings_endpoint_roundtrip(client):
    res = client.post("/stt/settings", json={"engine": "deepgram"})
    assert res.status_code == 200, res.text
    assert res.json()["engine"] == "deepgram"
    assert client.get("/stt/settings").json()["engine"] == "deepgram"
    # Вернём дефолт, чтобы не влиять на другие тесты (файл настроек общий).
    client.post("/stt/settings", json={"engine": "whisper"})


def test_providers_diagnostics_lists_cloud_engines(client):
    res = client.get("/stt/providers")
    assert res.status_code == 200
    ids = {p["id"] for p in res.json()["providers"]}
    assert "whisper-local" in ids
    assert "deepgram-nova3" in ids
    assert "yandex-speechkit-v3" in ids


def test_cloud_providers_unavailable_without_keys(monkeypatch):
    from app.services import secrets

    monkeypatch.setattr(secrets, "get_secret", lambda name: "")
    dg = DeepgramProvider()
    assert dg.is_available() is False
    assert "ключ" in dg._availability_reason().lower()
    diag = dg.get_diagnostics()
    assert diag.mode.value == "cloud"


def test_engine_provider_map_matches_registry():
    ids = {p.id for p in registry.all_providers()}
    for provider_id in registry.ENGINE_PROVIDER_IDS.values():
        assert provider_id in ids


def test_deepgram_ws_url_maps_language():
    assert "language=ru" in build_ws_url("ru", 16000)
    assert "language=en" in build_ws_url("en-US", 16000)
    assert "language=multi" in build_ws_url("multi", 16000)
    assert "sample_rate=16000" in build_ws_url("ru", 16000)
    assert "interim_results=true" in build_ws_url("ru", 16000)


def test_parse_deepgram_events():
    assert parse_deepgram_event(json.dumps({"type": "SpeechStarted"})) == {"type": "speech_started"}
    assert parse_deepgram_event(json.dumps({"type": "UtteranceEnd"})) == {"type": "utterance_end"}

    interim = json.dumps(
        {
            "type": "Results",
            "is_final": False,
            "speech_final": False,
            "channel": {"alternatives": [{"transcript": "что такое пайтест"}]},
        }
    )
    out = parse_deepgram_event(interim)
    assert out == {
        "type": "transcript",
        "text": "что такое пайтест",
        "is_final": False,
        "speech_final": False,
    }

    final = json.dumps(
        {
            "type": "Results",
            "is_final": True,
            "speech_final": True,
            "channel": {"alternatives": [{"transcript": "Что такое pytest?"}]},
        }
    )
    out = parse_deepgram_event(final)
    assert out is not None
    assert out["is_final"] is True and out["speech_final"] is True

    # Пустой транскрипт и мусор не должны генерировать сообщений.
    empty = json.dumps(
        {"type": "Results", "is_final": False, "channel": {"alternatives": [{"transcript": ""}]}}
    )
    assert parse_deepgram_event(empty) is None
    assert parse_deepgram_event("not json") is None


def test_speechkit_language_codes():
    from app.services.stt.speechkit_stream import _language_codes

    assert _language_codes("ru") == ["ru-RU"]
    assert _language_codes("en") == ["en-US"]
    # Авто/multi отдаёт обе локали в WHITELIST — литерала "auto" в API v3 нет,
    # раньше сюда уходил [] -> ["auto"] и авто-режим был сломан.
    assert _language_codes("multi") == ["ru-RU", "en-US"]
    assert _language_codes("") == ["ru-RU", "en-US"]


def test_speechkit_model_setting_sanitized():
    assert SttSettings(speechkit_model="general:rc").sanitized().speechkit_model == "general:rc"
    assert SttSettings(speechkit_model="nonsense").sanitized().speechkit_model == "general"
    assert SttSettings().sanitized().speechkit_model == "general"


def test_speechkit_model_endpoint_roundtrip(client):
    res = client.post("/stt/settings", json={"speechkit_model": "general:rc"})
    assert res.status_code == 200, res.text
    assert res.json()["speechkit_model"] == "general:rc"
    assert client.get("/stt/settings").json()["speechkit_model"] == "general:rc"
    # Вернём дефолт, чтобы не влиять на другие тесты (файл настроек общий).
    client.post("/stt/settings", json={"speechkit_model": "general"})


def test_speechkit_session_options_set_model_and_fast_eou():
    """Сессия обязана явно задавать модель и быстрый EOU-детектор: HIGH +
    подсказка о паузах — это и есть «качественно и быстро» по доке SpeechKit."""
    from unittest.mock import MagicMock

    from app.services.stt import speechkit_stream as sk

    stt_pb2 = MagicMock()
    sk.build_session_options(stt_pb2, language="ru", sample_rate=16000, model="general:rc")

    assert stt_pb2.RecognitionModelOptions.call_args.kwargs["model"] == "general:rc"
    eou = stt_pb2.DefaultEouClassifier.call_args.kwargs
    assert eou["type"] is stt_pb2.DefaultEouClassifier.HIGH
    assert eou["max_pause_between_words_hint_ms"] == sk.EOU_MAX_PAUSE_HINT_MS
    assert "eou_classifier" in stt_pb2.StreamingOptions.call_args.kwargs


def test_speechkit_rotation_budgets():
    """Ротация обязана учитывать оба лимита сессии: 5 минут И 10 МБ."""
    from app.services.stt import speechkit_stream as sk

    # Мягкая ротация — по времени или байтам, но только в паузе между фразами.
    assert sk.soft_rotation_due(sk.SESSION_RECONNECT_S + 1, 0, speech_active=False)
    assert not sk.soft_rotation_due(sk.SESSION_RECONNECT_S + 1, 0, speech_active=True)
    assert sk.soft_rotation_due(10, sk.SESSION_SOFT_BYTES, speech_active=False)
    assert not sk.soft_rotation_due(10, sk.SESSION_SOFT_BYTES - 1, speech_active=False)
    # Жёсткая — по байтам, независимо от речи (иначе сервер оборвёт сам).
    assert sk.hard_rotation_due(sk.SESSION_HARD_BYTES)
    assert not sk.hard_rotation_due(sk.SESSION_HARD_BYTES - 1)


def test_speechkit_48k_byte_budget_expires_before_time_deadline():
    """При 48 кГц (96 КБ/с) байтовый бюджет истекает раньше 240-с дедлайна —
    ротация по одному лишь времени опоздала бы (регресс исходного бага)."""
    from app.services.stt import speechkit_stream as sk

    bytes_at_time_deadline = 96_000 * sk.SESSION_RECONNECT_S
    assert bytes_at_time_deadline > sk.SESSION_SOFT_BYTES
    # А при дефолтных 16 кГц (32 КБ/с) время истекает первым — как задумано.
    assert 32_000 * sk.SESSION_RECONNECT_S < sk.SESSION_SOFT_BYTES


# --- gateway-relay fallback (без своего ключа Яндекса) --------------------
# Пользователь не должен вводить свой ключ Яндекса вообще: без локального
# ключа, но с настроенным gateway'ем аудио уходит через сервер SkillCue,
# который держит ключ сам (см. apps/api/src/gateway/gateway-stt.gateway.ts).


class _FakeClientWs:
    """Минимальный клиентский WS для проверки веток _run_gateway_relay без сети."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, msg: dict) -> None:
        self.sent.append(msg)


def test_gateway_stt_ws_url_maps_scheme_and_strips_nothing_extra():
    from app.services.stt.speechkit_stream import gateway_stt_ws_url

    url = gateway_stt_ws_url(
        "https://api.skillcue.app", "SKILLCUE-abc.def", language="ru", sample_rate=16000
    )
    assert url == (
        "wss://api.skillcue.app/gateway/stt/stream"
        "?key=SKILLCUE-abc.def&language=ru&sample_rate=16000"
    )
    # http (local/dev gateway) -> ws, not wss.
    assert gateway_stt_ws_url(
        "http://localhost:8787", "k", language="en", sample_rate=48000
    ).startswith("ws://localhost:8787/")
    # Незнакомая схема — не трогаем (лучше явная ошибка соединения, чем угадывание).
    assert gateway_stt_ws_url("ftp://x", "k", language="ru", sample_rate=16000).startswith(
        "ftp://x/"
    )


@pytest.mark.asyncio
async def test_gateway_relay_errors_clearly_when_no_gateway_configured(monkeypatch):
    from app.config import get_settings
    from app.services.stt import speechkit_stream as sk

    monkeypatch.setattr(get_settings(), "skillcue_gateway_url", "", raising=False)
    client_ws = _FakeClientWs()
    await sk._run_gateway_relay(client_ws, language="ru", sample_rate=16000)

    assert len(client_ws.sent) == 1
    assert client_ws.sent[0]["type"] == "error"
    assert "API-ключ" in client_ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_gateway_relay_errors_clearly_when_trial_claim_fails(monkeypatch):
    """Gateway настроен, но триал/лицензию получить не удалось (нет интернета
    или сервис недоступен) — пользователь должен получить понятный текст, а не
    зависание или трейсбек."""
    from app.config import get_settings
    from app.services.stt import speechkit_stream as sk

    monkeypatch.setattr(
        get_settings(), "skillcue_gateway_url", "https://gw.example.com", raising=False
    )
    monkeypatch.setattr("app.services.provider_adapter._gateway_license_key", lambda: "")

    client_ws = _FakeClientWs()
    await sk._run_gateway_relay(client_ws, language="ru", sample_rate=16000)

    assert len(client_ws.sent) == 1
    assert client_ws.sent[0]["type"] == "error"
    assert "SkillCue" in client_ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_run_speechkit_stream_delegates_to_gateway_relay_without_local_key(monkeypatch):
    """Без своего ключа Яндекса run_speechkit_stream не должен сразу отказывать —
    он обязан попытаться проксировать через gateway (см. _run_gateway_relay)."""
    from app.services.stt import speechkit_stream as sk

    monkeypatch.setattr(sk, "api_key", lambda: "")
    called = {}

    async def fake_relay(client_ws, *, language, sample_rate):
        called["args"] = (language, sample_rate)

    monkeypatch.setattr(sk, "_run_gateway_relay", fake_relay)

    await sk.run_speechkit_stream(_FakeClientWs(), language="en", sample_rate=48000)

    assert called["args"] == ("en", 48000)
