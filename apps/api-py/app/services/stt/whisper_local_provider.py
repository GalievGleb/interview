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
import threading
from pathlib import Path

from app.config import DATA_DIR

# faster-whisper downloads via huggingface_hub. hf-xet can hang on some routes;
# disable it before the hub is imported. Symlink warnings on Windows are noisy.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from .base import BaseTranscriptionProvider, ProviderMode
from .whisper_models import DEFAULT_QUALITY, QualityLevel, get_model_spec

logger = logging.getLogger("stt.whisper")


def _register_cuda_dll_dirs() -> None:
    """Make CUDA runtime DLLs from the nvidia-* pip packages loadable on Windows.

    ctranslate2 needs cuBLAS + cuDNN at runtime to use the GPU. When these ship as
    pip wheels (nvidia-cublas-cu12 / nvidia-cudnn-cu12) the DLLs live under
    ``site-packages/nvidia/*/bin`` and are NOT on the DLL search path, so the GPU
    silently falls back to CPU. Registering those dirs here (and prepending them
    to PATH) lets both ``ctypes.WinDLL`` probing and ctranslate2's own loader find
    them — turning the GPU path on without any manual environment setup.
    """
    if os.name != "nt":
        return
    try:
        import sysconfig

        purelib = sysconfig.get_paths().get("purelib")
    except Exception:  # noqa: BLE001
        return
    if not purelib:
        return
    nvidia_root = Path(purelib) / "nvidia"
    if not nvidia_root.is_dir():
        return
    for bin_dir in nvidia_root.glob("*/bin"):
        if not bin_dir.is_dir():
            continue
        path_str = str(bin_dir)
        try:
            os.add_dll_directory(path_str)
        except OSError:
            continue
        if path_str not in os.environ.get("PATH", ""):
            os.environ["PATH"] = path_str + os.pathsep + os.environ.get("PATH", "")


_register_cuda_dll_dirs()

# Local model cache lives under the app data dir so the UI can show size and
# offer "delete model" without touching the global HF cache. A packaged build can
# point this at a bundled, pre-downloaded cache via SKILLCUE_MODELS_DIR so the
# first run works fully offline.
_ENV_MODELS_DIR = os.environ.get("SKILLCUE_MODELS_DIR")
MODELS_DIR = Path(_ENV_MODELS_DIR) if _ENV_MODELS_DIR else DATA_DIR / "whisper_models"


# Process-wide cache of loaded WhisperModel objects, keyed by what actually
# determines a distinct loaded model: (model_id, device, compute_type).
#
# The expensive part of loading is not reading the weights — it is initialising
# the backend (on GPU this includes the CUDA context + cuDNN autotuning, which
# can take 10–15s the FIRST time). Caching the model object here means that cost
# is paid once for the whole process, no matter how many provider instances are
# created (live sessions, Test Lab, benchmark). Without this, anything that built
# a fresh provider re-initialised CUDA from scratch — the real cause of the fixed
# ~15s per-case STT latency on GPU machines.
_MODEL_CACHE: dict[tuple[str, str, str], object] = {}
_MODEL_CACHE_LOCK = threading.Lock()


def _get_or_load_whisper_model(model_id: str, device: str, compute_type: str):
    key = (model_id, device, compute_type)
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached
        from faster_whisper import WhisperModel  # lazy

        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        logger.info(
            "Loading Whisper model=%s device=%s compute=%s (first load this process)",
            model_id,
            device,
            compute_type,
        )
        model = WhisperModel(
            model_id,
            device=device,
            compute_type=compute_type,
            download_root=str(MODELS_DIR),
        )
        _MODEL_CACHE[key] = model
        return model


def clear_model_cache() -> None:
    """Drop all loaded models (e.g. when the STT model/device setting changes)."""
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE.clear()


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
        device, compute_type = (
            ("cpu", "int8") if force_cpu else _resolve_device(self.device_preference)
        )
        # Reuse a process-wide loaded model so CUDA/cuDNN init is paid once,
        # not per provider instance. This is what makes repeated transcriptions
        # (Test Lab, benchmark, every live session) fast after the first load.
        self._model = _get_or_load_whisper_model(self.spec.model_id, device, compute_type)
        return self._model

    def prepare(self) -> None:
        """Eagerly load (and, if needed, download) the model."""
        self._load_model()
        super().prepare()

    # --- transcription ----------------------------------------------------
    def _run_transcribe(self, model, audio, *, language: str | None) -> str:
        # Speed-tuned for the live path: we run our OWN energy VAD + endpointing
        # upstream, so Whisper's Silero `vad_filter` is pure overhead (~+400ms
        # per call, ~3x on the fast partial model) and is disabled here.
        # condition_on_previous_text=False keeps each utterance independent and
        # faster; temperature=0 / no timestamps trim decode work.
        segments, _info = model.transcribe(
            audio,
            language=None if language in (None, "multi", "") else language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            temperature=0.0,
            without_timestamps=True,
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
