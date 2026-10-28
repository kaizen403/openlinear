/**
 * Colour math for the design tokens: OKLCH ⇄ sRGB, WCAG 2.x contrast and
 * alpha compositing. Pure functions, no DOM. Used by the token build
 * (`scripts/design-tokens.mjs`), the contrast test and the run kit.
 */

/** OKLCH with `l` in 0..1, `c` ≥ 0, `h` in degrees. */
export interface Oklch {
  readonly l: number
  readonly c: number
  readonly h: number
}

/** 8-bit sRGB. */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export function oklch(l: number, c: number, h: number): Oklch {
  return { l, c, h }
}

function srgbToLinear(channel: number): number {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return v * 255
}

/** Unrounded linear-light sRGB for an OKLCH colour (may fall outside 0..1). */
function oklchToLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

/** True when the colour is displayable in sRGB without clipping. */
export function inSrgbGamut(color: Oklch): boolean {
  const epsilon = 1e-4
  return oklchToLinearRgb(color).every((channel) => channel >= -epsilon && channel <= 1 + epsilon)
}

/** OKLCH → 8-bit sRGB (rounded; channels clipped to 0..255). */
export function oklchToRgb(color: Oklch): Rgb {
  const [r, g, b] = oklchToLinearRgb(color).map((channel) =>
    Math.min(255, Math.max(0, Math.round(linearToSrgb(Math.min(1, Math.max(0, channel)))))),
  )
  return { r, g, b }
}

/** 8-bit sRGB → OKLCH (for authoring and round-trip checks). */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const c = Math.sqrt(a * a + bb * bb)
  const h = c < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l, c: c < 1e-4 ? 0 : c, h }
}

export function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`Not a hex colour: ${hex}`)
  const body = match[1].length === 3 ? match[1].split("").map((ch) => ch + ch).join("") : match[1]
  const value = Number.parseInt(body, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

/** `R G B` — the channel form Tailwind's `rgb(var(--x) / <alpha-value>)` expects. */
export function toChannels({ r, g, b }: Rgb): string {
  return `${r} ${g} ${b}`
}

/** CSS `oklch()` text, rounded for readability. */
export function formatOklch({ l, c, h }: Oklch): string {
  const round = (value: number, digits: number) => Number(value.toFixed(digits))
  return `oklch(${round(l * 100, 2)}% ${round(c, 4)} ${round(h, 2)})`
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `fg` at `alpha` painted over an opaque `bg` (sRGB space, as browsers composite). */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (top: number, bottom: number) => Math.round(top * alpha + bottom * (1 - alpha))
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) }
}
