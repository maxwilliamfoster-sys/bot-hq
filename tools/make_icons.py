"""Draw the Bot HQ app icons: three bot-coloured bars and a red signal dot on navy."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
NAVY = (21, 32, 43)
BARS = [((47, 91, 234), 0.62), ((201, 138, 0), 0.46), ((18, 163, 154), 0.54)]  # chess, bcf, escape
RED = (229, 56, 59)


def icon(size: int) -> Image.Image:
    s = 4 * size  # draw large, then downsample for smooth edges
    im = Image.new("RGB", (s, s), NAVY)
    d = ImageDraw.Draw(im)
    left, bar_h, gap = 0.22 * s, 0.10 * s, 0.07 * s
    top = 0.5 * s - (3 * bar_h + 2 * gap) / 2 + 0.06 * s
    for i, (colour, length) in enumerate(BARS):
        y = top + i * (bar_h + gap)
        d.rounded_rectangle([left, y, left + length * s, y + bar_h], radius=bar_h / 2, fill=colour)
    r = 0.07 * s
    cx, cy = 0.75 * s, 0.25 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED)
    return im.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180), ("badge-96.png", 96)]:
        icon(size).save(OUT / name, optimize=True)
    print("icons written to", OUT)
