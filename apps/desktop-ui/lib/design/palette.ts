/**
 * Tier 1 — primitive colours, authored in OKLCH.
 *
 * Names are `<hue>-<L>`, where L is the OKLCH lightness × 100. The name tells
 * you how light the colour is, so "darker within the same hue" means "a
 * smaller number". The token test checks that each name matches its L (±1).
 *
 * Only semantic tokens (tokens.ts) may reference primitives. Components never
 * do: they use Tailwind classes that resolve to tier 2/3 variables.
 *
 * Every value round-trips to the hex in PRIMITIVE_HEX and sits inside the
 * sRGB gamut (checked by the test), because the runtime CSS is emitted as
 * sRGB channels. See docs/design-tokens.md, "Why sRGB channels at runtime".
 */
import { oklch, type Oklch } from "./color"

export const PRIMITIVES = {
  // Neutral ramp (achromatic). The near-black steps are the app's existing
  // surface ladder; components rely on the small steps between them.
  "neutral-100": oklch(1, 0, 0),
  "neutral-97": oklch(0.9702, 0, 0),
  "neutral-92": oklch(0.9249, 0, 0),
  "neutral-71": oklch(0.7058, 0, 0),
  "neutral-63": oklch(0.6334, 0, 0),
  "neutral-52": oklch(0.5243, 0, 0),
  "neutral-35": oklch(0.3485, 0, 0),
  "neutral-28": oklch(0.285, 0, 0),
  "neutral-24": oklch(0.2393, 0, 0),
  "neutral-22": oklch(0.2178, 0, 0),
  "neutral-19": oklch(0.1913, 0, 0),
  "neutral-18": oklch(0.1776, 0, 0),
  "neutral-17": oklch(0.1684, 0, 0),
  "neutral-16": oklch(0.1591, 0, 0),
  "neutral-14": oklch(0.1448, 0, 0),
  "neutral-13": oklch(0.1344, 0, 0),
  // Black: the modal scrim (dims everything under a dialog or drawer).
  "neutral-0": oklch(0, 0, 0),

  // Brand: emerald, hue 162.48. 70 is the identity colour, unchanged. 55 is
  // the same hue with the lightness lowered until white text clears 4.5:1
  // with margin (4.66:1). It fills anything that carries text.
  "emerald-70": oklch(0.6959, 0.1491, 162.48),
  "emerald-55": oklch(0.5459, 0.1181, 162.48),

  // Status hues: the Tailwind 400s the UI already used, so chips keep their
  // colour. red-55 is the existing destructive fill (white text 5.43:1).
  "green-80": oklch(0.8003, 0.1821, 151.71),
  "amber-84": oklch(0.8369, 0.1644, 84.43),
  "red-71": oklch(0.7106, 0.1661, 22.22),
  "red-55": oklch(0.5496, 0.2181, 28.51),
  "sky-75": oklch(0.7535, 0.139, 232.66),
  "purple-72": oklch(0.7217, 0.1767, 305.5),
} as const satisfies Record<string, Oklch>

export type PrimitiveName = keyof typeof PRIMITIVES

/** The hex each primitive must round-trip to (an authoring guard; the test checks it). */
export const PRIMITIVE_HEX: Readonly<Record<PrimitiveName, string>> = {
  "neutral-100": "#ffffff",
  "neutral-97": "#f5f5f5",
  "neutral-92": "#e6e6e6",
  "neutral-71": "#a0a0a0",
  "neutral-63": "#8a8a8a",
  "neutral-52": "#6a6a6a",
  "neutral-35": "#3a3a3a",
  "neutral-28": "#2a2a2a",
  "neutral-24": "#1f1f1f",
  "neutral-22": "#1a1a1a",
  "neutral-19": "#141414",
  "neutral-18": "#111111",
  "neutral-17": "#0f0f0f",
  "neutral-16": "#0d0d0d",
  "neutral-14": "#0a0a0a",
  "neutral-13": "#080808",
  "neutral-0": "#000000",
  "emerald-70": "#10b981",
  "emerald-55": "#03855b",
  "green-80": "#4ade80",
  "amber-84": "#fbbf24",
  "red-71": "#f87171",
  "red-55": "#d31212",
  "sky-75": "#38bdf8",
  "purple-72": "#c084fc",
}
