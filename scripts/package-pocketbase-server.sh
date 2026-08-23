#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$repo_dir/build"
output="$output_dir/calorie-logger-pocketbase-server.tar.gz"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/calorie-logger-pocketbase-package.XXXXXX")
bundle="$temporary/calorie-logger-pocketbase-server"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

if [ ! -f "$repo_dir/pocketbase/pb_public/manifest.webmanifest" ]; then
  echo "Staged PWA is missing. Run npm run stage:pwa first." >&2
  exit 1
fi

eval "$("$repo_dir/scripts/version.sh")"

mkdir -p "$bundle/pocketbase" "$output_dir"
rsync -a \
  --exclude pb_data \
  --exclude .env \
  --exclude .DS_Store \
  "$repo_dir/pocketbase/" "$bundle/pocketbase/"
cp "$repo_dir/docs/setup.md" "$bundle/SETUP.md"

cat > "$bundle/version.json" <<JSON
{ "version": "$CALORIE_LOGGER_VERSION", "build": "$CALORIE_LOGGER_BUILD" }
JSON

# The macOS application, when this build produced one. It travels in the release so a deployment
# publishes the server and the desktop application that matches it in a single step. On a machine
# that cannot build it, the directory is absent and the server keeps handing out whatever it
# already has rather than losing the download.
if [ -f "$repo_dir/build/macos-release/release.json" ]; then
  mkdir -p "$bundle/downloads"
  cp -R "$repo_dir/build/macos-release/." "$bundle/downloads/"
fi

tar -czf "$output" -C "$temporary" calorie-logger-pocketbase-server
echo "$output"
