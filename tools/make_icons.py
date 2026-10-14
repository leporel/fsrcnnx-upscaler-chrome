"""Renders the extension icons: a coarse pixel block turning into a sharp
outline, on a teal-to-violet gradient tile.

Usage: python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
# Draw large and downsample for clean anti-aliased edges.
SUPERSAMPLE = 8
TEAL = (94, 234, 212)
VIOLET = (167, 139, 250)
INK = (8, 18, 22)
OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"


def gradient_tile(size: int) -> Image.Image:
    tile = Image.new("RGBA", (size, size))
    px = tile.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TEAL, VIOLET)) + (255,)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=size * 0.22, fill=255)
    tile.putalpha(mask)
    return tile


def render(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    img = gradient_tile(big)
    draw = ImageDraw.Draw(img)
    unit = big / 16

    # Coarse 2x2 "low-res" block, bottom-left.
    cell = unit * 2
    x0, y0 = unit * 3, unit * 7
    for i, j in ((0, 0), (1, 1), (0, 1)):
        draw.rectangle((x0 + i * cell, y0 + j * cell, x0 + (i + 1) * cell - unit * 0.4, y0 + (j + 1) * cell - unit * 0.4), fill=INK)

    # Sharp "high-res" frame, top-right.
    stroke = max(unit * 1.4, SUPERSAMPLE)
    draw.rounded_rectangle((unit * 6, unit * 3, unit * 13, unit * 10), radius=unit * 1.2, outline=INK, width=round(stroke))

    # Arrow from the block into the frame.
    draw.line((unit * 6.5, unit * 9.5, unit * 10, unit * 6), fill=INK, width=round(stroke))
    draw.polygon([(unit * 11, unit * 5), (unit * 7.6, unit * 5.4), (unit * 10.6, unit * 8.4)], fill=INK)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        render(size).save(OUT_DIR / f"icon-{size}.png")


if __name__ == "__main__":
    main()
