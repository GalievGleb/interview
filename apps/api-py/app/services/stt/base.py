"""Small provider contract for the single OpenAI Mini transcription engine."""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable


class ProviderMode(str, Enum):
    CLOUD = "cloud"


# Plain-language privacy copy. Re-used verbatim by the UI so the legal/ethical
# disclosure stays consistent everywhere.
PRIVACY_CLOUD = "Аудио может отправляться стороннему провайдеру распознавания речи."


@dataclass
class TranscriptResult:
    """Result of a one-shot (file or buffered) transcription."""

    text: str
    latency_ms: int
    provider_id: str
    model: str
    language: str | None = None
    is_final: bool = True
    first_partial_ms: int | None = None
    total_request_ms: int | None = None
    benchmark_mode: str = "file-upload"


@dataclass
class ProviderDiagnostics:
    """Snapshot used by the diagnostics screen and the onboarding UI."""

    id: str
    display_name: str
    mode: ProviderMode
    available: bool
    reason: str = ""
    model: str | None = None
    device: str | None = None
    estimated_latency_ms: int | None = None
    privacy_description: str = ""
    resource_usage: str = ""
    last_error: str | None = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "displayName": self.display_name,
            "mode": self.mode.value,
            "available": self.available,
            "reason": self.reason,
            "model": self.model,
            "device": self.device,
            "estimatedLatencyMs": self.estimated_latency_ms,
            "privacyDescription": self.privacy_description,
            "resourceUsage": self.resource_usage,
            "lastError": self.last_error,
        }


@runtime_checkable
class TranscriptionProvider(Protocol):
    """Common contract for every STT engine (local or cloud).

    Mirrors the product spec's ``TranscriptionProvider`` interface:
    ``id / displayName / mode / isAvailable / prepare / transcribeAudioChunk /
    transcribeAudioFile / getDiagnostics / getEstimatedLatency /
    getPrivacyDescription``.
    """

    id: str
    display_name: str
    mode: ProviderMode

    def is_available(self) -> bool: ...

    def prepare(self) -> None: ...

    async def transcribe_audio_file(
        self, audio: bytes, *, language: str | None = None, sample_rate: int = 16000
    ) -> TranscriptResult: ...

    def get_diagnostics(self) -> ProviderDiagnostics: ...

    def get_estimated_latency_ms(self) -> int: ...

    def get_privacy_description(self) -> str: ...


class BaseTranscriptionProvider:
    """Shared bookkeeping so concrete providers stay small.

    Concrete providers override the ``_*`` hooks and the data attributes; the
    public methods here handle error capture and diagnostics assembly.
    """

    id: str = "base"
    display_name: str = "Base"
    mode: ProviderMode = ProviderMode.CLOUD
    estimated_latency_ms: int = 0

    def __init__(self) -> None:
        self._last_error: str | None = None
        self._prepared = False

    # --- capabilities -----------------------------------------------------
    def is_available(self) -> bool:  # pragma: no cover - overridden
        return False

    def _availability_reason(self) -> str:
        return "available" if self.is_available() else "unavailable"

    def prepare(self) -> None:
        self._prepared = True

    def get_estimated_latency_ms(self) -> int:
        return self.estimated_latency_ms

    def get_privacy_description(self) -> str:
        return PRIVACY_CLOUD

    def get_resource_usage(self) -> str:
        return ""

    # --- transcription ----------------------------------------------------
    async def transcribe_audio_file(
        self, audio: bytes, *, language: str | None = None, sample_rate: int = 16000
    ) -> TranscriptResult:
        started = time.perf_counter()
        try:
            text = await self._transcribe_file(audio, language=language, sample_rate=sample_rate)
            self._last_error = None
        except Exception as exc:  # noqa: BLE001 - surfaced via diagnostics
            self._last_error = str(exc)
            raise
        latency_ms = int((time.perf_counter() - started) * 1000)
        return TranscriptResult(
            text=text,
            latency_ms=latency_ms,
            provider_id=self.id,
            model=self._active_model(),
            language=language,
        )

    async def _transcribe_file(
        self, audio: bytes, *, language: str | None, sample_rate: int
    ) -> str:  # pragma: no cover - overridden
        raise NotImplementedError

    def _active_model(self) -> str:
        return self.display_name

    def _active_device(self) -> str | None:
        return None

    # --- diagnostics ------------------------------------------------------
    def get_diagnostics(self) -> ProviderDiagnostics:
        available = self.is_available()
        return ProviderDiagnostics(
            id=self.id,
            display_name=self.display_name,
            mode=self.mode,
            available=available,
            reason=self._availability_reason(),
            model=self._active_model() if available else None,
            device=self._active_device(),
            estimated_latency_ms=self.get_estimated_latency_ms(),
            privacy_description=self.get_privacy_description(),
            resource_usage=self.get_resource_usage(),
            last_error=self._last_error,
        )
