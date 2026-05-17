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

set -euo pipefail

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
CACHE_DIR="$ROOT_DIR/.cache/appimage-tools"
APPIMAGETOOL="$CACHE_DIR/appimagetool-x86_64.AppImage"

mkdir -p "$CACHE_DIR"

if [ ! -x "$APPIMAGETOOL" ]; then
    log "Downloading appimagetool..."
    curl -fsSL -o "$APPIMAGETOOL" \
        https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
    chmod +x "$APPIMAGETOOL"
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
