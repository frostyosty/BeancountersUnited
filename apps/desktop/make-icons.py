#!/usr/bin/env python3
"""Draws the desktop apps' icons: a rounded square, one colour per app, with three ledger lines
and a total rule. Our own design (CLAUDE.md hard rule 3). Needs Pillow.

Run from anywhere: python3 apps/desktop/make-icons.py (on Ubuntu, apt install python3-pil)
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
APPS = {"master": (31, 78, 121), "client": (34, 120, 84), "dev": (184, 92, 20)}
SIZE = 512


def draw(colour):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((16, 16, SIZE - 16, SIZE - 16), radius=96, fill=colour)
    white = (255, 255, 255, 255)
    for i, width in enumerate((300, 220, 260)):
        y = 132 + i * 80
        d.rounded_rectangle((106, y, 106 + width, y + 36), radius=18, fill=white)
    d.rectangle((106, 380, 406, 392), fill=white)
    d.rectangle((106, 404, 406, 416), fill=white)
    return img


for app, colour in APPS.items():
    out = HERE / app / "icons"
    out.mkdir(exist_ok=True)
    img = draw(colour)
    img.save(out / "icon.png")
    img.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
