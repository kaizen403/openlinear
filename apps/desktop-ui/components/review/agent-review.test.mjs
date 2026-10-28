import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchAgentReviews: null, startAgentReview: null, cancelAgentReview: null }))
vi.mock('@/lib/api/agent-reviews', async (original) => ({
  ...(await original()),
  fetchAgentReviews: (...args) => api.fetchAgentReviews(...args),
  startAgentReview: (...args) => api.startAgentReview(...args),
  cancelAgentReview: (...args) => api.cancelAgentReview(...args),
}))
const commands = vi.hoisted(() => ({ bulkCreateTasks: vi.fn() }))
vi.mock('@/lib/api/task-commands', async (original) => ({ ...(await original()), bulkCreateTasks: (...args) => commands.bulkCreateTasks(...args) }))
const sse = vi.hoisted(() => ({ handler: null }))
vi.mock('@/providers/sse-provider', () => ({ useSSESubscription: (handler) => { sse.handler = handler } }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { AgentReviewSection } = await import('./agent-review.tsx')
const { evidenceLabel, findingComment, findingIssue, findingIssueKey } = await import('./model/agent-review.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const finding = (overrides) => ({
  id: 'f1', severity: 'major', file: 'src/math.ts', startLine: 6, endLine: 6, quote: '  return a / b;', title: 'Division by zero', body: 'Guard b === 0.',
  evidence: 'verified', inDiff: true, stale: false, ...overrides,
})
const review = (overrides) => ({
  id: 'rev-1', taskId: 't1', runId: 'run-1', runner: 'opencode', commit: COMMIT, baseCommit: 'b'.repeat(40), status: 'completed',
  startedAt: '2026-10-27T10:00:00.000Z', finishedAt: '2026-10-27T10:02:00.000Z', summary: 'divide needs a guard', findings: [], dropped: 0, diffTruncated: false,
  usage: { usd: 0.04, inputTokens: 1000, outputTokens: 200 }, error: null, headCommit: null, ...overrides,
})

function show(props = {}) {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  const handlers = { onComment: vi.fn(), onJump: vi.fn() }
  render(createElement(QueryClientProvider, { client }, createElement(AgentReviewSection, { taskId: 't1', projectId: 'p1', identifier: 'ENG-7', live: false, ...handlers, ...props })))
  return handlers
}

describe('W19a agent review section', () => {
  it('starts a review, shows it running and stops it', async () => {
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [], reviewing: false }))
    api.startAgentReview = vi.fn(async () => review({ status: 'running', summary: '' }))
    api.cancelAgentReview = vi.fn(async () => ({ cancelled: true }))
    show()
    const start = await screen.findByRole('button', { name: 'Review with agent' })
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [review({ status: 'running', summary: '' })], reviewing: true }))
    fireEvent.click(start)
    await waitFor(() => expect(api.startAgentReview).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText(/Reviewing abcdef1 with opencode/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(api.cancelAgentReview).toHaveBeenCalledWith('t1', 'rev-1'))
  })

  it('waits for a live run', async () => {
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [], reviewing: false }))
    show({ live: true })
    expect((await screen.findByRole('button', { name: 'Review with agent' })).hasAttribute('disabled')).toBe(true)
  })

  it('lists findings with their evidence; comment, jump and issue are the user\'s choice', async () => {
    const findings = [
      finding({}),
      finding({ id: 'f2', severity: 'blocker', title: 'Moved', evidence: 'relocated', startLine: 9, endLine: 10 }),
      finding({ id: 'f3', severity: 'nit', title: 'Unchecked', evidence: 'unverified', stale: null, inDiff: false }),
      finding({ id: 'f4', severity: 'minor', title: 'Already fixed', stale: true }),
    ]
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [review({ findings, headCommit: 'c'.repeat(40), dropped: 1 })], reviewing: false }))
    commands.bulkCreateTasks.mockResolvedValue({ created: [{ id: 'new', identifier: 'ENG-8' }], failed: [] })
    const handlers = show()
    expect(await screen.findByText('4 findings at abcdef1 · $0.04')).toBeTruthy()
    expect(screen.getByText(/The code has changed since \(ccccccc\)/)).toBeTruthy()
    expect(screen.getByText('1 finding pointed outside the repository and were left out.')).toBeTruthy()
    const row = (title) => screen.getByRole('listitem', { name: new RegExp(`finding: ${title}$`) })
    expect(within(row('Division by zero')).getByText('Checked')).toBeTruthy()
    expect(within(row('Moved')).getByText('Lines corrected')).toBeTruthy()
    expect(within(row('Moved')).getByText('src/math.ts:9–10')).toBeTruthy()
    expect(within(row('Unchecked')).getByText('Quote not found')).toBeTruthy()
    expect(within(row('Unchecked')).getByText('outside the change')).toBeTruthy()
    expect(within(row('Already fixed')).getByText('Stale')).toBeTruthy()

    fireEvent.click(within(row('Division by zero')).getByRole('button', { name: /Comment/ }))
    expect(handlers.onComment).toHaveBeenCalledWith(findings[0])
    fireEvent.click(within(row('Moved')).getByText('src/math.ts:9–10'))
    expect(handlers.onJump).toHaveBeenCalledWith(findings[1])
    fireEvent.click(within(row('Division by zero')).getByRole('button', { name: /Issue/ }))
    await waitFor(() => expect(commands.bulkCreateTasks).toHaveBeenCalledTimes(1))
    const [body, key] = commands.bulkCreateTasks.mock.calls[0]
    expect(key).toBe('agent-review:rev-1:f1')
    expect(body).toMatchObject({ projectId: 'p1', tasks: [{ title: 'Division by zero', parentId: 't1' }] })
    expect(body.tasks[0].description).toContain('`src/math.ts:6` at commit `abcdef123456`')
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Created ENG-8', expect.anything()))
  })

  it('W19b: Remember opens the knowledge form prefilled from the finding, with the review as its source', async () => {
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [review({ findings: [finding({})] })], reviewing: false }))
    show()
    fireEvent.click(await screen.findByRole('button', { name: /Remember/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Remember for later runs')).toBeTruthy()
    expect(within(dialog).getByLabelText('Title').value).toBe('Division by zero')
    expect(within(dialog).getByLabelText('What agents should know').value).toBe('Guard b === 0.')
    expect(within(dialog).getByRole('radio', { name: 'Convention' }).getAttribute('aria-checked')).toBe('true')
  })

  it('offers no issue button without a project, and says when nothing was found', async () => {
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [review({ findings: [finding({})] })], reviewing: false }))
    show({ projectId: null })
    await screen.findByText('Division by zero')
    expect(screen.queryByRole('button', { name: /Issue/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remember/ })).toBeNull()
    cleanup()
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [review({ findings: [], usage: { usd: 0, inputTokens: 0, outputTokens: 0 } })], reviewing: false }))
    show()
    expect(await screen.findByText('No problems found at abcdef1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review again' })).toBeTruthy()
  })

  it('shows why a review failed', async () => {
    api.fetchAgentReviews = vi.fn(async () => ({ reviews: [review({ status: 'failed', error: 'The review did not finish in time' })], reviewing: false }))
    show()
    expect(await screen.findByText('Review failed: The review did not finish in time')).toBeTruthy()
  })
})

describe('W19a finding → comment / issue', () => {
  it('a comment on the finding\'s last line, on the new side, with its first quoted line as excerpt', () => {
    expect(findingComment(finding({ startLine: 5, endLine: 7, quote: '\n  const x = 1;\n  y()' }), 'rev-9')).toEqual({
      path: 'src/math.ts', line: 7, side: 'new', body: 'Major: Division by zero\n\nGuard b === 0.', revision: 'rev-9', excerpt: '  const x = 1;',
    })
  })

  it('an issue with location, commit and the quote fenced against its own backticks', () => {
    const issue = findingIssue(finding({ quote: 'const s = ```x```' }), { identifier: 'ENG-7', commit: COMMIT })
    expect(issue.title).toBe('Division by zero')
    expect(issue.description).toContain('From an agent review of ENG-7 (major).')
    expect(issue.description).toContain('````\nconst s = ```x```\n````')
    expect(findingIssueKey('rev-1', { id: 'f1' })).toBe('agent-review:rev-1:f1')
  })

  it('labels evidence; stale wins', () => {
    expect(evidenceLabel({ evidence: 'verified', stale: true })).toEqual({ text: 'Stale', tone: 'muted' })
    expect(evidenceLabel({ evidence: 'unverified', stale: null })).toEqual({ text: 'Quote not found', tone: 'warning' })
  })
})
