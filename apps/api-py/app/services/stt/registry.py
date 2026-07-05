"""Provider registry + default selection.

Локальный Whisper — движок по умолчанию (приватно, бесплатно). Опционально
подключаются облачные стриминговые движки: Deepgram Nova-3 и Яндекс SpeechKit v3
(быстрее и точнее на слабом железе, нужен API-ключ). Выбор — в настройках STT
(``engine``), live-сокет диспетчеризует раннер по нему.
"""

from __future__ import annotations

import threading

from .base import ProviderMode, TranscriptionProvider
from .settings_store import load_stt_settings
from .whisper_local_provider import WhisperLocalProvider, clear_model_cache
from .whisper_models import QualityLevel


def build_whisper_provider(*, role: str = "final") -> WhisperLocalProvider:
    """Build a Whisper provider for live or batch STT.

    ``role`` is ``partial`` (fast interim captions) or ``final`` (utterance pass).

    This always returns a *fresh* instance. The live streaming path wants its own
    per-session providers (it warms and reuses them for the whole connection). For
    one-shot/batch callers that run many transcriptions back-to-back (Test Lab,
    benchmark), use :func:`get_cached_whisper_provider` instead so the model is
    loaded once rather than reloaded — and re-timed — on every call.
    """
    st = load_stt_settings()
    quality = st.partial_model if role == "partial" else st.final_model
    return WhisperLocalProvider(quality=quality, device=st.device)


# Process-wide provider cache for one-shot/batch transcription. Keyed by the
# settings that actually change the loaded model so a settings change rebuilds.
_cached_providers: dict[tuple[str, str, str], WhisperLocalProvider] = {}
_cache_lock = threading.Lock()


def get_cached_whisper_provider(*, role: str = "final") -> WhisperLocalProvider:
    """Return a shared provider whose Whisper model stays loaded across calls.

    The first call loads the model (slow, one-time); subsequent calls reuse the
    same in-memory model. This is what keeps Test Lab / benchmark ``sttLatencyMs``
    measuring real inference instead of a per-case model reload.
    """
    st = load_stt_settings()
    quality = st.partial_model if role == "partial" else st.final_model
    key = (role, str(quality), str(st.device))
    with _cache_lock:
        provider = _cached_providers.get(key)
        if provider is None:
            provider = WhisperLocalProvider(quality=quality, device=st.device)
            _cached_providers[key] = provider
        return provider


def reset_cached_providers() -> None:
    """Drop cached providers and loaded models (e.g. after the STT model/device
    setting changes, so the next call reloads with the new configuration)."""
    with _cache_lock:
        _cached_providers.clear()
    clear_model_cache()


def _cloud_providers() -> list[TranscriptionProvider]:
    from .deepgram_stream import DeepgramProvider
    from .speechkit_stream import SpeechKitProvider

    return [DeepgramProvider(), SpeechKitProvider()]


def get_provider(provider_id: str) -> TranscriptionProvider:
    for provider in _cloud_providers():
        if provider.id == provider_id:
            return provider
    return build_whisper_provider(role="final")


def all_providers() -> list[TranscriptionProvider]:
    return [build_whisper_provider(role="final"), *_cloud_providers()]


# engine из настроек → id провайдера в реестре.
ENGINE_PROVIDER_IDS = {
    "deepgram": "deepgram-nova3",
    "speechkit": "yandex-speechkit-v3",
}


def resolve_default_provider() -> TranscriptionProvider:
    st = load_stt_settings()
    wanted = ENGINE_PROVIDER_IDS.get(st.engine)
    if wanted:
        for provider in _cloud_providers():
            if provider.id == wanted:
                return provider
    return build_whisper_provider(role="final")


def diagnostics() -> dict:
    st = load_stt_settings()
    providers = [p.get_diagnostics() for p in all_providers()]
    default = resolve_default_provider()
    return {
        "default": default.id,
        "engine": st.engine,
        "localModel": st.final_model,
        "partialModel": st.partial_model,
        "finalModel": st.final_model,
        "device": st.device,
        "providers": [d.as_dict() for d in providers],
    }


__all__ = [
    "ProviderMode",
    "QualityLevel",
    "get_provider",
    "all_providers",
    "resolve_default_provider",
    "diagnostics",
    "build_whisper_provider",
    "get_cached_whisper_provider",
    "reset_cached_providers",
]
