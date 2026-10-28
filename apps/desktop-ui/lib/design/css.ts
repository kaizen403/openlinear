/**
 * Renders the token block between the @design-tokens markers in
 * app/globals.css. `node scripts/design-tokens.mjs --write` replaces the
 * block; tokens.test.ts fails when globals.css and this output differ.
 */
import { formatOklch, oklchToRgb, toChannels, toHex } from "./color"
import { PRIMITIVES, type PrimitiveName } from "./palette"
import {
  COMPONENT,
  RUNTIME_INPUTS,
  SEMANTIC,
  STATE,
  STATE_LAYER,
  isComponentName,
  isPrimitiveName,
  isRuntimeInputName,
  isSemanticName,
  runtimeInputOf,
  type RuntimeInputName,
  type SemanticName,
} from "./tokens"

export const TOKENS_START =
  "/* @design-tokens:start. Generated from lib/design/*.ts by `node scripts/design-tokens.mjs --write`; do not edit by hand. */"
export const TOKENS_END = "/* @design-tokens:end */"

/** The block sits inside `@layer base {`, so it is indented one level. */
const OUTER = "  "
const INNER = "    "

/** Hex form of each runtime input, for consumers that need a full colour (charts, color-mix). */
const HEX_INPUTS: Readonly<Record<RuntimeInputName, string>> = {
  "linear-accent-rgb": "linear-accent",
  "linear-accent-hover-rgb": "linear-accent-hover",
}

export function primitiveVar(name: PrimitiveName): string {
  return `--ol-${name}`
}

function semanticValue(name: SemanticName): string {
  const ref = SEMANTIC[name]
  if (isPrimitiveName(ref)) return `var(${primitiveVar(ref)})`
  return `var(--${runtimeInputOf(name)})`
}

export function renderTokenCss(): string {
  const body: string[] = []
  const section = (title: string) => {
    if (body.length > 0) body.push("")
    body.push(`/* ${title} */`)
  }

  section("Tier 1: primitives. Authored in OKLCH (lib/design/palette.ts), emitted as sRGB channels.")
  for (const name of Object.keys(PRIMITIVES).filter(isPrimitiveName)) {
    const color = PRIMITIVES[name]
    const rgb = oklchToRgb(color)
    body.push(`${primitiveVar(name)}: ${toChannels(rgb)}; /* ${toHex(rgb)} ${formatOklch(color)} */`)
  }

  section("Runtime inputs. Defaults; the accent picker overrides them on <html>.")
  for (const input of Object.keys(RUNTIME_INPUTS).filter(isRuntimeInputName)) {
    const primitive = RUNTIME_INPUTS[input]
    body.push(`--${input}: var(${primitiveVar(primitive)});`)
    body.push(`--${HEX_INPUTS[input]}: ${toHex(oklchToRgb(PRIMITIVES[primitive]))};`)
  }

  section("Tier 2: semantic.")
  for (const name of Object.keys(SEMANTIC).filter(isSemanticName)) {
    body.push(`--${name}: ${semanticValue(name)};`)
  }

  section("Tier 3: component and role tokens (what Tailwind classes resolve to).")
  for (const name of Object.keys(COMPONENT).filter(isComponentName)) {
    body.push(`--${name}: var(--${COMPONENT[name]});`)
  }

  section("States: alpha of a solid fill on hover / press, opacity of a disabled control.")
  for (const [state, value] of Object.entries(STATE)) {
    body.push(`--state-${state}: ${value};`)
  }

  section("State layers: alpha of --state-layer over any surface (hover, emphasis, dividers, outlines).")
  for (const [layer, value] of Object.entries(STATE_LAYER)) {
    body.push(`--state-layer-${layer}: ${value};`)
  }

  return [
    TOKENS_START,
    `${OUTER}:root {`,
    ...body.map((text) => (text === "" ? "" : `${INNER}${text}`)),
    `${OUTER}}`,
    `${OUTER}${TOKENS_END}`,
  ].join("\n")
}

function locate(source: string): { start: number; end: number } | null {
  const start = source.indexOf(TOKENS_START)
  const end = source.indexOf(TOKENS_END)
  if (start === -1 || end === -1 || end < start) return null
  return { start, end: end + TOKENS_END.length }
}

/** Replaces the marked block in `source` (globals.css text) with `block`. */
export function replaceTokenBlock(source: string, block: string): string {
  const range = locate(source)
  if (!range) throw new Error("globals.css: design-token markers not found")
  return `${source.slice(0, range.start)}${block}${source.slice(range.end)}`
}

/** The marked block currently in `source`, or null. */
export function extractTokenBlock(source: string): string | null {
  const range = locate(source)
  return range ? source.slice(range.start, range.end) : null
}
