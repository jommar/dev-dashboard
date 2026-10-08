#!/bin/sh
# Container entrypoint.
#
# Installs each sibling repo's dependencies into the container's own
# node_modules volumes (see docker-compose.yml), then runs the command as the
# node user. Host node_modules are never touched: they may be built for another
# OS or Node ABI.
set -eu

ROOT=/ezat
export NVM_DIR="${NVM_DIR:-/home/node/.nvm}"

if [ "$(id -u)" = 0 ]; then
  # Named volumes mounted under the bind-mounted repos start out root-owned.
  for dir in Portage-backend Portage-frontend TravelTracker TravelTracker/ui; do
    mkdir -p "$ROOT/$dir/node_modules"
    chown node:node "$ROOT/$dir/node_modules"
  done
  exec setpriv --reuid=1000 --regid=1000 --init-groups "$0" "$@"
fi

# Node version a service runs under: its own .nvmrc, else the monorepo root's.
# Same rule as backend/manager.mjs nvmrc().
pin_for() {
  if [ -f "$1/.nvmrc" ]; then file="$1/.nvmrc"; else file="$ROOT/.nvmrc"; fi
  sed -e 's/^v//' -e 's/[[:space:]]//g' "$file"
}

# install_deps <dir relative to /ezat> <dir whose .nvmrc picks the Node version>
install_deps() {
  dir="$ROOT/$1"
  if [ ! -f "$dir/package.json" ]; then
    echo "skip $1: not mounted"
    return 0
  fi
  pin=$(pin_for "$2")
  bin="$NVM_DIR/versions/node/v$pin/bin"
  if [ ! -x "$bin/npm" ]; then
    echo "error: $1 pins Node $pin, which is not in this image. Add it to NODE_PINS and rebuild." >&2
    exit 1
  fi
  key="$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)-$pin"
  stamp="$dir/node_modules/.dashboard-install"
  if [ "$(cat "$stamp" 2>/dev/null || true)" = "$key" ]; then
    echo "deps up to date: $1"
    return 0
  fi
  echo "installing deps: $1 (Node v$pin), this takes a while the first time"
  (cd "$dir" && PATH="$bin:$PATH" npm ci --no-audit --no-fund)
  printf '%s' "$key" > "$stamp"
}

install_deps Portage-backend "$ROOT/Portage-backend"
install_deps Portage-frontend "$ROOT/Portage-frontend"
install_deps TravelTracker "$ROOT/TravelTracker"
install_deps TravelTracker/ui "$ROOT/TravelTracker"

exec "$@"
