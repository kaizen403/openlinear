/**
 * Accent presets for Settings → Appearance, and the default accent.
 *
 * Each preset has a brand colour (indicators, accent text, borders, tints) and
 * a solid colour: the same hue with the OKLCH lightness lowered until white
 * text clears 4.5:1 (target 4.6:1). The picker writes them to
 * `--linear-accent-rgb` and `--linear-accent-hover-rgb` (legacy name; it is
 * the solid). The token test checks every preset: brand text ≥ 4.5:1 on the
 * dark surfaces, white on the solid (and its hover/pressed tints) ≥ 4.5:1,
 * same hue, darker solid.
 *
 * To add a preset, run `node scripts/design-tokens.mjs --suggest <hex>`: it
 * prints the solid (and a lighter brand if the hex is too dark for text).
 */
import { formatOklch, inSrgbGamut, oklch, oklchToRgb, parseHex, rgbToOklch, toHex, contrastRatio, type Oklch } from "./color"
import { PRIMITIVES } from "./palette"

export interface AccentPreset {
  readonly name: string
  /** Brand colour (`--linear-accent`). */
  readonly accent: string
  /** Fill behind white text (`--linear-accent-hover`). */
  readonly solid: string
}

export const DEFAULT_ACCENT: AccentPreset = {
  name: "Emerald",
  accent: toHex(oklchToRgb(PRIMITIVES["emerald-70"])),
  solid: toHex(oklchToRgb(PRIMITIVES["emerald-55"])),
}

// Brand colours keep the original presets' hues. Purple (#8b5cf6), Pink
// (#ec4899) and Red (#ef4444) were lightened within their hue until accent
// text passes on 20% tints and the pressed surface. Solids that already passed
// (#7c3aed, #dc2626) are unchanged.
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  DEFAULT_ACCENT,
  { name: "Purple", accent: "#a07fff", solid: "#7c3aed" },
  { name: "Green", accent: "#22c55e", solid: "#02873b" },
  { name: "Orange", accent: "#f97316", solid: "#c05402" },
  { name: "Pink", accent: "#f954a4", solid: "#d42e85" },
  { name: "Red", accent: "#ff5754", solid: "#dc2626" },
  { name: "Teal", accent: "#14b8a6", solid: "#008376" },
  { name: "Yellow", accent: "#eab308", solid: "#936f02" },
]

const WHITE = parseHex("#ffffff")

function fitToGamut(l: number, c: number, h: number): Oklch {
  let chroma = c
  while (chroma > 0 && !inSrgbGamut(oklch(l, chroma, h))) chroma = Math.max(0, chroma - 0.001)
  return oklch(l, chroma, h)
}

/**
 * The lightest colour of the same hue that white text reaches `target` on,
 * found by lowering OKLCH lightness (chroma reduced only to stay in gamut).
 */
export function solidFor(hex: string, target = 4.6): { hex: string; oklch: string; ratio: number } {
  const start = rgbToOklch(parseHex(hex))
  for (let l = start.l; l > 0.1; l -= 0.0025) {
    const color = fitToGamut(l, start.c, start.h)
    const rgb = oklchToRgb(color)
    const ratio = contrastRatio(rgb, WHITE)
    if (ratio >= target) return { hex: toHex(rgb), oklch: formatOklch(color), ratio }
  }
  throw new Error(`No solid for ${hex}`)
}

/**
 * The darkest colour of the same hue that reaches `target` as text on
 * `surface`, found by raising OKLCH lightness.
 */
export function textSafe(hex: string, surface: string, target = 4.6): { hex: string; oklch: string; ratio: number } {
  const start = rgbToOklch(parseHex(hex))
  const bg = parseHex(surface)
  for (let l = start.l; l < 1; l += 0.0025) {
    const color = fitToGamut(l, start.c, start.h)
    const rgb = oklchToRgb(color)
    const ratio = contrastRatio(rgb, bg)
    if (ratio >= target) return { hex: toHex(rgb), oklch: formatOklch(color), ratio }
  }
  throw new Error(`No text-safe variant of ${hex} on ${surface}`)
}
