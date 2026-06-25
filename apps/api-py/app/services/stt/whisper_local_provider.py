"""Local Whisper provider (faster-whisper / CTranslate2).

This is the **default, primary** transcription engine for the product. Audio is
transcribed on-device and never uploaded.

Hard rules honoured here:
* No cloud upload in local mode.
* ``faster-whisper`` is imported lazily, so the backend still starts and the
  rest of the app works even when the optional dependency or model is missing.
  In that case the provider reports ``is_available() == False`` with a clear
  reason instead of crashing — this is what enables a graceful fallback and the
  "download a model" onboarding prompt.
* No Ollama, no LLM, nothing asynchronous gating the transcript.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
from pathlib import Path

from app.config import DATA_DIR

# faster-whisper downloads via huggingface_hub. hf-xet can hang on some routes;
# disable it before the hub is imported. Symlink warnings on Windows are noisy.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from .base import BaseTranscriptionProvider, ProviderMode
from .whisper_models import DEFAULT_QUALITY, QualityLevel, get_model_spec

logger = logging.getLogger("stt.whisper")

# Local model cache lives under the app data dir so the UI can show size and
# offer "delete model" without touching the global HF cache.
MODELS_DIR = DATA_DIR / "whisper_models"


def _faster_whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception:  # noqa: BLE001 - optional dependency
        return False
    return True


def _cuda_runtime_ready() -> bool:
    """True only when CUDA device count > 0 and runtime DLLs (e.g. cuBLAS) load."""
    try:
        import ctranslate2  # type: ignore

        if ctranslate2.get_cuda_device_count() <= 0:
            return False
    except Exception:  # noqa: BLE001
        return False

    if os.name == "nt":
        import ctypes

        for dll in ("cublas64_12.dll", "cublas64_11.dll"):
            try:
                ctypes.WinDLL(dll)
                return True
            except OSError:
                continue
        return False

    return True


def _resolve_device(preference: str) -> tuple[str, str]:
    """Return ``(device, compute_type)`` for CTranslate2.

    ``preference`` is one of ``auto`` / ``cpu`` / ``gpu``. GPU is used only when
    CUDA runtime libraries are actually loadable; otherwise we fall back to CPU.
    """
    want_gpu = preference in ("gpu", "cuda", "auto")
    if want_gpu and _cuda_runtime_ready():
        return "cuda", "float16"
    if preference in ("gpu", "cuda"):
        logger.info("Whisper GPU requested but CUDA runtime unavailable; using CPU")
    return "cpu", "int8"


class WhisperLocalProvider(BaseTranscriptionProvider):
    id = "whisper-local"
    display_name = "Local Whisper"
    mode = ProviderMode.LOCAL

    def __init__(
        self,
        quality: QualityLevel | str = DEFAULT_QUALITY,
        *,
        device: str = "auto",
    ) -> None:
        super().__init__()
        self.spec = get_model_spec(quality)
        self.device_preference = device
        self._model = None  # cached faster_whisper.WhisperModel

    # --- capabilities -----------------------------------------------------
    def is_available(self) -> bool:
        return _faster_whisper_available()

    def _availability_reason(self) -> str:
        if not _faster_whisper_available():
            return "faster-whisper is not installed — run `pip install -r requirements-whisper.txt`"
        if not self.is_model_downloaded():
            return f"model '{self.spec.model_id}' is not downloaded yet"
        return "ready"

    @property
    def estimated_latency_ms(self) -> int:  # type: ignore[override]
        # Rough on-device figures; refined by the STT benchmark at runtime.
        return {
            QualityLevel.FAST: 300,
            QualityLevel.BALANCED: 700,
            QualityLevel.QUALITY: 1600,
        }.get(self.spec.quality, 700)

    def model_dir(self) -> Path:
        """Local cache directory for this model.

        faster-whisper resolves a bare size string through huggingface_hub,
        which stores the model under ``models--<org>--<name>/snapshots/<hash>/``
        inside ``download_root``. We point at that repo folder so "delete model"
        and "is downloaded" reason about the real on-disk layout.
        """
        cache_name = "models--" + self.spec.download_repo.replace("/", "--")
        return MODELS_DIR / cache_name

    def is_model_downloaded(self) -> bool:
        d = self.model_dir()
        if not d.is_dir():
            return False
        # The actual weights file is model.bin inside a snapshot dir.
        return any(d.glob("snapshots/*/model.bin")) or any(d.rglob("model.bin"))

    def _active_model(self) -> str:
        return f"whisper-{self.spec.model_id}"

    def _active_device(self) -> str | None:
        device, _ = _resolve_device(self.device_preference)
        return device

    # --- model lifecycle --------------------------------------------------
    def _load_model(self, *, force_cpu: bool = False):
        if self._model is not None and not force_cpu:
            return self._model
        from faster_whisper import WhisperModel  # lazy

        device, compute_type = ("cpu", "int8") if force_cpu else _resolve_device(self.device_preference)
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        logger.info(
            "Loading Whisper model=%s device=%s compute=%s",
            self.spec.model_id,
            device,
            compute_type,
        )
        self._model = WhisperModel(
            self.spec.model_id,
            device=device,
            compute_type=compute_type,
            download_root=str(MODELS_DIR),
        )
        return self._model

    def prepare(self) -> None:
        """Eagerly load (and, if needed, download) the model."""
        self._load_model()
        super().prepare()

    # --- transcription ----------------------------------------------------
    def _run_transcribe(self, model, audio, *, language: str | None) -> str:
        segments, _info = model.transcribe(
            audio,
            language=None if language in (None, "multi", "") else language,
            beam_size=1,
            vad_filter=True,
        )
        return "".join(seg.text for seg in segments).strip()

    def _transcribe_sync(self, audio, *, language: str | None) -> str:
        model = self._load_model()
        try:
            return self._run_transcribe(model, audio, language=language)
        except RuntimeError as exc:
            msg = str(exc).lower()
            if "cublas" in msg or "cuda" in msg:
                logger.warning("CUDA inference failed (%s); retrying on CPU", exc)
                self._model = None
                cpu_model = self._load_model(force_cpu=True)
                return self._run_transcribe(cpu_model, audio, language=language)
            raise

    async def _transcribe_file(
        self, audio: bytes, *, language: str | None, sample_rate: int
    ) -> str:
        # faster-whisper accepts a file-like; decoding (incl. WAV header) is
        # handled internally. Run off the event loop to avoid blocking.
        return await asyncio.to_thread(self._transcribe_sync, io.BytesIO(audio), language=language)

    async def transcribe_pcm16(
        self, pcm: bytes, *, language: str | None = None, sample_rate: int = 16000
    ) -> str:
        """Transcribe a buffered window of raw little-endian PCM16 mono.

        This is the entry point the live path calls once it has accumulated an
        utterance worth of audio frames. Whisper expects 16 kHz, so anything
        else (e.g. 48 kHz native capture) is resampled here.
        """
        import numpy as np  # lazy

        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if sample_rate != 16000 and samples.size:
            new_len = int(round(samples.size * 16000 / sample_rate))
            if new_len > 0:
                samples = np.interp(
                    np.linspace(0.0, samples.size, new_len, endpoint=False),
                    np.arange(samples.size),
                    samples,
                ).astype(np.float32)
        return await asyncio.to_thread(self._transcribe_sync, samples, language=language)
