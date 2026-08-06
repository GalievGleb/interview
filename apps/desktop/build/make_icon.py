"""Generate deterministic Windows artwork for SkillCue.

Only the Python standard library is used, so developer machines and the
Windows release runner produce the same bytes:

- icon.ico: multi-resolution application icon;
- installerHeader.bmp: 150 x 57 assisted-installer header;
- installerSidebar.bmp: 164 x 314 install welcome/finish artwork;
- uninstallerSidebar.bmp: 164 x 314 uninstall welcome/finish artwork.

Run from the repository root with:

    python apps/desktop/build/make_icon.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ACCENT = (99, 102, 241, 255)
WHITE = (255, 255, 255, 255)
SIZES = [16, 32, 48, 64, 128, 256]

RGB = tuple[int, int, int]

NIGHT: RGB = (7, 18, 32)
NAVY_SOFT: RGB = (20, 52, 73)
INDIGO: RGB = (99, 102, 241)
EMERALD: RGB = (35, 207, 137)
ICE: RGB = (226, 244, 239)
WINDOW: RGB = (248, 250, 252)


def _png(size: int) -> bytes:
    radius = max(2, round(size * 0.22))
    center_x = center_y = (size - 1) / 2
    dot = size * 0.17
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            corner_x = min(max(x, radius), size - 1 - radius)
            corner_y = min(max(y, radius), size - 1 - radius)
            if (x - corner_x) ** 2 + (y - corner_y) ** 2 > radius * radius:
                rows += bytes((0, 0, 0, 0))
            elif (x - center_x) ** 2 + (y - center_y) ** 2 <= dot * dot:
                rows += bytes(WHITE)
            else:
                rows += bytes(ACCENT)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def _mix(left: RGB, right: RGB, amount: float) -> RGB:
    amount = min(1.0, max(0.0, amount))
    return (
        round(left[0] + (right[0] - left[0]) * amount),
        round(left[1] + (right[1] - left[1]) * amount),
        round(left[2] + (right[2] - left[2]) * amount),
    )


class _Canvas:
    """Small supersampled RGB canvas used to keep the bitmap edges smooth."""

    def __init__(self, width: int, height: int, scale: int = 3) -> None:
        self.output_width = width
        self.output_height = height
        self.scale = scale
        self.width = width * scale
        self.height = height * scale
        self.pixels = bytearray(self.width * self.height * 3)

    def _write(self, x: int, y: int, color: RGB) -> None:
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        offset = (y * self.width + x) * 3
        self.pixels[offset : offset + 3] = bytes(color)

    def _read(self, x: int, y: int) -> RGB:
        offset = (y * self.width + x) * 3
        return (
            self.pixels[offset],
            self.pixels[offset + 1],
            self.pixels[offset + 2],
        )

    def blend(self, x: int, y: int, color: RGB, alpha: float = 1.0) -> None:
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        self._write(x, y, _mix(self._read(x, y), color, alpha))

    def fill_gradient(self, top: RGB, bottom: RGB, side_glow: RGB | None = None) -> None:
        for y in range(self.height):
            vertical = y / max(1, self.height - 1)
            base = _mix(top, bottom, vertical)
            for x in range(self.width):
                color = base
                if side_glow is not None:
                    diagonal = max(0.0, (x / self.width) - vertical * 0.35)
                    color = _mix(color, side_glow, diagonal * 0.13)
                self._write(x, y, color)

    def fill_horizontal_gradient(self, left: RGB, right: RGB, start: float = 0.0) -> None:
        start_x = self.width * start
        span = max(1.0, self.width - start_x)
        for y in range(self.height):
            for x in range(self.width):
                amount = min(1.0, max(0.0, (x - start_x) / span))
                smooth = amount * amount * (3.0 - 2.0 * amount)
                self._write(x, y, _mix(left, right, smooth))

    def line(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        thickness: float,
        color: RGB,
        alpha: float = 1.0,
    ) -> None:
        x1, y1 = start[0] * self.scale, start[1] * self.scale
        x2, y2 = end[0] * self.scale, end[1] * self.scale
        radius = thickness * self.scale / 2
        min_x = max(0, int(min(x1, x2) - radius - 1))
        max_x = min(self.width, int(max(x1, x2) + radius + 2))
        min_y = max(0, int(min(y1, y2) - radius - 1))
        max_y = min(self.height, int(max(y1, y2) + radius + 2))
        delta_x, delta_y = x2 - x1, y2 - y1
        length_squared = delta_x * delta_x + delta_y * delta_y
        for y in range(min_y, max_y):
            for x in range(min_x, max_x):
                if length_squared == 0:
                    projection = 0.0
                else:
                    projection = (
                        (x - x1) * delta_x + (y - y1) * delta_y
                    ) / length_squared
                    projection = min(1.0, max(0.0, projection))
                nearest_x = x1 + projection * delta_x
                nearest_y = y1 + projection * delta_y
                if (x - nearest_x) ** 2 + (y - nearest_y) ** 2 <= radius * radius:
                    self.blend(x, y, color, alpha)

    def circle(
        self,
        center: tuple[float, float],
        radius: float,
        color: RGB,
        alpha: float = 1.0,
    ) -> None:
        center_x, center_y = center[0] * self.scale, center[1] * self.scale
        scaled_radius = radius * self.scale
        min_x = max(0, int(center_x - scaled_radius - 1))
        max_x = min(self.width, int(center_x + scaled_radius + 2))
        min_y = max(0, int(center_y - scaled_radius - 1))
        max_y = min(self.height, int(center_y + scaled_radius + 2))
        for y in range(min_y, max_y):
            for x in range(min_x, max_x):
                if (x - center_x) ** 2 + (y - center_y) ** 2 <= scaled_radius**2:
                    self.blend(x, y, color, alpha)

    def ring(
        self,
        center: tuple[float, float],
        radius: float,
        thickness: float,
        color: RGB,
        alpha: float = 1.0,
    ) -> None:
        center_x, center_y = center[0] * self.scale, center[1] * self.scale
        scaled_radius = radius * self.scale
        half = thickness * self.scale / 2
        outer = scaled_radius + half
        inner = max(0.0, scaled_radius - half)
        min_x = max(0, int(center_x - outer - 1))
        max_x = min(self.width, int(center_x + outer + 2))
        min_y = max(0, int(center_y - outer - 1))
        max_y = min(self.height, int(center_y + outer + 2))
        for y in range(min_y, max_y):
            for x in range(min_x, max_x):
                distance_squared = (x - center_x) ** 2 + (y - center_y) ** 2
                if inner * inner <= distance_squared <= outer * outer:
                    self.blend(x, y, color, alpha)

    def rounded_rect(
        self,
        box: tuple[float, float, float, float],
        radius: float,
        color: RGB,
        alpha: float = 1.0,
    ) -> None:
        left, top, right, bottom = (value * self.scale for value in box)
        scaled_radius = radius * self.scale
        min_x = max(0, int(left))
        max_x = min(self.width, int(right + 1))
        min_y = max(0, int(top))
        max_y = min(self.height, int(bottom + 1))
        for y in range(min_y, max_y):
            for x in range(min_x, max_x):
                nearest_x = min(max(x, left + scaled_radius), right - scaled_radius)
                nearest_y = min(max(y, top + scaled_radius), bottom - scaled_radius)
                if (x - nearest_x) ** 2 + (y - nearest_y) ** 2 <= scaled_radius**2:
                    self.blend(x, y, color, alpha)

    def to_bmp(self) -> bytes:
        downsampled: list[list[RGB]] = []
        samples = self.scale * self.scale
        for output_y in range(self.output_height):
            row: list[RGB] = []
            for output_x in range(self.output_width):
                red = green = blue = 0
                for sample_y in range(self.scale):
                    for sample_x in range(self.scale):
                        color = self._read(
                            output_x * self.scale + sample_x,
                            output_y * self.scale + sample_y,
                        )
                        red += color[0]
                        green += color[1]
                        blue += color[2]
                row.append(
                    (
                        round(red / samples),
                        round(green / samples),
                        round(blue / samples),
                    )
                )
            downsampled.append(row)

        stride = ((self.output_width * 3 + 3) // 4) * 4
        pixel_bytes = bytearray()
        padding = bytes(stride - self.output_width * 3)
        for row in reversed(downsampled):
            for red, green, blue in row:
                pixel_bytes += bytes((blue, green, red))
            pixel_bytes += padding

        pixel_offset = 14 + 40
        file_size = pixel_offset + len(pixel_bytes)
        file_header = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, pixel_offset)
        info_header = struct.pack(
            "<IiiHHIIiiII",
            40,
            self.output_width,
            self.output_height,
            1,
            24,
            0,
            len(pixel_bytes),
            2835,
            2835,
            0,
            0,
        )
        return file_header + info_header + bytes(pixel_bytes)


def _brand_mark(canvas: _Canvas, x: float, y: float, size: float) -> None:
    canvas.rounded_rect((x, y, x + size, y + size), size * 0.26, NAVY_SOFT, 0.94)
    canvas.ring(
        (x + size * 0.5, y + size * 0.5),
        size * 0.42,
        1.0,
        ICE,
        0.18,
    )
    canvas.circle((x + size * 0.43, y + size * 0.5), size * 0.22, INDIGO, 0.96)
    canvas.circle((x + size * 0.61, y + size * 0.5), size * 0.22, EMERALD, 0.95)
    canvas.circle((x + size * 0.52, y + size * 0.5), size * 0.09, ICE)


def _installer_header() -> bytes:
    canvas = _Canvas(150, 57)
    canvas.fill_horizontal_gradient(WINDOW, NIGHT, start=0.24)
    canvas.line((61, 57), (116, 0), 1.0, INDIGO, 0.22)
    canvas.ring((131, 29), 26, 1.2, EMERALD, 0.26)
    canvas.ring((116, 18), 31, 1.0, INDIGO, 0.22)
    _brand_mark(canvas, 108, 9, 39)
    return canvas.to_bmp()


def _installer_sidebar(uninstall: bool = False) -> bytes:
    canvas = _Canvas(164, 314)
    top = (8, 20, 35) if not uninstall else (11, 20, 38)
    bottom = (10, 39, 55) if not uninstall else (19, 29, 55)
    canvas.fill_gradient(top, bottom, INDIGO)

    # Structure the image without competing with the native copy beside it.
    for x in (20, 52, 84, 116, 148):
        canvas.line((x, 0), (x, 314), 0.45, ICE, 0.055)
    for y in range(26, 314, 32):
        canvas.line((0, y), (164, y), 0.45, ICE, 0.045)

    orbit_color = INDIGO if not uninstall else EMERALD
    secondary_color = EMERALD if not uninstall else INDIGO
    canvas.ring((158, 73), 103, 2.0, orbit_color, 0.34)
    canvas.ring((8, 267), 91, 1.1, secondary_color, 0.22)
    canvas.line((25, 117), (124, 231), 1.0, orbit_color, 0.36)
    canvas.line((124, 231), (55, 280), 1.0, secondary_color, 0.28)

    _brand_mark(canvas, 22, 24, 48)

    cue_cards = [
        (24, 128, 132, 151, 35, orbit_color),
        (36, 164, 141, 187, 117, secondary_color),
        (20, 200, 125, 223, 44, orbit_color),
    ]
    if uninstall:
        cue_cards.reverse()
    for index, (left, top_y, right, bottom_y, dot_x, color) in enumerate(cue_cards):
        canvas.rounded_rect((left, top_y, right, bottom_y), 7, NAVY_SOFT, 0.72)
        canvas.circle((dot_x, top_y + 11.5), 3.2, color, 0.94)
        line_start = min(left + 28, right - 24)
        canvas.line(
            (line_start, top_y + 9),
            (right - 11 - index * 8, top_y + 9),
            2.0,
            ICE,
            0.56,
        )
        canvas.line(
            (line_start, top_y + 15),
            (right - 25 - index * 5, top_y + 15),
            1.3,
            ICE,
            0.20,
        )

    canvas.circle((55, 280), 5.2, secondary_color, 0.92)
    canvas.circle((55, 280), 2.0, ICE)
    return canvas.to_bmp()


def main() -> None:
    output = Path(__file__).parent / "icon.ico"
    icon_source = output.parent.parent / "assets" / "branding" / "skillcue-app-icon.ico"
    output.write_bytes(icon_source.read_bytes())

    assets = {
        "installerHeader.bmp": _installer_header(),
        "installerSidebar.bmp": _installer_sidebar(),
        "uninstallerSidebar.bmp": _installer_sidebar(uninstall=True),
    }
    for name, content in assets.items():
        (output.parent / name).write_bytes(content)

    written = ", ".join([output.name, *assets])
    print(f"wrote {written} (SkillCue flag application icon)")


if __name__ == "__main__":
    main()
