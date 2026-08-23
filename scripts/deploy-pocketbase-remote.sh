#!/bin/sh
set -eu

# Synology installs Container Manager commands outside the restricted SSH/sudo
# PATH. Adding these paths is harmless on ordinary Linux and avoids treating an
# installed, running Container Manager package as missing.
PATH="/usr/local/bin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:$PATH"
export PATH

# Reported before anything else runs. Synology denies the deployment account read access to
# /usr/local/sbin, so this is the only way deploy.sh can confirm which helper is installed --
# and an out-of-date helper is otherwise discovered only as a confusing deployment failure.
if command -v cksum >/dev/null 2>&1; then
  echo "deployment-helper-checksum: $(cksum "$0" | awk '{ print $1 " " $2 }')"
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "deploy-calorie-logger must be installed as a root-owned command and invoked through sudo." >&2
  exit 1
fi

reset_data=false
for argument in "$@"; do
  case "$argument" in
    --reset-data) reset_data=true ;;
    *)
      echo "deploy-calorie-logger accepts only --reset-data; provide the deployment archive on standard input." >&2
      exit 1
      ;;
  esac
done

archive=$(mktemp /tmp/calorie-logger-deploy.XXXXXX)
cleanup() {
  status=$?
  trap - EXIT
  rm -f "$archive"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

chmod 600 "$archive"
cat > "$archive"
[ -s "$archive" ] || { echo "The deployment archive is empty." >&2; exit 1; }

is_synology=false
if [ -f /etc/synoinfo.conf ] || [ -d /volume1/@appstore/ContainerManager ]; then
  is_synology=true
fi

download_file() {
  source_url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$source_url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$source_url" -O "$destination"
  else
    echo "curl or wget is required to install Docker." >&2
    exit 1
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  if [ "$is_synology" = true ]; then
    echo "Install Synology Container Manager once from Package Center, then run deploy.sh again." >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update
      apt-get install -y ca-certificates curl
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y ca-certificates curl
    elif command -v yum >/dev/null 2>&1; then
      yum install -y ca-certificates curl
    fi
  fi
  docker_installer=$(mktemp /tmp/calorie-logger-get-docker.XXXXXX)
  download_file https://get.docker.com "$docker_installer"
  sh "$docker_installer"
  rm -f "$docker_installer"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  fi
fi

compose_mode=
if docker compose version >/dev/null 2>&1; then
  compose_mode=plugin
elif command -v docker-compose >/dev/null 2>&1; then
  compose_mode=standalone
elif [ "$is_synology" = false ] && command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker-compose-plugin
  compose_mode=plugin
elif [ "$is_synology" = false ] && command -v dnf >/dev/null 2>&1; then
  dnf install -y docker-compose-plugin
  compose_mode=plugin
else
  echo "Docker Compose is unavailable. Update/install Container Manager or the Docker Compose plugin." >&2
  exit 1
fi

compose() {
  if [ "$compose_mode" = plugin ]; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# Where Calorie Logger lives on this server. The defaults suit the two common cases; a server
# with a different layout writes its own path once into /etc/calorie-logger-root. That file is
# root-owned configuration, not something a deployment can set, which is what keeps the restricted
# sudo command safe to grant.
if [ -f /etc/calorie-logger-root ]; then
  install_root=$(head -n 1 /etc/calorie-logger-root | tr -d '[:space:]')
elif [ "$is_synology" = true ] && [ -d /volume1/docker ]; then
  install_root=/volume1/docker/calorie-logger
else
  install_root=/opt/calorie-logger
fi
case "$install_root" in
  /*/calorie-logger) ;;
  *) echo "The install root must be an absolute path ending in /calorie-logger: $install_root" >&2; exit 1 ;;
esac
data_path="$install_root/pb_data"
downloads_path="$install_root/downloads"
mkdir -p "$install_root/releases" "$data_path" "$downloads_path"

release="$install_root/releases/$(date +%Y%m%d-%H%M%S)"
temporary=$(mktemp -d /tmp/calorie-logger-release.XXXXXX)
tar -xzf "$archive" -C "$temporary"
mv "$temporary/calorie-logger-pocketbase-server" "$release"
rmdir "$temporary"

# The release names the build it came from, so /health can report which one is running.
app_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$release/version.json" 2>/dev/null | head -n 1)
app_build=$(sed -n 's/.*"build"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$release/version.json" 2>/dev/null | head -n 1)

cat > "$release/pocketbase/.env" <<EOF
PB_VERSION=0.39.10
PB_BIND_ADDRESS=127.0.0.1
PB_PORT=8090
PB_DATA_PATH=$data_path
CALORIE_LOGGER_DOWNLOADS_PATH=$downloads_path
CALORIE_LOGGER_VERSION=${app_version:-0.0.0}
CALORIE_LOGGER_BUILD=${app_build:-0}
EOF

# Server-held secrets, appended to the generated environment. They live outside every release so
# that a deployment carries no credential of any kind, and so that a key survives the next one.
# The path follows the install root, which differs between Synology DSM and ordinary Linux, so it
# is reported either way: a key left in the other location is silent until someone asks for an
# estimate and is told the server has none.
secrets_file="$install_root/secrets.env"
if [ -f "$secrets_file" ]; then
  chmod 600 "$secrets_file"
  # A secrets file without a closing newline would otherwise be glued onto the last generated
  # line, which turns the key into part of a path and loses both.
  printf '\n' >> "$release/pocketbase/.env"
  cat "$secrets_file" >> "$release/pocketbase/.env"
  echo "Loaded server secrets from $secrets_file."
else
  echo "No $secrets_file: describing a portion for estimation will report that this server has no estimator."
fi
chmod 600 "$release/pocketbase/.env"

compose --env-file "$release/pocketbase/.env" -f "$release/pocketbase/compose.yaml" -p calorie-logger build

old_container=$(docker inspect calorie-logger-pocketbase --format '{{.Id}}' 2>/dev/null || true)
if [ -n "$old_container" ]; then
  docker stop "$old_container" >/dev/null
fi

# Nothing below may touch a path that is not this application's own data directory.
case "$data_path" in
  /*/calorie-logger/pb_data) ;;
  *) echo "Refusing to operate on an unexpected data path: $data_path" >&2; exit 1 ;;
esac

copy_database() {
  for suffix in "" -wal -shm; do
    if [ -f "$1$suffix" ]; then
      cp "$1$suffix" "$2$suffix"
    fi
  done
}

# The database holds the owner's foods, entries, and targets, and a deployment must not be the
# thing that loses them. It is copied first, and the copy is kept whether or not the rest of the
# deployment works. The container is already stopped, so the file is at rest.
backup_root="$install_root/backups"
if [ -f "$data_path/data.db" ]; then
  backup="$backup_root/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  copy_database "$data_path/data.db" "$backup/data.db"
  chmod 700 "$backup"
  echo "Database backed up to $backup."
  # Ten deployments back is far enough to notice and recover from a bad one, and far less than
  # the database is worth keeping forever.
  ls -1d "$backup_root"/*/ 2>/dev/null | sort | head -n -10 | while read -r stale; do
    rm -rf "$stale"
  done
else
  mkdir -p "$data_path"
  echo "No existing database; PocketBase will create one from the migrations."
fi

if [ "$reset_data" = true ]; then
  rm -rf "$data_path"
  mkdir -p "$data_path"
  echo "--reset-data: the database was deleted and will be rebuilt empty from the migrations."
  echo "Every account, food, log entry, and target is gone; the backup above is the only copy."
fi

# A database left by an earlier release that stashed accounts beside it. Nothing reads it now
# that the database itself survives a deployment.
for suffix in "" -wal -shm; do
  rm -f "$install_root/previous-accounts.db$suffix" "$data_path/previous-accounts.db$suffix"
done

# The desktop application, when this release carries one. A release built on a machine that
# cannot compile it has no downloads directory, and the server keeps offering the one it already
# published rather than withdrawing the download.
if [ -f "$release/downloads/release.json" ]; then
  rm -f "$downloads_path"/*.zip
  cp -R "$release/downloads/." "$downloads_path/"
  echo "Published the macOS application from this release."
elif [ -f "$downloads_path/release.json" ]; then
  echo "This release carries no macOS application; the previously published one is kept."
fi

compose --env-file "$release/pocketbase/.env" -f "$release/pocketbase/compose.yaml" -p calorie-logger up -d --force-recreate

api_version=$(sed -n 's/^const API_VERSION = \([0-9][0-9]*\);.*/\1/p' \
  "$release/pocketbase/pb_hooks/calorie-logger.js" | head -n 1)
if [ -z "$api_version" ]; then
  echo "The deployment archive does not declare a Calorie Logger API version." >&2
  exit 1
fi

health_is_ready() {
  response=$1
  case "$response" in *'"service":"calorie-logger"'*) ;; *) return 1 ;; esac
  case "$response" in *'"status":"ok"'*) ;; *) return 1 ;; esac
  case "$response" in
    *"\"apiVersion\":$api_version,"*) return 0 ;;
    *"\"apiVersion\":$api_version}"*) return 0 ;;
    *) return 1 ;;
  esac
}

health=
attempt=0
while [ "$attempt" -lt 60 ]; do
  if command -v curl >/dev/null 2>&1; then
    health=$(curl -sS "http://127.0.0.1:8090/api/calorie-logger/v$api_version/health" 2>/dev/null || true)
  else
    health=$(wget -qO- "http://127.0.0.1:8090/api/calorie-logger/v$api_version/health" 2>/dev/null || true)
  fi
  if health_is_ready "$health"; then break; fi
  attempt=$((attempt + 1))
  sleep 1
done

if health_is_ready "$health"; then
  ln -sfn "$release" "$install_root/current"
  echo "$health"
  echo "Calorie Logger ${app_version:-} is running. Existing reverse-proxy or Tailscale configuration was not changed."
  if [ "$reset_data" = true ]; then
    # Nothing survived a deliberate reset, so say plainly how to make accounts rather than
    # leaving the owner at a sign-in form no password can satisfy.
    echo "There are no accounts. Create the superuser, then add your Calorie Logger account in the dashboard at /_/:"
    echo "  docker exec -it calorie-logger-pocketbase /pb/pocketbase superuser upsert EMAIL PASSWORD"
  else
    echo "Accounts, foods, log entries, and targets were kept; any new migrations have been applied."
  fi
else
  docker logs --tail 100 calorie-logger-pocketbase || true
  echo "Last v$api_version health response: ${health:-<no response>}" >&2
  docker inspect calorie-logger-pocketbase --format 'Running image: {{.Image}}; started: {{.State.StartedAt}}' >&2 || true
  echo "Calorie Logger failed its health check after 60 seconds." >&2
  exit 1
fi
