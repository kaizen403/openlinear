/**
 * Tier 2 (semantic) and tier 3 (component/role) colour tokens.
 *
 *   tier 1  --ol-<hue>-<L>        palette.ts: OKLCH primitives, never used by components
 *   tier 2  --surface-*, --fg-*,  meaning: what a colour is for
 *           --border-*, --accent-*, --tone-*
 *   tier 3  --background, --primary, --linear-text, --status-done, ...
 *           role tokens Tailwind classes resolve to (shadcn names, the legacy
 *           linear-* names, board status/priority, run phases)
 *
 * Tier 2 references primitives or a runtime input; tier 3 references tier 2.
 * The CSS block in app/globals.css is generated from this file by
 * `node scripts/design-tokens.mjs --write`; lib/design/tokens.test.ts fails
 * when the two drift or when a contrast pair in contrast.ts drops below its
 * WCAG minimum.
 */
import { oklchToRgb, toHex, type Rgb } from "./color"
import { PRIMITIVES, type PrimitiveName } from "./palette"

/**
 * Runtime inputs: the accent picker (components/settings/appearance-section.tsx
 * and the boot script in app/layout.tsx) writes these on <html>. Their
 * defaults are primitives. Names are legacy and kept for stored preferences:
 * `-hover-` is the solid accent (the fill behind text), not a hover colour.
 */
export const RUNTIME_INPUTS = {
  "linear-accent-rgb": "emerald-70",
  "linear-accent-hover-rgb": "emerald-55",
} as const satisfies Record<string, PrimitiveName>

export type RuntimeInputName = keyof typeof RUNTIME_INPUTS

type SemanticRef = PrimitiveName | `input:${RuntimeInputName}`

export const SEMANTIC = {
  // Surfaces, darkest to lightest. "inset" is darker than "app" (the
  // existing ladder; see docs/design-tokens.md, "Known deviations").
  "surface-overlay": "neutral-13",
  "surface-canvas": "neutral-14",
  "surface-card": "neutral-16",
  "surface-inset": "neutral-17",
  "surface-app": "neutral-18",
  "surface-raised": "neutral-19",
  "surface-hover": "neutral-22",
  "surface-pressed": "neutral-24",

  // Text and icons.
  "fg-primary": "neutral-97",
  "fg-default": "neutral-92",
  "fg-secondary": "neutral-71",
  "fg-tertiary": "neutral-63",
  "fg-on-solid": "neutral-100",
  "fg-on-inverse": "neutral-14",

  // Borders. Only `control` and `focus` carry meaning (WCAG 1.4.11, 3:1);
  // subtle/default/strong are decorative separators and card outlines.
  "border-subtle": "neutral-24",
  "border-default": "neutral-28",
  "border-strong": "neutral-35",
  "border-control": "neutral-52",
  "border-focus": "neutral-92",

  // Accent (runtime-themable).
  "accent-brand": "input:linear-accent-rgb",
  "accent-solid": "input:linear-accent-hover-rgb",

  // Tones. Each is the text/icon/dot colour; tints are the same token at
  // /10 (background) and /30 (border). Only danger has a solid fill.
  "tone-neutral": "neutral-71",
  "tone-info": "sky-75",
  "tone-success": "green-80",
  "tone-warning": "amber-84",
  "tone-danger": "red-71",
  "tone-danger-solid": "red-55",
  "tone-discovery": "purple-72",

  // Translucent layers. `state-layer` is painted at a STATE_LAYER alpha over
  // whatever surface is underneath (row hover, unread/emphasis rows, row
  // dividers, chip outlines), so one class works on every surface; a light
  // theme would point it at a dark neutral. `scrim` dims the page under a
  // modal, drawer or mobile sidebar (`bg-scrim/40`…`/80`).
  "state-layer": "neutral-100",
  scrim: "neutral-0",
} as const satisfies Record<string, SemanticRef>

export type SemanticName = keyof typeof SEMANTIC

export const COMPONENT = {
  // shadcn roles
  background: "surface-canvas",
  foreground: "fg-default",
  card: "surface-card",
  "card-foreground": "fg-default",
  popover: "surface-overlay",
  "popover-foreground": "fg-default",
  primary: "accent-solid",
  "primary-foreground": "fg-on-solid",
  secondary: "surface-card",
  "secondary-foreground": "fg-default",
  muted: "surface-card",
  "muted-foreground": "fg-tertiary",
  accent: "accent-solid",
  "accent-foreground": "fg-on-solid",
  destructive: "tone-danger",
  "destructive-solid": "tone-danger-solid",
  "destructive-foreground": "fg-on-solid",
  border: "border-subtle",
  input: "border-control",
  ring: "border-focus",

  // Brand (the bright accent: indicators, accent text, borders, tints) and
  // its solid (fills behind text).
  brand: "accent-brand",
  "brand-solid": "accent-solid",

  // Legacy linear-* names (2,000+ class usages); values unchanged except
  // linear-text-tertiary (#6a6a6a → #8a8a8a) and linear-accent-hover (solid).
  "linear-bg": "surface-app",
  "linear-bg-secondary": "surface-raised",
  "linear-bg-tertiary": "surface-inset",
  "linear-border": "border-default",
  "linear-border-hover": "border-strong",
  "linear-text": "fg-primary",
  "linear-text-secondary": "fg-secondary",
  "linear-text-tertiary": "fg-tertiary",

  // Board task status (lib/design-tokens.ts STATUS_COLORS).
  "status-todo": "fg-tertiary",
  "status-in-progress": "accent-brand",
  "status-done": "tone-success",
  "status-cancelled": "tone-neutral",
  "status-error": "tone-danger",
  "status-committing": "tone-warning",
  "status-publishing": "tone-discovery",

  // Board priority (PRIORITY_COLORS).
  "priority-low": "fg-tertiary",
  "priority-medium": "accent-brand",
  "priority-high": "tone-warning",
  "priority-urgent": "tone-danger",

  // Agent-run phase tones (components/execution, lib/run-model PhaseTone).
  "run-neutral": "tone-neutral",
  "run-info": "tone-info",
  "run-active": "accent-brand",
  "run-warning": "tone-warning",
  "run-success": "tone-success",
  "run-danger": "tone-danger",

  // Chrome.
  "scrollbar-thumb": "border-subtle",
  "scrollbar-thumb-hover": "border-default",
} as const satisfies Record<string, SemanticName>

export type ComponentName = keyof typeof COMPONENT

/**
 * Interaction states as numbers, so every control derives hover/pressed the
 * same way from its own colour (and stays correct for any picker accent):
 * a solid fill at `hover` / `pressed` alpha over the dark surface reads
 * darker, which only raises the contrast of the white text on it. Disabled
 * controls render at `disabled` opacity (exempt from WCAG 1.4.3).
 */
export const STATE = {
  hover: 0.9,
  pressed: 0.8,
  disabled: 0.5,
} as const

export type StateName = keyof typeof STATE

/**
 * Alphas of the `state-layer` colour (Tailwind `bg-layer-faint`,
 * `hover:bg-layer-hover`, `divide-layer-divider`, `border-layer-outline`).
 * They replace the hand-picked `bg-white/[0.0N]` / `border-white/N` overlays:
 * `faint` marks a resting emphasis (unread row, sticky group header), `hover`
 * a hovered row, `divider` a row separator and `outline` a chip outline.
 * Text over `faint`/`hover` is contrast-checked (contrast.ts); dividers and
 * outlines are decorative.
 */
export const STATE_LAYER = {
  faint: 0.02,
  hover: 0.04,
  divider: 0.04,
  outline: 0.1,
} as const

export type StateLayerName = keyof typeof STATE_LAYER

/** Any variable a Tailwind class or a contrast pair may name. */
export type TokenName = SemanticName | ComponentName

export function isPrimitiveName(name: string): name is PrimitiveName {
  return Object.hasOwn(PRIMITIVES, name)
}

export function isRuntimeInputName(name: string): name is RuntimeInputName {
  return Object.hasOwn(RUNTIME_INPUTS, name)
}

export function isSemanticName(name: string): name is SemanticName {
  return Object.hasOwn(SEMANTIC, name)
}

export function isComponentName(name: string): name is ComponentName {
  return Object.hasOwn(COMPONENT, name)
}

/** The runtime input a semantic token reads, or null when it is a fixed primitive. */
export function runtimeInputOf(name: SemanticName): RuntimeInputName | null {
  const ref: SemanticRef = SEMANTIC[name]
  if (isPrimitiveName(ref)) return null
  const input = ref.slice("input:".length)
  if (!isRuntimeInputName(input)) throw new Error(`Unknown runtime input in ${name}: ${ref}`)
  return input
}

/** The primitive a token resolves to with default runtime inputs. */
export function resolvePrimitive(name: TokenName): PrimitiveName {
  const semantic: SemanticName = isComponentName(name) ? COMPONENT[name] : name
  const ref: SemanticRef = SEMANTIC[semantic]
  if (isPrimitiveName(ref)) return ref
  const input = runtimeInputOf(semantic)
  if (!input) throw new Error(`Unresolvable token ${name}`)
  return RUNTIME_INPUTS[input]
}

/** sRGB of a token with default runtime inputs. */
export function resolveToken(name: TokenName): Rgb {
  return oklchToRgb(PRIMITIVES[resolvePrimitive(name)])
}

/** Hex of a token with default runtime inputs (meta tags, contrast tests, the run kit's hex fields). */
export function tokenHex(name: TokenName): string {
  return toHex(resolveToken(name))
}
