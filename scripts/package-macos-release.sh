#!/bin/zsh
set -euo pipefail

# Builds the macOS host for release and packages it as the archive the server hands out, together
# with the manifest the installed application polls.
#
# The archive is a zip rather than a disk image on purpose: the updater expands it with `ditto -x`,
# which needs no mount, no detach, and no cleanup after a failure part-way through.

project_root="${0:A:h:h}"
cd "$project_root"

eval "$("$project_root/scripts/version.sh")"

"$project_root/scripts/build-macos.sh" --release

staging="$project_root/build/macos-release"
rm -rf "$staging"
mkdir -p "$staging"

archive_name="CalorieLogger-$CALORIE_LOGGER_VERSION-$CALORIE_LOGGER_BUILD.zip"
archive="$staging/$archive_name"

# --keepParent so the archive expands to "Calorie Logger.app" rather than its contents.
ditto -c -k --sequesterRsrc --keepParent "$project_root/build/Calorie Logger.app" "$archive"

checksum=$(shasum -a 256 "$archive" | awk '{ print $1 }')
size=$(wc -c < "$archive" | tr -d ' ')

cat > "$staging/release.json" <<JSON
{
  "version": "$CALORIE_LOGGER_VERSION",
  "build": "$CALORIE_LOGGER_BUILD",
  "file": "$archive_name",
  "size": $size,
  "sha256": "$checksum"
}
JSON

print "Packaged $archive_name ($size bytes)"
