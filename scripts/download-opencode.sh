#!/bin/bash
set -e

# Downloads the latest opencode binary for the current platform
# and places it in the Tauri sidecar binaries directory with
# the correct target-triple naming convention.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"

REPO="opencode-ai/opencode"
OPENCODE_VERSION="${OPENCODE_VERSION:-latest}"

OS="$(uname -s)"
ARCH="$(uname -m)"

echo "==> Downloading opencode binary for $OS / $ARCH (version: $OPENCODE_VERSION)"

# Resolve GitHub asset name + Tauri target triple. Keep a few archive-name
# aliases because upstream release assets have used both architecture spellings.
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)
        ASSET_NAMES=("opencode-mac-arm64.tar.gz" "opencode-darwin-arm64.tar.gz")
        TARGET_TRIPLE="aarch64-apple-darwin"
        ;;
      x86_64)
        ASSET_NAMES=("opencode-mac-x86_64.tar.gz" "opencode-darwin-x86_64.tar.gz" "opencode-darwin-amd64.tar.gz")
        TARGET_TRIPLE="x86_64-apple-darwin"
        ;;
      *)
        echo "Unsupported macOS architecture: $ARCH"
        exit 1
        ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)
        ASSET_NAMES=("opencode-linux-x86_64.tar.gz" "opencode-linux-amd64.tar.gz" "opencode-linux-x64.tar.gz")
        TARGET_TRIPLE="x86_64-unknown-linux-gnu"
        ;;
      aarch64)
        ASSET_NAMES=("opencode-linux-arm64.tar.gz" "opencode-linux-aarch64.tar.gz")
        TARGET_TRIPLE="aarch64-unknown-linux-gnu"
        ;;
      *)
        echo "Unsupported Linux architecture: $ARCH"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

DEST="$BINARIES_DIR/opencode-$TARGET_TRIPLE"

# Skip if already downloaded
if [ -f "$DEST" ]; then
  echo "  - opencode binary already exists at $DEST, skipping download"
  echo "  - Delete it manually to force re-download"
  exit 0
fi

if [ "$OPENCODE_VERSION" = "latest" ]; then
  RELEASE_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  RELEASE_URL="https://api.github.com/repos/$REPO/releases/tags/$OPENCODE_VERSION"
fi

echo "  - Fetching release metadata from $RELEASE_URL..."
RELEASE_JSON=$(curl -fsSL "$RELEASE_URL")

DOWNLOAD_INFO=$(printf '%s' "$RELEASE_JSON" | node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const wanted = process.argv.slice(1);
const assets = Array.isArray(data.assets) ? data.assets : [];
const asset = wanted
  .map((name) => assets.find((candidate) => candidate.name === name))
  .find(Boolean);

if (!asset || !asset.browser_download_url) {
  const available = assets.map((candidate) => candidate.name).join("\n");
  console.error(`No matching asset found. Tried:\n${wanted.join("\n")}`);
  if (available) {
    console.error(`Available assets:\n${available}`);
  }
  process.exit(1);
}

process.stdout.write(`${asset.name}\n${asset.browser_download_url}\n${data.tag_name || ""}`);
' "${ASSET_NAMES[@]}")

ASSET_NAME=$(printf '%s\n' "$DOWNLOAD_INFO" | sed -n '1p')
DOWNLOAD_URL=$(printf '%s\n' "$DOWNLOAD_INFO" | sed -n '2p')
TAG=$(printf '%s\n' "$DOWNLOAD_INFO" | sed -n '3p')

if [ -z "$DOWNLOAD_URL" ]; then
  echo "  ! Failed to find download URL for ${ASSET_NAMES[*]} (version: $OPENCODE_VERSION)"
  exit 1
fi

echo "  - Resolved version: $TAG"
echo "  - Downloading $ASSET_NAME..."

# Download and extract
TMPDIR=$(mktemp -d)
curl -fL "$DOWNLOAD_URL" -o "$TMPDIR/$ASSET_NAME"

echo "  - Extracting..."
tar -xzf "$TMPDIR/$ASSET_NAME" -C "$TMPDIR"

# The tarball contains: LICENSE, README.md, opencode
if [ ! -f "$TMPDIR/opencode" ]; then
  echo "  ! Expected 'opencode' binary not found in tarball"
  ls -la "$TMPDIR"
  exit 1
fi

# Copy to binaries dir with Tauri target triple naming
mkdir -p "$BINARIES_DIR"
cp "$TMPDIR/opencode" "$DEST"
chmod +x "$DEST"

# Cleanup
rm -rf "$TMPDIR"

echo "  - Installed opencode $TAG -> $DEST"
echo "  - Size: $(du -h "$DEST" | cut -f1)"
