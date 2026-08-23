#!/bin/sh
set -eu

# Builds Calorie Logger and installs it on a server.
#
#   ./deploy.sh              deploy to the server you configured
#   ./deploy.sh --local      run it on this computer instead, with no SSH at all
#   ./deploy.sh --configure  choose a different server
#   ./deploy.sh --reset-data delete everything on the server and start empty
#
# The same command is both the first install and every update afterwards.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config="$repo_dir/.calorie-logger-deploy"

mode=remote
reset_data=false
for argument in "$@"; do
  case "$argument" in
    --local) mode=local ;;
    --configure) rm -f "$config" ;;
    --reset-data) reset_data=true ;;
    *) echo "Usage: ./deploy.sh [--local] [--configure] [--reset-data]" >&2; exit 1 ;;
  esac
done

for command_name in npm curl; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "$command_name is required on this computer." >&2; exit 1; }
done

# One version identity for everything this run produces: the web bundle, the macOS application,
# and the server release all report the same build.
eval "$("$repo_dir/scripts/version.sh")"

run_quietly() {
  label=$1
  shift
  log_file=$(mktemp "${TMPDIR:-/tmp}/calorie-logger-deploy-log.XXXXXX")
  printf "%s... " "$label"
  if "$@" >"$log_file" 2>&1; then
    rm -f "$log_file"
    echo "done"
  else
    echo "failed"
    cat "$log_file" >&2
    rm -f "$log_file"
    exit 1
  fi
}

confirm_reset() {
  where=$1
  echo "--reset-data deletes every account, food, log entry, and target on $where."
  echo "A backup is taken first, but the app starts empty and each account must be recreated."
  printf "Type DELETE to continue: "
  read -r confirmation
  [ "$confirmation" = "DELETE" ] || { echo "Nothing was deployed." >&2; exit 1; }
}

# The macOS application is built only where it can be: on a Mac with the toolchain installed.
# Anywhere else the step is skipped and the server keeps offering whatever it already has, so
# deploying from a Linux box never withdraws the desktop download.
build_macos_application() {
  rm -rf "$repo_dir/build/macos-release"
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "Not macOS: skipping the desktop application; the server keeps the one it has."
    return 0
  fi
  if ! command -v xcodegen >/dev/null 2>&1 || ! command -v xcodebuild >/dev/null 2>&1; then
    echo "Xcode or XcodeGen is missing: skipping the desktop application."
    return 0
  fi
  run_quietly "Building the macOS application" "$repo_dir/scripts/package-macos-release.sh"
}

build_release() {
  run_quietly "Installing build dependencies" npm ci --prefix web --no-audit --no-fund
  build_macos_application
  run_quietly "Building the deployment package" npm run package:server
}

# --------------------------------------------------------------------------------------------
# Running on this computer
# --------------------------------------------------------------------------------------------

deploy_local() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is required to run Calorie Logger on this computer." >&2; exit 1; }
  if docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
  elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose "$@"; }
  else
    echo "Docker Compose is required." >&2
    exit 1
  fi

  install_root=${CALORIE_LOGGER_ROOT:-$HOME/.calorie-logger}
  # 127.0.0.1 keeps the server to this computer. Set CALORIE_LOGGER_BIND=0.0.0.0 to let phones on
  # the same network reach it; see docs/setup.md for why that needs HTTPS to be an installable app.
  bind_address=${CALORIE_LOGGER_BIND:-127.0.0.1}
  port=${CALORIE_LOGGER_PORT:-8090}

  [ "$reset_data" = false ] || confirm_reset "this computer"

  build_release

  mkdir -p "$install_root/pb_data" "$install_root/downloads" "$install_root/backups"

  if [ -f "$install_root/pb_data/data.db" ]; then
    backup="$install_root/backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
    for suffix in "" -wal -shm; do
      if [ -f "$install_root/pb_data/data.db$suffix" ]; then
        cp "$install_root/pb_data/data.db$suffix" "$backup/data.db$suffix"
      fi
    done
    echo "Database backed up to $backup."
  fi

  if [ "$reset_data" = true ]; then
    rm -rf "$install_root/pb_data"
    mkdir -p "$install_root/pb_data"
    echo "The database was deleted and will be rebuilt empty."
  fi

  if [ -f "$repo_dir/build/macos-release/release.json" ]; then
    cp -R "$repo_dir/build/macos-release/." "$install_root/downloads/"
  fi

  environment=$(mktemp "${TMPDIR:-/tmp}/calorie-logger-local-env.XXXXXX")
  trap 'rm -f "$environment"' EXIT HUP INT TERM
  {
    printf 'PB_BIND_ADDRESS=%s\n' "$bind_address"
    printf 'PB_PORT=%s\n' "$port"
    printf 'PB_DATA_PATH=%s\n' "$install_root/pb_data"
    printf 'CALORIE_LOGGER_DOWNLOADS_PATH=%s\n' "$install_root/downloads"
    printf 'CALORIE_LOGGER_VERSION=%s\n' "$CALORIE_LOGGER_VERSION"
    printf 'CALORIE_LOGGER_BUILD=%s\n' "$CALORIE_LOGGER_BUILD"
  } > "$environment"
  # Server-held settings, such as the food estimator's key. They live outside the repository so
  # that nothing secret is ever part of a build.
  if [ -f "$install_root/secrets.env" ]; then
    printf '\n' >> "$environment"
    cat "$install_root/secrets.env" >> "$environment"
    echo "Loaded settings from $install_root/secrets.env."
  fi

  run_quietly "Starting Calorie Logger" compose --env-file "$environment" \
    -f "$repo_dir/pocketbase/compose.yaml" -p calorie-logger up -d --build --force-recreate

  wait_for_health "http://127.0.0.1:$port" || {
    docker logs --tail 100 calorie-logger-pocketbase >&2 || true
    echo "Calorie Logger did not become healthy." >&2
    exit 1
  }

  echo
  echo "Calorie Logger is running at http://$bind_address:$port"
  report_accounts
}

wait_for_health() {
  origin=$1
  api_version=$(sed -n 's/^const API_VERSION = \([0-9][0-9]*\);.*/\1/p' \
    "$repo_dir/pocketbase/pb_hooks/calorie-logger.js" | head -n 1)
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    health=$(curl -sS "$origin/api/calorie-logger/v$api_version/health" 2>/dev/null || true)
    case "$health" in
      *'"service":"calorie-logger"'*'"status":"ok"'*) echo "$health"; return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

report_accounts() {
  echo
  echo "If this is a new database, create the administrator and then your own account:"
  echo "  docker exec -it calorie-logger-pocketbase \\"
  echo "    /pb/pocketbase superuser upsert 'you@example.com' 'A_STRONG_UNIQUE_PASSWORD'"
  echo "Then open /_/ in a browser, sign in, and add yourself to the 'users' collection."
}

# --------------------------------------------------------------------------------------------
# Deploying to a server over SSH
# --------------------------------------------------------------------------------------------

calorie_logger_ssh() {
  ssh -o LogLevel=ERROR -o WarnWeakCrypto=no "$@"
}

deploy_remote() {
  for command_name in awk cksum ssh; do
    command -v "$command_name" >/dev/null 2>&1 || { echo "$command_name is required on this computer." >&2; exit 1; }
  done

  if [ ! -f "$config" ]; then
    printf "SSH destination (user@server): "
    read -r deploy_target
    case "$deploy_target" in
      *@?*) ;;
      *) echo "Enter an SSH destination such as user@server.example.com." >&2; exit 1 ;;
    esac
    case "$deploy_target" in
      *[!A-Za-z0-9._@:-]*) echo "The SSH destination contains unsupported characters." >&2; exit 1 ;;
    esac
    umask 077
    printf "DEPLOY_TARGET=%s\n" "$deploy_target" > "$config"
  fi

  # The configuration contains only a validated user@host value.
  . "$config"

  helper_arguments=""
  if [ "$reset_data" = true ]; then
    confirm_reset "$DEPLOY_TARGET"
    helper_arguments=" --reset-data"
  fi

  # An optional hardening: a reviewed copy of the deployment helper, owned by root and allowed
  # through sudo without a password. When it is installed and current, deployments ask for
  # nothing. When it is not, the ordinary path below simply asks for the sudo password once.
  # See "Deploying without a password prompt" in docs/setup.md.
  local_helper_checksum=$(cksum "$repo_dir/scripts/deploy-pocketbase-remote.sh" | awk '{ print $1 " " $2 }')
  remote_helper_checksum=$(calorie_logger_ssh -T "$DEPLOY_TARGET" \
    'cksum /usr/local/sbin/deploy-calorie-logger 2>/dev/null' 2>/dev/null | awk '{ print $1 " " $2 }')
  installed_helper=none
  if [ -n "$remote_helper_checksum" ]; then
    if [ "$remote_helper_checksum" = "$local_helper_checksum" ]; then
      installed_helper=current
    else
      installed_helper=stale
    fi
  else
    # Synology DSM can allow restricted sudo execution while denying the deployment account read
    # access to /usr/local/sbin. Ask the helper to identify itself instead: an empty archive makes
    # it report its checksum and stop before it changes anything.
    helper_preflight=$(calorie_logger_ssh -T "$DEPLOY_TARGET" \
      'sudo -n /usr/local/sbin/deploy-calorie-logger 2>/dev/null' </dev/null 2>/dev/null || true)
    case "$helper_preflight" in
      *"deployment-helper-checksum: $local_helper_checksum"*) installed_helper=current ;;
      *"deployment-helper-checksum:"*) installed_helper=stale ;;
    esac
  fi

  if [ "$installed_helper" = stale ]; then
    echo "The passwordless deployment helper on $DEPLOY_TARGET is out of date." >&2
    echo "Refresh it with the steps in docs/setup.md, or remove it to deploy with a sudo password." >&2
    exit 1
  fi

  build_release

  if [ "$installed_helper" = current ]; then
    echo "Uploading and installing (passwordless helper)..."
    calorie_logger_ssh -T "$DEPLOY_TARGET" \
      "if [ \"\$(id -u)\" -eq 0 ]; then /usr/local/sbin/deploy-calorie-logger$helper_arguments; \
       else sudo -n /usr/local/sbin/deploy-calorie-logger$helper_arguments; fi" \
      < "$repo_dir/build/calorie-logger-pocketbase-server.tar.gz" || remote_failed
    return 0
  fi

  echo "Uploading to $DEPLOY_TARGET..."
  calorie_logger_ssh -T "$DEPLOY_TARGET" \
    'umask 077 && cat > /tmp/calorie-logger-release.tar.gz' \
    < "$repo_dir/build/calorie-logger-pocketbase-server.tar.gz"
  calorie_logger_ssh -T "$DEPLOY_TARGET" \
    'umask 077 && cat > /tmp/calorie-logger-deploy-helper.sh' \
    < "$repo_dir/scripts/deploy-pocketbase-remote.sh"

  # -t so sudo can ask for the password on a real terminal. One prompt covers the whole
  # deployment, including removing the uploaded files afterwards.
  echo "Installing on $DEPLOY_TARGET (sudo may ask for your password)..."
  # An account that is already root does not need sudo, and on a minimal server may not have it.
  calorie_logger_ssh -t "$DEPLOY_TARGET" \
    "if [ \"\$(id -u)\" -eq 0 ]; then run=\"sh\"; else run=\"sudo sh\"; fi; \
     \$run /tmp/calorie-logger-deploy-helper.sh$helper_arguments < /tmp/calorie-logger-release.tar.gz; \
     status=\$?; rm -f /tmp/calorie-logger-release.tar.gz /tmp/calorie-logger-deploy-helper.sh; exit \$status" \
    || remote_failed
}

remote_failed() {
  echo "The deployment failed. The messages above come from $DEPLOY_TARGET." >&2
  exit 1
}

if [ "$mode" = local ]; then
  deploy_local
else
  deploy_remote
  echo "Calorie Logger deployment completed successfully."
fi
