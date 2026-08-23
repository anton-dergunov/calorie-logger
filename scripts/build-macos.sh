#!/bin/zsh
set -euo pipefail

# Builds the macOS host. `--release` produces the configuration that is published to the server and
# installed by people; the default Debug build is for development.

project_root="${0:A:h:h}"
cd "$project_root"

configuration=Debug
for argument in "$@"; do
  case "$argument" in
    --release) configuration=Release ;;
    *) print -u2 "Usage: build-macos.sh [--release]"; exit 1 ;;
  esac
done

eval "$("$project_root/scripts/version.sh")"

if [[ ! -d web/node_modules ]]; then
  npm --prefix web install
fi

npm run build:web
xcodegen generate --spec macos/project.yml
xcodebuild \
  -project macos/CalorieLogger.xcodeproj \
  -scheme CalorieLogger \
  -configuration "$configuration" \
  -derivedDataPath "$project_root/DerivedData" \
  MARKETING_VERSION="$CALORIE_LOGGER_VERSION" \
  CURRENT_PROJECT_VERSION="$CALORIE_LOGGER_BUILD" \
  CODE_SIGNING_ALLOWED=NO \
  build

mkdir -p "$project_root/build"
rm -rf "$project_root/build/Calorie Logger.app"
ditto "$project_root/DerivedData/Build/Products/$configuration/Calorie Logger.app" \
  "$project_root/build/Calorie Logger.app"

# A real ad-hoc signature, not the linker's. `SMAppService` refuses to register an application
# whose Info.plist is not bound into its code signature, which is what "Open at login" needs, and
# a bound signature is also what lets the updater verify it replaced a coherent bundle.
codesign --sign - --force --deep --timestamp=none "$project_root/build/Calorie Logger.app"

print "Built $configuration $CALORIE_LOGGER_VERSION ($CALORIE_LOGGER_BUILD) at build/Calorie Logger.app"
