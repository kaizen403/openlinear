#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
API_DIR="$ROOT_DIR/apps/api"
BINARIES_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"

echo "==> Building TypeScript..."
pnpm --filter @openlinear/api build

echo "==> Building binaries with pkg..."
cd "$API_DIR"
pnpm run build:pkg
cd "$ROOT_DIR"

echo "==> Creating binaries directory..."
mkdir -p "$BINARIES_DIR"

echo "==> Copying and renaming binaries with Tauri target triples..."

# pkg outputs: api-macos-x64, api-macos-arm64, api-linux-x64
# Tauri expects: openlinear-api-{target-triple}

# Mac Intel
if [ -f "$API_DIR/dist/api-macos-x64" ]; then
  cp "$API_DIR/dist/api-macos-x64" "$BINARIES_DIR/openlinear-api-x86_64-apple-darwin"
  echo "  - openlinear-api-x86_64-apple-darwin"
fi

# Mac ARM
if [ -f "$API_DIR/dist/api-macos-arm64" ]; then
  cp "$API_DIR/dist/api-macos-arm64" "$BINARIES_DIR/openlinear-api-aarch64-apple-darwin"
  echo "  - openlinear-api-aarch64-apple-darwin"
fi

# Linux x64
if [ -f "$API_DIR/dist/api-linux-x64" ]; then
  cp "$API_DIR/dist/api-linux-x64" "$BINARIES_DIR/openlinear-api-x86_64-unknown-linux-gnu"
  echo "  - openlinear-api-x86_64-unknown-linux-gnu"
fi

echo "==> Build complete!"
ls -la "$BINARIES_DIR"
