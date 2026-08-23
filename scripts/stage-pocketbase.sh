#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
destination="$repo_dir/pocketbase/pb_public"

mkdir -p "$destination"
rsync -a --delete --exclude .gitkeep "$repo_dir/web/dist/" "$destination/"
