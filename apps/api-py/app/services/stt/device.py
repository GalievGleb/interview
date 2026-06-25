"""Best-effort device detection for the 'Auto choose for my device' flow.

Everything here degrades gracefully: if RAM can't be detected we return ``None``
and the recommender prefers Balanced. No hard dependency on psutil — we try it,
then fall back to a Windows ctypes call, then give up cleanly.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("stt.device")


def detect_total_ram_gb() -> float | None:
    # 1) psutil if available (most accurate, cross-platform).
    try:
        import psutil  # type: ignore

        return round(psutil.virtual_memory().total / (1024**3), 1)
    except Exception:  # noqa: BLE001
        pass

    # 2) POSIX sysconf (not available on Windows).
    try:
        sysconf_names = getattr(os, "sysconf_names", {})
        if hasattr(os, "sysconf") and "SC_PAGE_SIZE" in sysconf_names:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            return round((pages * page_size) / (1024**3), 1)
    except Exception:  # noqa: BLE001
        pass

    # 3) Windows ctypes.
    try:
        import ctypes

        class _MemStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = _MemStatus()
        stat.dwLength = ctypes.sizeof(_MemStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):  # type: ignore[attr-defined]
            return round(stat.ullTotalPhys / (1024**3), 1)
    except Exception:  # noqa: BLE001
        pass

    return None


def detect_gpu() -> bool:
    """True only if CTranslate2 reports a usable CUDA device."""
    try:
        import ctranslate2  # type: ignore

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        return False


def detect_device_info() -> dict:
    ram = detect_total_ram_gb()
    has_gpu = detect_gpu()
    from .whisper_models import recommend_for_device

    recommended = recommend_for_device(total_ram_gb=ram, has_gpu=has_gpu)
    return {
        "totalRamGb": ram,
        "cpuCount": os.cpu_count(),
        "hasGpu": has_gpu,
        "recommendedQuality": recommended.value,
        "recommendedDevice": "gpu" if has_gpu else "cpu",
    }
