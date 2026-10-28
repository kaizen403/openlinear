import { describe, it, expect } from 'vitest'

const { RunModel, foldRunEvents } = await import('./model.ts')
const { decodeExecutionEvent } = await import('./decode.ts')
const { runElapsedMs, formatElapsed, phaseLabel } = await import('./phase.ts')
const {
  TASK_ID,
  PR_URL,
  COMPARE_URL,
  iso,
  legacySuccessRun,
  legacyHistory,
  legacyCancelledRun,
  journalRun,
  journalEvent,
  chattyRun,
  V2_RUN,
  v2State,
  v2Beat,
  v2VerifiedRun,
} = await import('./fixtures.mjs')

let clock = Date.parse('2026-10-25T10:00:00.000Z')
const now = () => clock

function decodeAll(events) {
  return events.map(([type, data, meta]) => {
    const decoded = decodeExecutionEvent(type, data, meta, now())
    if (!decoded) throw new Error(`fixture did not decode: ${type} ${JSON.stringify(data)}`)
    return decoded
  })
}

function modelFrom(events, options = {}) {
  const model = new RunModel({ taskId: TASK_ID, now, ...options })
  model.applyMany(decodeAll(events))
  return model
}

function kinds(snapshot) {
  return snapshot.entries.map((entry) => entry.kind)
}

/** Everything a user can see, minus generated ids/version. */
function visible(snapshot) {
  return {
    phase: snapshot.phase,
    attempt: snapshot.attempt,
    counters: snapshot.counters,
    files: snapshot.files,
    entries: snapshot.entries.map(({ id: _id, ...rest }) => rest),
    outcome: snapshot.outcome,
  }
}

describe('run model: recorded legacy run', () => {
  it('folds a successful run into phases, a timeline, counters and the PR outcome', () => {
    const snapshot = modelFrom(legacySuccessRun()).getSnapshot()

    expect(snapshot.phase).toBe('succeeded')
    expect(snapshot.attempt).toBe(1)
    expect(snapshot.runner).toBe('OpenCode')
    expect(snapshot.model).toBe('Claude Sonnet 4.5')
    expect(snapshot.branch).toBe('openlinear/kt-12-fix-login')
    expect(snapshot.counters).toMatchObject({ tools: 4, toolsRunning: 0, toolErrors: 1, filesChanged: 1, errors: 0 })
    expect(snapshot.files).toEqual([{ path: 'src/auth/login.ts', change: 'modified', edits: 1, lastAt: Date.parse(iso(10_450)) }])
    expect(snapshot.outcome).toMatchObject({ kind: 'pull_request', pullRequestUrl: PR_URL })
    expect(snapshot.cost).toEqual({ status: 'unknown' })

    const tools = snapshot.entries.filter((entry) => entry.kind === 'tool')
    expect(tools.map((tool) => [tool.name, tool.summary, tool.status])).toEqual([
      ['read', 'src/auth/login.ts', 'completed'],
      ['bash', 'Run unit tests', 'completed'],
      ['edit', 'src/auth/login.ts', 'completed'],
      ['write', 'src/auth/session.ts', 'error'],
    ])
    const bash = tools[1]
    expect(bash.isCommand).toBe(true)
    expect(bash.durationMs).toBe(5_100)
    expect(bash.output).toContain('12 passed')

    expect(kinds(snapshot)).toEqual([
      'system', 'system', 'system', 'system', 'system', // repo, branch, agent started, model, prompt sent
      'reasoning', 'assistant',
      'tool', 'tool', 'tool', 'file', 'tool',
      'assistant', 'system', 'system', 'system', 'system',
    ])
    // "Agent is thinking..." is an activity beat, not a timeline row.
    expect(snapshot.entries.some((entry) => 'text' in entry && entry.text.startsWith('Agent is thinking'))).toBe(false)
  })

  it('reports elapsed time from the first live beat to the terminal one', () => {
    clock = Date.parse('2026-10-25T10:00:00.000Z')
    const model = new RunModel({ taskId: TASK_ID, now })
    const events = decodeAll(legacySuccessRun())
    events.forEach((event, index) => {
      clock = Date.parse('2026-10-25T10:00:00.000Z') + index * 1_000
      model.apply({ ...event, receivedAt: clock })
    })
    const snapshot = model.getSnapshot()
    expect(snapshot.phase).toBe('succeeded')
    // Starts at the cloning beat (receivedAt 0) — log timestamps never move the start backwards.
    expect(snapshot.startedAt).toBe(Date.parse('2026-10-25T10:00:00.000Z'))
    expect(runElapsedMs(snapshot, clock + 60_000)).toBe(snapshot.endedAt - snapshot.startedAt)
    expect(formatElapsed(29_000)).toBe('29s')
  })

  it('dedupes reconnect replay and the HTTP history copy of the same lines', () => {
    const events = legacySuccessRun()
    const once = modelFrom(events).getSnapshot()

    const model = modelFrom(events)
    // Reconnect: the stream replays from its cursor (same ids) …
    model.applyMany(decodeAll(events.slice(10)))
    // … and the detail view re-fetches GET /api/tasks/:id/logs (no ids, same content).
    model.apply({ kind: 'history', taskId: TASK_ID, entries: legacyHistory(events) })
    const replayed = model.getSnapshot()

    expect(visible(replayed)).toEqual(visible(once))
    expect(replayed.entries).toHaveLength(once.entries.length)
  })

  it('history first, live copies second, folds each line once', () => {
    const events = legacySuccessRun()
    const model = new RunModel({ taskId: TASK_ID, now })
    model.apply({ kind: 'history', taskId: TASK_ID, entries: legacyHistory(events) })
    const fromHistory = model.getSnapshot().entries.length
    model.applyMany(decodeAll(events))
    expect(model.getSnapshot().entries).toHaveLength(fromHistory)
    expect(model.getSnapshot().phase).toBe('succeeded')
  })

  it('orders out-of-order arrivals and never moves a finished run backwards', () => {
    const events = legacySuccessRun()
    const shuffled = [...events]
    // Outbox delivery can race: swap the bash start/title/completion and the last two progress beats.
    const swap = (a, b) => { const tmp = shuffled[a]; shuffled[a] = shuffled[b]; shuffled[b] = tmp }
    swap(16, 14) // "Completed: bash" before "Running: bash"
    swap(29, 26) // `done` before `creating_pr`
    const inOrder = modelFrom(events).getSnapshot()
    const snapshot = modelFrom(shuffled).getSnapshot()

    expect(snapshot.phase).toBe('succeeded')
    const timestamps = snapshot.entries.map((entry) => entry.at)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
    const bash = snapshot.entries.find((entry) => entry.kind === 'tool' && entry.name === 'bash')
    expect(bash).toMatchObject({ status: 'completed', isCommand: true })
    expect(bash.durationMs).toBeGreaterThan(0)
    expect(snapshot.counters.tools).toBe(inOrder.counters.tools)
    expect(snapshot.counters.toolsRunning).toBe(0)
  })

  it('ignores a late beat with an older outbox id, and post-cancel beats of the same run', () => {
    const model = modelFrom(legacyCancelledRun())
    expect(model.getSnapshot().phase).toBe('cancelled')
    // Older id replayed after the terminal beat.
    model.apply(decodeExecutionEvent('execution:progress', { taskId: TASK_ID, status: 'executing', message: 'Agent is thinking...' }, { id: '2004' }))
    // Newer id, but not a fresh start: OpenCode's `session.status busy` still beats after a cancel.
    model.apply(decodeExecutionEvent('execution:progress', { taskId: TASK_ID, status: 'executing', message: 'Agent is thinking...' }, { id: '2010' }))
    const snapshot = model.getSnapshot()
    expect(snapshot.phase).toBe('cancelled')
    expect(snapshot.attempt).toBe(1)
    // The tool that was running when the run was cancelled never reported a result.
    expect(snapshot.entries.find((entry) => entry.kind === 'tool')).toMatchObject({ summary: 'pnpm install', status: 'unfinished' })
    expect(snapshot.outcome).toMatchObject({ kind: 'cancelled' })
  })

  it('a fresh start after a finished run opens a new attempt and keeps the earlier evidence', () => {
    const model = modelFrom(legacyCancelledRun())
    const before = model.getSnapshot().entries.length
    model.applyMany(decodeAll(legacySuccessRun({ idOffset: 5_000, timeOffset: 600_000 })))
    const snapshot = model.getSnapshot()
    expect(snapshot.attempt).toBe(2)
    expect(snapshot.phase).toBe('succeeded')
    const divider = snapshot.entries.find((entry) => entry.kind === 'attempt')
    expect(divider).toMatchObject({ text: 'Run 2 started', attempt: 2 })
    expect(snapshot.entries.length).toBeGreaterThan(before)
    // Counters describe the current attempt only.
    expect(snapshot.counters.tools).toBe(4)
    expect(snapshot.entries.filter((entry) => entry.attempt === 1).length).toBe(before)
  })
})

describe('run model: connectivity and the persisted row', () => {
  it('goes unknown when the stream drops mid-run and restores on reconnect', () => {
    const model = modelFrom(legacySuccessRun().slice(0, 15))
    expect(model.getSnapshot().phase).toBe('running')
    model.apply({ kind: 'stream', state: 'lost' })
    expect(model.getSnapshot()).toMatchObject({ phase: 'unknown', recovery: 'stream_lost' })
    expect(phaseLabel(model.getSnapshot())).toBe('Connection lost')
    // Replayed progress while still reconnecting doesn't clear the flag on its own.
    model.apply({ kind: 'stream', state: 'open' })
    expect(model.getSnapshot()).toMatchObject({ phase: 'running', recovery: null })
  })

  it('a dropped stream after the run finished changes nothing', () => {
    const model = modelFrom(legacySuccessRun())
    model.apply({ kind: 'stream', state: 'lost' })
    expect(model.getSnapshot()).toMatchObject({ phase: 'succeeded', recovery: null })
  })

  it('derives phase and outcome from the task row when there are no live events', () => {
    const done = foldRunEvents([{ kind: 'snapshot', task: row({ status: 'done', prUrl: PR_URL, outcome: '3 files changed, 5 tools executed', executionElapsedMs: 95_000 }) }])
    expect(done).toMatchObject({ phase: 'succeeded', attempt: 1, persistedElapsedMs: 95_000 })
    expect(done.outcome).toMatchObject({ kind: 'pull_request' })
    expect(formatElapsed(runElapsedMs(done, Date.now()))).toBe('1m 35s')

    const failed = foldRunEvents([{ kind: 'snapshot', task: row({ status: 'cancelled', outcome: 'Commit/push failed: rejected. Work retained on openlinear/kt-12 at /repos/acme' }) }])
    expect(failed.phase).toBe('failed')
    expect(failed.outcome).toMatchObject({ kind: 'publication_failed', retained: { branch: 'openlinear/kt-12', path: '/repos/acme' } })

    const never = foldRunEvents([{ kind: 'snapshot', task: row({ status: 'todo' }) }])
    expect(never).toMatchObject({ phase: 'idle', attempt: 0, hasActivity: false })

    const compare = foldRunEvents([{ kind: 'snapshot', task: row({ status: 'done', prUrl: COMPARE_URL }) }])
    expect(compare.outcome).toMatchObject({ kind: 'branch_evidence', branchUrl: COMPARE_URL, pullRequestUrl: null })
  })

  it('flags a run the execution service restarted under as recovery required', () => {
    const snapshot = foldRunEvents([{ kind: 'snapshot', task: row({ status: 'in_progress', outcome: 'sidecar_recovery_salvaged', executionStartedAt: iso(0) }) }])
    expect(snapshot).toMatchObject({ phase: 'unknown', recovery: 'service_restarted' })
    expect(phaseLabel(snapshot)).toBe('Recovery required')
  })

  it('a re-sent task row with the same status does not end a newer attempt', () => {
    const model = new RunModel({ taskId: TASK_ID, now })
    model.apply({ kind: 'snapshot', task: row({ status: 'done', prUrl: PR_URL }) })
    model.applyMany(decodeAll(legacySuccessRun().slice(0, 12)))
    expect(model.getSnapshot()).toMatchObject({ attempt: 2, phase: 'running' })
    // Board re-renders hand the same (stale) row again, e.g. after a title edit.
    model.apply({ kind: 'snapshot', task: row({ status: 'done', prUrl: PR_URL, title: 'renamed' }) })
    expect(model.getSnapshot()).toMatchObject({ attempt: 2, phase: 'running' })
    // The row moving to in_progress is consistent with the live phase.
    model.apply({ kind: 'snapshot', task: row({ status: 'in_progress' }) })
    expect(model.getSnapshot().phase).toBe('running')
  })

  it('queues on a start request until the service reports', () => {
    const model = new RunModel({ taskId: TASK_ID, now })
    model.apply({ kind: 'start-requested' })
    expect(model.getSnapshot()).toMatchObject({ phase: 'queued', phaseSource: 'request', hasActivity: true })
    model.applyMany(decodeAll(legacySuccessRun().slice(0, 1)))
    expect(model.getSnapshot()).toMatchObject({ phase: 'preparing', attempt: 1 })
  })

  it('a rejected start drops the queued overlay and leaves the last run untouched', () => {
    const model = modelFrom(legacyCancelledRun())
    model.apply({ kind: 'start-requested' })
    expect(model.getSnapshot().phase).toBe('queued')
    model.apply({ kind: 'start-abandoned' })
    expect(model.getSnapshot()).toMatchObject({ phase: 'cancelled', attempt: 1 })
    // An accepted start: the first report opens attempt 2 even without ordering evidence.
    model.apply({ kind: 'start-requested' })
    model.apply({ kind: 'progress', taskId: TASK_ID, status: 'cloning', message: 'Cloning repository...' })
    expect(model.getSnapshot()).toMatchObject({ phase: 'preparing', attempt: 2 })
  })
})

describe('run model: journal (W05 path)', () => {
  it('folds AgentEvent payloads: tool calls with args/output/duration, file kinds, text deltas', () => {
    const snapshot = modelFrom(journalRun()).getSnapshot()
    expect(snapshot.runId).toBe('run-7f3a')
    expect(snapshot.model).toBe('claude-sonnet-4-5')
    expect(snapshot.phase).toBe('running')
    const [bash, edit] = snapshot.entries.filter((entry) => entry.kind === 'tool')
    expect(bash).toMatchObject({ name: 'bash', summary: 'pnpm test --filter auth', status: 'error', isCommand: true, callId: 'c1' })
    expect(bash.output).toBe('FAIL login.test.ts\n1 failed, 11 passed\n')
    expect(bash.args).toContain('"command": "pnpm test --filter auth"')
    expect(edit).toMatchObject({ name: 'edit', summary: 'login.ts', status: 'completed' })
    expect(snapshot.files.map((file) => [file.path, file.change])).toEqual([
      ['src/auth/login.ts', 'modified'],
      ['src/auth/cookie.ts', 'added'],
      ['src/auth/legacy.ts', 'deleted'],
    ])
    expect(snapshot.entries.find((entry) => entry.kind === 'reasoning')).toMatchObject({ text: 'Need to find the failing test.' })
    expect(snapshot.entries.find((entry) => entry.kind === 'assistant')).toMatchObject({ text: 'Fixed the redirect bug.' })
    expect(snapshot.tokens).toMatchObject({ input: 1200, output: 300, cacheRead: 5000 })
    // Usage without a provider cost is unknown, never $0.
    expect(snapshot.cost).toEqual({ status: 'unknown' })
  })

  it('orders by seq, drops replayed seqs, and reports cost only when the provider does', () => {
    const events = journalRun()
    const reversedPair = [...events]
    const tmp = reversedPair[6]; reversedPair[6] = reversedPair[5]; reversedPair[5] = tmp // output chunk 7 before 6
    const model = modelFrom(reversedPair)
    model.applyMany(decodeAll(events.slice(8))) // reconnect replay
    const snapshot = model.getSnapshot()
    expect(snapshot.entries.filter((entry) => entry.kind === 'tool')).toHaveLength(2)
    expect(snapshot.counters.tools).toBe(2)

    model.apply(decodeAll([journalEvent(18, { t: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0.0123, basis: 'provider' }, messageId: 'm2' })])[0])
    expect(model.getSnapshot().cost).toEqual({ status: 'known', usd: 0.0123, basis: 'provider' })
  })

  it('lights up W05 phases and outcomes through run.phase / run.outcome', () => {
    const model = modelFrom(journalRun())
    model.apply(decodeAll([journalEvent(18, { t: 'run.phase', phase: 'verifying' })])[0])
    expect(model.getSnapshot().phase).toBe('verifying')
    model.apply(decodeAll([journalEvent(19, { t: 'run.phase', phase: 'awaiting_approval' })])[0])
    expect(model.getSnapshot().phase).toBe('awaiting_approval')
    // An older phase event replayed late is ignored.
    model.apply(decodeAll([journalEvent(17.5, { t: 'run.phase', phase: 'running' })])[0])
    expect(model.getSnapshot().phase).toBe('awaiting_approval')
    model.apply(decodeAll([journalEvent(20, { t: 'run.outcome', status: 'failed', reason: 'Verification failed', retained: { branch: 'openlinear/kt-12', path: '/w/kt-12' } })])[0])
    const snapshot = model.getSnapshot()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.outcome).toMatchObject({ kind: 'failed', reason: 'Verification failed', retained: { branch: 'openlinear/kt-12', path: '/w/kt-12' } })
  })

  it('a new runId starts a new attempt; late events from the old run are ignored', () => {
    const model = modelFrom(journalRun())
    model.apply(decodeExecutionEvent('execution:progress', { runId: 'run-2', taskId: TASK_ID, seq: 1, type: 'session.started', payload: { t: 'session.started', externalId: 's2', model: { id: 'gpt-5' } } }, { id: 'run:run-2:1' }))
    expect(model.getSnapshot()).toMatchObject({ attempt: 2, runId: 'run-2', model: 'gpt-5' })
    const before = model.getSnapshot().entries.length
    model.apply(decodeAll([journalEvent(30, { t: 'message.delta', text: 'late' })])[0])
    expect(model.getSnapshot().entries).toHaveLength(before)
  })
})

describe('run model: bounded memory', () => {
  it('caps entries, collapses old output and keeps totals across 10,000 events', () => {
    const events = chattyRun(10_000)
    const model = modelFrom(events, { maxEntries: 600, keepFullOutputFor: 100, collapsedOutputChars: 80, maxSeenKeys: 2_000 })
    const snapshot = model.getSnapshot()

    expect(snapshot.entries.length).toBeLessThanOrEqual(600)
    expect(snapshot.droppedEntries).toBeGreaterThan(0)
    expect(snapshot.counters.entriesTotal).toBe(snapshot.entries.length + snapshot.droppedEntries)
    // 2 tool calls per 8 events, all counted even though most rows were dropped.
    expect(snapshot.counters.tools).toBe(2_500)
    expect(snapshot.counters.toolsRunning).toBe(0)
    // chattyRun edits 50 distinct paths (i ≡ 5 mod 8, i % 400).
    expect(snapshot.counters.filesChanged).toBe(50)

    const outputs = snapshot.entries.filter((entry) => entry.kind === 'tool' && entry.output)
    const old = outputs.slice(0, outputs.length - 60)
    expect(old.length).toBeGreaterThan(0)
    for (const tool of old) expect(tool.output.length).toBeLessThanOrEqual(80)
    const newest = outputs[outputs.length - 1]
    expect(newest.output.length).toBeGreaterThan(80)
  })

  it('per-event fold time stays flat as the run grows', () => {
    const events = decodeAll(chattyRun(20_000))
    const model = new RunModel({ taskId: TASK_ID, now })
    const first = performance.now()
    for (let i = 0; i < 2_000; i++) model.apply(events[i])
    const early = (performance.now() - first) / 2_000
    for (let i = 2_000; i < 18_000; i++) model.apply(events[i])
    const lateStart = performance.now()
    for (let i = 18_000; i < 20_000; i++) model.apply(events[i])
    const late = (performance.now() - lateStart) / 2_000
    // Generous bound for shared CI machines; the point is "no O(n) growth".
    expect(late).toBeLessThan(Math.max(early * 5, 0.25))
  })
})

function row(overrides = {}) {
  return {
    id: TASK_ID,
    status: 'todo',
    outcome: null,
    prUrl: null,
    batchId: null,
    executionStartedAt: null,
    executionElapsedMs: 0,
    model: null,
    ...overrides,
  }
}

describe('v2 run engine beats (FE-01: every state, refresh/reconnect reproduces it)', () => {
  function phases(events) {
    const model = new RunModel({ taskId: TASK_ID, now })
    return decodeAll(events).map((event) => {
      model.apply(event)
      return model.getSnapshot().phase
    })
  }

  it('shows every state of the machine separately, in order', () => {
    expect(phases(v2VerifiedRun())).toEqual([
      'queued', 'preparing', 'preparing', 'running', 'running',
      'awaiting_approval',
      // A status-only beat never knocks a state back to "running".
      'awaiting_approval',
      'running', 'compacting', 'running',
      'verifying', 'verifying',
      // finishing: the beat's status names the step.
      'committing', 'publishing',
      'succeeded',
    ])
    const snapshot = modelFrom(v2VerifiedRun()).getSnapshot()
    expect(snapshot).toMatchObject({ runId: V2_RUN, attempt: 1, phase: 'succeeded', message: 'pull request created' })
  })

  it('recovery_required and abandoned are their own terminal phases, not "failed"', () => {
    const recovery = modelFrom([v2State(1, 'preparing'), v2State(2, 'running'), v2State(3, 'recovery_required', 'the sidecar restarted mid-turn')]).getSnapshot()
    expect(recovery.phase).toBe('recovery_required')
    expect(phaseLabel(recovery)).toBe('Recovery required')
    expect(recovery.outcome).not.toBeNull()
    const abandoned = modelFrom([v2State(1, 'running'), v2State(2, 'abandoned', 'lease lost')]).getSnapshot()
    expect(abandoned.phase).toBe('abandoned')
    expect(phaseLabel(abandoned)).toBe('Abandoned')
  })

  it('a replay or the second delivery path never folds twice; an older beat never rewinds the phase', () => {
    const local = v2VerifiedRun()
    const model = modelFrom(local)
    const before = model.getSnapshot()
    // The same events relayed through the control plane (cloud ids), then a full local replay.
    const relayed = local.map(([type, data], index) => [type, data, { stream: 'cloud', id: String(500 + index) }])
    expect(model.applyMany(decodeAll(relayed))).toBe(false)
    expect(model.applyMany(decodeAll(local))).toBe(false)
    expect(model.getSnapshot().version).toBe(before.version)

    const out = new RunModel({ taskId: TASK_ID, now })
    out.applyMany(decodeAll([v2State(1, 'preparing'), v2State(4, 'running'), v2State(11, 'verifying')]))
    out.applyMany(decodeAll([v2State(6, 'awaiting_approval'), v2Beat(5, 'executing', 'late beat')]))
    expect(out.getSnapshot()).toMatchObject({ phase: 'verifying', message: 'verifying' })
  })

  it('a new run opens attempt 2 behind a divider; late beats of the finished run are ignored', () => {
    const model = modelFrom(v2VerifiedRun())
    model.applyMany(decodeAll([v2State(1, 'preparing', 'accepted', { runId: 'run-v2-2' }), v2State(2, 'running', 'agent started', { runId: 'run-v2-2' })]))
    const second = model.getSnapshot()
    expect(second).toMatchObject({ runId: 'run-v2-2', attempt: 2, phase: 'running' })
    expect(second.entries.some((entry) => entry.kind === 'attempt' && entry.text === 'Run 2 started') || second.entries.length === 0).toBe(true)
    expect(model.applyMany(decodeAll([v2State(16, 'failed', 'late', { runId: V2_RUN })]))).toBe(false)
    expect(model.getSnapshot().phase).toBe('running')
  })

  it('a start request shows queued until the engine reports; a 202-queued run stays queued', () => {
    const model = new RunModel({ taskId: TASK_ID, now })
    model.apply({ kind: 'start-requested', at: now() })
    expect(model.getSnapshot().phase).toBe('queued')
    model.applyMany(decodeAll([v2State(1, 'queued', 'queued behind the parallel limit')]))
    expect(model.getSnapshot()).toMatchObject({ phase: 'queued', phaseSource: 'journal', runId: V2_RUN })
  })

  it('decodes the v2 fields defensively', () => {
    const decoded = decodeExecutionEvent('execution:progress', { taskId: TASK_ID, status: 'queued', message: 'q', runId: 'r', runSeq: 3, runState: 'nonsense' }, null, 1)
    expect(decoded).toMatchObject({ kind: 'progress', status: 'queued', runId: 'r', runSeq: 3, runState: null })
    const noSeq = decodeExecutionEvent('execution:progress', { taskId: TASK_ID, status: 'executing', message: 'x', runId: 'r', runSeq: 0 }, null, 1)
    expect(noSeq.runId).toBeUndefined()
  })
})

describe('FE-08 budgets from the durable run state', () => {
  it('carries the sealed budgets; a new run starts without them until its own run state arrives', () => {
    const model = new RunModel({ taskId: TASK_ID, now })
    model.apply({ kind: 'run-state', taskId: TASK_ID, runId: 'run-b1', lastSeq: 3, state: 'running', runner: 'opencode', budgets: { maxUsd: 2 } })
    expect(model.getSnapshot().budget).toEqual({ maxUsd: 2, maxTokens: null })
    model.applyMany(decodeAll([v2State(1, 'preparing', 'accepted', { runId: 'run-b2' })]))
    expect(model.getSnapshot()).toMatchObject({ runId: 'run-b2', budget: null })
    model.apply({ kind: 'run-state', taskId: TASK_ID, runId: 'run-b2', lastSeq: 2, state: 'running', runner: 'opencode', budgets: null })
    expect(model.getSnapshot().budget).toBeNull()
  })
})
