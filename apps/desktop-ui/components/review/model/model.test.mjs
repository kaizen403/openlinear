import { describe, it, expect } from 'vitest'

const rows = await import('./rows.ts')
const { tokenizeLine, languageForPath, MAX_HIGHLIGHT_CHARS } = await import('./syntax.ts')
const drafts = await import('./drafts.ts')
const followUpIssue = await import('./follow-up-issue.ts')
const { normalizeTaskDiff, normalizeRunState, DiffPayloadError } = await import('./normalize.ts')
const { planFollowUp, DEFAULT_FOLLOW_UP_MESSAGE } = await import('./follow-up.ts')
const { buildFileTree, flattenTree } = await import('./tree.ts')
const { sampleDiff, largeDiff, memoryStorage } = await import('../fixtures.mjs')

const files = () => normalizeTaskDiff(sampleDiff()).files

describe('diff payload normalization', () => {
  it('keeps a well-formed payload and computes defaults', () => {
    const diff = normalizeTaskDiff(sampleDiff())
    expect(diff.files).toHaveLength(5)
    expect(diff.files[3]).toMatchObject({ status: 'renamed', oldPath: 'docs/refresh-tokens.md', similarity: 92 })
    expect(diff.files[1].untracked).toBe(true)
    expect(diff.stats).toMatchObject({ files: 5, additions: 11, deletions: 6, binaryFiles: 1 })
    expect(diff.revision).toBe('rev-1')
  })

  it('drops malformed files/lines instead of throwing, and keeps hostile text as plain strings', () => {
    const raw = sampleDiff({
      files: [
        { path: 'ok.ts', status: 'modified', additions: 1, deletions: 0, hunks: [{ header: '@@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [
          { kind: 'add', newNo: 1, text: '<img src=x onerror="alert(1)">' },
          { kind: 'evil', text: 'x' },
          { kind: 'add', text: 42 },
          null,
          { kind: 'del', oldNo: -3, newNo: 9, text: 'removed' },
        ] }] },
        { path: '', status: 'modified', hunks: [] },
        { path: 'x.ts', status: 'exploded', hunks: [] },
        'nope',
      ],
    })
    const diff = normalizeTaskDiff(raw)
    expect(diff.files).toHaveLength(1)
    const lines = diff.files[0].hunks[0].lines
    expect(lines).toHaveLength(2)
    expect(lines[0].text).toBe('<img src=x onerror="alert(1)">')
    // A removed line never carries a new-side number; negative numbers are dropped.
    expect(lines[1]).toEqual({ kind: 'del', text: 'removed' })
  })

  it('rejects an unusable envelope', () => {
    expect(() => normalizeTaskDiff(null)).toThrow(DiffPayloadError)
    expect(() => normalizeTaskDiff({ files: 'x' })).toThrow(DiffPayloadError)
    expect(() => normalizeTaskDiff('<html>')).toThrow(DiffPayloadError)
  })

  it('decodes run state, verification and only https detail links', () => {
    const run = normalizeRunState({
      run: {
        runId: 'r1', state: 'succeeded', attemptId: 'a1', lastSeq: 9, relayAckSeq: 9,
        terminal: { state: 'succeeded', reason: 'done', outcome: null, prUrl: 'https://github.com/o/r/pull/3', claimed: true },
        effects: [{ key: 'k', kind: 'pr.create', status: 'confirmed' }, { key: 'bad', kind: 'x', status: 'weird' }],
        verification: { status: 'passed', commit: 'abc1234', checks: [
          { name: 'unit', status: 'passed', url: 'https://ci.example/1' },
          { name: 'lint', status: 'failed', url: 'javascript:alert(1)' },
          { name: 'bogus', status: 'meh' },
        ] },
      },
    })
    expect(run.effects).toHaveLength(1)
    expect(run.terminal.state).toBe('succeeded')
    expect(run.verification.checks).toEqual([
      { name: 'unit', status: 'passed', url: 'https://ci.example/1' },
      { name: 'lint', status: 'failed' },
    ])
    expect(normalizeRunState({ error: 'x' })).toBeNull()
    // W11a/W12: an expired worktree survives decoding (Continue is hidden for it); malformed → null.
    expect(run.workspaceExpired).toBeNull()
    expect(normalizeRunState({ run: { runId: 'r2', state: 'abandoned', workspaceExpired: { at: '2026-10-27T10:00:00.000Z', reason: 'ttl' } } }).workspaceExpired)
      .toEqual({ at: '2026-10-27T10:00:00.000Z', reason: 'ttl' })
    expect(normalizeRunState({ run: { runId: 'r3', state: 'abandoned', workspaceExpired: { at: 5 } } }).workspaceExpired).toBeNull()
  })
})

describe('row model', () => {
  it('unified: file header, hunk headers, every line, anchors on the right side', () => {
    const model = rows.buildDiffRows({ files: files(), mode: 'unified' })
    expect(model.fileStarts).toHaveLength(5)
    expect(model.hunkStarts).toHaveLength(5)
    expect(model.lineCount).toBe(10 + 6 + 4 + 2 + 4)
    const lineRows = model.rows.filter((row) => row.kind === 'line')
    expect(lineRows).toHaveLength(model.lineCount)
    const removed = lineRows.find((row) => row.line.kind === 'del')
    expect(removed.anchor).toEqual({ path: 'apps/api/src/routes/auth.ts', side: 'old', line: 12 })
    const context = lineRows.find((row) => row.line.kind === 'context')
    expect(context.anchor.side).toBe('new')
    // Binary file: a notice, no hunks.
    const binaryNotice = model.rows.find((row) => row.kind === 'notice' && row.fileIndex === 4)
    expect(binaryNotice.text).toMatch(/Binary file/)
  })

  it('split: pairs removal runs with following additions; context lines are one anchor', () => {
    const pairs = rows.pairHunkLines(files()[0].hunks[0].lines)
    expect(pairs).toHaveLength(8)
    expect(pairs[2].left.text).toMatch(/router.post\('\/refresh', async/)
    expect(pairs[2].right.text).toMatch(/rateLimit/)
    expect(pairs[3].left).toBeNull()
    expect(pairs[3].right.text).toMatch(/family/)
    const model = rows.buildDiffRows({ files: files(), mode: 'split' })
    const contextPair = model.rows.find((row) => row.kind === 'pair' && row.left && row.left === row.right)
    expect(contextPair.leftAnchor).toEqual(contextPair.rightAnchor)
  })

  it('places threads under their line, the editor where requested, and orphans at the end of the file', () => {
    const path = 'apps/api/src/routes/auth.ts'
    const comments = [
      { id: 'c1', path, line: 13, side: 'new', body: 'Why a family lookup here?', revision: 'rev-1', createdAt: 1, updatedAt: 1 },
      { id: 'c2', path, line: 999, side: 'new', body: 'Stale', revision: 'rev-0', createdAt: 2, updatedAt: 2 },
      { id: 'c3', path, body: 'Whole file comment', revision: 'rev-1', createdAt: 3, updatedAt: 3 },
    ]
    const model = rows.buildDiffRows({ files: files(), mode: 'unified', comments, editing: { path, side: 'old', line: 12 } })
    const threads = model.rows.filter((row) => row.kind === 'thread')
    expect(threads.map((row) => [row.target.line ?? 'file', row.orphaned, row.editing, row.comments.length])).toEqual([
      ['file', false, false, 1],
      [12, false, true, 0],
      [13, false, false, 1],
      ['file', true, false, 1],
    ])
    const lineIndex = model.rows.findIndex((row) => row.kind === 'line' && row.anchor?.line === 13 && row.anchor.side === 'new')
    expect(model.rows[lineIndex + 1].kind).toBe('thread')
    expect(model.rows[0].comments).toBe(3)
  })

  it('collapsed files render only their header', () => {
    const model = rows.buildDiffRows({ files: files(), mode: 'unified', collapsed: new Set(['apps/api/src/routes/auth.ts']) })
    expect(model.rows[0]).toMatchObject({ kind: 'file', collapsed: true })
    expect(model.rows[1]).toMatchObject({ kind: 'file', fileIndex: 1 })
  })

  it('j/k and n/p navigation targets', () => {
    const model = rows.buildDiffRows({ files: files(), mode: 'unified' })
    const [f0, f1, f2] = model.fileStarts
    const [h0, h1, h2] = model.hunkStarts
    expect(rows.adjacentFileStart(model, f0, 1)).toBe(f1)
    expect(rows.adjacentFileStart(model, f0 + 3, 1)).toBe(f1)
    expect(rows.adjacentFileStart(model, f0 + 3, -1)).toBe(f0)
    expect(rows.adjacentFileStart(model, f1, -1)).toBe(f0)
    expect(rows.adjacentFileStart(model, f0, -1)).toBeNull()
    expect(rows.adjacentHunkStart(model, f0, 1)).toBe(h0)
    expect(rows.adjacentHunkStart(model, h0, 1)).toBe(h1)
    expect(rows.adjacentHunkStart(model, h1 + 2, 1)).toBe(h2)
    expect(rows.adjacentHunkStart(model, h1, -1)).toBe(h0)
    expect(rows.adjacentHunkStart(model, h1 + 2, -1)).toBe(h1)
    expect(rows.adjacentHunkStart(model, h0, -1)).toBeNull()
    expect(f2).toBeGreaterThan(f1)
  })

  it('builds 20,000 lines in well under a frame budget per 1,000 lines', () => {
    const diff = normalizeTaskDiff(largeDiff({ fileCount: 40, linesPerFile: 500 }))
    const started = performance.now()
    const model = rows.buildDiffRows({ files: diff.files, mode: 'split' })
    const elapsed = performance.now() - started
    expect(model.lineCount).toBe(20000)
    expect(elapsed).toBeLessThan(400)
  })

  it('finds the anchored line text for excerpts', () => {
    const file = files()[0]
    expect(rows.lineTextAt(file, { path: file.path, side: 'old', line: 12 })).toMatch(/async \(req, res\)/)
    expect(rows.lineTextAt(file, { path: file.path, side: 'new', line: 13 })).toMatch(/family/)
    expect(rows.lineTextAt(file, { path: file.path })).toBeUndefined()
  })
})

describe('syntax-light colouring', () => {
  it('maps extensions and colours comments, strings, keywords and numbers', () => {
    expect(languageForPath('src/a.tsx')).toBe('js')
    expect(languageForPath('Dockerfile')).toBe('sh')
    expect(languageForPath('README')).toBeNull()
    const tokens = tokenizeLine('const x = "a // not a comment" + 42 // real', 'js')
    expect(tokens.map((token) => token.kind)).toEqual(['keyword', 'plain', 'string', 'plain', 'number', 'plain', 'comment'])
    expect(tokens.map((token) => token.text).join('')).toBe('const x = "a // not a comment" + 42 // real')
    expect(tokenizeLine(' * doc continuation', 'js')).toEqual([{ kind: 'comment', text: ' * doc continuation' }])
    expect(tokenizeLine('SELECT id FROM t -- note', 'sql').map((t) => t.kind)).toEqual(['keyword', 'plain', 'keyword', 'plain', 'comment'])
  })

  it('never interprets markup and falls back to plain text for unknown or huge lines', () => {
    const hostile = '<script>alert(1)</script>'
    expect(tokenizeLine(hostile, null)).toEqual([{ kind: 'plain', text: hostile }])
    expect(tokenizeLine(hostile, 'js').map((token) => token.text).join('')).toBe(hostile)
    const huge = 'x'.repeat(MAX_HIGHLIGHT_CHARS + 1)
    expect(tokenizeLine(huge, 'js')).toEqual([{ kind: 'plain', text: huge }])
    expect(tokenizeLine('"unterminated', 'js')).toEqual([{ kind: 'string', text: '"unterminated' }])
  })
})

describe('drafts', () => {
  it('round-trips through storage per task and clears when empty', () => {
    const storage = memoryStorage()
    let state = drafts.applyDraftAction(drafts.EMPTY_DRAFTS, { type: 'add', id: 'c1', now: 5, comment: { path: 'a.ts', line: 3, side: 'new', body: '  fix this  ', revision: 'r1', excerpt: 'x'.repeat(500) } })
    state = drafts.applyDraftAction(state, { type: 'message', message: 'Please also add tests' })
    expect(drafts.saveDrafts('t1', state, storage)).toBe(true)
    const loaded = drafts.loadDrafts('t1', storage)
    expect(loaded.message).toBe('Please also add tests')
    expect(loaded.comments).toEqual([{ id: 'c1', path: 'a.ts', line: 3, side: 'new', body: 'fix this', revision: 'r1', excerpt: 'x'.repeat(200), createdAt: 5, updatedAt: 5 }])
    expect(drafts.loadDrafts('t2', storage)).toEqual(drafts.EMPTY_DRAFTS)
    const cleared = drafts.applyDraftAction(loaded, { type: 'sent', commentIds: ['c1'], clearMessage: true })
    drafts.saveDrafts('t1', cleared, storage)
    expect(storage.map.has(drafts.draftStorageKey('t1'))).toBe(false)
  })

  it('reads corrupt, foreign or throwing storage as empty', () => {
    expect(drafts.loadDrafts('t', memoryStorage({ [drafts.draftStorageKey('t')]: '{nope' }))).toEqual(drafts.EMPTY_DRAFTS)
    expect(drafts.loadDrafts('t', memoryStorage({ [drafts.draftStorageKey('t')]: JSON.stringify({ v: 2, comments: [] }) }))).toEqual(drafts.EMPTY_DRAFTS)
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    expect(drafts.loadDrafts('t', throwing)).toEqual(drafts.EMPTY_DRAFTS)
    expect(drafts.saveDrafts('t', { message: 'x', comments: [] }, throwing)).toBe(false)
    const mixed = memoryStorage({ [drafts.draftStorageKey('t')]: JSON.stringify({ v: 1, message: 7, comments: [{ id: 'a', path: 'p', body: 'b', line: -1 }, { path: 'p' }, 'x'] }) })
    expect(drafts.loadDrafts('t', mixed)).toEqual({ message: '', comments: [{ id: 'a', path: 'p', body: 'b', revision: null, createdAt: 0, updatedAt: 0 }] })
  })

  it('reducer: edit, empty edit removes, limits, identity when unchanged', () => {
    let state = drafts.EMPTY_DRAFTS
    for (let i = 0; i < drafts.MAX_DRAFT_COMMENTS + 5; i++) {
      state = drafts.applyDraftAction(state, { type: 'add', id: `c${i}`, comment: { path: 'a.ts', line: i + 1, body: 'b', revision: null } })
    }
    expect(state.comments).toHaveLength(drafts.MAX_DRAFT_COMMENTS)
    expect(drafts.applyDraftAction(state, { type: 'add', comment: { path: 'a', body: '   ', revision: null } })).toBe(state)
    const edited = drafts.applyDraftAction(state, { type: 'edit', id: 'c0', body: 'changed' })
    expect(edited.comments[0].body).toBe('changed')
    expect(drafts.applyDraftAction(edited, { type: 'edit', id: 'c0', body: 'changed' })).toBe(edited)
    expect(drafts.applyDraftAction(edited, { type: 'edit', id: 'c0', body: '' }).comments).toHaveLength(drafts.MAX_DRAFT_COMMENTS - 1)
    expect(drafts.applyDraftAction(edited, { type: 'remove', id: 'missing' })).toBe(edited)
  })
})

describe('follow-up plan', () => {
  const base = (comments, message = '') => ({ message, comments })
  it('orders comments by file and line, maps to the contract, defaults the message', () => {
    const result = planFollowUp(base([
      { id: 'b', path: 'z.ts', line: 2, side: 'new', body: ' second ', revision: 'r1', createdAt: 2, updatedAt: 2 },
      { id: 'a', path: 'a.ts', line: 9, side: 'old', body: 'first', revision: 'r0', createdAt: 1, updatedAt: 1 },
      { id: 'f', path: 'a.ts', body: 'file level', revision: 'r1', createdAt: 3, updatedAt: 3 },
    ]), 'r1')
    expect(result.ok).toBe(true)
    expect(result.plan.request).toEqual({
      message: DEFAULT_FOLLOW_UP_MESSAGE,
      comments: [
        { path: 'a.ts', body: 'file level' },
        { path: 'a.ts', line: 9, side: 'old', body: 'first' },
        { path: 'z.ts', line: 2, side: 'new', body: 'second' },
      ],
    })
    expect(result.plan.commentIds).toEqual(['f', 'a', 'b'])
    expect(result.plan.outdated).toBe(1)
  })

  it('sends a message alone, refuses nothing', () => {
    expect(planFollowUp(base([], '  Use the shared limiter  '), null)).toMatchObject({ ok: true, plan: { request: { message: 'Use the shared limiter' }, commentIds: [] } })
    expect(planFollowUp(base([], '   '), null)).toEqual({ ok: false, error: expect.stringMatching(/message or add a comment/) })
  })
})

describe('file tree', () => {
  it('compresses single-child directories, sums counts and respects collapse', () => {
    const tree = buildFileTree(files())
    expect(tree.map((node) => node.name)).toEqual(['apps', 'docs/auth'])
    const visible = flattenTree(tree, new Set())
    expect(visible.map((item) => `${'  '.repeat(item.depth - 1)}${item.node.name}`)).toEqual([
      'apps',
      '  api/src',
      '    legacy',
      '      session-store.ts',
      '    routes',
      '      auth.ts',
      '    services',
      '      rate-limit.ts',
      '  desktop/icons',
      '    icon.png',
      'docs/auth',
      '  refresh.md',
    ])
    expect(tree[0]).toMatchObject({ additions: 10, deletions: 5, fileCount: 4 })
    expect(flattenTree(tree, new Set(['d:apps'])).map((item) => item.node.name)).toEqual(['apps', 'docs/auth', 'refresh.md'])
  })
})

describe('FE-12 follow-up issues from review comments', () => {
  const { followUpIssueFrom, followUpIssueKey, followUpIssueTitle, MAX_FOLLOW_UP_TITLE } = followUpIssue
  it('titles from the first meaningful line, keeps the evidence, and keys by comment', () => {
    expect(followUpIssueTitle('\n> ## Use a constant-time compare\nmore')).toBe('Use a constant-time compare')
    expect(followUpIssueTitle('x'.repeat(200))).toHaveLength(MAX_FOLLOW_UP_TITLE)
    const comment = { id: 'c1 2', path: 'src/a.ts', line: 7, side: 'old', body: 'Why remove this?', revision: 'r', excerpt: 'check()', createdAt: 0, updatedAt: 0 }
    const issue = followUpIssueFrom(comment, { identifier: null, headSha: null })
    expect(issue.description).toBe('Why remove this?\n\n---\n\nFrom a review of the parent issue: `src/a.ts` removed line 7.\n\n```\ncheck()\n```')
    expect(followUpIssueFrom({ ...comment, line: undefined, excerpt: undefined }, { identifier: 'ENG-1', headSha: 'a'.repeat(40) }).description)
      .toBe('Why remove this?\n\n---\n\nFrom the review of ENG-1: `src/a.ts` at commit `aaaaaaaaaaaa`.')
    expect(followUpIssueKey(comment)).toBe('review-issue-c1-2')
  })
})
