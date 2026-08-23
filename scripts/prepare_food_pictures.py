#!/usr/bin/env python3
"""Build the bundled food pictures from the curated master artwork.

The masters in `icons/` are 512x512 PNGs, far larger than anything the interface draws: the
biggest picture on screen is the 52px chooser summary, which needs 192px even on a three-times
display. Shipping the masters would put five megabytes into the offline precache for artwork that
is never seen at that size, so this writes a 192px WebP of each one instead.

The catalogue in `web/src/data/pictures.yaml` is the source of truth for which pictures exist.
This script refuses to run when it disagrees with the master artwork, because a food referring to
a picture that was never bundled would silently fall back to the default one.

Requires Pillow and PyYAML. Run with `npm run generate:pictures`.
"""
from pathlib import Path

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MASTERS = ROOT / "icons"
CATALOGUE = ROOT / "web/src/data/pictures.yaml"
BUNDLE = ROOT / "web/src/assets/pictures"
SERVER_ALLOWLIST = ROOT / "pocketbase/pb_hooks/data/food-pictures.json"

SIZE = 192
QUALITY = 82


def main() -> None:
    catalogue = yaml.safe_load(CATALOGUE.read_text(encoding="utf-8"))
    catalogue_ids = [str(item["id"]) for item in catalogue]
    master_ids = sorted(path.stem for path in MASTERS.glob("*.png"))

    missing_master = sorted(set(catalogue_ids) - set(master_ids))
    missing_entry = sorted(set(master_ids) - set(catalogue_ids))
    if missing_master:
        raise SystemExit(f"{CATALOGUE.name} lists pictures with no master artwork: {missing_master}")
    if missing_entry:
        raise SystemExit(f"{MASTERS.name}/ holds artwork missing from {CATALOGUE.name}: {missing_entry}")
    if len(set(catalogue_ids)) != len(catalogue_ids):
        raise SystemExit(f"{CATALOGUE.name} repeats a picture id.")

    BUNDLE.mkdir(parents=True, exist_ok=True)
    for stale in BUNDLE.glob("*.webp"):
        if stale.stem not in catalogue_ids:
            stale.unlink()

    total = 0
    for picture_id in catalogue_ids:
        master = Image.open(MASTERS / f"{picture_id}.png").convert("RGBA")
        destination = BUNDLE / f"{picture_id}.webp"
        master.resize((SIZE, SIZE), Image.LANCZOS).save(destination, "WEBP", quality=QUALITY, method=6)
        total += destination.stat().st_size

    # The server validates every saved picture against the same list, so it is generated here
    # rather than maintained by hand in the hook, where it could quietly drift.
    SERVER_ALLOWLIST.parent.mkdir(parents=True, exist_ok=True)
    SERVER_ALLOWLIST.write_text(
        '{\n  "pictures": [\n' + ",\n".join(f'    "{picture_id}"' for picture_id in catalogue_ids) + "\n  ]\n}\n",
        encoding="utf-8",
    )

    print(f"Wrote {len(catalogue_ids)} pictures to {BUNDLE.relative_to(ROOT)} ({total / 1024:.0f} KB).")


if __name__ == "__main__":
    main()
