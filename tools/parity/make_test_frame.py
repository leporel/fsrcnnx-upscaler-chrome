"""Generates test-frame.png, the synthetic source frame of the parity pages.

A decoded PNG is bit-identical in every Chrome configuration, unlike shapes
drawn with canvas 2D, whose anti-aliasing depends on the ANGLE backend.

Usage: python tools/parity/make_test_frame.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SRC_W, SRC_H = 240, 135
# Rendered 4x larger and downsampled so edges get smooth, video-like gradients.
SUPERSAMPLE = 4


def main() -> None:
    s = SUPERSAMPLE
    img = Image.new("RGB", (SRC_W * s, SRC_H * s), "#204060")
    draw = ImageDraw.Draw(img)
    try:
        big = ImageFont.truetype("arialbd.ttf", 22 * s)
        small = ImageFont.truetype("times.ttf", 11 * s)
    except OSError:
        big = small = ImageFont.load_default()
    draw.text((20 * s, 20 * s), "FSRCNNX test", font=big, fill="#f0e0c0")
    for i in range(8):
        draw.line([((20 + i * 12) * s, 60 * s), ((60 + i * 18) * s, 125 * s)], fill="#ff5050", width=2 * s)
    draw.ellipse([160 * s, 60 * s, 220 * s, 120 * s], fill="#50ff90")
    draw.text((120 * s, 116 * s), "small text sample 0123", font=small, fill="#000000")
    img.resize((SRC_W, SRC_H), Image.Resampling.LANCZOS).save(HERE / "test-frame.png", optimize=True)


if __name__ == "__main__":
    main()
