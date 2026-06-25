"""Speech-to-text provider layer.

Public surface is intentionally small: import the registry helpers and the
manifest from here.
"""

from .base import (
    PRIVACY_CLOUD,
    PRIVACY_LOCAL,
    RESOURCE_USAGE_LOCAL,
    ProviderDiagnostics,
    ProviderMode,
    TranscriptionProvider,
    TranscriptResult,
)
from .registry import (
    all_providers,
    build_whisper_provider,
    diagnostics,
    get_provider,
    resolve_default_provider,
)
from .whisper_models import (
    DEFAULT_QUALITY,
    WHISPER_MODELS,
    QualityLevel,
    manifest,
    recommend_for_device,
)

__all__ = [
    "PRIVACY_CLOUD",
    "PRIVACY_LOCAL",
    "RESOURCE_USAGE_LOCAL",
    "ProviderDiagnostics",
    "ProviderMode",
    "TranscriptionProvider",
    "TranscriptResult",
    "all_providers",
    "build_whisper_provider",
    "diagnostics",
    "get_provider",
    "resolve_default_provider",
    "DEFAULT_QUALITY",
    "WHISPER_MODELS",
    "QualityLevel",
    "manifest",
    "recommend_for_device",
]
