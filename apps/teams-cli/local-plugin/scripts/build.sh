#!/bin/sh
set -eu
cd "$(dirname "$0")/../source/teams-bridge"
"${GO_BIN:-go}" test ./...
"${GO_BIN:-go}" build -trimpath -o ../../bin/teams-bridge .
