"""Renders icons/icon{16,32,48,128}.png: a white 中 on a vermilion rounded square.

    python3 scripts/make-icons.py [path/to/NotoSansCJK-Bold.ttc]
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
OUT = Path(__file__).resolve().parent.parent / "icons"
BG, FG = (200, 64, 42, 255), (255, 255, 255, 255)
SCALE = 8  # draw large, then downsample for clean edges

def icon(size):
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)
    font = ImageFont.truetype(FONT, int(s * 0.74), index=2)  # index 2 = SC in the .ttc
    l, t, r, b = d.textbbox((0, 0), "中", font=font)
    d.text(((s - (r - l)) / 2 - l, (s - (b - t)) / 2 - t), "中", font=font, fill=FG)
    return img.resize((size, size), Image.LANCZOS)

OUT.mkdir(exist_ok=True)
for size in (16, 32, 48, 128):
    icon(size).save(OUT / f"icon{size}.png")
print("icons written to", OUT)
