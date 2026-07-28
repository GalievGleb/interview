"""Registry for SkillCue's single speech-recognition provider."""

from __future__ import annotations

from .base import ProviderMode, TranscriptionProvider
from .openai_transcribe import OpenAiMiniTranscribeProvider
from .settings_store import STT_ENGINE, STT_MODEL

_provider: OpenAiMiniTranscribeProvider | None = None


def resolve_default_provider() -> OpenAiMiniTranscribeProvider:
    global _provider
    if _provider is None:
        _provider = OpenAiMiniTranscribeProvider()
    return _provider


def get_provider(_provider_id: str = "") -> OpenAiMiniTranscribeProvider:
    return resolve_default_provider()


def all_providers() -> list[TranscriptionProvider]:
    return [resolve_default_provider()]


def reset_cached_providers() -> None:
    global _provider
    _provider = None


def diagnostics() -> dict:
    provider = resolve_default_provider()
    return {
        "default": provider.id,
        "engine": STT_ENGINE,
        "model": STT_MODEL,
        "providers": [provider.get_diagnostics().as_dict()],
    }


__all__ = [
    "ProviderMode",
    "all_providers",
    "diagnostics",
    "get_provider",
    "reset_cached_providers",
    "resolve_default_provider",
]
