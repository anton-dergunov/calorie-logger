#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
"$project_root/scripts/build-macos.sh"
open "$project_root/build/Calorie Logger.app"

