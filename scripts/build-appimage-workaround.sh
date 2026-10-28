#!/usr/bin/env bash
#
# AppImage build workaround for Tauri sidecar corruption.
#
# Root cause: linuxdeploy (used by tauri-bundler for AppImage) runs patchelf on
# every binary in usr/bin to set RUNPATH=$ORIGIN/../lib. This corrupts
# self-contained executables produced by pkg/SEA/Bun/PyInstaller/Nuitka, because
# their internal layout is not a normal dynamically-linked ELF. The opencode
# binary (~160MB Node SEA) and openlinear-sidecar (pkg-built) both trip this.
#
# Reported upstream:
#   https://github.com/tauri-apps/tauri/issues/5189
#   https://github.com/tauri-apps/tauri/issues/11898
#
# Workaround: build the AppImage WITHOUT the sidecars in externalBin so
# linuxdeploy never touches them, then inject the unpatched sidecars into the
# resulting AppDir and re-pack with appimagetool.
#
# appimagetool is pinned by version and SHA-256 (the same pin release.yml
# pre-seeds). A cached copy that does not match the pin — e.g. an older
# unpinned "continuous" download — is replaced, and a download that does not
# match fails the build.
#
# Usage:
#   scripts/build-appimage-workaround.sh              # build the AppImage
#   scripts/build-appimage-workaround.sh --tool-only  # only fetch + verify appimagetool
# Overrides (both together, for a deliberate pin bump):
#   APPIMAGETOOL_URL, APPIMAGETOOL_SHA256
# Cache location (default <repo>/.cache/appimage-tools): APPIMAGETOOL_CACHE_DIR

set -euo pipefail

# Pin: AppImage/appimagetool 1.9.1, verified against the release API digest
# (docs/reports/revamp-2026-10-26/release.md §3.3).
APPIMAGETOOL_PINNED_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_PINNED_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"

TOOL_ONLY=0
case "${1:-}" in
    "") ;;
    --tool-only) TOOL_ONLY=1 ;;
    *) echo "usage: $0 [--tool-only]" >&2; exit 2 ;;
esac

if [ -n "${APPIMAGETOOL_URL:-}${APPIMAGETOOL_SHA256:-}" ] \
    && { [ -z "${APPIMAGETOOL_URL:-}" ] || [ -z "${APPIMAGETOOL_SHA256:-}" ]; }; then
    echo "[appimage] set APPIMAGETOOL_URL and APPIMAGETOOL_SHA256 together" >&2
    exit 2
fi
APPIMAGETOOL_URL="${APPIMAGETOOL_URL:-$APPIMAGETOOL_PINNED_URL}"
APPIMAGETOOL_SHA256="${APPIMAGETOOL_SHA256:-$APPIMAGETOOL_PINNED_SHA256}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[appimage]${NC} $1"; }
ok()   { echo -e "${GREEN}[appimage]${NC} $1"; }
warn() { echo -e "${YELLOW}[appimage]${NC} $1"; }
err()  { echo -e "${RED}[appimage]${NC} $1"; }

TAURI_CONF="apps/desktop/src-tauri/tauri.conf.json"
TAURI_CONF_BACKUP="$TAURI_CONF.appimage-backup"
BINARIES_DIR="apps/desktop/src-tauri/binaries"
BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"
APPIMAGE_DIR="$BUNDLE_DIR/appimage"
CACHE_DIR="${APPIMAGETOOL_CACHE_DIR:-$ROOT_DIR/.cache/appimage-tools}"
APPIMAGETOOL="$CACHE_DIR/appimagetool-x86_64.AppImage"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# Leaves a verified, executable appimagetool at $APPIMAGETOOL or exits 1.
ensure_appimagetool() {
    mkdir -p "$CACHE_DIR"
    if [ -f "$APPIMAGETOOL" ]; then
        if [ "$(sha256_of "$APPIMAGETOOL")" = "$APPIMAGETOOL_SHA256" ]; then
            chmod +x "$APPIMAGETOOL"
            ok "appimagetool verified (cached, sha256 ${APPIMAGETOOL_SHA256:0:12}…)"
            return 0
        fi
        warn "Cached appimagetool does not match the pinned sha256 (stale or unpinned download); replacing it."
        rm -f "$APPIMAGETOOL"
    fi
    log "Downloading appimagetool from $APPIMAGETOOL_URL ..."
    local tmp="$APPIMAGETOOL.download.$$"
    if ! curl -fsSL --retry 3 -o "$tmp" "$APPIMAGETOOL_URL"; then
        rm -f "$tmp"
        err "Failed to download appimagetool."
        exit 1
    fi
    local actual
    actual="$(sha256_of "$tmp")"
    if [ "$actual" != "$APPIMAGETOOL_SHA256" ]; then
        rm -f "$tmp"
        err "appimagetool checksum mismatch: expected $APPIMAGETOOL_SHA256, got $actual."
        exit 1
    fi
    chmod +x "$tmp"
    mv -f "$tmp" "$APPIMAGETOOL"
    ok "appimagetool downloaded and verified (sha256 ${APPIMAGETOOL_SHA256:0:12}…)"
}

ensure_appimagetool
if [ "$TOOL_ONLY" = 1 ]; then
    exit 0
fi

restore_state() {
    if [ -f "$TAURI_CONF_BACKUP" ]; then
        mv "$TAURI_CONF_BACKUP" "$TAURI_CONF"
        log "Restored $TAURI_CONF."
    fi
}
trap restore_state EXIT

log "Backing up $TAURI_CONF and stripping externalBin for clean linuxdeploy run..."
cp "$TAURI_CONF" "$TAURI_CONF_BACKUP"

# Strip "externalBin" array from the bundle section. Sidecars will be injected
# back into the AppDir after Tauri finishes.
node -e '
const fs = require("fs");
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, "utf8"));
delete j.bundle.externalBin;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$TAURI_CONF"

log "Cleaning previous AppImage build artifacts..."
rm -rf "$APPIMAGE_DIR" "$BUNDLE_DIR/appimage_deb"

log "Running tauri build --bundles appimage (without sidecars)..."
NO_STRIP=1 pnpm --filter @openlinear/desktop tauri build --bundles appimage

APPDIR="$APPIMAGE_DIR/OpenLinear.AppDir"
if [ ! -d "$APPDIR" ]; then
    err "Expected AppDir not found at $APPDIR"
    exit 1
fi

INITIAL_APPIMAGE="$(find "$APPIMAGE_DIR" -maxdepth 1 -type f -name "*.AppImage" | head -1 || true)"
if [ -n "$INITIAL_APPIMAGE" ]; then
    log "Removing initial sidecar-less AppImage: $(basename "$INITIAL_APPIMAGE")"
    rm -f "$INITIAL_APPIMAGE"
fi

log "Injecting unpatched sidecars into $APPDIR/usr/bin..."
HOST_TRIPLE="x86_64-unknown-linux-gnu"
for name in opencode openlinear-sidecar; do
    src="$BINARIES_DIR/${name}-${HOST_TRIPLE}"
    if [ ! -f "$src" ]; then
        err "Missing sidecar source: $src"
        exit 1
    fi
    cp "$src" "$APPDIR/usr/bin/$name"
    chmod +x "$APPDIR/usr/bin/$name"
    ok "  injected $name ($(du -h "$src" | cut -f1))"
done

log "Removing bundled glib/gio libs so app uses host versions (avoids gvfs ABI mismatch)..."
for pattern in 'libgio-2.0.so*' 'libglib-2.0.so*' 'libgmodule-2.0.so*' 'libgobject-2.0.so*' 'libgthread-2.0.so*'; do
    find "$APPDIR/usr/lib" -maxdepth 1 -name "$pattern" -delete 2>/dev/null || true
done
rm -rf "$APPDIR/usr/lib/gio" "$APPDIR/usr/lib/gvfs"

log "Patching AppRun to clear GIO_MODULE_DIR (skip gvfs module probing)..."
APPRUN="$APPDIR/AppRun"
if ! grep -q "GIO_MODULE_DIR" "$APPRUN"; then
    sed -i '0,/^export /{s|^export |export GIO_MODULE_DIR=\nexport GSETTINGS_SCHEMA_DIR="${APPDIR}/usr/share/glib-2.0/schemas"\nexport |}' "$APPRUN"
fi

log "Repacking AppImage with appimagetool..."
VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$TAURI_CONF_BACKUP")"
OUTPUT_APPIMAGE="$APPIMAGE_DIR/OpenLinear_${VERSION}_amd64.AppImage"

ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" "$OUTPUT_APPIMAGE"

if [ ! -f "$OUTPUT_APPIMAGE" ]; then
    err "appimagetool did not produce $OUTPUT_APPIMAGE"
    exit 1
fi
chmod +x "$OUTPUT_APPIMAGE"

ok "AppImage built: $OUTPUT_APPIMAGE ($(du -h "$OUTPUT_APPIMAGE" | cut -f1))"
