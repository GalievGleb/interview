"""Pre-download a Whisper model into dist/models for offline bundling.

The desktop installer ships this directory as ``resources/models`` and the
packaged backend reads it via ``SKILLCUE_MODELS_DIR`` (see whisper_local_provider),
so the first run works with no network.

Usage:
    python predownload_models.py            # default: small (Balanced)
    python predownload_models.py tiny       # Fast
    python predownload_models.py medium     # Quality
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> None:
    from faster_whisper import WhisperModel

    size = sys.argv[1] if len(sys.argv) > 1 else "small"
    out = Path(__file__).parent / "dist" / "models"
    out.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Whisper '{size}' into {out} …")
    # Same download_root layout the app expects (models--<org>--<name>/snapshots/…).
    WhisperModel(size, device="cpu", compute_type="int8", download_root=str(out))
    print("done")


if __name__ == "__main__":
    main()
