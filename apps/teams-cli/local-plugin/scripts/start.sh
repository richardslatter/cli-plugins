#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
usable_node() {
  [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1
}
node_path=$(command -v node || true)
if ! usable_node "$node_path"; then
  node_path=''
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if usable_node "$candidate"; then node_path=$candidate; fi
  done
fi
if [ -z "$node_path" ]; then
  echo 'Teams CLI requires Node.js 22.12 or newer.' >&2
  exit 1
fi
if [ ! -d node_modules/@modelcontextprotocol/sdk ]; then
  echo 'Teams CLI dependencies are missing. Run npm ci in the plugin folder.' >&2
  exit 1
fi
exec "$node_path" scripts/server.mjs
