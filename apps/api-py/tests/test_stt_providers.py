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
def test_manifest_has_expected_quality_tiers():
    qualities = {m["quality"] for m in manifest()}
    assert qualities == {"fast", "balanced", "quality", "max"}


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


def test_registry_exposes_local_plus_optional_cloud():
    # Local Whisper — обязателен и первый; облачные (Deepgram/SpeechKit) —
    # опциональные, без ключа помечаются unavailable, но в реестре видны.
    providers = registry.all_providers()
    ids = [p.id for p in providers]
    assert ids[0] == "whisper-local"
    assert set(ids) == {"whisper-local", "deepgram-nova3", "yandex-speechkit-v3"}


def test_unknown_provider_id_resolves_to_whisper():
    assert registry.get_provider("???").id == "whisper-local"
    assert registry.get_provider("deepgram-nova3").id == "deepgram-nova3"


def test_default_provider_is_local_unless_engine_switched():
    from app.services.stt.settings_store import load_stt_settings

    if load_stt_settings().engine == "whisper":
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


# --- hallucination filter ------------------------------------------------
def test_hallucination_filter_drops_subtitle_credits():
    from app.services.stt.whisper_local_provider import _is_hallucination

    junk = [
        "Субтитры создавал DimaTorzok",
        "Субтитры субтитров Н.Новикова",
        "Субтитры субтитры субтитры субтитры субтитры",
        "ПОДПИСЫВАЙТЕСЬ на канал",
        "Спасибо за просмотр",
        "Редактор субтитров А.Семкин",
    ]
    for t in junk:
        assert _is_hallucination(t), t


def test_hallucination_filter_keeps_real_questions():
    from app.services.stt.whisper_local_provider import _is_hallucination

    real = [
        "Что такое Page Object Model?",
        "Какие бывают техники тест-дизайна",
        "Расскажите про pytest фикстуры и conftest",
        "Что делать если вы нашли баг на проде",
    ]
    for t in real:
        assert not _is_hallucination(t), t


def test_diagnostics_shape():
    diag = registry.diagnostics()
    assert diag["default"] == "whisper-local"
    assert diag["engine"] in {"whisper", "deepgram", "speechkit"}
    assert "allowCloudFallback" not in diag
    modes = [p["mode"] for p in diag["providers"]]
    assert modes[0] == "local"  # локальный движок всегда первый
    assert set(modes) == {"local", "cloud"}
    # Every provider explains its privacy posture.
    assert all(p["privacyDescription"] for p in diag["providers"])
