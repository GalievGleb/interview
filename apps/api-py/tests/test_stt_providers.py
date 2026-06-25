"""Tests for the STT provider abstraction, manifest, and registry policy.

The product is on-device Whisper only — Deepgram has been removed.
"""

from app.services.stt import (
    PRIVACY_LOCAL,
    ProviderMode,
    QualityLevel,
    manifest,
    recommend_for_device,
    registry,
)
from app.services.stt.whisper_models import DEFAULT_QUALITY, get_model_spec


# --- manifest ------------------------------------------------------------
def test_manifest_has_three_quality_tiers():
    qualities = {m["quality"] for m in manifest()}
    assert qualities == {"fast", "balanced", "quality"}


def test_manifest_entries_have_required_fields():
    required = {
        "quality",
        "modelId",
        "label",
        "description",
        "approxDownloadMb",
        "recommendedRamGb",
        "recommendedDevice",
        "expectedSpeed",
        "downloadRepo",
    }
    for m in manifest():
        assert required.issubset(m.keys())
        assert m["approxDownloadMb"] > 0


def test_default_quality_is_balanced():
    assert DEFAULT_QUALITY is QualityLevel.BALANCED


def test_get_model_spec_falls_back_safely():
    assert get_model_spec("nonsense").quality is DEFAULT_QUALITY
    assert get_model_spec("small").model_id == "small"
    assert get_model_spec(QualityLevel.FAST).model_id == "tiny"


# --- auto-choose ---------------------------------------------------------
def test_recommend_weak_device_picks_fast():
    assert recommend_for_device(total_ram_gb=2, has_gpu=False) is QualityLevel.FAST


def test_recommend_unknown_device_prefers_balanced():
    assert recommend_for_device(total_ram_gb=None, has_gpu=False) is QualityLevel.BALANCED


def test_recommend_strong_gpu_device_picks_quality():
    assert recommend_for_device(total_ram_gb=32, has_gpu=True) is QualityLevel.QUALITY


# --- registry policy -----------------------------------------------------
def test_whisper_is_local_and_default_id():
    w = registry.build_whisper_provider()
    assert w.id == "whisper-local"
    assert w.mode is ProviderMode.LOCAL
    assert w.get_privacy_description() == PRIVACY_LOCAL


def test_no_cloud_provider_exists():
    # Deepgram removed: the registry exposes only the local engine.
    ids = {p.id for p in registry.all_providers()}
    assert ids == {"whisper-local"}
    assert not hasattr(registry, "build_deepgram_provider")


def test_any_provider_id_resolves_to_whisper():
    assert registry.get_provider("???").id == "whisper-local"
    assert registry.get_provider("deepgram").id == "whisper-local"


def test_default_provider_is_always_local():
    assert registry.resolve_default_provider().mode is ProviderMode.LOCAL


def test_diagnostics_shape():
    diag = registry.diagnostics()
    assert diag["default"] == "whisper-local"
    assert "allowCloudFallback" not in diag
    assert [p["mode"] for p in diag["providers"]] == ["local"]
    # Every provider explains its privacy posture.
    assert all(p["privacyDescription"] for p in diag["providers"])
