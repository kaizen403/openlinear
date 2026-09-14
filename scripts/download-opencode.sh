#!/bin/bash
set -e

# Downloads the opencode binary for the current platform and places it in
# the Tauri sidecar binaries directory with the correct target-triple naming
# convention.
#
# SECURITY (C6a F19): the version is pinned to an exact release tag and every
# download is verified against a checksum committed to this repo
# (scripts/opencode.sha256) before it's ever extracted or installed — a
# compromised/hijacked upstream release, or a tampered local copy, gets
# rejected instead of silently becoming the agent executable every OpenLinear
# build ships. There is deliberately no "skip if already downloaded"
# shortcut any more: every invocation re-verifies, so a binary that was
# swapped out on disk after a previous run doesn't get trusted.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"
CHECKSUMS_FILE="$SCRIPT_DIR/opencode.sha256"

REPO="opencode-ai/opencode"
# Pinned to the version installed/verified at the time this hardening was
# added (see scripts/opencode.sha256 for provenance + how to regenerate).
# Override via the environment only alongside updating opencode.sha256 —
# checksum verification below fails closed for any asset name it doesn't
# have a pinned hash for, so an unpinned override can't silently succeed.
OPENCODE_VERSION="${OPENCODE_VERSION:-v0.0.55}"

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

compute_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

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

# Fail closed: refuse to download anything we don't have a pinned checksum
# for, before spending the time/bandwidth on the download itself.
EXPECTED_SHA256=""
if [ -f "$CHECKSUMS_FILE" ]; then
  EXPECTED_SHA256=$(awk -v name="$ASSET_NAME" '$2 == name { print $1; exit }' "$CHECKSUMS_FILE")
fi
if [ -z "$EXPECTED_SHA256" ]; then
  echo "  ! No pinned checksum found for '$ASSET_NAME' in $CHECKSUMS_FILE"
  echo "  ! Refusing to install an unverified opencode binary."
  echo "  ! See the REGENERATE instructions at the top of $CHECKSUMS_FILE."
  exit 1
fi

echo "  - Resolved version: $TAG"
echo "  - Downloading $ASSET_NAME..."

# Download and extract
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
curl -fL "$DOWNLOAD_URL" -o "$TMPDIR/$ASSET_NAME"

echo "  - Verifying checksum..."
ACTUAL_SHA256=$(compute_sha256 "$TMPDIR/$ASSET_NAME")
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "  ! Checksum mismatch for $ASSET_NAME"
  echo "      expected: $EXPECTED_SHA256"
  echo "      actual:   $ACTUAL_SHA256"
  echo "  ! Refusing to install a binary that doesn't match the pinned checksum."
  exit 1
fi
echo "  - Checksum verified ($ACTUAL_SHA256)"

echo "  - Extracting..."
tar --no-same-owner -xzf "$TMPDIR/$ASSET_NAME" -C "$TMPDIR"

# The tarball contains: LICENSE, README.md, opencode
if [ ! -f "$TMPDIR/opencode" ]; then
  echo "  ! Expected 'opencode' binary not found in tarball"
  ls -la "$TMPDIR"
  exit 1
fi

# Copy to binaries dir with Tauri target triple naming. No "skip if exists"
# check — always re-verify and reinstall so a binary tampered with on disk
# after a previous run doesn't get silently trusted.
mkdir -p "$BINARIES_DIR"
cp "$TMPDIR/opencode" "$DEST"
chmod +x "$DEST"

echo "  - Installed opencode $TAG -> $DEST"
echo "  - Size: $(du -h "$DEST" | cut -f1)"
