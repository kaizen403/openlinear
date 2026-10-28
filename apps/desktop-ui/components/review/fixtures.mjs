// Review-kit fixtures (not a test file): diff payloads in the sidecar's
// `GET /api/tasks/:id/diff` shape, plus a jsdom viewport for the virtualizer.

export const LIMITS = {
  maxFiles: 300,
  maxLinesPerFile: 5000,
  maxTotalLines: 20000,
  maxLineChars: 1000,
  maxPatchBytes: 8388608,
  maxUntrackedFileBytes: 524288,
}

function line(kind, oldNo, newNo, text, extra = {}) {
  const value = { kind, text, ...extra }
  if (kind !== 'add' && oldNo !== undefined) value.oldNo = oldNo
  if (kind !== 'del' && newNo !== undefined) value.newNo = newNo
  return value
}

/** A small realistic diff: modified TS file (2 hunks), added file, deleted file, rename, binary, untracked. */
export function sampleDiff(overrides = {}) {
  const files = [
    {
      path: 'apps/api/src/routes/auth.ts',
      status: 'modified',
      additions: 6,
      deletions: 3,
      hunks: [
        {
          header: '@@ -10,7 +10,8 @@ export function createAuthRouter(deps: AuthDeps) {',
          oldStart: 10,
          oldLines: 7,
          newStart: 10,
          newLines: 8,
          lines: [
            line('context', 10, 10, '  const router = Router()'),
            line('context', 11, 11, '  // Refresh tokens rotate on every use.'),
            line('del', 12, undefined, "  router.post('/refresh', async (req, res) => {"),
            line('add', undefined, 12, "  router.post('/refresh', rateLimit({ limit: 30 }), async (req, res) => {"),
            line('add', undefined, 13, '    const family = await deps.sessions.family(req.cookies.rt)'),
            line('context', 13, 14, '    const token = req.cookies.rt'),
            line('del', 14, undefined, "    if (!token) return res.status(401).json({ error: 'missing' })"),
            line('add', undefined, 15, "    if (!token || !family) return res.status(401).json({ error: 'missing', code: 'AUTH_REQUIRED' })"),
            line('context', 15, 16, '    return deps.sessions.rotate(token, res)'),
            line('context', 16, 17, '  })'),
          ],
        },
        {
          header: '@@ -40,4 +41,5 @@ export function createAuthRouter(deps: AuthDeps) {',
          oldStart: 40,
          oldLines: 4,
          newStart: 41,
          newLines: 5,
          lines: [
            line('context', 40, 41, '  router.post(\'/logout\', async (req, res) => {'),
            line('del', 41, undefined, '    await deps.sessions.revoke(req.cookies.rt)'),
            line('add', undefined, 42, '    await deps.sessions.revokeFamily(req.cookies.rt)'),
            line('add', undefined, 43, "    res.clearCookie('rt', { path: '/api/auth' })"),
            line('context', 42, 44, '    res.status(204).end()'),
            line('context', 43, 45, '  })', { noEol: true }),
          ],
        },
      ],
    },
    {
      path: 'apps/api/src/services/rate-limit.ts',
      status: 'added',
      additions: 4,
      deletions: 0,
      untracked: true,
      hunks: [
        {
          header: '@@ -0,0 +1,4 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 4,
          lines: [
            line('add', undefined, 1, "import { rateLimit as base } from 'express-rate-limit'"),
            line('add', undefined, 2, ''),
            line('add', undefined, 3, '/** 30 refreshes per minute per IP. */'),
            line('add', undefined, 4, "export const rateLimit = (opts: { limit: number }) => base({ windowMs: 60_000, limit: opts.limit })"),
          ],
        },
      ],
    },
    {
      path: 'apps/api/src/legacy/session-store.ts',
      status: 'deleted',
      additions: 0,
      deletions: 2,
      hunks: [
        {
          header: '@@ -1,2 +0,0 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 0,
          newLines: 0,
          lines: [line('del', 1, undefined, '// Deprecated: replaced by session families.'), line('del', 2, undefined, 'export {}')],
        },
      ],
    },
    {
      path: 'docs/auth/refresh.md',
      oldPath: 'docs/refresh-tokens.md',
      status: 'renamed',
      similarity: 92,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -3,3 +3,3 @@',
          oldStart: 3,
          oldLines: 3,
          newStart: 3,
          newLines: 3,
          lines: [line('context', 3, 3, 'Refresh tokens rotate.'), line('del', 4, undefined, 'Reuse logs out.'), line('add', undefined, 4, 'Reuse revokes the whole family.'), line('context', 5, 5, '')],
        },
      ],
    },
    { path: 'apps/desktop/icons/icon.png', status: 'binary', additions: 0, deletions: 0, hunks: [] },
  ]
  return {
    base: { ref: 'origin/main', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
    head: { ref: 'openlinear/kt-12', sha: 'f00dbabe0123456789abcdef0123456789abcdef', dirty: false },
    revision: 'rev-1',
    source: 'v2',
    files,
    truncated: false,
    stats: { files: files.length, additions: 11, deletions: 6, shownFiles: files.length, binaryFiles: 1, untrackedFiles: 1 },
    limits: LIMITS,
    ...overrides,
  }
}

/** A diff with `fileCount` files of `linesPerFile` changed lines each, in hunks of `hunkSize`. */
export function largeDiff({ fileCount = 10, linesPerFile = 500, hunkSize = 50, revision = 'rev-large' } = {}) {
  const files = []
  for (let f = 0; f < fileCount; f++) {
    const hunks = []
    let produced = 0
    let oldNo = 1
    let newNo = 1
    while (produced < linesPerFile) {
      const size = Math.min(hunkSize, linesPerFile - produced)
      const lines = []
      for (let i = 0; i < size; i++) {
        const mod = (produced + i) % 5
        if (mod === 0) lines.push(line('del', oldNo++, undefined, `  const value${produced + i} = compute(${produced + i}) // old`))
        else if (mod === 1) lines.push(line('add', undefined, newNo++, `  const value${produced + i} = computeFast(${produced + i}, "fast")`))
        else lines.push(line('context', oldNo++, newNo++, `  return value${produced + i} + ${i}`))
      }
      hunks.push({ header: `@@ -${oldNo - size},${size} +${newNo - size},${size} @@ function block${hunks.length}()`, oldStart: oldNo - size, oldLines: size, newStart: newNo - size, newLines: size, lines })
      produced += size
      oldNo += 10
      newNo += 10
    }
    files.push({ path: `src/module-${String(f).padStart(3, '0')}/file.ts`, status: 'modified', additions: Math.ceil(linesPerFile / 5), deletions: Math.ceil(linesPerFile / 5), hunks })
  }
  return {
    base: { ref: 'origin/main', sha: '1'.repeat(40) },
    head: { ref: 'openlinear/big', sha: '2'.repeat(40), dirty: true },
    revision,
    source: 'v2',
    files,
    truncated: false,
    stats: { files: fileCount, additions: fileCount * Math.ceil(linesPerFile / 5), deletions: fileCount * Math.ceil(linesPerFile / 5), shownFiles: fileCount, binaryFiles: 0, untrackedFiles: 0 },
    limits: LIMITS,
  }
}

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

/** jsdom has no layout: give the diff scroller a fixed viewport so the virtualizer computes a window. */
export function installDiffViewport(height = 600, width = 900) {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.hasAttribute?.('data-review-diff-scroller') ? height : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.hasAttribute?.('data-review-diff-scroller') ? width : 0
    },
  })
}

export function restoreDiffViewport() {
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
}

/** In-memory DraftStorage. */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}
