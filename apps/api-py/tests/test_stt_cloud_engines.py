"""Облачные STT-движки: настройка engine, диагностика, перевод событий Deepgram."""

import json

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
