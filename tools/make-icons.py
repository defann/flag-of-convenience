#!/usr/bin/env python3
"""Generates the extension's default icons (a flag on a pole), no dependencies.

Draws with 4x supersampling and writes PNGs through zlib/struct.
Usage: python3 tools/make-icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZES = [16, 24, 32, 48, 128]
SS = 4  # supersampling factor
# The Web Store listing icon needs its artwork inset in a 128 px canvas.
STORE_ICON = ("store-icon128.png", 128, 0.75)

BG = (37, 99, 235)       # background gradient, top
BG2 = (29, 78, 216)      # background gradient, bottom
POLE = (255, 255, 255)
FLAG = (255, 255, 255)


def render(size: int, fill: float = 1.0) -> bytes:
    """Renders the icon. `fill` < 1 insets the artwork, leaving transparent
    margins, which is what the Chrome Web Store listing icon requires."""
    n = size * SS
    px = bytearray(n * n * 4)

    inset = n * (1 - fill) / 2
    span = n * fill

    def sx(f: float) -> float:
        return inset + span * f

    corner = span * 0.22
    x0, x1 = sx(0.0), sx(1.0)
    pole_x0, pole_x1 = sx(0.26), sx(0.34)
    pole_y0, pole_y1 = sx(0.16), sx(0.84)
    flag_x0, flag_x1 = pole_x1, sx(0.80)
    flag_y0, flag_y1 = sx(0.20), sx(0.52)
    notch = span * 0.10  # swallowtail cut on the right edge

    for y in range(n):
        t = y / n
        base = (
            round(BG[0] + (BG2[0] - BG[0]) * t),
            round(BG[1] + (BG2[1] - BG[1]) * t),
            round(BG[2] + (BG2[2] - BG[2]) * t),
        )
        for x in range(n):
            if not (x0 <= x < x1 and x0 <= y < x1):
                continue  # outside the artwork area
            # rounded square mask
            dx = max(x0 + corner - x, x - (x1 - 1 - corner), 0)
            dy = max(x0 + corner - y, y - (x1 - 1 - corner), 0)
            if dx * dx + dy * dy > corner * corner:
                continue  # transparent corner

            r, g, b = base
            if pole_x0 <= x < pole_x1 and pole_y0 <= y < pole_y1:
                r, g, b = POLE
            elif flag_x0 <= x < flag_x1 and flag_y0 <= y < flag_y1:
                fy = (y - flag_y0) / (flag_y1 - flag_y0)
                cut = notch * (1 - abs(fy - 0.5) * 2)
                if x < flag_x1 - cut:
                    r, g, b = FLAG

            i = (y * n + x) * 4
            px[i], px[i + 1], px[i + 2], px[i + 3] = r, g, b, 255

    # downsample by averaging each SS x SS block
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type "none"
        for x in range(size):
            rs = gs = bs = as_ = 0
            for sy in range(SS):
                for sx in range(SS):
                    i = ((y * SS + sy) * n + x * SS + sx) * 4
                    a = px[i + 3]
                    rs += px[i] * a
                    gs += px[i + 1] * a
                    bs += px[i + 2] * a
                    as_ += a
            if as_:
                out += bytes((rs // as_, gs // as_, bs // as_, as_ // (SS * SS)))
            else:
                out += b"\x00\x00\x00\x00"
    return bytes(out)


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def write_png(path: Path, size: int, raw: bytes) -> None:
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"{path} written")

    name, size, fill = STORE_ICON
    store_dir = OUT.parent / "store"
    store_dir.mkdir(exist_ok=True)
    write_png(store_dir / name, size, render(size, fill))
    print(f"{store_dir / name} written (artwork inset to {int(size * fill)} px)")


main()
