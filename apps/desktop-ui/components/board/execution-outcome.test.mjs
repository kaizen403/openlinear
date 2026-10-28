import { describe, it, expect } from 'vitest'

const {
  classifyPublicationUrl,
  deriveBatchMemberPhase,
  describeBatchOutcome,
  describeTaskExecution,
  isLocalCommitReadyOutcome,
  isReadyToPublishTask,
  outcomeReason,
  parseOutcomePullRequest,
  parseRetainedWork,
} = await import('./execution-outcome.ts')

const PR = 'https://github.com/acme/app/pull/42'
const COMPARE = 'https://github.com/acme/app/compare/main...openlinear%2Fbatch-1'

// Outcome strings exactly as the sidecar writes them (W01).
const SINGLE_STREAM_FAILURE = 'Agent event stream ended unexpectedly. Work retained on openlinear/3f2a9c1d at /Users/me/Library/Application Support/openlinear/repos/app/3f2a9c1d'
const SINGLE_PUBLICATION_FAILURE = `Pull request creation was not confirmed; pushed branch retained. Work retained on openlinear/3f2a9c1d at /tmp/repos/app/3f2a9c1d; pull request ${PR}`
const BATCH_READY = 'Local commit ready; publication pending. Work retained on branch openlinear/batch-1/task-1 at /tmp/wt/task-1'
const BATCH_FAILED = 'Failed: Merge conflict. Work retained on branch openlinear/batch-1/task-2 at /tmp/wt/task-2'
const BATCH_CANCELLED = 'Cancelled; work retained on openlinear/batch-1/task-3 at /tmp/wt/task-3'
const BATCH_DONE = `Completed via Parallel Execution; pull request ${PR}`

function task(overrides) {
  return { status: 'todo', outcome: null, prUrl: null, batchId: null, ...overrides }
}

describe('publication URLs', () => {
  it('only treats /pull/<n> as a confirmed pull request', () => {
    expect(classifyPublicationUrl(PR)).toBe('pull_request')
    expect(classifyPublicationUrl(COMPARE)).toBe('compare')
    expect(classifyPublicationUrl('https://github.com/acme/app/pull/new/branch')).toBe('other')
    expect(classifyPublicationUrl('http://github.com/acme/app/pull/42')).toBe('other')
    expect(classifyPublicationUrl('not a url')).toBe('other')
    expect(classifyPublicationUrl(null)).toBeNull()
  })
})

describe('outcome text parsing', () => {
  it('extracts the retained branch and a path with spaces', () => {
    expect(parseRetainedWork(SINGLE_STREAM_FAILURE)).toEqual({
      branch: 'openlinear/3f2a9c1d',
      path: '/Users/me/Library/Application Support/openlinear/repos/app/3f2a9c1d',
    })
  })

  it('stops the path before an accepted pull request', () => {
    expect(parseRetainedWork(SINGLE_PUBLICATION_FAILURE)).toEqual({ branch: 'openlinear/3f2a9c1d', path: '/tmp/repos/app/3f2a9c1d' })
    expect(parseOutcomePullRequest(SINGLE_PUBLICATION_FAILURE)).toBe(PR)
  })

  it('parses batch member outcomes', () => {
    expect(parseRetainedWork(BATCH_FAILED)).toEqual({ branch: 'openlinear/batch-1/task-2', path: '/tmp/wt/task-2' })
    expect(parseRetainedWork(BATCH_CANCELLED)).toEqual({ branch: 'openlinear/batch-1/task-3', path: '/tmp/wt/task-3' })
    expect(parseRetainedWork('Failed: x. Work retained on branch openlinear/b/t')).toEqual({ branch: 'openlinear/b/t', path: null })
    expect(parseRetainedWork('Agent finished without making code changes')).toBeNull()
  })

  it('reduces the outcome to its reason', () => {
    expect(outcomeReason(BATCH_FAILED)).toBe('Merge conflict')
    expect(outcomeReason(SINGLE_PUBLICATION_FAILURE)).toBe('Pull request creation was not confirmed; pushed branch retained')
    expect(outcomeReason('sidecar_recovery_failed')).toBe('The execution service restarted during this run')
  })

  it('detects publish-ready batch members', () => {
    expect(isLocalCommitReadyOutcome(BATCH_READY)).toBe(true)
    expect(isReadyToPublishTask(task({ status: 'in_progress', batchId: 'b1', outcome: BATCH_READY }))).toBe(true)
    // A single run doesn't belong to a batch, even with a stale outcome.
    expect(isReadyToPublishTask(task({ status: 'in_progress', batchId: null, outcome: BATCH_READY }))).toBe(false)
    expect(isReadyToPublishTask(task({ status: 'done', batchId: 'b1', outcome: BATCH_READY }))).toBe(false)
  })
})

describe('describeTaskExecution', () => {
  it('confirmed pull request', () => {
    const outcome = describeTaskExecution(task({ status: 'done', prUrl: PR, outcome: '3 files changed, 9 tools executed' }))
    expect(outcome).toMatchObject({ kind: 'pull_request', pullRequestUrl: PR, branchUrl: null, tone: 'success' })
  })

  it('compare link is branch evidence, never a PR', () => {
    const outcome = describeTaskExecution(task({ status: 'done', prUrl: COMPARE }))
    expect(outcome).toMatchObject({ kind: 'branch_evidence', pullRequestUrl: null, branchUrl: COMPARE, tone: 'warning' })
    const live = describeTaskExecution(task({ status: 'in_progress' }), { status: 'done', prUrl: COMPARE, isCompareLink: true })
    expect(live.kind).toBe('branch_evidence')
  })

  it('batch member committed while the batch runs is ready to publish, not done', () => {
    const outcome = describeTaskExecution(task({ status: 'in_progress', batchId: 'b1', outcome: BATCH_READY }))
    expect(outcome).toMatchObject({ kind: 'ready_to_publish', tone: 'info' })
    expect(outcome.label).toMatch(/waiting for batch publication/)
  })

  it('failed publication keeps the retained branch/path and the accepted PR', () => {
    const outcome = describeTaskExecution(task({ status: 'cancelled', outcome: SINGLE_PUBLICATION_FAILURE }))
    expect(outcome).toMatchObject({
      kind: 'publication_failed',
      pullRequestUrl: PR,
      retained: { branch: 'openlinear/3f2a9c1d', path: '/tmp/repos/app/3f2a9c1d' },
      label: 'Failed after the pull request was opened',
    })
  })

  it('single-task run failure shows retained work', () => {
    const outcome = describeTaskExecution(task({ status: 'cancelled', outcome: SINGLE_STREAM_FAILURE }))
    expect(outcome).toMatchObject({ kind: 'failed', label: 'Run failed — work retained', tone: 'danger' })
    expect(outcome.reason).toBe('Agent event stream ended unexpectedly')
  })

  it('failed batch member returns to todo with its retained branch', () => {
    const outcome = describeTaskExecution(task({ status: 'todo', batchId: 'b1', outcome: BATCH_FAILED }))
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'Merge conflict', retained: { branch: 'openlinear/batch-1/task-2' } })
  })

  it('failures without retained work still show the reason', () => {
    expect(describeTaskExecution(task({ status: 'cancelled', outcome: 'Commit/push failed: rejected' }))).toMatchObject({
      kind: 'publication_failed',
      label: 'Publication failed',
    })
    expect(describeTaskExecution(task({ status: 'cancelled', outcome: 'Agent finished without making code changes' }))).toMatchObject({
      kind: 'failed',
      label: 'Run failed',
    })
  })

  it('cancellation', () => {
    expect(describeTaskExecution(task({ status: 'cancelled', outcome: BATCH_CANCELLED }))).toMatchObject({ kind: 'cancelled', label: 'Cancelled — work retained' })
    expect(describeTaskExecution(task({ status: 'cancelled' }))).toMatchObject({ kind: 'cancelled', label: 'Cancelled' })
    // A user-cancel doesn't overwrite outcome; an earlier run's success must not read as a failure or a fresh PR.
    expect(describeTaskExecution(task({ status: 'cancelled', prUrl: PR, outcome: BATCH_DONE }))).toMatchObject({
      kind: 'cancelled',
      label: 'Cancelled',
      pullRequestUrl: PR,
    })
  })

  it('nothing to show for plain tasks', () => {
    expect(describeTaskExecution(task({ status: 'todo' })).kind).toBe('none')
    expect(describeTaskExecution(task({ status: 'todo', batchId: 'b1', outcome: 'Batch queued' })).kind).toBe('none')
    expect(describeTaskExecution(task({ status: 'done' })).kind).toBe('none')
    expect(describeTaskExecution(task({ status: 'in_progress' })).kind).toBe('none')
  })
})

describe('batch members', () => {
  it('completed while the batch runs is ready to publish', () => {
    expect(deriveBatchMemberPhase({ status: 'completed' }, 'running')).toBe('ready_to_publish')
    expect(deriveBatchMemberPhase({ status: 'completed' }, 'pending')).toBe('ready_to_publish')
    expect(deriveBatchMemberPhase({ status: 'completed' }, 'merging')).toBe('publishing')
    expect(deriveBatchMemberPhase({ status: 'completed' }, 'completed')).toBe('published')
    expect(deriveBatchMemberPhase({ status: 'completed' }, 'failed')).toBe('not_published')
    expect(deriveBatchMemberPhase({ status: 'completed' }, 'cancelled')).toBe('cancelled')
  })

  it('uses the persisted task row when the committed event was not delivered', () => {
    const committed = { status: 'in_progress', batchId: 'b1', outcome: BATCH_READY }
    expect(deriveBatchMemberPhase({ status: 'running' }, 'running', committed)).toBe('ready_to_publish')
    expect(deriveBatchMemberPhase({ status: 'running' }, 'running', { status: 'in_progress', batchId: 'b1', outcome: 'Batch queued' })).toBe('running')
    expect(deriveBatchMemberPhase({ status: 'failed' }, 'running')).toBe('failed')
  })
})

describe('describeBatchOutcome', () => {
  const members = [
    { taskId: 't1', title: 'One', status: 'completed', branch: 'openlinear/b/t1' },
    { taskId: 't2', title: 'Two', status: 'failed', branch: 'openlinear/b/t2', error: 'Merge conflict' },
  ]

  it('confirmed PR with a retained failed member', () => {
    const view = describeBatchOutcome({ status: 'completed', prUrl: PR, publication: { phase: 'completed' }, tasks: members })
    expect(view).toMatchObject({ label: 'Pull request opened', pullRequestUrl: PR, branchUrl: null, tone: 'warning' })
    expect(view.retained.map((member) => member.taskId)).toEqual(['t2'])
  })

  it('failed publication after the push shows branch evidence and the error', () => {
    const view = describeBatchOutcome({
      status: 'failed',
      prUrl: null,
      publication: { phase: 'failed', branchUrl: COMPARE, error: 'GitHub rejected the pull request', receiptPath: '/repos/.receipts/batch-b.json' },
      tasks: members,
    })
    expect(view).toMatchObject({
      label: 'Publication failed — branch pushed',
      branchUrl: COMPARE,
      pullRequestUrl: null,
      publicationError: 'GitHub rejected the pull request',
      receiptPath: '/repos/.receipts/batch-b.json',
      tone: 'danger',
    })
    expect(view.retained.map((member) => member.taskId)).toEqual(['t1', 't2'])
  })

  it('cancelled batch with an accepted PR and an unconfirmed stop', () => {
    const view = describeBatchOutcome({
      status: 'cancelled',
      prUrl: PR,
      publication: { phase: 'cancelled', error: 'Provider abort could not be confirmed' },
      tasks: [{ taskId: 't1', title: 'One', status: 'cancelled', branch: 'openlinear/b/t1', cancelUnconfirmed: true }],
    })
    expect(view).toMatchObject({ label: 'Cancelled — the pull request was still opened', tone: 'warning', pullRequestUrl: PR })
    expect(view.unconfirmedStops.map((member) => member.taskId)).toEqual(['t1'])
  })

  it('a compare link in prUrl is not reported as a PR', () => {
    const view = describeBatchOutcome({ status: 'completed', prUrl: COMPARE, tasks: [] })
    expect(view.pullRequestUrl).toBeNull()
    expect(view.label).toBe('Completed — no pull request confirmed')
  })
})
