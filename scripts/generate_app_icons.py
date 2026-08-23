#!/usr/bin/env python3
"""Regenerate every Calorie Logger launcher asset from the approved meal-grid artwork.

The approved illustration is four produce tiles held in a dark aubergine box, drawn on an
aubergine field. The field was sized for Android launcher masks, but the platforms that
trim the least handed almost all of it back as a heavy near-black band around the icon.
This script keeps the illustration's own pixels, box rim included, and replaces only the
field it sits on with a warm oat one, so the bento outline still reads while the edge of
the icon stays light on every platform.

Two masters come out of it. The launcher master carries a modest field for platforms that
apply a gentle mask or none at all; the maskable master carries a large disposable field
for Android launcher shapes. Nothing is pre-rounded: every platform applies its own mask.

Requires Pillow. Run with `npm run generate:icons`.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/icon-concepts/10-meal-grid.png"
MASTER = ROOT / "docs/icon-concepts/10-meal-grid-oat-field.png"
MASKABLE_MASTER = ROOT / "docs/icon-concepts/10-meal-grid-oat-field-maskable.png"
WEB_ICONS = ROOT / "web/public"
MAC_ICONS = ROOT / "macos/Resources/Assets.xcassets/AppIcon.appiconset"

# The meal box's outer edge in the approved artwork, measured from the source pixels. The
# crop lands on the rim itself, so only the four corners fall outside the box.
BOX = (180, 162, 1069, 1076)
# How far the old field may travel from its own colour before the fill stops. The rim is 53
# away and must survive, so this clears the field and its antialiased edge but no more.
BACKGROUND_TOLERANCE = 40

FIELD = (237, 222, 190)
MASTER_SIZE = 1024
# Field width per side, as a fraction of the canvas. The launcher figure survives the mask
# and is meant to be seen, giving the box something to sit on rather than a dark edge that
# runs off the icon; the maskable figure is bleed Android launcher shapes may cut away.
LAUNCHER_FIELD = 0.07
MASKABLE_FIELD = 0.14


def bento_layer() -> Image.Image:
    """The meal box, with the field it used to sit on replaced by the new one.

    The box's rounded corners leave the old field enclosing the crop's own corners, so
    filling inwards from those four points reaches all of it and nothing else. The rim,
    the dividing cross, and the produce are left exactly as they were drawn.
    """
    layer = Image.open(SOURCE).convert("RGB").crop(BOX)
    width, height = layer.size
    for corner in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        ImageDraw.floodfill(layer, corner, FIELD, thresh=BACKGROUND_TOLERANCE)
    return layer


def master(layer: Image.Image, field: float) -> Image.Image:
    """Centre the box on an opaque square field with the given margin."""
    content = round(MASTER_SIZE * (1 - 2 * field))
    scale = content / max(layer.size)
    scaled = layer.resize((round(layer.width * scale), round(layer.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGB", (MASTER_SIZE, MASTER_SIZE), FIELD)
    canvas.paste(scaled, ((MASTER_SIZE - scaled.width) // 2, (MASTER_SIZE - scaled.height) // 2))
    return canvas


def emit(source: Image.Image, path: Path, size: int) -> None:
    """Write one opaque RGB size. Launchers own the corner mask, so corners stay square."""
    source.resize((size, size), Image.LANCZOS).save(path, format="PNG")


def main() -> None:
    layer = bento_layer()
    launcher = master(layer, LAUNCHER_FIELD)
    maskable = master(layer, MASKABLE_FIELD)
    launcher.save(MASTER, format="PNG")
    maskable.save(MASKABLE_MASTER, format="PNG")

    emit(launcher, WEB_ICONS / "app-icon-64.png", 64)
    emit(launcher, WEB_ICONS / "apple-touch-icon.png", 180)
    emit(launcher, WEB_ICONS / "pwa-192x192.png", 192)
    emit(launcher, WEB_ICONS / "pwa-512x512.png", 512)
    emit(maskable, WEB_ICONS / "pwa-maskable-512x512.png", 512)

    for name, size in {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }.items():
        emit(launcher, MAC_ICONS / name, size)

    print("Launcher artwork regenerated.")


if __name__ == "__main__":
    main()
