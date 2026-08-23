#!/usr/bin/env python3
import json
import struct
from pathlib import Path

project_root = Path(__file__).resolve().parents[1]
root = project_root / "web/dist"
manifest = json.loads((root / "manifest.webmanifest").read_text())
assert manifest["short_name"] == "Calorie Logger"
assert manifest["display"] == "standalone"
assert {icon["sizes"] for icon in manifest["icons"]} >= {"192x192", "512x512"}
any_icons = [icon for icon in manifest["icons"] if "any" in icon.get("purpose", "any").split()]
maskable_icons = [icon for icon in manifest["icons"] if "maskable" in icon.get("purpose", "").split()]
assert {icon["src"] for icon in any_icons} >= {"pwa-192x192.png", "pwa-512x512.png"}
assert {icon["src"] for icon in maskable_icons} == {"pwa-maskable-512x512.png"}
assert not {icon["src"] for icon in any_icons} & {icon["src"] for icon in maskable_icons}
for name in ["index.html", "sw.js", "app-icon-64.png", "apple-touch-icon.png", "pwa-192x192.png", "pwa-512x512.png", "pwa-maskable-512x512.png"]:
    assert (root / name).is_file(), name


def png_info(path: Path) -> tuple[int, int, int]:
    with path.open("rb") as image:
        assert image.read(8) == b"\x89PNG\r\n\x1a\n", path
        _, chunk_type = struct.unpack(">I4s", image.read(8))
        assert chunk_type == b"IHDR", path
        width, height, _, color_type = struct.unpack(">IIBB", image.read(10))
        return width, height, color_type


for name, size in {
    "app-icon-64.png": (64, 64),
    "apple-touch-icon.png": (180, 180),
    "pwa-192x192.png": (192, 192),
    "pwa-512x512.png": (512, 512),
    "pwa-maskable-512x512.png": (512, 512),
}.items():
    width, height, color_type = png_info(root / name)
    assert (width, height) == size, name
    # Platform launchers own the corner mask. RGB files guarantee an opaque,
    # full-square canvas instead of pre-cut transparent corners.
    assert color_type == 2, f"{name} must be an opaque RGB PNG"

mac_icon_root = project_root / "macos/Resources/Assets.xcassets/AppIcon.appiconset"
for name, size in {
    "icon_16x16.png": (16, 16),
    "icon_16x16@2x.png": (32, 32),
    "icon_32x32.png": (32, 32),
    "icon_32x32@2x.png": (64, 64),
    "icon_128x128.png": (128, 128),
    "icon_128x128@2x.png": (256, 256),
    "icon_256x256.png": (256, 256),
    "icon_256x256@2x.png": (512, 512),
    "icon_512x512.png": (512, 512),
    "icon_512x512@2x.png": (1024, 1024),
}.items():
    width, height, color_type = png_info(mac_icon_root / name)
    assert (width, height) == size, name
    assert color_type == 2, f"{name} must be an opaque RGB PNG"

index = (root / "index.html").read_text()
assert 'href="./app-icon-64.png"' in index
assert "viewport-fit=cover" in index
assert "interactive-widget=resizes-content" in index
worker = (root / "sw.js").read_text()
wasm_assets = list((root / "assets").glob("*.wasm"))
assert len(wasm_assets) == 1, wasm_assets
assert wasm_assets[0].name in worker
assert 'createHandlerBoundToURL("index.html")' in worker
# The app shell must not answer navigations to paths the server owns: /api/ is the Calorie
# Logger API, and /_/ is PocketBase's dashboard, which is how accounts are created after a
# deployment resets the database. Serving the shell there makes the dashboard unreachable.
assert "denylist:[/^\\/api\\//,/^\\/_\\//]" in worker
assert "/api/calorie-logger/" not in worker
# The update is offered, not taken. A worker that calls skipWaiting() or clientsClaim() of its own
# accord activates while the app is being used and reloads the page underneath whoever is typing;
# the only skipWaiting left must be the one that answers the SKIP_WAITING message the app sends
# when the update is accepted.
skip_waiting_calls = [index for index in range(len(worker)) if worker.startswith("skipWaiting()", index)]
assert len(skip_waiting_calls) == 1, skip_waiting_calls
# The one remaining call must be the reply to the message the app sends when the update is
# accepted, not an unconditional one in the worker's own start-up.
assert "SKIP_WAITING" in worker[max(0, skip_waiting_calls[0] - 120):skip_waiting_calls[0]]
assert "clientsClaim" not in worker
assert "NetworkFirst" not in worker and "CacheFirst" not in worker
# The macOS application is served from its own route, never from pb_public, so it can never be
# precached onto a phone.
assert ".zip" not in worker

# Food pictures are part of the shell: an installed app opening with no connection has to be able
# to draw the catalogue, and these are the only artwork the interface has.
picture_catalogue = (root.parents[1] / "web/src/data/pictures.yaml").read_text()
picture_count = picture_catalogue.count("\n- id: ")
assert picture_count > 90, picture_count
pictures = list((root / "assets").glob("*.webp"))
assert len(pictures) == picture_count, (len(pictures), picture_count)
for picture in pictures:
    assert picture.name in worker, picture.name
# Every picture is a file, never a data URI inlined into the bundle, so the precache lists them
# all and the macOS host serves them through its scheme handler like any other asset.
bundle = "".join(script.read_text() for script in (root / "assets").glob("index-*.js"))
assert "data:image/webp" not in bundle

print("PWA output verification passed.")
