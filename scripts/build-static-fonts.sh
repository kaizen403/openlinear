#!/usr/bin/env bash
# Regenerate static per-weight masters of Anthropic Sans from a source
# variable font. Run this only when the upstream variable font is updated.
#
# Output: apps/desktop-ui/public/fonts/AnthropicSans-{Regular,Medium,SemiBold,Bold}.woff2
#
# Each output is the variable font instanced at a single wght and pinned
# at opsz=16 (the Text master) — see globals.css for why we ship static
# masters instead of the variable file.
#
# Requires: python3, fonttools, brotli
#   pip install --user fonttools brotli

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_DIR="$ROOT_DIR/apps/desktop-ui/public/fonts"
SRC="${1:-$FONT_DIR/AnthropicSans.woff2}"

if [ ! -f "$SRC" ]; then
    echo "error: source variable font not found at $SRC" >&2
    echo "usage: $0 [path/to/variable.woff2]" >&2
    exit 1
fi

cd "$FONT_DIR"
python3 - "$SRC" <<'PY'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

src = sys.argv[1]
weights = [("Regular", 400), ("Medium", 500), ("SemiBold", 600), ("Bold", 700)]

for name, wght in weights:
    font = TTFont(src)
    inst = instantiateVariableFont(
        font, {"wght": wght, "opsz": 16}, inplace=False, optimize=True
    )
    inst.flavor = "woff2"
    out = f"AnthropicSans-{name}.woff2"
    inst.save(out)
    import os
    print(f"  wrote {out} ({os.path.getsize(out)} bytes)")
PY

echo "done. static fonts written to $FONT_DIR"
