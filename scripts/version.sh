#!/bin/sh
set -eu

# The single source of truth for the application's version identity.
#
# The semantic version is hand-maintained in the root package.json. The build number is a UTC
# minute stamp regenerated for each build, and it is the value the macOS updater compares: every
# deployment then produces an installable update whether or not the version was bumped, so a
# forgotten bump can never leave a Mac running an old binary against a moved-on database.
#
# Both values are taken from the environment when they are already set, so every step of one
# build -- the web bundle, the macOS app, the server release -- reports exactly the same identity.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -z "${CALORIE_LOGGER_VERSION:-}" ]; then
  CALORIE_LOGGER_VERSION=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$repo_dir/package.json" | head -n 1)
  [ -n "$CALORIE_LOGGER_VERSION" ] || { echo "package.json does not declare a version." >&2; exit 1; }
fi

if [ -z "${CALORIE_LOGGER_BUILD:-}" ]; then
  CALORIE_LOGGER_BUILD=$(date -u +%Y%m%d%H%M)
fi

case "${1:-}" in
  --version) printf '%s\n' "$CALORIE_LOGGER_VERSION" ;;
  --build) printf '%s\n' "$CALORIE_LOGGER_BUILD" ;;
  "")
    # Suitable for `eval "$(scripts/version.sh)"`.
    printf 'CALORIE_LOGGER_VERSION=%s\n' "$CALORIE_LOGGER_VERSION"
    printf 'CALORIE_LOGGER_BUILD=%s\n' "$CALORIE_LOGGER_BUILD"
    printf 'export CALORIE_LOGGER_VERSION CALORIE_LOGGER_BUILD\n'
    ;;
  *) echo "Usage: version.sh [--version|--build]" >&2; exit 1 ;;
esac
