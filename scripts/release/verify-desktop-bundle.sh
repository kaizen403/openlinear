#!/usr/bin/env bash
# Verifies a built desktop bundle before it is released:
#   - the sidecar and OpenCode binaries are inside it, where the launcher
#     looks for them (next to the app executable, no target-triple suffix);
#   - the bundled OpenCode reports the pinned version (scripts/opencode.sha256);
#   - the bundled sidecar passes scripts/release/smoke-sidecar-binary.sh, i.e.
#     bundling (codesign, linuxdeploy) did not corrupt the pkg executable;
#   - macOS: the .app signature verifies; the signing mode is reported.
#
# Usage:
#   scripts/release/verify-desktop-bundle.sh macos-app path/to/OpenLinear.app
#   scripts/release/verify-desktop-bundle.sh deb       path/to/openlinear.deb
#   scripts/release/verify-desktop-bundle.sh appimage  path/to/OpenLinear.AppImage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
KIND="${1:-}"
BUNDLE="${2:-}"

die() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -n "$KIND" ] && [ -n "$BUNDLE" ] || die "usage: $0 <macos-app|deb|appimage> <path>"
[ -e "$BUNDLE" ] || die "$BUNDLE does not exist"
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"

PINNED_VERSION="$(awk '/^# Version: /{ print $3; exit }' "$ROOT_DIR/scripts/opencode.sha256")"
PINNED_VERSION="${PINNED_VERSION#v}"
[ -n "$PINNED_VERSION" ] || die "no '# Version:' line in scripts/opencode.sha256"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$KIND" in
  macos-app)
    BIN_DIR="$BUNDLE/Contents/MacOS"
    ;;
  deb)
    command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required"
    dpkg-deb -x "$BUNDLE" "$WORK/deb"
    BIN_DIR="$WORK/deb/usr/bin"
    ;;
  appimage)
    chmod +x "$BUNDLE"
    # --appimage-extract needs no FUSE; it unpacks into ./squashfs-root.
    (cd "$WORK" && "$BUNDLE" --appimage-extract >/dev/null)
    BIN_DIR="$WORK/squashfs-root/usr/bin"
    ;;
  *)
    die "unknown bundle kind: $KIND"
    ;;
esac

echo "==> $KIND: $BUNDLE"
for name in openlinear-sidecar opencode; do
  [ -f "$BIN_DIR/$name" ] || die "$name is missing from $BIN_DIR"
  [ -x "$BIN_DIR/$name" ] || die "$name in $BIN_DIR is not executable"
  echo "  ok  $name present ($(du -h "$BIN_DIR/$name" | cut -f1))"
done

mkdir -p "$WORK/home"
REPORTED="$(HOME="$WORK/home" "$BIN_DIR/opencode" --version 2>/dev/null | tr -d '[:space:]')" \
  || die "bundled opencode does not run"
[ "$REPORTED" = "$PINNED_VERSION" ] || die "bundled opencode reports '$REPORTED', expected $PINNED_VERSION"
echo "  ok  bundled opencode --version -> $REPORTED"

if [ "$KIND" = "macos-app" ]; then
  codesign --verify --deep --strict --verbose=2 "$BUNDLE" 2>&1 | sed 's/^/      /'
  AUTHORITY="$(codesign -dvv "$BUNDLE" 2>&1 | awk -F= '/^Authority=/{ print $2; exit }')"
  if [ -n "$AUTHORITY" ]; then
    echo "  ok  signed by: $AUTHORITY"
    if xcrun stapler validate "$BUNDLE" >/dev/null 2>&1; then
      echo "  ok  notarization ticket stapled"
    else
      echo "  --  no stapled notarization ticket"
    fi
  else
    echo "  --  ad-hoc signature (no Developer ID): Gatekeeper will warn on download"
  fi
fi

"$SCRIPT_DIR/smoke-sidecar-binary.sh" "$BIN_DIR/openlinear-sidecar"
echo "==> Bundle verified"
