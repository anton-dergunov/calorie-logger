#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
cd "$project_root"

if [[ ! -d web/node_modules ]]; then
  npm --prefix web install
fi

eval "$("$project_root/scripts/version.sh")"

npm run build:web
xcodegen generate --spec macos/project.yml
xcodebuild \
  -project macos/CalorieLogger.xcodeproj \
  -scheme CalorieLogger \
  -configuration Debug \
  -derivedDataPath "$project_root/DerivedData" \
  MARKETING_VERSION="$CALORIE_LOGGER_VERSION" \
  CURRENT_PROJECT_VERSION="$CALORIE_LOGGER_BUILD" \
  CODE_SIGNING_ALLOWED=NO \
  test

