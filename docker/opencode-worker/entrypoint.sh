#!/bin/sh
set -e

REPOS_DIR="${REPOS_DIR:-/home/opencode/repos}"
mkdir -p "$REPOS_DIR"

git config --global --add safe.directory '*'

echo "Starting OpenCode worker..."
echo "  Port: ${OPENCODE_PORT:-4096}"
echo "  Repos dir: $REPOS_DIR"

exec node /home/opencode/server.mjs
