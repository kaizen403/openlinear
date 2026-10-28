/**
 * Every colour pair the token set promises, with its WCAG 2.x minimum.
 *
 * - `text`: body text, 4.5:1 (WCAG 1.4.3). The UI's text is 10–14 px, so no
 *   pair qualifies for the large-text 3:1 exception.
 * - `ui`: component boundaries, focus indicators, state indicators and icons
 *   that carry meaning, 3:1 (WCAG 1.4.11).
 * - `decorative`: separators and card outlines that identify nothing on their
 *   own; reported, not enforced (1.4.11 does not apply).
 *
 * Disabled controls are exempt (they render at 50 % opacity) and not listed.
 */
import { composite, contrastRatio, parseHex, toHex, type Rgb } from "./color"
import { ACCENT_PRESETS, type AccentPreset } from "./accent"
import {
  COMPONENT,
  STATE,
  STATE_LAYER,
  isComponentName,
  resolveToken,
  runtimeInputOf,
  type RuntimeInputName,
  type SemanticName,
  type TokenName,
} from "./tokens"

export type PairKind = "text" | "ui" | "decorative"

export const MINIMUM: Readonly<Record<PairKind, number>> = { text: 4.5, ui: 3, decorative: 0 }

/** A token, optionally at an alpha painted over an opaque token. */
export interface Paint {
  readonly token: TokenName
  readonly alpha?: number
  readonly over?: TokenName
}

export interface ContrastPair {
  readonly fg: Paint
  readonly bg: Paint
  readonly kind: PairKind
  readonly usage: string
}

export interface ContrastResult extends ContrastPair {
  readonly fgHex: string
  readonly bgHex: string
  readonly ratio: number
  readonly minimum: number
  readonly pass: boolean
}

export type Resolver = (token: TokenName) => Rgb

/** Surfaces text is drawn on (including the hover/pressed state layers). */
export const TEXT_SURFACES = [
  "background",
  "popover",
  "card",
  "linear-bg-tertiary",
  "linear-bg",
  "linear-bg-secondary",
  "surface-hover",
  "surface-pressed",
] as const satisfies readonly TokenName[]

/** Surfaces controls sit on (inputs live on pages, cards, popovers, dialogs). */
export const CONTROL_SURFACES = [
  "background",
  "popover",
  "card",
  "linear-bg-tertiary",
  "linear-bg",
  "linear-bg-secondary",
  "surface-hover",
] as const satisfies readonly TokenName[]

const NEUTRAL_TEXT = [
  "linear-text",
  "foreground",
  "linear-text-secondary",
  "linear-text-tertiary",
  "muted-foreground",
] as const satisfies readonly TokenName[]

/**
 * Coloured text and icons that are also drawn on their own /10 and /20 tint
 * (chips, banners, pills, hovered chips).
 */
export const TINTED_TEXT = [
  "brand",
  "destructive",
  "tone-success",
  "tone-warning",
  "tone-info",
  "tone-discovery",
  "tone-neutral",
  "status-in-progress",
  "status-done",
  "status-cancelled",
  "status-error",
  "status-committing",
  "status-publishing",
  "priority-medium",
  "priority-high",
  "priority-urgent",
  "run-neutral",
  "run-info",
  "run-active",
  "run-warning",
  "run-success",
  "run-danger",
] as const satisfies readonly TokenName[]

/** Status/priority text drawn on neutral chips (`bg-muted`), never on its own tint. */
const NEUTRAL_CHIP_TEXT = ["status-todo", "priority-low"] as const satisfies readonly TokenName[]

function pairs(): ContrastPair[] {
  const list: ContrastPair[] = []
  const add = (fg: Paint, bg: Paint, kind: PairKind, usage: string) => list.push({ fg, bg, kind, usage })

  for (const surface of TEXT_SURFACES) {
    for (const token of NEUTRAL_TEXT) add({ token }, { token: surface }, "text", "text ladder")
    for (const token of NEUTRAL_CHIP_TEXT) add({ token }, { token: surface }, "text", "neutral status / priority chip")
    for (const token of TINTED_TEXT) add({ token }, { token: surface }, "text", "coloured text, icons, dots")
  }
  // Tints are measured with the text token itself. `bg-linear-accent/10` and
  // `bg-destructive/10` tint the darker solids, which only raises contrast.
  for (const token of TINTED_TEXT) {
    for (const over of ["linear-bg", "linear-bg-secondary"] as const) {
      add({ token }, { token, alpha: 0.1, over }, "text", "chip / banner on its own 10% tint")
      add({ token }, { token, alpha: 0.2, over }, "text", "chip on its own 20% tint")
    }
  }
  for (const token of ["linear-text", "linear-text-secondary", "linear-text-tertiary"] as const) {
    add({ token }, { token: "brand", alpha: 0.1, over: "linear-bg" }, "text", "selected card / row (brand 10%)")
  }
  // Rows under a translucent state layer (`bg-layer-faint`, `hover:bg-layer-hover`).
  for (const over of ["background", "linear-bg", "linear-bg-secondary"] as const) {
    for (const token of NEUTRAL_TEXT) {
      add({ token }, { token: "state-layer", alpha: STATE_LAYER.faint, over }, "text", "unread row / group header (state layer)")
      add({ token }, { token: "state-layer", alpha: STATE_LAYER.hover, over }, "text", "hovered row (state layer)")
    }
    for (const token of TINTED_TEXT) {
      add({ token }, { token: "state-layer", alpha: STATE_LAYER.hover, over }, "text", "coloured icon / text on a hovered row (state layer)")
    }
  }

  // Text on fills: rest, hover and pressed (STATE alphas) over every surface.
  // `bg-linear-accent` and `bg-destructive` resolve to these solids too
  // (tailwind.config.ts backgroundColor), so legacy `… text-white` buttons are covered.
  const solids = [
    ["primary-foreground", "primary", "primary button, badge, checked selection, bg-linear-accent"],
    ["accent-foreground", "accent", "menu highlight, ghost/outline hover"],
    ["destructive-foreground", "destructive-solid", "destructive button, bg-destructive"],
  ] as const satisfies readonly (readonly [TokenName, TokenName, string])[]
  for (const [fg, bg, usage] of solids) {
    add({ token: fg }, { token: bg }, "text", usage)
    for (const over of TEXT_SURFACES) {
      add({ token: fg }, { token: bg, alpha: STATE.hover, over }, "text", `${usage} (hover)`)
      add({ token: fg }, { token: bg, alpha: STATE.pressed, over }, "text", `${usage} (pressed)`)
    }
  }
  add({ token: "foreground" }, { token: "background" }, "text", "shadcn foreground/background")
  add({ token: "card-foreground" }, { token: "card" }, "text", "card")
  add({ token: "popover-foreground" }, { token: "popover" }, "text", "popover, menu, select")
  add({ token: "secondary-foreground" }, { token: "secondary" }, "text", "secondary button")
  add({ token: "muted-foreground" }, { token: "muted" }, "text", "tabs list, muted panels")

  // Non-text contrast (3:1).
  for (const surface of CONTROL_SURFACES) {
    add({ token: "input" }, { token: surface }, "ui", "input / select / textarea / checkbox boundary, switch track (off), slider track")
    add({ token: "ring" }, { token: surface }, "ui", "focus ring")
    add({ token: "brand" }, { token: surface }, "ui", "accent indicator, selected border, progress")
    add({ token: "primary" }, { token: surface }, "ui", "checked checkbox / selection fill")
    add({ token: "foreground" }, { token: surface }, "ui", "switch track (on), checked checkbox, slider")
  }
  add({ token: "background" }, { token: "input" }, "ui", "switch thumb on the off track")
  add({ token: "foreground" }, { token: "input" }, "ui", "slider range on its track")
  add({ token: "background" }, { token: "foreground" }, "ui", "switch thumb / check mark on the on track")

  // Decorative: reported only.
  for (const surface of ["background", "linear-bg", "linear-bg-secondary"] as const) {
    add({ token: "border" }, { token: surface }, "decorative", "default border (separators)")
    add({ token: "linear-border" }, { token: surface }, "decorative", "card / panel outline")
    add({ token: "linear-border-hover" }, { token: surface }, "decorative", "hovered outline")
    add({ token: "scrollbar-thumb" }, { token: surface }, "decorative", "scrollbar thumb")
    add({ token: "state-layer", alpha: STATE_LAYER.divider }, { token: surface }, "decorative", "row divider (state layer)")
    add({ token: "state-layer", alpha: STATE_LAYER.outline }, { token: surface }, "decorative", "chip outline (state layer)")
  }
  return list
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = pairs()

function paint(p: Paint, resolve: Resolver, under?: Rgb): Rgb {
  const color = resolve(p.token)
  if (p.alpha === undefined) return color
  const base = p.over ? resolve(p.over) : under
  if (!base) throw new Error(`Translucent ${p.token} needs an opaque surface`)
  return composite(color, p.alpha, base)
}

export function describePaint(p: Paint): string {
  if (p.alpha === undefined) return p.token
  return `${p.token}/${Math.round(p.alpha * 100)}${p.over ? ` over ${p.over}` : ""}`
}

export function evaluatePairs(list: readonly ContrastPair[] = CONTRAST_PAIRS, resolve: Resolver = resolveToken): ContrastResult[] {
  return list.map((pair) => {
    const bg = paint(pair.bg, resolve)
    const fg = paint(pair.fg, resolve, bg)
    const ratio = contrastRatio(fg, bg)
    const minimum = MINIMUM[pair.kind]
    return { ...pair, fgHex: toHex(fg), bgHex: toHex(bg), ratio, minimum, pass: ratio + 1e-9 >= minimum }
  })
}

/** Resolves tokens as if the accent picker had applied `preset`. */
export function resolverForAccent(preset: AccentPreset): Resolver {
  const inputs: Readonly<Record<RuntimeInputName, Rgb>> = {
    "linear-accent-rgb": parseHex(preset.accent),
    "linear-accent-hover-rgb": parseHex(preset.solid),
  }
  return (token) => {
    const semantic: SemanticName = isComponentName(token) ? COMPONENT[token] : token
    const input = runtimeInputOf(semantic)
    return input ? inputs[input] : resolveToken(token)
  }
}

function readsAccent(paint: Paint): boolean {
  const semantic: SemanticName = isComponentName(paint.token) ? COMPONENT[paint.token] : paint.token
  return runtimeInputOf(semantic) !== null
}

/** The pairs whose colours change with the accent picker. */
export const ACCENT_PAIRS: readonly ContrastPair[] = CONTRAST_PAIRS.filter(
  (pair) => pair.kind !== "decorative" && (readsAccent(pair.fg) || readsAccent(pair.bg)),
)

export interface PresetResult extends ContrastResult {
  readonly preset: string
}

/** Every accent-dependent pair, re-evaluated for each picker preset. */
export function evaluateAccentPresets(presets: readonly AccentPreset[] = ACCENT_PRESETS): PresetResult[] {
  return presets.flatMap((preset) =>
    evaluatePairs(ACCENT_PAIRS, resolverForAccent(preset)).map((result) => ({ ...result, preset: preset.name })),
  )
}
