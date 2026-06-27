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


# --- cached provider (Test Lab / batch reuse) ----------------------------
def test_cached_provider_returns_same_instance():
    registry.reset_cached_providers()
    a = registry.get_cached_whisper_provider()
    b = registry.get_cached_whisper_provider()
    assert a is b  # model stays loaded across calls instead of reloading


def test_build_provider_is_not_cached():
    # The live path deliberately gets fresh per-session instances.
    assert registry.build_whisper_provider() is not registry.build_whisper_provider()


def test_reset_cached_providers_forces_rebuild():
    first = registry.get_cached_whisper_provider()
    registry.reset_cached_providers()
    second = registry.get_cached_whisper_provider()
    assert first is not second


def test_cached_provider_loads_model_once(monkeypatch):
    """The model must load on first use and be reused after — this is the fix
    for the ~16s fixed STT overhead caused by reloading per case."""
    registry.reset_cached_providers()
    provider = registry.get_cached_whisper_provider()

    load_calls = {"n": 0}
    sentinel = object()

    def fake_load(*, force_cpu: bool = False):
        if provider._model is not None and not force_cpu:
            return provider._model
        load_calls["n"] += 1
        provider._model = sentinel
        return sentinel

    monkeypatch.setattr(provider, "_load_model", fake_load)

    provider.prepare()
    provider.prepare()  # no-op: already loaded
    assert load_calls["n"] == 1
    assert provider._model is sentinel


def test_diagnostics_shape():
    diag = registry.diagnostics()
    assert diag["default"] == "whisper-local"
    assert "allowCloudFallback" not in diag
    assert [p["mode"] for p in diag["providers"]] == ["local"]
    # Every provider explains its privacy posture.
    assert all(p["privacyDescription"] for p in diag["providers"])
