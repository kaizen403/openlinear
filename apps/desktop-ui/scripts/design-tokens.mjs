#!/usr/bin/env node
// Design-token build and contrast report for apps/desktop-ui.
//
//   node scripts/design-tokens.mjs            check: globals.css is in sync and every pair passes (exit 1 if not)
//   node scripts/design-tokens.mjs --write    regenerate the token block in app/globals.css
//   node scripts/design-tokens.mjs --report   markdown contrast report (before → after for changed pairs)
//   node scripts/design-tokens.mjs --inventory  count hard-coded colours in app/, components/, lib/
//   node scripts/design-tokens.mjs --suggest '#22c55e'   solid + text-safe variants for an accent
//
// The token source is TypeScript (lib/design/*.ts). This script transpiles it
// with the package's own `typescript` into node_modules/.cache, so it needs no
// TS runner and works on any Node ≥ 18.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = join(PKG, 'lib/design')
const CACHE_DIR = join(PKG, 'node_modules/.cache/design-tokens')
const GLOBALS = join(PKG, 'app/globals.css')

async function loadTokens() {
  const ts = createRequire(join(PKG, 'package.json'))('typescript')
  mkdirSync(CACHE_DIR, { recursive: true })
  const files = readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
  for (const name of files) {
    const source = readFileSync(join(SOURCE_DIR, name), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      fileName: name,
    })
    const rewritten = outputText.replace(/from "(\.\/[^"]+)"/g, (_, spec) => `from "${spec}.mjs"`)
    writeFileSync(join(CACHE_DIR, name.replace(/\.ts$/, '.mjs')), rewritten)
  }
  return import(pathToFileURL(join(CACHE_DIR, 'index.mjs')).href)
}

const args = process.argv.slice(2)
const mode = args.find((arg) => arg.startsWith('--')) ?? '--check'
const design = await loadTokens()

function main() {
  if (mode === '--write') {
    const source = readFileSync(GLOBALS, 'utf8')
    const next = design.replaceTokenBlock(source, design.renderTokenCss())
    if (next === source) console.log('app/globals.css is already up to date')
    else {
      writeFileSync(GLOBALS, next)
      console.log('app/globals.css: token block regenerated')
    }
  } else if (mode === '--check') {
    process.exitCode = check() ? 0 : 1
  } else if (mode === '--report') {
    report()
  } else if (mode === '--inventory') {
    inventory()
  } else if (mode === '--suggest') {
    const hex = args.find((arg) => !arg.startsWith('--'))
    if (!hex) throw new Error('usage: --suggest <#rrggbb>')
    const surface = design.tokenHex('surface-pressed')
    const solid = design.solidFor(hex)
    const text = design.textSafe(hex, surface)
    console.log(`accent ${hex}`)
    console.log(`  solid (white text): ${solid.hex}  ${solid.oklch}  ${solid.ratio.toFixed(2)}:1`)
    console.log(`  text-safe on ${surface}: ${text.hex}  ${text.oklch}  ${text.ratio.toFixed(2)}:1`)
    console.log('  then add it to ACCENT_PRESETS in lib/design/accent.ts and run this script (tints are checked too)')
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
}

function check() {
  let ok = true
  const block = design.extractTokenBlock(readFileSync(GLOBALS, 'utf8'))
  if (block !== design.renderTokenCss()) {
    ok = false
    console.error('not ok app/globals.css token block is out of date: run node scripts/design-tokens.mjs --write')
  } else {
    console.log('ok app/globals.css token block in sync')
  }
  const results = design.evaluatePairs()
  const enforced = results.filter((result) => result.kind !== 'decorative')
  const failing = enforced.filter((result) => !result.pass)
  for (const result of failing) {
    console.error(`not ok ${describe(result)} ${result.ratio.toFixed(2)}:1 < ${result.minimum}:1 (${result.usage})`)
  }
  const presets = design.evaluateAccentPresets()
  const failingPresets = presets.filter((result) => !result.pass)
  for (const result of failingPresets) {
    console.error(`not ok accent ${result.preset}: ${describe(result)} ${result.ratio.toFixed(2)}:1 < ${result.minimum}:1 (${result.usage})`)
  }
  console.log(`${failing.length === 0 ? 'ok' : 'not ok'} ${enforced.length - failing.length}/${enforced.length} contrast pairs pass (${results.length - enforced.length} decorative pairs reported only)`)
  console.log(`${failingPresets.length === 0 ? 'ok' : 'not ok'} ${presets.length - failingPresets.length}/${presets.length} accent preset checks pass`)
  return ok && failing.length === 0 && failingPresets.length === 0
}

function describe(result) {
  return `${design.describePaint(result.fg)} on ${design.describePaint(result.bg)} (${result.fgHex} on ${result.bgHex})`
}

// Values on the base tree (HEAD 922dbd7 + round-4 base patch), for the before → after report.
const BEFORE = {
  background: '#0a0a0a', foreground: '#e6e6e6', card: '#0d0d0d', 'card-foreground': '#e6e6e6',
  popover: '#080808', 'popover-foreground': '#e6e6e6',
  // Primary buttons were `bg-linear-accent text-white`; menus used bg-accent (#10b981) + white.
  primary: '#10b981', 'primary-foreground': '#ffffff', accent: '#10b981', 'accent-foreground': '#ffffff',
  secondary: '#0d0d0d', 'secondary-foreground': '#e6e6e6', muted: '#0d0d0d', 'muted-foreground': '#595959',
  destructive: '#d31212', 'destructive-solid': '#d31212', 'destructive-foreground': '#ffffff',
  border: '#1f1f1f', input: '#1f1f1f', ring: '#e6e6e6',
  brand: '#10b981', 'brand-solid': '#059669',
  'linear-bg': '#111111', 'linear-bg-secondary': '#141414', 'linear-bg-tertiary': '#0f0f0f',
  'linear-border': '#2a2a2a', 'linear-border-hover': '#3a3a3a',
  'linear-text': '#f5f5f5', 'linear-text-secondary': '#a0a0a0', 'linear-text-tertiary': '#6a6a6a',
  'surface-hover': '#1a1a1a', 'surface-pressed': '#1f1f1f',
  'tone-neutral': '#9ca3af', 'tone-info': '#38bdf8', 'tone-success': '#4ade80', 'tone-warning': '#fbbf24',
  'tone-danger': '#f87171', 'tone-danger-solid': '#d31212', 'tone-discovery': '#c084fc',
  // STATUS_COLORS / PRIORITY_COLORS / execution-kit TONE_TEXT on the base tree.
  'status-todo': '#595959', 'status-in-progress': '#10b981', 'status-done': '#4ade80', 'status-cancelled': '#9ca3af',
  'status-error': '#f87171', 'status-committing': '#facc15', 'status-publishing': '#c084fc',
  'priority-low': '#595959', 'priority-medium': '#10b981', 'priority-high': '#fbbf24', 'priority-urgent': '#d31212',
  'run-neutral': '#9ca3af', 'run-info': '#38bdf8', 'run-active': '#34d399', 'run-warning': '#fbbf24',
  'run-success': '#4ade80', 'run-danger': '#f87171',
  'scrollbar-thumb': '#1f1f1f', 'scrollbar-thumb-hover': '#2a2a2a',
}

function report() {
  const after = design.evaluatePairs()
  const before = design.evaluatePairs(design.CONTRAST_PAIRS, (token) =>
    BEFORE[token] ? design.parseHex(BEFORE[token]) : design.resolveToken(token))
  const rows = after.map((result, index) => ({ after: result, before: before[index] }))
  const enforced = rows.filter(({ after: result }) => result.kind !== 'decorative')
  const failedBefore = enforced.filter(({ before: result }) => !result.pass)
  const failedAfter = enforced.filter(({ after: result }) => !result.pass)
  console.log(`Pairs: ${rows.length} (${enforced.length} enforced, ${rows.length - enforced.length} decorative).`)
  console.log(`Failing before: ${failedBefore.length}. Failing after: ${failedAfter.length}.\n`)

  // Group failing-before pairs by fg/bg role so the table stays readable.
  const groups = new Map()
  for (const row of failedBefore) {
    const key = `${row.after.fg.token}|${row.after.usage}`
    const group = groups.get(key) ?? { row, count: 0, worstBefore: Infinity, worstAfter: Infinity, bgs: new Set() }
    group.count += 1
    group.worstBefore = Math.min(group.worstBefore, row.before.ratio)
    group.worstAfter = Math.min(group.worstAfter, row.after.ratio)
    group.bgs.add(design.describePaint(row.after.bg))
    groups.set(key, group)
  }
  console.log('| Foreground (token) | Used for | Pairs failing before | Worst before | Worst after | Min |')
  console.log('|---|---|---|---|---|---|')
  for (const group of [...groups.values()].sort((a, b) => a.worstBefore - b.worstBefore)) {
    const { row } = group
    console.log(`| \`${row.after.fg.token}\` ${row.before.fgHex} → ${row.after.fgHex} | ${row.after.usage} | ${group.count} | ${group.worstBefore.toFixed(2)} | ${group.worstAfter.toFixed(2)} | ${row.after.minimum} |`)
  }

  console.log('\nWorst enforced pair per foreground token (after):\n')
  console.log('| Foreground | Hex | Worst background | Ratio | Min |')
  console.log('|---|---|---|---|---|')
  const worst = new Map()
  for (const { after: result } of enforced) {
    const key = `${result.fg.token}|${result.kind}`
    const current = worst.get(key)
    if (!current || result.ratio < current.ratio) worst.set(key, result)
  }
  for (const result of [...worst.values()].sort((a, b) => a.ratio - b.ratio)) {
    console.log(`| \`${design.describePaint(result.fg)}\` (${result.kind}) | ${result.fgHex} | ${design.describePaint(result.bg)} ${result.bgHex} | ${result.ratio.toFixed(2)} | ${result.minimum} |`)
  }

  console.log('\nDecorative pairs (reported, not enforced):\n')
  console.log('| Pair | Ratio |')
  console.log('|---|---|')
  for (const { after: result } of rows.filter(({ after: r }) => r.kind === 'decorative')) {
    console.log(`| ${describe(result)} | ${result.ratio.toFixed(2)} |`)
  }

  const presets = design.evaluateAccentPresets()
  console.log('\nAccent presets (worst check per preset):\n')
  console.log('| Preset | Accent | Solid | Worst check | Ratio |')
  console.log('|---|---|---|---|---|')
  for (const preset of design.ACCENT_PRESETS) {
    const checks = presets.filter((result) => result.preset === preset.name)
    const low = checks.reduce((a, b) => (b.ratio / b.minimum < a.ratio / a.minimum ? b : a))
    console.log(`| ${preset.name} | ${preset.accent} | ${preset.solid} | ${describe(low)} | ${low.ratio.toFixed(2)} (min ${low.minimum}) |`)
  }
}

function inventory() {
  const roots = ['app', 'components', 'lib']
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\.|\.capture\.|\/lib\/design\//.test(path)) files.push(path)
    }
  }
  for (const root of roots) walk(join(PKG, root))
  const patterns = {
    'arbitrary colour classes (bg-[#..], border-[#..], text-[#..])': /\b[a-z-]+-\[#[0-9a-fA-F]{3,8}\]/g,
    'Tailwind palette classes (text-red-400, bg-emerald-500/10, ...)':
      /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|placeholder|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    'accent fill + white text (bg-linear-accent … text-white)': /bg-linear-accent(?![-/])[^"'`]*text-white|text-white[^"'`]*bg-linear-accent(?![-/])/g,
    'translucent white/black overlays (bg-white/[0.04], bg-black/80, ...)':
      /\b(?:bg|border|divide|ring|decoration|from|to|via|outline)-(?:white|black)\/(?:\[[0-9.]+\]|\d+)/g,
    'thinned text tokens (text-muted-foreground/70, ...)': /\btext-(?:muted-foreground|foreground|linear-text(?:-secondary|-tertiary)?)\/\d+/g,
    'hex literals in TS/TSX': /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g,
    'linear-* utilities (resolve to tokens)': /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|caret|decoration)-linear-[a-z-]+/g,
  }
  const totals = Object.fromEntries(Object.keys(patterns).map((key) => [key, { all: 0, components: 0 }]))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const inComponents = relative(PKG, file).startsWith('components/')
    for (const [key, pattern] of Object.entries(patterns)) {
      const count = source.match(pattern)?.length ?? 0
      totals[key].all += count
      if (inComponents) totals[key].components += count
    }
  }
  const config = readFileSync(join(PKG, 'tailwind.config.ts'), 'utf8')
  console.log(`tailwind.config.ts hex literals: ${config.match(/#[0-9a-fA-F]{6}\b/g)?.length ?? 0}`)
  for (const [key, { all, components }] of Object.entries(totals)) console.log(`${key}: ${all} (components/: ${components})`)
}

main()
