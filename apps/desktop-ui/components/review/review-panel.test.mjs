import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const sse = vi.hoisted(() => ({ listeners: new Set() }))
const api = vi.hoisted(() => ({
  fetchTaskDiff: vi.fn(),
  fetchTaskRunState: vi.fn(),
  sendTaskFollowUp: vi.fn(),
}))

vi.mock('@/providers/sse-provider', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    useSSESubscription(handler) {
      const ref = useRef(handler)
      ref.current = handler
      useEffect(() => {
        const listener = (...args) => ref.current(...args)
        sse.listeners.add(listener)
        return () => sse.listeners.delete(listener)
      }, [])
    },
    useSSEStatus: () => ({ isConnected: true, isReconnecting: false }),
  }
})
vi.mock('@/lib/api/review', () => api)
const commands = vi.hoisted(() => ({ bulkCreateTasks: vi.fn() }))
vi.mock('@/lib/api/task-commands', async (original) => ({ ...(await original()), bulkCreateTasks: (...args) => commands.bulkCreateTasks(...args) }))

const { TaskReviewPanel } = await import('./review-panel.tsx')
const { ApiError } = await import('@/lib/api/fetch.ts')
const { draftStorageKey } = await import('./model/drafts.ts')
const { toast } = await import('sonner')
const { sampleDiff, installDiffViewport, restoreDiffViewport, memoryStorage } = await import('./fixtures.mjs')

const COMPARE = 'https://github.com/o/r/compare/main...openlinear/kt-12'
const AUTH = 'apps/api/src/routes/auth.ts'

let counter = 0
function makeTask(overrides = {}) {
  counter += 1
  return { id: `review-task-${counter}`, status: 'done', outcome: null, prUrl: COMPARE, batchId: null, ...overrides }
}

function emit(type, data) {
  for (const listener of sse.listeners) listener(type, data, { stream: 'local' })
}

async function renderPanel(props = {}) {
  const storage = props.storage ?? memoryStorage()
  const onOpenUrl = vi.fn()
  const onFollowUpStarted = vi.fn()
  const task = props.task ?? makeTask()
  const utils = render(createElement(TaskReviewPanel, { task, phase: 'succeeded', storage, onOpenUrl, onFollowUpStarted, ...props }))
  return { ...utils, storage, onOpenUrl, onFollowUpStarted, task }
}

async function diffReady() {
  await screen.findByRole('tree', { name: 'Changed files' })
  return document.querySelector('[data-review-diff-scroller]')
}

function activeKey() {
  return document.activeElement?.getAttribute('data-row-key')
}

function key(target, keyName, init = {}) {
  fireEvent.keyDown(target ?? document.activeElement, { key: keyName, ...init })
}

beforeEach(() => {
  installDiffViewport(600)
  sse.listeners.clear()
  api.fetchTaskDiff.mockReset().mockResolvedValue(sampleDiff())
  api.fetchTaskRunState.mockReset().mockRejectedValue(new ApiError(404, 'No v2 run', 'RUN_NOT_FOUND'))
  api.sendTaskFollowUp.mockReset().mockResolvedValue({ runId: 'run-2', attemptId: 'att-2', state: 'running' })
  toast.success.mockClear()
})
afterEach(() => {
  cleanup()
  restoreDiffViewport()
})

describe('TaskReviewPanel — diff and keyboard', () => {
  it('shows base/head, stats, file tree with status and counts, and the virtualized diff', async () => {
    await renderPanel()
    await diffReady()
    expect(screen.getByRole('button', { name: /^Base origin\/main at a1b2c3d/ })).toBeTruthy()
    expect(screen.getByText('openlinear/kt-12')).toBeTruthy()
    expect(screen.getByLabelText('5 files changed, 11 added lines, 6 removed lines')).toBeTruthy()
    const tree = screen.getByRole('tree', { name: 'Changed files' })
    expect(within(tree).getByRole('treeitem', { name: `${AUTH}, modified, 6 added, 3 removed` })).toBeTruthy()
    expect(within(tree).getByRole('treeitem', { name: 'apps/desktop/icons/icon.png, binary' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: `File ${AUTH}, modified, 6 added, 3 removed, expanded` })).toBeTruthy()
    expect(api.fetchTaskDiff).toHaveBeenCalledWith(expect.stringMatching(/^review-task-/), expect.objectContaining({ base: null }))
  })

  it('j/k move between files, n/p between hunks, arrows between lines (roving focus)', async () => {
    await renderPanel()
    const scroller = await diffReady()
    const first = scroller.querySelector(`[data-row-key="f:${AUTH}"]`)
    expect(first.getAttribute('tabindex')).toBe('0')
    act(() => first.focus())
    act(() => key(first, 'j'))
    expect(activeKey()).toBe('f:apps/api/src/services/rate-limit.ts')
    act(() => key(null, 'k'))
    expect(activeKey()).toBe(`f:${AUTH}`)
    act(() => key(null, 'n'))
    expect(activeKey()).toBe(`h:${AUTH}:0`)
    act(() => key(null, 'n'))
    expect(activeKey()).toBe(`h:${AUTH}:1`)
    act(() => key(null, 'p'))
    expect(activeKey()).toBe(`h:${AUTH}:0`)
    act(() => key(null, 'ArrowDown'))
    expect(activeKey()).toBe(`l:${AUTH}:0:0`)
    expect(document.activeElement.getAttribute('aria-label')).toBe(`unchanged line 10 of ${AUTH}:   const router = Router()`)
    // Only one tab stop at a time.
    expect(scroller.querySelectorAll('[tabindex="0"][data-row-key]')).toHaveLength(1)
  })

  it('j/k from the file tree drive the diff; Enter on a tree file opens it', async () => {
    await renderPanel()
    await diffReady()
    const tree = screen.getByRole('tree', { name: 'Changed files' })
    const docs = within(tree).getByRole('treeitem', { name: /^docs\/auth\/refresh\.md/ })
    act(() => docs.focus())
    act(() => key(docs, 'Enter'))
    expect(activeKey()).toBe('f:docs/auth/refresh.md')
    act(() => key(null, 'k'))
    expect(activeKey()).toBe('f:apps/api/src/legacy/session-store.ts')
  })

  it('Enter on a file header collapses it', async () => {
    await renderPanel()
    const scroller = await diffReady()
    const header = scroller.querySelector(`[data-row-key="f:${AUTH}"]`)
    act(() => header.focus())
    act(() => key(header, 'Enter'))
    expect(screen.getByRole('heading', { name: `File ${AUTH}, modified, 6 added, 3 removed, collapsed` })).toBeTruthy()
    expect(scroller.querySelector(`[data-row-key="h:${AUTH}:0"]`)).toBeNull()
  })

  it('renders hostile diff text as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    const diff = sampleDiff()
    diff.files[0].hunks[0].lines[0].text = hostile
    api.fetchTaskDiff.mockResolvedValue(diff)
    await renderPanel()
    const scroller = await diffReady()
    expect(scroller.querySelector('img')).toBeNull()
    expect(scroller.querySelector('script')).toBeNull()
    expect(scroller.textContent).toContain(hostile)
    expect(window.__pwned).toBeUndefined()
  })

  it('split view pairs lines and remembers the preference', async () => {
    const { storage } = await renderPanel()
    const scroller = await diffReady()
    fireEvent.click(screen.getByRole('button', { name: 'split' }))
    expect(screen.getByRole('button', { name: 'split' }).getAttribute('aria-pressed')).toBe('true')
    expect(scroller.querySelector(`[data-row-key="p:${AUTH}:0:2"]`)).toBeTruthy()
    expect(storage.map.get('openlinear:review-view-mode')).toBe('split')
  })
})

describe('TaskReviewPanel — inline comments and follow-up', () => {
  async function commentOn(lineKey, body) {
    const row = document.querySelector(`[data-row-key="${lineKey}"]`)
    act(() => row.focus())
    act(() => key(row, 'c'))
    const editor = await screen.findByRole('textbox', { name: /^New comment on/ })
    expect(document.activeElement).toBe(editor)
    fireEvent.change(editor, { target: { value: body } })
    act(() => key(editor, 'Enter', { ctrlKey: true }))
  }

  it('c opens an editor on the focused line; Ctrl+Enter saves a draft that persists per task; focus returns to the line', async () => {
    const { storage, task, unmount } = await renderPanel()
    await diffReady()
    await commentOn(`l:${AUTH}:0:3`, 'Rate-limit the refresh route per user, not per IP.')
    expect(screen.getByText('Rate-limit the refresh route per user, not per IP.')).toBeTruthy()
    expect(activeKey()).toBe(`l:${AUTH}:0:3`)
    const stored = JSON.parse(storage.map.get(draftStorageKey(task.id)))
    expect(stored.comments).toEqual([
      expect.objectContaining({ path: AUTH, line: 12, side: 'new', body: 'Rate-limit the refresh route per user, not per IP.', revision: 'rev-1', excerpt: expect.stringMatching(/rateLimit/) }),
    ])
    expect(screen.getByRole('treeitem', { name: /auth\.ts, modified, 6 added, 3 removed, 1 draft comment/ })).toBeTruthy()

    // Survives a remount (sheet closed and reopened).
    unmount()
    await renderPanel({ task, storage })
    await diffReady()
    expect(screen.getByText('Rate-limit the refresh route per user, not per IP.')).toBeTruthy()
  })

  it('FE-12: makes a sub-issue from a comment, with its file, line, commit and code, then drops the draft', async () => {
    commands.bulkCreateTasks.mockReset().mockResolvedValue({ created: [{ id: 'new-1', identifier: 'ENG-40' }], failed: [] })
    const { task, storage } = await renderPanel({ task: makeTask({ projectId: 'p1', identifier: 'ENG-12' }) })
    await diffReady()
    await commentOn(`l:${AUTH}:0:3`, '- Rate-limit the refresh route per user.\nAlso log it.')
    fireEvent.click(screen.getByRole('button', { name: 'Make an issue from this comment' }))
    await waitFor(() => expect(commands.bulkCreateTasks).toHaveBeenCalledTimes(1))
    const [body, key] = commands.bulkCreateTasks.mock.calls[0]
    expect(body).toMatchObject({ projectId: 'p1', tasks: [{ title: 'Rate-limit the refresh route per user.', parentId: task.id }] })
    expect(body.tasks[0].description).toContain(`From the review of ENG-12: \`${AUTH}\` line 12 at commit \`f00dbabe0123\`.`)
    expect(body.tasks[0].description).toMatch(/```\n.*rateLimit/)
    expect(key).toMatch(/^review-issue-/)
    await waitFor(() => expect(screen.queryByText(/Rate-limit the refresh route per user/)).toBeNull())
    expect(JSON.parse(storage.map.get(draftStorageKey(task.id)) ?? '{"comments":[]}').comments).toEqual([])
    expect(toast.success).toHaveBeenCalledWith('Created ENG-40', expect.objectContaining({ description: expect.stringContaining('sub-issue') }))
  })

  it('FE-12: offers no "make issue" for a task without a project', async () => {
    await renderPanel()
    await diffReady()
    await commentOn(`l:${AUTH}:0:3`, 'Something to fix later')
    expect(screen.queryByRole('button', { name: 'Make an issue from this comment' })).toBeNull()
  })

  it('Escape cancels the editor without saving; removed lines anchor to the old side', async () => {
    const { storage, task } = await renderPanel()
    await diffReady()
    const row = document.querySelector(`[data-row-key="l:${AUTH}:0:2"]`)
    act(() => row.focus())
    act(() => key(row, 'c'))
    const editor = await screen.findByRole('textbox', { name: `New comment on removed line 12 of ${AUTH}` })
    fireEvent.change(editor, { target: { value: 'never mind' } })
    act(() => key(editor, 'Escape'))
    expect(screen.queryByRole('textbox', { name: /^New comment on/ })).toBeNull()
    expect(storage.map.has(draftStorageKey(task.id))).toBe(false)
    expect(activeKey()).toBe(`l:${AUTH}:0:2`)
  })

  it('sends all drafts plus the message to the follow-up endpoint, clears them, and hands over the new run', async () => {
    const { storage, task, onFollowUpStarted } = await renderPanel()
    await diffReady()
    await commentOn(`l:${AUTH}:0:3`, 'Per user, please.')
    await commentOn(`l:${AUTH}:0:2`, 'Keep the old handler name.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to the agent' }), { target: { value: 'Also add a test for reuse.' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    })
    expect(api.sendTaskFollowUp).toHaveBeenCalledWith(task.id, {
      message: 'Also add a test for reuse.',
      comments: [
        { path: AUTH, line: 12, side: 'new', body: 'Per user, please.' },
        { path: AUTH, line: 12, side: 'old', body: 'Keep the old handler name.' },
      ],
    })
    await waitFor(() => expect(onFollowUpStarted).toHaveBeenCalledWith({ runId: 'run-2', attemptId: 'att-2', state: 'running' }))
    expect(storage.map.has(draftStorageKey(task.id))).toBe(false)
    expect(screen.queryByText('Per user, please.')).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('Sent to the agent', { description: '2 comments went to a new run.' })
  })

  it.each([
    ['an older sidecar (404 without a code)', new ApiError(404, 'Request failed with status 404'), /Update OpenLinear to use this/],
    ['RUN_ACTIVE', new ApiError(409, 'Task has an active run', 'RUN_ACTIVE'), /The agent is still working on this task/],
    ['FOLLOW_UP_UNSUPPORTED', new ApiError(409, 'Legacy runs cannot continue.', 'FOLLOW_UP_UNSUPPORTED'), /This run can't take a follow-up.*Legacy runs cannot continue/s],
    ['SANDBOX_UNAVAILABLE', new ApiError(503, 'No sandbox on this machine', 'SANDBOX_UNAVAILABLE'), /No sandbox on this machine/],
    ['CLOUD_API_UNREACHABLE', new ApiError(503, 'unreachable', 'CLOUD_API_UNREACHABLE'), /Can't reach OpenLinear to verify your session/],
    ['VALIDATION_ERROR', new ApiError(400, 'Invalid body', 'VALIDATION_ERROR', { fieldErrors: { message: ['Message is too long'] } }), /message: Message is too long/],
  ])('keeps drafts and explains a follow-up failure: %s', async (_label, error, pattern) => {
    api.sendTaskFollowUp.mockRejectedValue(error)
    const { storage, task, onFollowUpStarted } = await renderPanel()
    await diffReady()
    await commentOn(`l:${AUTH}:0:3`, 'Keep me.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    })
    const composer = screen.getByRole('region', { name: 'Send back to the agent' })
    await waitFor(() => expect(within(composer).getByRole('status').textContent).toMatch(pattern))
    expect(onFollowUpStarted).not.toHaveBeenCalled()
    expect(JSON.parse(storage.map.get(draftStorageKey(task.id))).comments).toHaveLength(1)
    expect(api.sendTaskFollowUp).toHaveBeenCalledTimes(1)
  })

  it('does not send while the agent is working, but drafting still works', async () => {
    await renderPanel({ phase: 'running' })
    await diffReady()
    await commentOn(`l:${AUTH}:0:3`, 'Later.')
    const send = screen.getByRole('button', { name: 'Send to agent' })
    expect(send.disabled).toBe(true)
    expect(screen.getByText(/The agent is working on this task/)).toBeTruthy()
  })

  it('asks for a message or comment instead of sending nothing', async () => {
    await renderPanel()
    await diffReady()
    expect(screen.getByRole('button', { name: 'Send to agent' }).disabled).toBe(true)
  })
})

describe('TaskReviewPanel — checks gate publishing', () => {
  it('Create PR stays disabled until an explicit override, which applies to this revision only', async () => {
    const { onOpenUrl, task } = await renderPanel()
    await diffReady()
    const create = screen.getByRole('button', { name: /Create PR on GitHub/ })
    expect(create.disabled).toBe(true)
    expect(screen.getByText('Blocked by Verification (not reported).')).toBeTruthy()
    const override = screen.getByRole('checkbox', { name: /Override: I reviewed this diff/ })
    fireEvent.click(override)
    const anyway = screen.getByRole('button', { name: /Create PR on GitHub anyway/ })
    expect(anyway.disabled).toBe(false)
    fireEvent.click(anyway)
    expect(onOpenUrl).toHaveBeenCalledWith(COMPARE)

    // The agent's work changes → a new revision → the override no longer applies.
    api.fetchTaskDiff.mockResolvedValue(sampleDiff({ revision: 'rev-2' }))
    await act(async () => {
      emit('execution:progress', { taskId: task.id, status: 'done' })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Create PR on GitHub/ }).disabled).toBe(true))
    expect(screen.getByRole('checkbox', { name: /Override/ }).checked).toBe(false)
  })

  it('opens the gate when the run reports passing verification for the displayed commit', async () => {
    api.fetchTaskRunState.mockResolvedValue({
      run: {
        runId: 'r1', state: 'succeeded', attemptId: 'a1', lastSeq: 4, relayAckSeq: 4, effects: [{ key: 'k', kind: 'git.push', status: 'confirmed' }],
        terminal: { state: 'succeeded', reason: 'ok', outcome: null, prUrl: null, claimed: true },
        verification: { status: 'passed', commit: 'f00dbabe', checks: [{ name: 'pnpm test', status: 'passed' }] },
      },
    })
    const { onOpenUrl } = await renderPanel()
    await diffReady()
    await waitFor(() => expect(screen.getByText('All required checks passed.')).toBeTruthy())
    const create = screen.getByRole('button', { name: 'Create PR on GitHub' })
    expect(create.disabled).toBe(false)
    expect(screen.queryByRole('checkbox', { name: /Override/ })).toBeNull()
    fireEvent.click(create)
    expect(onOpenUrl).toHaveBeenCalledWith(COMPARE)
  })

  it('unsent drafts block publishing', async () => {
    await renderPanel()
    await diffReady()
    const row = document.querySelector(`[data-row-key="l:${AUTH}:0:3"]`)
    act(() => row.focus())
    act(() => key(row, 'c'))
    const editor = await screen.findByRole('textbox', { name: /^New comment on/ })
    fireEvent.change(editor, { target: { value: 'x' } })
    act(() => key(editor, 'Enter', { metaKey: true }))
    expect(screen.getByText("1 draft comment hasn't been sent to the agent.")).toBeTruthy()
  })

  it('Merge is offered once a pull request exists, and is never enabled while the agent works', async () => {
    await renderPanel({ task: makeTask({ prUrl: 'https://github.com/o/r/pull/7' }), phase: 'running' })
    await diffReady()
    const merge = screen.getByRole('button', { name: /Merge on GitHub/ })
    expect(merge.disabled).toBe(true)
    expect(screen.getByText('Wait for the agent to finish before publishing.')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Override/ })).toBeNull()
  })
})

describe('TaskReviewPanel — diff unavailable', () => {
  it.each([
    [new ApiError(404, 'gone', 'DIFF_WORKSPACE_NOT_FOUND'), 'succeeded', /No local changes to review on this device/],
    [new ApiError(404, 'gone', 'DIFF_WORKSPACE_NOT_FOUND'), 'idle', /This task hasn't run yet/],
    [new ApiError(404, 'Request failed with status 404'), 'succeeded', /Update OpenLinear to use this/],
    [new ApiError(409, 'unsafe', 'GIT_CONFIG_UNSAFE', { keys: ['filter.evil.clean', 'diff.evil.textconv'] }), 'succeeded', /refused to read this workspace.*filter\.evil\.clean, diff\.evil\.textconv/s],
    [new ApiError(403, 'mine', 'RUN_PRINCIPAL_MISMATCH'), 'succeeded', /This run belongs to another account/],
  ])('%s (%s)', async (error, phase, pattern) => {
    api.fetchTaskDiff.mockRejectedValue(error)
    await renderPanel({ phase })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(pattern)
    expect(api.fetchTaskDiff).toHaveBeenCalledTimes(1)
  })

  it('an empty diff while the agent works says it will refresh', async () => {
    api.fetchTaskDiff.mockResolvedValue(sampleDiff({ files: [], stats: { files: 0, additions: 0, deletions: 0, shownFiles: 0, binaryFiles: 0, untrackedFiles: 0 } }))
    await renderPanel({ phase: 'running' })
    expect(await screen.findByText(/hasn't changed any files yet/)).toBeTruthy()
  })
})
