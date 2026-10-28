import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const colors = await import('./diff-colors.ts')
const { describeReviewError, isRouteMissing } = await import('./review-errors.ts')
const { ApiError, AuthExpiredError, NetworkError } = await import('@/lib/api/fetch.ts')
const { reviewConsumesEscape } = await import('./comment-thread.tsx')

// Theme values come from the design-token system (lib/design), the single
// source of the shipped colours, so these checks cannot drift from the CSS.
const { resolveToken } = await import('@/lib/design/tokens.ts')
const rgb = (name) => {
  const { r, g, b } = resolveToken(name)
  return [r, g, b]
}
const THEME = {
  background: rgb('background'),
  card: rgb('card'),
  foreground: rgb('foreground'),
  primary: rgb('primary'),
  destructive: rgb('destructive'),
  success: rgb('tone-success'),
  danger: rgb('tone-danger'),
  warning: rgb('tone-warning'),
  info: rgb('tone-info'),
  brand: rgb('brand'),
  'muted-foreground': rgb('muted-foreground'),
  'linear-text-secondary': rgb('linear-text-secondary'),
}

function over(color, alpha, base) {
  return color.map((channel, i) => channel * alpha + base[i] * (1 - alpha))
}

function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `text-linear-text-secondary italic` → the colour it paints over `surface`. */
function textOn(className, surface) {
  const match = /(?:^|\s)text-(muted-foreground|linear-text-secondary|foreground|primary|destructive|success|danger|warning|info|brand)(?:\/(\d+))?(?:\s|$)/.exec(className)
  if (!match) throw new Error(`no semantic text colour in "${className}"`)
  return over(THEME[match[1]], match[2] ? Number(match[2]) / 100 : 1, surface)
}

const SURFACES = {
  background: THEME.background,
  card: THEME.card,
  selected: over(THEME.foreground, 0.1, THEME.background),
  hunk: over(THEME.foreground, 0.05, THEME.background),
  add: over(THEME.success, 0.12, THEME.background),
  del: over(THEME.danger, 0.12, THEME.background),
  addGutter: over(THEME.primary, 0.18, THEME.background),
  delGutter: over(THEME.destructive, 0.18, THEME.background),
}

describe('review colours: semantic classes only, contrast on the base theme', () => {
  it('no hex/arbitrary colour or raw palette class anywhere in components/review', () => {
    const offenders = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(tsx?|jsx)$/.test(name)) {
          const source = readFileSync(path, 'utf8')
          const hex = source.match(/\b(?:bg|text|border|ring|fill|stroke|decoration|outline|accent|from|to|via|divide|placeholder:text)-\[(?:#|rgb|hsl)[^\]]*\]/g) ?? []
          const palette = source.match(/\b(?:bg|text|border|ring|fill|stroke|decoration|outline|accent|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/g) ?? []
          for (const hit of [...hex, ...palette]) offenders.push(`${path}: ${hit}`)
        }
      }
    }
    walk(import.meta.dirname)
    expect(offenders).toEqual([])
  })

  it('code, syntax and gutter text keep 4.5:1 on every diff surface', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      for (const [kind, className] of Object.entries(colors.SYNTAX_TEXT)) {
        expect(contrast(textOn(className, surface), surface), `${kind} on ${name}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(textOn(colors.GUTTER_TEXT, surface), surface), `gutter on ${name}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(textOn(colors.HUNK_HEADER, surface), surface), `hunk header on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('text roles, including every status tone, keep 4.5:1 on panel surfaces', () => {
    const panel = [SURFACES.background, SURFACES.card, SURFACES.selected]
    const roles = [
      ...Object.values(colors.TEXT).filter((role) => role.startsWith('text-')),
      colors.TONE.success.text,
      colors.TONE.warning.text,
      colors.TONE.info.text,
      colors.TONE.danger.text,
    ]
    for (const surface of panel) {
      for (const role of roles) expect(contrast(textOn(role, surface), surface), `${role}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('review error copy', () => {
  it('a 404 without a code means the sidecar predates the route', () => {
    const missing = new ApiError(404, 'Request failed with status 404')
    expect(isRouteMissing(missing)).toBe(true)
    expect(isRouteMissing(new ApiError(404, 'x', 'TASK_NOT_FOUND'))).toBe(false)
    expect(isRouteMissing(new AuthExpiredError())).toBe(false)
    expect(describeReviewError(missing, 'follow-up')).toMatchObject({ kind: 'route_missing', title: 'Update OpenLinear to use this', hint: expect.stringMatching(/send review follow-ups.*drafts are kept/) })
    expect(describeReviewError(missing, 'diff').hint).toMatch(/show the agent's changes/)
  })

  it('maps follow-up codes and falls back to the shared map', () => {
    expect(describeReviewError(new ApiError(404, 'x', 'TASK_NOT_FOUND'), 'follow-up').title).toMatch(/no longer exists/)
    expect(describeReviewError(new ApiError(409, 'x', 'RUN_ACTIVE'), 'follow-up').kind).toBe('run_active')
    expect(describeReviewError(new ApiError(409, 'Request failed with status 409', 'FOLLOW_UP_UNSUPPORTED'), 'follow-up').hint).not.toMatch(/Request failed/)
    expect(describeReviewError(new ApiError(503, 'x', 'CLOUD_API_UNREACHABLE'), 'follow-up')).toMatchObject({ kind: 'offline', retryable: true })
    expect(describeReviewError(new NetworkError(), 'diff')).toMatchObject({ kind: 'offline', title: "The local execution service isn't reachable" })
    expect(describeReviewError(new ApiError(503, 'Sandbox missing', 'SANDBOX_UNAVAILABLE'), 'follow-up')).toMatchObject({ title: 'Sandbox missing', hint: expect.stringMatching(/Execution was blocked/) })
    expect(describeReviewError(new ApiError(409, 'x', 'GIT_CONFIG_UNSAFE', { keys: ['a.b', 7] }), 'diff').hint).toMatch(/\(a\.b\)/)
  })
})

describe('Escape ownership', () => {
  it('editors marked data-review-escape keep Escape from the sheet', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-review-escape', '')
    const textarea = document.createElement('textarea')
    wrapper.appendChild(textarea)
    expect(reviewConsumesEscape({ target: textarea })).toBe(true)
    expect(reviewConsumesEscape({ target: document.createElement('div') })).toBe(false)
    expect(reviewConsumesEscape({ target: null })).toBe(false)
  })
})
