"""Pre-download a Whisper model into dist/models for offline bundling.

The desktop installer ships this directory as ``resources/models`` and the
packaged backend reads it via ``SKILLCUE_MODELS_DIR`` (see whisper_local_provider),
so the first run works with no network.

Usage:
    python predownload_models.py            # default: small (Balanced)
    python predownload_models.py tiny       # Fast
    python predownload_models.py medium     # Quality

ВАЖНО (Windows/CI): huggingface_hub раскладывает кэш через СИМЛИНКИ
(``snapshots/<rev>/model.bin`` → ``../../blobs/<sha>``). electron-builder/7za на
Windows не умеют паковать такие симлинки и падают с «The directory name is
invalid». Поэтому после скачивания симлинки разыменовываем (заменяем реальными
копиями) и удаляем ставшую ненужной папку ``blobs`` — установщик получает
обычные файлы, а faster-whisper грузит модель из ``snapshots`` как обычно.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


def _flatten_symlinks(root: Path) -> int:
    """Заменить все симлинки под root реальными копиями их целей. Вернуть счётчик."""
    replaced = 0
    for p in list(root.rglob("*")):
        if p.is_symlink():
            target = p.resolve()
            if not target.exists():
                continue  # битый симлинк — пропускаем
            p.unlink()
            shutil.copy2(target, p)
            replaced += 1
    # blobs/ backed the symlinks; snapshots теперь содержат реальные файлы —
    # удаляем blobs, чтобы не дублировать вес модели в установщике.
    for blobs in root.glob("models--*/blobs"):
        shutil.rmtree(blobs, ignore_errors=True)
    return replaced


def main() -> None:
    from faster_whisper import WhisperModel

    size = sys.argv[1] if len(sys.argv) > 1 else "small"
    out = Path(__file__).parent / "dist" / "models"
    out.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Whisper '{size}' into {out} …")
    # Same download_root layout the app expects (models--<org>--<name>/snapshots/…).
    WhisperModel(size, device="cpu", compute_type="int8", download_root=str(out))
    replaced = _flatten_symlinks(out)
    print(f"done (симлинков разыменовано: {replaced}, blobs удалены)")


if __name__ == "__main__":
    main()
