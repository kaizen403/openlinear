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

# Resolve GitHub asset name + Tauri target triple
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)
        ASSET_NAME="opencode-mac-arm64.tar.gz"
        TARGET_TRIPLE="aarch64-apple-darwin"
        ;;
      x86_64)
        ASSET_NAME="opencode-mac-x86_64.tar.gz"
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
        ASSET_NAME="opencode-linux-x86_64.tar.gz"
        TARGET_TRIPLE="x86_64-unknown-linux-gnu"
        ;;
      aarch64)
        ASSET_NAME="opencode-linux-arm64.tar.gz"
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
GH_AUTH_HEADER=()
if [ -n "${GH_TOKEN:-}" ]; then
  GH_AUTH_HEADER=(-H "Authorization: Bearer $GH_TOKEN")
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  GH_AUTH_HEADER=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi
RELEASE_JSON=$(curl -sL "${GH_AUTH_HEADER[@]}" "$RELEASE_URL")
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url.*$ASSET_NAME" | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "  ! Failed to find download URL for $ASSET_NAME (version: $OPENCODE_VERSION)"
  exit 1
fi

TAG=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | cut -d '"' -f 4)
echo "  - Resolved version: $TAG"
echo "  - Downloading $ASSET_NAME..."

# Download and extract
TMPDIR=$(mktemp -d)
curl -sL "$DOWNLOAD_URL" -o "$TMPDIR/$ASSET_NAME"

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
