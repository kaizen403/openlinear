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
family = "Anthropic Sans"

def set_windows_name(font, name_id, value):
    font["name"].setName(value, name_id, 3, 1, 0x409)

def normalize_static_face(font, style, weight):
    # Instancing removes fvar/gvar, but keep the generated files free of
    # leftover axis metadata so WebKitGTK/fontconfig register four plain faces.
    for tag in ("fvar", "avar", "gvar", "HVAR", "MVAR", "VVAR", "STAT"):
        if tag in font:
            del font[tag]

    font["OS/2"].usWeightClass = weight
    selection = font["OS/2"].fsSelection
    selection &= ~(1 << 5)  # Bold
    selection &= ~(1 << 6)  # Regular
    selection |= 1 << 7     # Use typo metrics
    if weight == 400:
        selection |= 1 << 6
    if weight >= 700:
        selection |= 1 << 5
    font["OS/2"].fsSelection = selection

    font["head"].macStyle &= ~0b11
    if weight >= 700:
        font["head"].macStyle |= 0b1

    font["name"].names = [
        record
        for record in font["name"].names
        if record.nameID not in {1, 2, 3, 4, 6, 16, 17, 25}
    ]
    set_windows_name(font, 1, family)
    set_windows_name(font, 2, style)
    set_windows_name(font, 3, f"OpenLinear;AnthropicSans-{style};static-opsz16-wght{weight}")
    set_windows_name(font, 4, f"{family} {style}")
    set_windows_name(font, 6, f"AnthropicSans-{style}")
    set_windows_name(font, 16, family)
    set_windows_name(font, 17, style)

for name, wght in weights:
    font = TTFont(src)
    inst = instantiateVariableFont(
        font, {"wght": wght, "opsz": 16}, inplace=False, optimize=True
    )
    normalize_static_face(inst, name, wght)
    inst.flavor = "woff2"
    out = f"AnthropicSans-{name}.woff2"
    inst.save(out)
    import os
    print(f"  wrote {out} ({os.path.getsize(out)} bytes)")
PY

echo "done. static fonts written to $FONT_DIR"
