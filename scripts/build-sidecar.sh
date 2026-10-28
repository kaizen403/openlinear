#!/usr/bin/env bash
set -euo pipefail

# Builds the packaged (pkg) sidecar executable for one Tauri target and
# installs it as apps/desktop/src-tauri/binaries/openlinear-sidecar-<triple>
# (Tauri externalBin naming). Then fetches and verifies the matching OpenCode
# binary (scripts/download-opencode.sh) unless SKIP_OPENCODE_DOWNLOAD=1.
#
# Usage:
#   scripts/build-sidecar.sh                      # host target
#   scripts/build-sidecar.sh --target x86_64-apple-darwin
#   SIDECAR_TARGET=<triple> scripts/build-sidecar.sh
#
# pkg cannot cross-compile Node's native layout reliably for macOS (the base
# binary must be signed on the target OS), so release.yml builds each target
# on its own runner.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$ROOT_DIR/apps/sidecar"
BINARIES_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"

TARGET="${SIDECAR_TARGET:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TARGET" ]; then
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) TARGET="aarch64-apple-darwin" ;;
    Darwin/x86_64) TARGET="x86_64-apple-darwin" ;;
    Linux/x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
    Linux/aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
    *) echo "==> Unsupported host: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
  esac
fi

# The sidecar journal uses `node:sqlite`, which needs Node >= 22.5 (and the
# --experimental-sqlite flag below 22.13), so the packaged runtime is Node 22.
# Node 18 binaries cannot load the sidecar at all.
case "$TARGET" in
  aarch64-apple-darwin) PKG_TARGET="node22-macos-arm64" ;;
  x86_64-apple-darwin) PKG_TARGET="node22-macos-x64" ;;
  x86_64-unknown-linux-gnu) PKG_TARGET="node22-linux-x64" ;;
  aarch64-unknown-linux-gnu) PKG_TARGET="node22-linux-arm64" ;;
  *) echo "==> Unsupported target triple: $TARGET" >&2; exit 1 ;;
esac
# Baked into the executable: harmless on Node >= 22.13, required below it
# (pkg-fetch 3.5.x ships Node 22.10.0).
PKG_NODE_OPTIONS="experimental-sqlite"

echo "==> Target: $TARGET (pkg $PKG_TARGET)"

echo "==> Bundling the API-only sidecar (CommonJS, no Prisma, no @openlinear/api)..."
cd "$SIDECAR_DIR"
# W03a: the packaged sidecar persists only through OPENLINEAR_API_URL. The
# bundle step fails if any database or cloud-API source is included, and no
# Prisma client/query-compiler artifacts are shipped any more.
node esbuild.config.js --packaged

# pkg's dependency walker decides whether `require("node:x")` is a built-in
# with the host's `module.builtinModules`, which does not list prefix-only
# built-ins (node:sqlite, node:test, node:sea). It then tries to read
# "node:sqlite" as a file and aborts ("Cannot read file, ENOENT node:sqlite").
# Load those through process.getBuiltinModule() (Node >= 22.3), which pkg
# does not walk. Every other require is left untouched.
# shellcheck disable=SC2016 # single quotes: JavaScript, not shell
node -e '
const fs = require("node:fs");
const { builtinModules } = require("node:module");
const file = process.argv[1];
const source = fs.readFileSync(file, "utf8");
const rewritten = [];
const output = source.replace(/\brequire\("node:([a-z_/]+)"\)/g, (match, name) => {
  if (builtinModules.includes(name)) return match;
  rewritten.push(name);
  return `process.getBuiltinModule("node:${name}")`;
});
fs.writeFileSync(file, output);
console.log(rewritten.length
  ? `  - prefix-only built-ins loaded via process.getBuiltinModule: ${[...new Set(rewritten)].join(", ")}`
  : "  - no prefix-only built-ins in the bundle");
' dist/bundle.cjs

OUTPUT="dist/openlinear-sidecar-$TARGET"
echo "==> Building $OUTPUT with pkg ($PKG_TARGET)..."
# `pnpm exec` uses the lockfile-pinned @yao-pkg/pkg and fails if it is missing
# (npx would silently download whatever is latest). pkg-fetch verifies the
# Node base binary it downloads against its own pinned hashes.
pnpm exec pkg dist/bundle.cjs --target "$PKG_TARGET" --options "$PKG_NODE_OPTIONS" --output "$OUTPUT"

cd "$ROOT_DIR"
mkdir -p "$BINARIES_DIR"
# New file + rename: overwriting a signed Mach-O in place makes macOS kill it.
DEST="$BINARIES_DIR/openlinear-sidecar-$TARGET"
cp "$SIDECAR_DIR/$OUTPUT" "$DEST.tmp.$$"
chmod 0755 "$DEST.tmp.$$"
mv -f "$DEST.tmp.$$" "$DEST"
echo "  - $BINARIES_DIR/openlinear-sidecar-$TARGET"

if [ "${SKIP_OPENCODE_DOWNLOAD:-0}" != "1" ]; then
  echo "==> Downloading and verifying the OpenCode binary..."
  "$SCRIPT_DIR/download-opencode.sh" --target "$TARGET"
fi

echo "==> Build complete!"
ls -la "$BINARIES_DIR"
