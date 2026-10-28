import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { inSrgbGamut, oklchToRgb, parseHex, rgbToOklch, toHex } from "./color"
import { PRIMITIVES, PRIMITIVE_HEX } from "./palette"
import { COMPONENT, RUNTIME_INPUTS, SEMANTIC, STATE_LAYER, isComponentName, isPrimitiveName, isSemanticName, resolveToken, runtimeInputOf, tokenHex } from "./tokens"
import { ACCENT_PRESETS, DEFAULT_ACCENT } from "./accent"
import { CONTRAST_PAIRS, describePaint, evaluateAccentPresets, evaluatePairs, type ContrastResult } from "./contrast"
import { extractTokenBlock, renderTokenCss } from "./css"

const PKG = resolve(import.meta.dirname, "../..")
const read = (path: string) => readFileSync(join(PKG, path), "utf8")

function failures(results: readonly ContrastResult[]): string[] {
  return results
    .filter((result) => result.kind !== "decorative" && !result.pass)
    .map((result) => `${describePaint(result.fg)} on ${describePaint(result.bg)} = ${result.ratio.toFixed(2)}:1 < ${result.minimum}:1 (${result.usage})`)
}

describe("tier 1: primitives", () => {
  it("round-trip to their hex, sit in the sRGB gamut and are named by OKLCH lightness", () => {
    for (const name of Object.keys(PRIMITIVES).filter(isPrimitiveName)) {
      const color = PRIMITIVES[name]
      expect(inSrgbGamut(color), `${name} is outside sRGB`).toBe(true)
      expect(toHex(oklchToRgb(color)), name).toBe(PRIMITIVE_HEX[name])
      const lightness = Number(name.split("-").at(-1))
      expect(Math.abs(lightness - color.l * 100), `${name} has L ${(color.l * 100).toFixed(1)}`).toBeLessThanOrEqual(1)
    }
  })

  it("are all used by a semantic token or a runtime default (no orphans)", () => {
    const used = new Set<string>([...Object.values(SEMANTIC), ...Object.values(RUNTIME_INPUTS)])
    const orphans = Object.keys(PRIMITIVES).filter((name) => !used.has(name))
    expect(orphans).toEqual([])
  })
})

describe("tiers", () => {
  it("semantic tokens reference primitives or runtime inputs; component tokens reference semantic tokens", () => {
    for (const name of Object.keys(SEMANTIC).filter(isSemanticName)) {
      const ref = SEMANTIC[name]
      expect(isPrimitiveName(ref) || runtimeInputOf(name) !== null, `${name} → ${ref}`).toBe(true)
    }
    for (const name of Object.keys(COMPONENT).filter(isComponentName)) {
      expect(isSemanticName(COMPONENT[name]), `${name} → ${COMPONENT[name]}`).toBe(true)
    }
  })

  it("tier names never collide", () => {
    const names = [...Object.keys(SEMANTIC), ...Object.keys(COMPONENT), ...Object.keys(RUNTIME_INPUTS)]
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((name) => name.startsWith("ol-"))).toEqual([])
  })

  it("the default accent preset is the runtime default", () => {
    expect(DEFAULT_ACCENT.accent).toBe(tokenHex("brand"))
    expect(DEFAULT_ACCENT.solid).toBe(tokenHex("primary"))
  })
})

describe("generated CSS", () => {
  const globals = read("app/globals.css")

  it("app/globals.css carries the current token block (run `node scripts/design-tokens.mjs --write`)", () => {
    expect(extractTokenBlock(globals)).toBe(renderTokenCss())
  })

  it("every colour Tailwind maps exists in the token block, and the config has no literal colours", () => {
    const config = read("tailwind.config.ts")
    const css = renderTokenCss()
    const referenced = [...config.matchAll(/(?:token|state)\("([a-z0-9-]+)"/g)].map((match) => match[1])
    expect(referenced.length).toBeGreaterThan(40)
    for (const name of referenced) expect(css, `--${name}`).toContain(`--${name}:`)
    const layers = [...config.matchAll(/\blayer\("([a-z]+)"\)/g)].map((match) => match[1])
    expect(layers.sort()).toEqual(Object.keys(STATE_LAYER).sort())
    for (const name of layers) expect(css, `--state-layer-${name}`).toContain(`--state-layer-${name}:`)
    expect(css).toContain("--state-layer:")
    expect(config.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(config).not.toMatch(/hsl\(var\(/)
  })

  it("Tailwind resolves fills to the solids and text to the text-safe tokens", async () => {
    const { default: postcss } = await import("postcss")
    const { default: tailwindcss } = await import("tailwindcss")
    const { default: loadConfig } = await import("tailwindcss/loadConfig")
    const config = loadConfig(join(PKG, "tailwind.config.ts"))
    const classes = [
      "bg-linear-accent", "hover:bg-linear-accent-hover", "text-linear-accent", "border-linear-accent",
      "bg-destructive", "bg-destructive/10", "text-destructive", "bg-primary", "hover:bg-primary-hover",
      "active:bg-primary-pressed", "text-linear-text-tertiary", "disabled:opacity-disabled", "bg-run-active/10",
      "hover:bg-layer-hover", "bg-layer-faint", "divide-layer-divider", "border-layer-outline", "bg-scrim/80",
    ]
    const { css } = await postcss([tailwindcss({ ...config, content: [{ raw: `<div class="${classes.join(" ")}"></div>`, extension: "html" }] })])
      .process("@tailwind utilities;", { from: undefined })
    const rule = (selector: string) => {
      const match = new RegExp(`${selector.replace(/[.:/[\]\\]/g, (ch) => `\\\\?\\${ch}`)}[^{]*\\{([^}]*)\\}`).exec(css)
      if (!match) throw new Error(`no rule for ${selector}`)
      return match[1]
    }
    expect(rule(".bg-linear-accent")).toContain("var(--brand-solid)")
    expect(rule(".hover:bg-linear-accent-hover")).toContain("rgb(var(--brand-solid) / var(--state-hover))")
    expect(rule(".text-linear-accent")).toContain("var(--brand)")
    expect(rule(".border-linear-accent")).toContain("var(--brand)")
    expect(rule(".bg-destructive")).toContain("var(--destructive-solid)")
    expect(rule(".text-destructive")).toContain("var(--destructive)")
    expect(rule(".hover:bg-primary-hover")).toContain("rgb(var(--primary) / var(--state-hover))")
    expect(rule(".active:bg-primary-pressed")).toContain("rgb(var(--primary) / var(--state-pressed))")
    expect(rule(".disabled:opacity-disabled")).toContain("var(--state-disabled)")
    expect(rule(".bg-run-active/10")).toContain("rgb(var(--run-active) / 0.1)")
    expect(rule(".hover:bg-layer-hover")).toContain("rgb(var(--state-layer) / var(--state-layer-hover))")
    expect(rule(".bg-layer-faint")).toContain("rgb(var(--state-layer) / var(--state-layer-faint))")
    expect(css).toContain("rgb(var(--state-layer) / var(--state-layer-divider))")
    expect(rule(".border-layer-outline")).toContain("rgb(var(--state-layer) / var(--state-layer-outline))")
    expect(rule(".bg-scrim/80")).toContain("rgb(var(--scrim) / 0.8)")
  })

  it("globals.css paints chrome from tokens, not literals", () => {
    const outsideBlock = globals.replace(extractTokenBlock(globals) ?? "", "")
    const rules = outsideBlock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@font-face\s*{[^}]*}/g, "")
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
  })
})

describe("contrast (WCAG 2.x)", () => {
  it("every text pair is ≥ 4.5:1 and every UI pair ≥ 3:1", () => {
    expect(failures(evaluatePairs())).toEqual([])
  })

  it("covers the surfaces, the solid fills with their hover/pressed tints, and the run/board tones", () => {
    const enforced = CONTRAST_PAIRS.filter((pair) => pair.kind !== "decorative")
    expect(enforced.length).toBeGreaterThan(400)
    const named = new Set(enforced.flatMap((pair) => [pair.fg.token, pair.bg.token]))
    for (const token of ["linear-text-tertiary", "muted-foreground", "primary", "accent", "destructive-solid", "input", "ring", "status-done", "priority-urgent", "run-active"] as const) {
      expect(named.has(token), token).toBe(true)
    }
  })

  it("would have caught the base tree's failures (emerald + white, #6a6a6a, #595959, #1f1f1f inputs)", () => {
    const before: Record<string, string> = {
      primary: "#10b981",
      accent: "#10b981",
      "linear-text-tertiary": "#6a6a6a",
      "muted-foreground": "#595959",
      input: "#1f1f1f",
      destructive: "#d31212",
    }
    const failing = failures(evaluatePairs(CONTRAST_PAIRS, (token) => (before[token] ? parseHex(before[token]) : resolveToken(token))))
    expect(failing.length).toBeGreaterThan(50)
    expect(failing.some((line) => line.startsWith("primary-foreground on primary ="))).toBe(true)
    expect(failing.some((line) => line.startsWith("input on linear-bg ="))).toBe(true)
  })

  it("every accent preset passes every accent-dependent pair", () => {
    const failing = evaluateAccentPresets()
      .filter((result) => !result.pass)
      .map((result) => `${result.preset}: ${describePaint(result.fg)} on ${describePaint(result.bg)} = ${result.ratio.toFixed(2)}:1`)
    expect(failing).toEqual([])
  })

  it("each preset's solid is its accent's hue with lower lightness", () => {
    for (const preset of ACCENT_PRESETS) {
      const accent = rgbToOklch(parseHex(preset.accent))
      const solid = rgbToOklch(parseHex(preset.solid))
      const hueGap = Math.abs(((accent.h - solid.h + 540) % 360) - 180)
      expect(hueGap, `${preset.name} hue`).toBeLessThanOrEqual(3)
      expect(solid.l, `${preset.name} lightness`).toBeLessThan(accent.l)
    }
  })
})

describe("components use tokens", () => {
  function sources(dir: string): string[] {
    return readdirSync(join(PKG, dir)).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(join(PKG, path)).isDirectory()) return sources(path)
      return /\.(tsx?|mjs)$/.test(name) && !/\.test\.|\.capture\./.test(name) ? [path] : []
    })
  }

  it("no arbitrary hex colour classes (bg-[#…], border-[#…], text-[#…]) in app/ or components/", () => {
    const offenders = [...sources("app"), ...sources("components")].flatMap((path) =>
      [...read(path).matchAll(/\b[a-z:-]*-\[#[0-9a-fA-F]{3,8}\]/g)].map((match) => `${relative(PKG, join(PKG, path))}: ${match[0]}`),
    )
    expect(offenders).toEqual([])
  })

  const offendersOf = (paths: readonly string[], pattern: RegExp) =>
    paths.flatMap((path) => [...read(path).matchAll(pattern)].map((match) => `${relative(PKG, join(PKG, path))}: ${match[0]}`))

  it("no raw Tailwind palette classes (text-red-400, bg-emerald-500/10, …) in app/ or components/", () => {
    const palette = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|placeholder|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g
    expect(offendersOf([...sources("app"), ...sources("components")], palette)).toEqual([])
  })

  it("text tokens are never thinned with an opacity modifier (text-muted-foreground/70 fails contrast)", () => {
    const thinned = /\btext-(?:muted-foreground|foreground|linear-text(?:-secondary|-tertiary)?)\/\d+/g
    expect(offendersOf([...sources("app"), ...sources("components")], thinned)).toEqual([])
  })

  it("translucent white/black overlays use the state-layer / scrim tokens (only the execution kit is left)", () => {
    const overlay = /\b(?:bg|border|divide|ring|decoration|from|to|via|outline)-(?:white|black)\/(?:\[[0-9.]+\]|\d+)/g
    expect(offendersOf(sources("app"), overlay)).toEqual([])
    // Leftover owned by the execution kit (components/execution); see docs/design-tokens.md.
    const outsideKit = offendersOf(sources("components"), overlay).filter((line) => !line.startsWith("components/execution/"))
    expect(outsideKit).toEqual([])
  })

  it("components never reference tier-1 primitives directly", () => {
    const offenders = [...sources("app"), ...sources("components")].filter((path) => /--ol-|\bol-(?:neutral|emerald|green|amber|red|sky|purple)-\d/.test(read(path)))
    expect(offenders).toEqual([])
  })
})
