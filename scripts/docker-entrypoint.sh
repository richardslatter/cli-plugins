#!/bin/sh
set -eu

# A newly mounted Fly volume is owned by root. Initialize its directory before
# dropping privileges; the backend and provider CLIs always run as node.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "${DATA_DIR:-/var/data}"
  chown node:node "${DATA_DIR:-/var/data}"
  chmod 700 "${DATA_DIR:-/var/data}"
  exec gosu node "$@"
fi
exec "$@"
