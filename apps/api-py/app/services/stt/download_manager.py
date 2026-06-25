"""In-memory model download manager.

faster-whisper downloads happen inside ``WhisperModel(...)`` construction. We
run that in a background daemon thread so the request returns immediately, and
expose coarse progress by measuring on-disk bytes against the manifest's
approximate size. This is deliberately simple and dependency-free; it is enough
to drive a progress bar, a cancel/retry, and a "downloaded" state in the UI.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from dataclasses import dataclass, field

from .whisper_local_provider import WhisperLocalProvider
from .whisper_models import QualityLevel, get_model_spec

logger = logging.getLogger("stt.download")


@dataclass
class DownloadState:
    quality: str
    status: str = "idle"  # idle | downloading | ready | error
    error: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    _thread: threading.Thread | None = field(default=None, repr=False)


class DownloadManager:
    def __init__(self) -> None:
        self._states: dict[str, DownloadState] = {}
        self._lock = threading.Lock()

    def _state(self, quality: str) -> DownloadState:
        return self._states.setdefault(quality, DownloadState(quality=quality))

    def _dir_size_bytes(self, provider: WhisperLocalProvider) -> int:
        d = provider.model_dir()
        if not d.is_dir():
            return 0
        total = 0
        for f in d.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                continue
        return total

    def start(self, quality: QualityLevel | str) -> dict:
        spec = get_model_spec(quality)
        q = spec.quality.value
        with self._lock:
            state = self._state(q)
            provider = WhisperLocalProvider(quality=q, device="auto")
            if provider.is_model_downloaded():
                state.status = "ready"
                return self.status(q)
            if state.status == "downloading" and state._thread and state._thread.is_alive():
                return self.status(q)
            if not provider.is_available():
                state.status = "error"
                state.error = (
                    "faster-whisper is not installed — run "
                    "`pip install -r requirements-whisper.txt`"
                )
                return self.status(q)

            state.status = "downloading"
            state.error = None
            state.started_at = time.time()
            state.finished_at = None

            def _run() -> None:
                try:
                    WhisperLocalProvider(quality=q, device="auto").prepare()
                    state.status = "ready"
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Whisper model download failed (%s): %s", q, exc)
                    state.status = "error"
                    state.error = str(exc)
                finally:
                    state.finished_at = time.time()

            thread = threading.Thread(target=_run, name=f"whisper-dl-{q}", daemon=True)
            state._thread = thread
            thread.start()
        return self.status(q)

    def status(self, quality: QualityLevel | str) -> dict:
        spec = get_model_spec(quality)
        q = spec.quality.value
        provider = WhisperLocalProvider(quality=q, device="auto")
        state = self._state(q)

        downloaded = provider.is_model_downloaded()
        if downloaded and state.status != "downloading":
            state.status = "ready"

        expected_bytes = spec.approx_download_mb * 1024 * 1024
        on_disk = self._dir_size_bytes(provider)
        if downloaded:
            progress = 1.0
        elif state.status == "downloading" and expected_bytes:
            progress = min(0.99, on_disk / expected_bytes)
        else:
            progress = 0.0

        return {
            "quality": q,
            "modelId": spec.model_id,
            "status": state.status,
            "downloaded": downloaded,
            "progress": round(progress, 3),
            "onDiskMb": round(on_disk / (1024 * 1024), 1),
            "approxDownloadMb": spec.approx_download_mb,
            "error": state.error,
        }

    def delete(self, quality: QualityLevel | str) -> dict:
        spec = get_model_spec(quality)
        q = spec.quality.value
        provider = WhisperLocalProvider(quality=q, device="auto")
        with self._lock:
            state = self._state(q)
            if state.status == "downloading":
                return {"quality": q, "deleted": False, "reason": "download in progress"}
            d = provider.model_dir()
            existed = d.is_dir()
            if existed:
                shutil.rmtree(d, ignore_errors=True)
            state.status = "idle"
            state.error = None
        return {"quality": q, "deleted": existed}


# Process-wide singleton.
download_manager = DownloadManager()
