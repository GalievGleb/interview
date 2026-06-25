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


def build_whisper_provider(*, role: str = "final") -> WhisperLocalProvider:
    """Build a Whisper provider for live or batch STT.

    ``role`` is ``partial`` (fast interim captions) or ``final`` (utterance pass).
    """
    st = load_stt_settings()
    quality = st.partial_model if role == "partial" else st.final_model
    return WhisperLocalProvider(quality=quality, device=st.device)


def get_provider(provider_id: str) -> TranscriptionProvider:
    return build_whisper_provider(role="final")


def all_providers() -> list[TranscriptionProvider]:
    return [build_whisper_provider(role="final")]


def resolve_default_provider() -> TranscriptionProvider:
    return build_whisper_provider(role="final")


def diagnostics() -> dict:
    st = load_stt_settings()
    providers = [p.get_diagnostics() for p in all_providers()]
    default = resolve_default_provider()
    return {
        "default": default.id,
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
]
