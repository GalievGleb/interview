"""Local Whisper model manifest.

The manifest is the single source of truth for the onboarding model cards and
the Speech-Recognition settings screen. Sizes are **approximate** on purpose —
the actual download size is resolved at download time, we never claim a fake
exact number.

We target ``faster-whisper`` (CTranslate2) model identifiers. faster-whisper
resolves a bare size string (e.g. ``"small"``) to the corresponding
``Systran/faster-whisper-<size>`` repository on Hugging Face and caches it
locally, so ``model_id`` doubles as the download resolver key.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class QualityLevel(str, Enum):
    FAST = "fast"
    BALANCED = "balanced"
    QUALITY = "quality"
    MAX = "max"


@dataclass(frozen=True)
class WhisperModelSpec:
    quality: QualityLevel
    model_id: str  # faster-whisper size string / resolver key
    label: str
    description: str
    approx_download_mb: int  # approximate, shown with a "~"
    recommended_ram_gb: int
    recommended_device: str  # "cpu" | "gpu" | "any"
    expected_speed: str  # human label
    download_repo: str  # Hugging Face repo the resolver pulls from

    def as_dict(self) -> dict:
        return {
            "quality": self.quality.value,
            "modelId": self.model_id,
            "label": self.label,
            "description": self.description,
            "approxDownloadMb": self.approx_download_mb,
            "recommendedRamGb": self.recommended_ram_gb,
            "recommendedDevice": self.recommended_device,
            "expectedSpeed": self.expected_speed,
            "downloadRepo": self.download_repo,
        }


WHISPER_MODELS: tuple[WhisperModelSpec, ...] = (
    WhisperModelSpec(
        quality=QualityLevel.FAST,
        model_id="tiny",
        label="Fast",
        description=(
            "For weak laptops or battery mode. Lowest resource usage and "
            "fastest startup, lower accuracy on technical terms. Best for "
            "quick testing or older machines."
        ),
        approx_download_mb=75,
        recommended_ram_gb=2,
        recommended_device="cpu",
        expected_speed="fastest",
        download_repo="Systran/faster-whisper-tiny",
    ),
    WhisperModelSpec(
        quality=QualityLevel.BALANCED,
        model_id="small",
        label="Balanced",
        description=(
            "For most modern laptops. Good speed/accuracy balance and the "
            "recommended default for live interviews. Good for QA/Python "
            "terms together with glossary correction."
        ),
        approx_download_mb=480,
        recommended_ram_gb=4,
        recommended_device="any",
        expected_speed="balanced",
        download_repo="Systran/faster-whisper-small",
    ),
    WhisperModelSpec(
        quality=QualityLevel.QUALITY,
        model_id="medium",
        label="Quality",
        description=(
            "For powerful laptops/desktops. Better accuracy with higher "
            "CPU/GPU and memory usage. Better for noisy audio or difficult "
            "terminology."
        ),
        approx_download_mb=1500,
        recommended_ram_gb=8,
        recommended_device="gpu",
        expected_speed="slower",
        download_repo="Systran/faster-whisper-medium",
    ),
    WhisperModelSpec(
        quality=QualityLevel.MAX,
        model_id="large-v3",
        label="Max accuracy",
        description=(
            "Best accuracy on Russian and technical terms. Requires an NVIDIA "
            "GPU to stay fast (about a second per question on a modern GPU; very "
            "slow on CPU). Largest download. Recommended when a GPU is available."
        ),
        approx_download_mb=3100,
        recommended_ram_gb=10,
        recommended_device="gpu",
        expected_speed="gpu-only",
        download_repo="Systran/faster-whisper-large-v3",
    ),
)

DEFAULT_QUALITY = QualityLevel.BALANCED

_BY_QUALITY = {m.quality: m for m in WHISPER_MODELS}
_BY_MODEL_ID = {m.model_id: m for m in WHISPER_MODELS}


def get_model_spec(quality: QualityLevel | str) -> WhisperModelSpec:
    """Resolve a quality level (or raw model id) to a spec, defaulting safely."""
    if isinstance(quality, str):
        if quality in _BY_MODEL_ID:
            return _BY_MODEL_ID[quality]
        try:
            quality = QualityLevel(quality)
        except ValueError:
            quality = DEFAULT_QUALITY
    return _BY_QUALITY.get(quality, _BY_QUALITY[DEFAULT_QUALITY])


def manifest() -> list[dict]:
    return [m.as_dict() for m in WHISPER_MODELS]


def recommend_for_device(*, total_ram_gb: float | None, has_gpu: bool) -> QualityLevel:
    """'Auto choose for my device' — pick a safe default.

    Prefers Balanced when unsure, falls back to Fast on weak devices, and only
    suggests Quality when there is clearly enough headroom.
    """
    if total_ram_gb is None:
        return DEFAULT_QUALITY  # unsure -> Balanced
    if total_ram_gb < 4:
        return QualityLevel.FAST
    if has_gpu and total_ram_gb >= 16:
        return QualityLevel.QUALITY
    return QualityLevel.BALANCED
