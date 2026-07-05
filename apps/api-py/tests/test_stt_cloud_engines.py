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
    assert parse_deepgram_event(json.dumps({"type": "SpeechStarted"})) == {
        "type": "speech_started"
    }
    assert parse_deepgram_event(json.dumps({"type": "UtteranceEnd"})) == {
        "type": "utterance_end"
    }

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
    assert _language_codes("multi") == []
