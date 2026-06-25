"""Provider registry + default selection.

The product runs **on-device Whisper only**. Deepgram has been removed; there is
no cloud STT provider and no Ollama in the live path. The registry stays as a
small seam so a future optional provider could be added without touching call
sites.
"""

from __future__ import annotations

from .base import ProviderMode, TranscriptionProvider
from .settings_store import load_stt_settings
from .whisper_local_provider import WhisperLocalProvider
from .whisper_models import QualityLevel


def build_whisper_provider() -> WhisperLocalProvider:
    st = load_stt_settings()
    return WhisperLocalProvider(
        quality=st.local_model,
        device=st.device,
    )


def get_provider(provider_id: str) -> TranscriptionProvider:
    # Only local Whisper exists; everything resolves to it.
    return build_whisper_provider()


def all_providers() -> list[TranscriptionProvider]:
    return [build_whisper_provider()]


def resolve_default_provider() -> TranscriptionProvider:
    """The default (and only) engine is local Whisper."""
    return build_whisper_provider()


def diagnostics() -> dict:
    st = load_stt_settings()
    providers = [p.get_diagnostics() for p in all_providers()]
    default = resolve_default_provider()
    return {
        "default": default.id,
        "localModel": st.local_model,
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
]
