"""Tests for STT settings persistence, device detection, and model manager.

Settings writes are redirected to a tmp file so they never touch the real data
dir or leak into other tests (which reason about the default provider).
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.stt import device as stt_device
from app.services.stt import settings_store
from app.services.stt.download_manager import download_manager

client = TestClient(app)


@pytest.fixture
def tmp_settings(tmp_path, monkeypatch):
    path = tmp_path / "stt_settings.json"
    monkeypatch.setattr(settings_store, "STT_SETTINGS_PATH", path)
    return path


# --- settings store ------------------------------------------------------
def test_defaults_when_no_file(tmp_settings):
    s = settings_store.load_stt_settings()
    assert s.local_model == "balanced"
    assert s.device == "auto"


def test_save_and_reload(tmp_settings):
    settings_store.save_stt_settings(
        settings_store.SttSettings(final_model="quality", device="cpu")
    )
    s = settings_store.load_stt_settings()
    assert s.final_model == "quality"
    assert s.local_model == "quality"  # local_model is kept in sync with final_model
    assert s.device == "cpu"


def test_invalid_values_are_sanitized(tmp_settings):
    s = settings_store.SttSettings(local_model="ultra", device="quantum").sanitized()
    assert s.local_model == "balanced"  # falls back to env default
    assert s.device == "auto"


def test_update_only_changes_given_fields(tmp_settings):
    settings_store.update_stt_settings(local_model="fast")
    s = settings_store.load_stt_settings()
    assert s.local_model == "fast"
    assert s.device == "auto"  # untouched


# --- device detection ----------------------------------------------------
def test_device_info_shape():
    info = stt_device.detect_device_info()
    assert "hasGpu" in info
    assert info["recommendedQuality"] in {"fast", "balanced", "quality"}
    assert info["recommendedDevice"] in {"cpu", "gpu"}
    # RAM is best-effort; either a positive number or None.
    assert info["totalRamGb"] is None or info["totalRamGb"] > 0


# --- download manager ----------------------------------------------------
def test_status_shape_for_quality():
    st = download_manager.status("balanced")
    assert st["quality"] == "balanced"
    assert st["modelId"] == "small"
    assert "downloaded" in st and "progress" in st
    assert 0.0 <= st["progress"] <= 1.0


def test_delete_missing_model_is_safe(tmp_path, monkeypatch):
    # Point the model cache at an empty tmp dir so nothing real is deleted.
    from app.services.stt import whisper_local_provider as wlp

    monkeypatch.setattr(wlp, "MODELS_DIR", tmp_path / "models")
    res = download_manager.delete("quality")
    assert res["deleted"] is False


# --- endpoints -----------------------------------------------------------
def test_device_endpoint():
    r = client.get("/stt/device")
    assert r.status_code == 200
    assert "recommendedQuality" in r.json()


def test_models_status_endpoint():
    r = client.get("/stt/models/fast/status")
    assert r.status_code == 200
    assert r.json()["modelId"] == "tiny"


def test_unknown_quality_returns_404():
    assert client.get("/stt/models/nonsense/status").status_code == 404
    assert client.delete("/stt/models/nonsense").status_code == 404


def test_diagnostics_endpoint():
    r = client.get("/stt/diagnostics")
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "whisper-local"
    assert "model" in body and "device" in body
    assert body["privacyDescription"]


def test_settings_endpoints_roundtrip(tmp_settings):
    r = client.get("/stt/settings")
    assert r.status_code == 200
    assert r.json()["local_model"] in {"fast", "balanced", "quality"}

    r2 = client.post("/stt/settings", json={"local_model": "quality"})
    assert r2.status_code == 200
    assert r2.json()["local_model"] == "quality"
