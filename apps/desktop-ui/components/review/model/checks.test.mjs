import { describe, it, expect } from 'vitest'

const { deriveReviewGate, publishActions, overrideApplies, canOverride } = await import('./checks.ts')

const PR = 'https://github.com/o/r/pull/12'
const COMPARE = 'https://github.com/o/r/compare/main...openlinear/kt-12'

function gate(overrides = {}) {
  return deriveReviewGate({
    phase: 'succeeded',
    runState: null,
    revision: 'rev-1',
    headSha: 'f00dbabe0123456789',
    headDirty: false,
    diffTruncated: false,
    draftCount: 0,
    outcome: { kind: 'branch_evidence', pullRequestUrl: null, branchUrl: COMPARE },
    ...overrides,
  })
}

function verified(status, extra = {}) {
  return {
    runId: 'r1', state: 'succeeded', attemptId: 'a', lastSeq: 1, relayAckSeq: 1, effects: [],
    terminal: { state: 'succeeded', reason: 'ok', outcome: null, prUrl: null, claimed: true },
    verification: { status, commit: 'f00dbabe', checks: [{ name: 'unit tests', status }] },
    ...extra,
  }
}

describe('review gate', () => {
  it('blocks when verification is not reported (today\'s default) and explains why', () => {
    const result = gate()
    expect(result.status).toBe('blocked')
    expect(result.blocking.map((check) => check.id)).toEqual(['verification'])
    expect(result.summary).toBe('Blocked by Verification (not reported).')
    expect(canOverride(result)).toBe(true)
  })

  it('opens when the run succeeded, verification passed on the displayed commit and no drafts are pending', () => {
    const result = gate({ runState: verified('passed') })
    expect(result.status).toBe('open')
    expect(result.summary).toBe('All required checks passed.')
    const [action] = publishActions(result, { kind: 'branch_evidence', pullRequestUrl: null, branchUrl: COMPARE }, null)
    expect(action).toMatchObject({ action: 'create_pr', enabled: true, url: COMPARE, label: 'Create PR on GitHub', reason: null })
  })

  it('treats a report for another commit, or a dirty workspace, as out of date', () => {
    expect(gate({ runState: verified('passed'), headSha: 'deadbeef00' }).checks[1]).toMatchObject({ status: 'stale', detail: expect.stringMatching(/f00dbab.*deadbee/) })
    expect(gate({ runState: verified('passed'), headDirty: true }).checks[1].status).toBe('stale')
    expect(gate({ runState: verified('passed'), headDirty: true }).checks.some((check) => check.id === 'workspace')).toBe(true)
  })

  it('unsent draft comments block publishing', () => {
    const result = gate({ runState: verified('passed'), draftCount: 2 })
    expect(result.status).toBe('blocked')
    expect(result.checks.find((check) => check.id === 'comments').detail).toBe("2 draft comments haven't been sent to the agent.")
  })

  it('is pending (and never overridable) while the agent works; verification running is pending', () => {
    const running = gate({ phase: 'running', runState: verified('passed') })
    expect(running.status).toBe('pending')
    expect(running.agentBusy).toBe(true)
    expect(canOverride(running)).toBe(false)
    expect(overrideApplies(running, { revision: 'rev-1' })).toBe(false)
    const [action] = publishActions(running, { kind: 'none', pullRequestUrl: null, branchUrl: COMPARE }, { revision: 'rev-1' })
    expect(action).toMatchObject({ enabled: false, reason: 'Wait for the agent to finish before publishing.' })
    expect(gate({ runState: verified('running') }).status).toBe('pending')
  })

  it('failed runs and failed checks block; terminal state beats the phase when not live', () => {
    expect(gate({ phase: 'failed' }).checks[0].status).toBe('failed')
    const recovery = gate({ phase: 'unknown', runState: { ...verified('passed'), terminal: { state: 'recovery_required', reason: 'x', outcome: null, prUrl: null, claimed: true } } })
    expect(recovery.checks[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/unknown after a restart/) })
    const failedChecks = gate({ runState: verified('failed') })
    expect(failedChecks.checks[1]).toMatchObject({ status: 'failed', detail: '1 check failed on f00dbab.' })
    expect(failedChecks.checks[1].items).toEqual([{ name: 'unit tests', status: 'failed' }])
  })

  it('override: explicit, bound to the revision, relabels the action', () => {
    const blocked = gate()
    const outcome = { kind: 'pull_request', pullRequestUrl: PR, branchUrl: null }
    expect(publishActions(blocked, outcome, null)[0]).toMatchObject({ action: 'merge', enabled: false, reason: expect.stringMatching(/Override below/) })
    const overridden = publishActions(blocked, outcome, { revision: 'rev-1' })[0]
    expect(overridden).toMatchObject({ enabled: true, overridden: true, label: 'Merge on GitHub anyway', url: PR })
    const changed = gate({ revision: 'rev-2' })
    expect(overrideApplies(changed, { revision: 'rev-1' })).toBe(false)
    expect(publishActions(changed, outcome, { revision: 'rev-1' })[0].enabled).toBe(false)
  })

  it('without a pushed branch Create PR is disabled with a reason, gate or not', () => {
    const [action] = publishActions(gate({ runState: verified('passed') }), { kind: 'none', pullRequestUrl: null, branchUrl: null }, null)
    expect(action).toMatchObject({ enabled: false, url: null, reason: expect.stringMatching(/No branch has been pushed/) })
  })

  it('publication progress from run effects', () => {
    const effects = (list) => gate({ runState: { ...verified('passed'), effects: list }, outcome: { kind: 'none', pullRequestUrl: null, branchUrl: null } }).checks.find((check) => check.id === 'publication')
    expect(effects([{ key: 'a', kind: 'git.push', status: 'pending' }]).status).toBe('running')
    expect(effects([{ key: 'a', kind: 'git.push', status: 'confirmed' }]).status).toBe('warning')
    expect(effects([{ key: 'a', kind: 'pr.create', status: 'confirmed' }]).status).toBe('passed')
    expect(effects([{ key: 'a', kind: 'git.push', status: 'failed' }]).status).toBe('failed')
  })
})

describe('review gate with W11a verification evidence', () => {
  const evidence = (verification) => ({
    runId: 'r1', state: 'succeeded', attemptId: 'a', lastSeq: 1, relayAckSeq: 1, effects: [],
    terminal: { state: 'succeeded', reason: 'ok', outcome: null, prUrl: null, claimed: true },
    verification: { commit: 'f00dbabe01', checks: [], ...verification },
  })

  it('names the commit, keeps informational failures from blocking and opens the gate on a pass', () => {
    const result = gate({ runState: evidence({
      status: 'passed',
      policy: 'warn',
      checks: [
        { id: 'unit', name: 'Unit tests', required: true, status: 'passed', summary: 'exit 0 · 1.2 s' },
        { id: 'lint', name: 'Lint (informational)', required: false, status: 'failed', summary: 'exit 1 · 0.4 s · informational' },
      ],
      environment: { sandboxMode: 'enforce', provider: 'seatbelt', providerVersion: '1', platform: 'darwin', arch: 'arm64', checkout: 'pristine-clone' },
    }) })
    const verification = result.checks[1]
    expect(verification.status).toBe('passed')
    expect(verification.detail).toBe('1 check passed on f00dbab.')
    expect(verification.items.map((item) => item.status)).toEqual(['passed', 'warning'])
    expect(result.status).toBe('open')
  })

  it('explains an unevaluable verification with the sidecar detail and blocks', () => {
    const result = gate({ runState: evidence({ status: 'error', detail: 'no verified sandbox is available; the check was not run' }) })
    expect(result.checks[1]).toMatchObject({ status: 'failed', detail: "Verification couldn't be completed on f00dbab: no verified sandbox is available; the check was not run" })
    expect(result.status).toBe('blocked')
  })

  it('surfaces integrity notes: unsandboxed checks, a blocked publication, an edited check file', () => {
    const result = gate({ runState: evidence({
      status: 'failed',
      policy: 'require-pass',
      publication: 'blocked',
      checks: [{ name: 'Typecheck', required: true, status: 'failed', summary: 'exit 2 · 3 s' }],
      environment: { sandboxMode: 'trusted-host', provider: null, providerVersion: null, platform: 'darwin', arch: 'arm64', checkout: 'pristine-clone' },
      warnings: ["the agent's commit changes .openlinear/checks.json; the copy from the base commit abc was graded"],
    }) })
    const detail = result.checks[1].detail
    expect(detail).toMatch(/^1 check failed on f00dbab\./)
    expect(detail).toContain('without OS isolation')
    expect(detail).toContain('nothing was published')
    expect(detail).toContain("changed the repository's check file")
  })

  it('a skipped verification says why (no checks configured) and still needs an override', () => {
    const result = gate({ runState: evidence({ status: 'skipped', detail: 'no verification checks are configured' }) })
    expect(result.checks[1]).toMatchObject({ status: 'missing', detail: 'Verification was skipped: no verification checks are configured.' })
    expect(canOverride(result)).toBe(true)
  })
})

describe('review gate with v2 run phases', () => {
  it('compacting is live (not overridable); recovery_required and abandoned block with their own reason', () => {
    const compacting = gate({ phase: 'compacting' })
    expect(compacting.agentBusy).toBe(true)
    expect(canOverride(compacting)).toBe(false)
    expect(gate({ phase: 'recovery_required' }).checks[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/unknown after a restart/) })
    expect(gate({ phase: 'abandoned' }).checks[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/lost authority/) })
  })
})
