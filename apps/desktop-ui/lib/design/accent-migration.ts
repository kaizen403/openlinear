/**
 * Migration of saved accent choices to the contrast-safe presets.
 *
 * The Appearance picker stores `{ accent, hover }` under `openlinear-accent`
 * (`hover` is the solid behind white text; the name is legacy). Choices saved
 * before the design-token change keep their old solids, which fail 4.5:1 with
 * white (Emerald #059669 3.77:1, Green #16a34a 3.30:1, Orange #ea580c 3.56:1,
 * Teal #0d9488 3.74:1, Yellow #ca8a04 2.94:1), and the old Purple/Pink/Red
 * brand colours fail on 20 % tints. Even older choices are the retired blues,
 * which reset to the default.
 *
 * One table drives both readers: the boot script in app/layout.tsx (inlined
 * by `accentBootScript()`, runs before first paint) and the Appearance
 * section (`migrateStoredAccent`). accent-migration.test.ts runs the inlined
 * script against the TypeScript function and checks every target solid.
 */
import { parseHex, toChannels } from "./color"
import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentPreset } from "./accent"

export const ACCENT_STORAGE_KEY = "openlinear-accent"

/** The stored preference, as the picker writes it. */
export interface StoredAccent {
  readonly accent: string
  /** The solid (legacy name). */
  readonly hover: string
}

/** What the picker saved for each preset before the contrast-safe solids. */
export const LEGACY_PRESET_VALUES: Readonly<Record<string, StoredAccent>> = {
  Emerald: { accent: "#10b981", hover: "#059669" },
  Purple: { accent: "#8b5cf6", hover: "#7c3aed" },
  Green: { accent: "#22c55e", hover: "#16a34a" },
  Orange: { accent: "#f97316", hover: "#ea580c" },
  Pink: { accent: "#ec4899", hover: "#db2777" },
  Red: { accent: "#ef4444", hover: "#dc2626" },
  Teal: { accent: "#14b8a6", hover: "#0d9488" },
  Yellow: { accent: "#eab308", hover: "#ca8a04" },
}

/** The blue accents retired before emerald; any of them resets to the default. */
export const LEGACY_BLUE_ACCENTS: readonly string[] = ["#1d4ed8", "#1e40af", "#3b82f6", "#2563eb"]

function toStored(preset: AccentPreset): readonly [string, string] {
  return [preset.accent.toLowerCase(), preset.solid.toLowerCase()]
}

function buildTable(): Readonly<Record<string, readonly [string, string]>> {
  const table: Record<string, readonly [string, string]> = {}
  const add = (hex: string, target: readonly [string, string]) => {
    const key = hex.toLowerCase()
    const existing = table[key]
    if (existing && (existing[0] !== target[0] || existing[1] !== target[1])) {
      throw new Error(`Accent migration: ${key} maps to two presets`)
    }
    table[key] = target
  }
  for (const preset of ACCENT_PRESETS) {
    const target = toStored(preset)
    // Current values map to themselves, so a migrated choice stays put.
    add(preset.accent, target)
    add(preset.solid, target)
    const legacy = LEGACY_PRESET_VALUES[preset.name]
    if (legacy) {
      add(legacy.accent, target)
      add(legacy.hover, target)
    }
  }
  for (const blue of LEGACY_BLUE_ACCENTS) add(blue, toStored(DEFAULT_ACCENT))
  return table
}

/**
 * Lowercase hex (a stored accent or solid, current or legacy) → the current
 * preset `[accent, solid]`. A stored choice is looked up by its accent first,
 * then by its solid; anything not in the table (no picker preset ever wrote
 * it) is left alone.
 */
export const ACCENT_MIGRATION_TABLE: Readonly<Record<string, readonly [string, string]>> = buildTable()

export interface AccentMigrationResult {
  readonly value: StoredAccent
  /** True when the stored value changed and should be written back. */
  readonly migrated: boolean
}

function isStoredAccent(value: unknown): value is StoredAccent {
  return typeof value === "object" && value !== null &&
    typeof (value as { accent?: unknown }).accent === "string" &&
    typeof (value as { hover?: unknown }).hover === "string"
}

/**
 * The accent to apply for a parsed stored preference, or null when it is not
 * a `{ accent, hover }` pair (the CSS defaults then stay in effect).
 */
export function migrateStoredAccent(raw: unknown): AccentMigrationResult | null {
  if (!isStoredAccent(raw)) return null
  const accent = raw.accent.toLowerCase()
  const hover = raw.hover.toLowerCase()
  const target = ACCENT_MIGRATION_TABLE[accent] ?? ACCENT_MIGRATION_TABLE[hover]
  if (target && (target[0] !== accent || target[1] !== hover)) {
    return { value: { accent: target[0], hover: target[1] }, migrated: true }
  }
  return { value: { accent: raw.accent, hover: raw.hover }, migrated: false }
}

/** `R G B` channels of a hex colour, or `fallback` when it isn't one (same parser as the boot script). */
export function accentChannels(hex: string, fallback: string): string {
  let normalized = hex.replace("#", "").trim()
  if (normalized.length === 3) normalized = normalized.split("").map((char) => char + char).join("")
  const value = Number.parseInt(normalized, 16)
  if (!Number.isFinite(value) || normalized.length !== 6) return fallback
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`
}

/** Channel fallbacks for a malformed stored value: the default accent and solid. */
export const DEFAULT_ACCENT_CHANNELS = {
  accent: toChannels(parseHex(DEFAULT_ACCENT.accent)),
  solid: toChannels(parseHex(DEFAULT_ACCENT.solid)),
} as const

/**
 * The accent part of the pre-paint boot script (app/layout.tsx): read the
 * stored choice, migrate it with `ACCENT_MIGRATION_TABLE` (writing the result
 * back), and set the four `--linear-accent*` variables. ES5, self-contained,
 * and wrapped in its own try so a corrupt preference never skips the rest of
 * the boot script.
 */
export function accentBootScript(): string {
  const table = JSON.stringify(ACCENT_MIGRATION_TABLE)
  const key = JSON.stringify(ACCENT_STORAGE_KEY)
  const accentFallback = JSON.stringify(DEFAULT_ACCENT_CHANNELS.accent)
  const solidFallback = JSON.stringify(DEFAULT_ACCENT_CHANNELS.solid)
  return [
    "try{",
    "var d=document.documentElement;",
    `var m=${table};`,
    'function rgb(hex,fallback){var h=String(hex||"").replace("#","").trim();if(h.length===3){h=h.split("").map(function(x){return x+x}).join("")}var n=parseInt(h,16);if(!isFinite(n)||h.length!==6)return fallback;return ((n>>16)&255)+" "+((n>>8)&255)+" "+(n&255)}',
    `var s=localStorage.getItem(${key});`,
    "if(s){var c=JSON.parse(s);",
    'if(c&&typeof c.accent==="string"&&typeof c.hover==="string"){',
    "var a=c.accent.toLowerCase(),h=c.hover.toLowerCase(),t=m[a]||m[h];",
    `if(t&&(t[0]!==a||t[1]!==h)){c={accent:t[0],hover:t[1]};localStorage.setItem(${key},JSON.stringify(c))}`,
    'd.style.setProperty("--linear-accent",c.accent);',
    'd.style.setProperty("--linear-accent-hover",c.hover);',
    `d.style.setProperty("--linear-accent-rgb",rgb(c.accent,${accentFallback}));`,
    `d.style.setProperty("--linear-accent-hover-rgb",rgb(c.hover,${solidFallback}))`,
    "}}",
    "}catch(e){}",
  ].join("")
}
