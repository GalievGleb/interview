"""Generate apps/desktop/build/icon.ico — the multi-resolution SkillCue mark
(indigo rounded square + white centre dot, the app's status-dot motif).

    python apps/desktop/build/make_icon.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ACCENT = (99, 102, 241, 255)
WHITE = (255, 255, 255, 255)
SIZES = [16, 32, 48, 64, 128, 256]


def _png(size: int) -> bytes:
    r = max(2, round(size * 0.22))  # corner radius
    cx = cy = (size - 1) / 2
    dot = size * 0.17  # centre dot radius
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter byte (none)
        for x in range(size):
            qx = min(max(x, r), size - 1 - r)
            qy = min(max(y, r), size - 1 - r)
            if (x - qx) ** 2 + (y - qy) ** 2 > r * r:
                rows += bytes((0, 0, 0, 0))  # outside the rounded square
            elif (x - cx) ** 2 + (y - cy) ** 2 <= dot * dot:
                rows += bytes(WHITE)
            else:
                rows += bytes(ACCENT)

    def chunk(typ: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    pngs = [(s, _png(s)) for s in SIZES]
    out = Path(__file__).parent / "icon.ico"
    entries = bytearray()
    data = bytearray()
    offset = 6 + 16 * len(pngs)
    for s, png in pngs:
        wh = 0 if s >= 256 else s  # 0 means 256 in the ICO dir
        entries += struct.pack("<BBBBHHII", wh, wh, 0, 0, 1, 32, len(png), offset)
        data += png
        offset += len(png)
    out.write_bytes(struct.pack("<HHH", 0, 1, len(pngs)) + bytes(entries) + bytes(data))
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(pngs)} sizes)")


if __name__ == "__main__":
    main()
