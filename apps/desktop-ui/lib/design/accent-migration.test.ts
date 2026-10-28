import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { contrastRatio, parseHex } from "./color"
import { ACCENT_PRESETS, DEFAULT_ACCENT } from "./accent"
import {
  ACCENT_MIGRATION_TABLE,
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT_CHANNELS,
  LEGACY_BLUE_ACCENTS,
  LEGACY_PRESET_VALUES,
  accentBootScript,
  migrateStoredAccent,
} from "./accent-migration"

const WHITE = parseHex("#ffffff")

interface BootRun {
  readonly stored: string | null
  readonly vars: Record<string, string>
}

/** Runs the inlined boot script with a fake document and localStorage. */
function runBootScript(stored: string | null): BootRun {
  const storage = new Map<string, string>()
  if (stored !== null) storage.set(ACCENT_STORAGE_KEY, stored)
  const vars: Record<string, string> = {}
  runInNewContext(accentBootScript(), {
    document: { documentElement: { style: { setProperty: (name: string, value: string) => { vars[name] = value } } } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    },
  })
  return { stored: storage.get(ACCENT_STORAGE_KEY) ?? null, vars }
}

function channels(hex: string): string {
  const { r, g, b } = parseHex(hex)
  return `${r} ${g} ${b}`
}

describe("saved accent migration", () => {
  it("maps every pre-token preset to its contrast-safe preset", () => {
    for (const [name, legacy] of Object.entries(LEGACY_PRESET_VALUES)) {
      const preset = ACCENT_PRESETS.find((p) => p.name === name)
      expect(preset, name).toBeDefined()
      const result = migrateStoredAccent(legacy)
      expect(result?.value, name).toEqual({ accent: preset?.accent, hover: preset?.solid })
      // Unchanged pairs (none today) would not be rewritten.
      expect(result?.migrated, name).toBe(legacy.accent !== preset?.accent || legacy.hover !== preset?.solid)
    }
  })

  it("resets the retired blue accents to the default", () => {
    for (const blue of LEGACY_BLUE_ACCENTS) {
      expect(migrateStoredAccent({ accent: blue, hover: "#000000" })?.value).toEqual({ accent: DEFAULT_ACCENT.accent, hover: DEFAULT_ACCENT.solid })
      expect(migrateStoredAccent({ accent: "#123456", hover: blue.toUpperCase() })?.value).toEqual({ accent: DEFAULT_ACCENT.accent, hover: DEFAULT_ACCENT.solid })
    }
  })

  it("leaves current presets and unknown values alone, and rejects malformed ones", () => {
    for (const preset of ACCENT_PRESETS) {
      expect(migrateStoredAccent({ accent: preset.accent, hover: preset.solid })).toEqual({
        value: { accent: preset.accent, hover: preset.solid },
        migrated: false,
      })
    }
    expect(migrateStoredAccent({ accent: "#123456", hover: "#654321" })).toEqual({ value: { accent: "#123456", hover: "#654321" }, migrated: false })
    expect(migrateStoredAccent(null)).toBeNull()
    expect(migrateStoredAccent({ accent: 1, hover: "#fff" })).toBeNull()
    expect(migrateStoredAccent("#10b981")).toBeNull()
  })

  it("is idempotent", () => {
    for (const legacy of Object.values(LEGACY_PRESET_VALUES)) {
      const once = migrateStoredAccent(legacy)
      expect(migrateStoredAccent(once?.value)?.migrated).toBe(false)
    }
  })

  it("every migration target clears 4.5:1 with white text (the old solids did not)", () => {
    for (const [hex, [, solid]] of Object.entries(ACCENT_MIGRATION_TABLE)) {
      expect(contrastRatio(WHITE, parseHex(solid)), `${hex} → ${solid}`).toBeGreaterThanOrEqual(4.5)
    }
    const failingBefore = Object.values(LEGACY_PRESET_VALUES).filter((legacy) => contrastRatio(WHITE, parseHex(legacy.hover)) < 4.5)
    expect(failingBefore.length).toBeGreaterThanOrEqual(5)
  })
})

describe("boot script (app/layout.tsx)", () => {
  it("migrates, writes back and applies exactly what the TypeScript migration returns", () => {
    const inputs: unknown[] = [
      ...Object.values(LEGACY_PRESET_VALUES),
      ...ACCENT_PRESETS.map((preset) => ({ accent: preset.accent, hover: preset.solid })),
      ...LEGACY_BLUE_ACCENTS.map((blue) => ({ accent: blue, hover: blue })),
      { accent: "#123456", hover: "#654321" },
      { accent: "#10B981", hover: "#059669" },
    ]
    for (const input of inputs) {
      const raw = JSON.stringify(input)
      const expected = migrateStoredAccent(input)
      const run = runBootScript(raw)
      expect(expected).not.toBeNull()
      if (!expected) continue
      expect(run.stored, raw).toBe(expected.migrated ? JSON.stringify(expected.value) : raw)
      expect(run.vars, raw).toEqual({
        "--linear-accent": expected.value.accent,
        "--linear-accent-hover": expected.value.hover,
        "--linear-accent-rgb": channels(expected.value.accent),
        "--linear-accent-hover-rgb": channels(expected.value.hover),
      })
    }
  })

  it("keeps the CSS defaults for missing, malformed or corrupt preferences, without throwing", () => {
    for (const stored of [null, "{not json", JSON.stringify({ accent: 3 }), JSON.stringify("x"), "null"]) {
      const run = runBootScript(stored)
      expect(run.vars, String(stored)).toEqual({})
      expect(run.stored).toBe(stored)
    }
  })

  it("falls back to the default channels for a stored value that is not a hex", () => {
    const run = runBootScript(JSON.stringify({ accent: "teal", hover: "#zzzzzz" }))
    expect(run.vars["--linear-accent-rgb"]).toBe(DEFAULT_ACCENT_CHANNELS.accent)
    expect(run.vars["--linear-accent-hover-rgb"]).toBe(DEFAULT_ACCENT_CHANNELS.solid)
    expect(DEFAULT_ACCENT_CHANNELS.solid).toBe(channels(DEFAULT_ACCENT.solid))
  })
})
