// Recorded-shape fixtures for the run model tests and the timeline benchmark.
//
// Legacy events follow the exact payloads the sidecar emits today:
//   execution:progress  { taskId, status, message, prUrl?, isCompareLink? }  (broadcastProgress)
//   execution:log       { taskId, entry: { timestamp, type, message, details? } } (addLogEntry)
// delivered on the cloud stream with numeric outbox ids. Message texts are the
// literal strings from apps/sidecar/src/services/execution/{lifecycle,events,
// event-stream-processor}.ts and services/delta-buffer.ts.
//
// Journal events follow the run journal mirror: SSE `execution:progress`
// `{ runId, taskId, seq, type, payload }`, id `run:<runId>:<seq>`, where
// `payload` is the execution-core AgentEvent (`type === payload.t`).

export const TASK_ID = 'task-kt-12'
export const PR_URL = 'https://github.com/acme/app/pull/42'
export const COMPARE_URL = 'https://github.com/acme/app/compare/main...openlinear%2Fkt-12'
const T0 = Date.parse('2026-10-25T10:00:00.000Z')

export function iso(offsetMs) {
  return new Date(T0 + offsetMs).toISOString()
}

/** A wire event as the SSE provider hands it to listeners: [type, data, meta]. */
function progressAt(id, status, message, extra = {}) {
  return ['execution:progress', { taskId: TASK_ID, status, message, ...extra }, { stream: 'cloud', id: String(id) }]
}

function logAt(id, offsetMs, type, message, details) {
  const entry = { timestamp: iso(offsetMs), type, message, ...(details !== undefined ? { details } : {}) }
  return ['execution:log', { taskId: TASK_ID, entry }, { stream: 'cloud', id: String(id) }]
}

/**
 * One successful single-task run, as the board receives it. `idOffset` /
 * `timeOffset` shift outbox ids and timestamps to place a later run.
 */
export function legacySuccessRun({ idOffset = 0, timeOffset = 0 } = {}) {
  const progress = (id, ...rest) => progressAt(id + idOffset, ...rest)
  const log = (id, offsetMs, ...rest) => logAt(id + idOffset, offsetMs + timeOffset, ...rest)
  return [
    progress(1001, 'cloning', 'Preparing local repository...'),
    log(1002, 100, 'info', 'Using local repository: /Users/me/acme/app'),
    log(1003, 200, 'info', 'Branch created: openlinear/kt-12-fix-login'),
    log(1004, 300, 'info', 'OpenCode agent started'),
    progress(1005, 'executing', 'Starting OpenCode agent...'),
    log(1006, 400, 'info', 'Using model: Claude Sonnet 4.5'),
    log(1007, 500, 'info', 'Task prompt sent to agent'),
    log(1008, 1_000, 'agent', 'Agent is thinking...'),
    progress(1009, 'executing', 'Agent is thinking...'),
    log(1010, 1_800, 'agent', 'Thinking: The login handler drops the session cookie when the redirect param is set.'),
    log(1011, 2_600, 'agent', "I'll start by reading the login handler."),
    log(1012, 3_000, 'tool', 'Running: src/auth/login.ts'),
    progress(1013, 'executing', 'Running: src/auth/login.ts'),
    log(1014, 3_400, 'success', 'Completed: read', 'export async function login(req: Request, res: Response) {\n  const { redirect } = req.query'),
    log(1015, 4_000, 'tool', 'Running: bash'),
    log(1016, 4_100, 'tool', 'Running: Run unit tests'),
    log(1017, 9_100, 'success', 'Completed: bash', 'PASS src/auth/login.test.ts (12 tests)\nTests: 12 passed, 12 total'),
    log(1018, 10_000, 'tool', 'Running: src/auth/login.ts'),
    log(1019, 10_400, 'success', 'Completed: edit', ''),
    log(1020, 10_450, 'success', 'Edited file: src/auth/login.ts'),
    log(1021, 11_000, 'tool', 'Running: src/auth/session.ts'),
    log(1022, 11_300, 'error', 'Failed: write', 'EACCES: permission denied, open src/auth/session.ts'),
    log(1023, 12_000, 'agent', 'The fix is in place and the tests pass.'),
    log(1024, 12_500, 'success', 'Agent completed work'),
    progress(1025, 'committing', 'Committing changes...'),
    log(1026, 12_600, 'info', 'Agent finished, committing changes...'),
    progress(1027, 'creating_pr', 'Creating pull request...'),
    log(1028, 14_000, 'info', 'Creating pull request...'),
    log(1029, 16_000, 'success', 'Pull request created', PR_URL),
    progress(1030, 'done', 'Pull request created', { prUrl: PR_URL, isCompareLink: false }),
  ]
}

/** The run's logs as `GET /api/tasks/:id/logs` returns them (no ids). */
export function legacyHistory(events = legacySuccessRun()) {
  return events.filter(([type]) => type === 'execution:log').map(([, data]) => data.entry)
}

/** A run cancelled by the user mid-tool (cancelTask broadcasts before the abort is confirmed). */
export function legacyCancelledRun() {
  const progress = progressAt
  const log = logAt
  return [
    progress(2001, 'cloning', 'Cloning repository...'),
    log(2002, 100, 'info', 'Repository cloned successfully'),
    log(2003, 200, 'info', 'Branch created: openlinear/kt-12-retry'),
    progress(2004, 'executing', 'Agent is thinking...'),
    log(2005, 1_000, 'tool', 'Running: pnpm install'),
    log(2006, 2_000, 'info', 'Execution cancelled by user'),
    progress(2007, 'cancelled', 'Execution cancelled'),
  ]
}

export const RUN_ID = 'run-7f3a'

function journal(seq, payload, extra = {}) {
  return [
    'execution:progress',
    { runId: RUN_ID, taskId: TASK_ID, seq, type: payload.t, payload, ...extra },
    { stream: 'cloud', id: `run:${RUN_ID}:${seq}` },
  ]
}

/** A v2 engine run journal (AgentEvent payloads). */
export function journalRun() {
  return [
    journal(1, { t: 'session.started', externalId: 'ses_1', model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } }),
    journal(2, { t: 'turn.started', turn: 1 }),
    journal(3, { t: 'reasoning.delta', text: 'Need to find ' }),
    journal(4, { t: 'reasoning.delta', text: 'the failing test.' }),
    journal(5, { t: 'tool.started', callId: 'c1', name: 'bash', input: { command: 'pnpm test --filter auth', description: 'Run auth tests' } }),
    journal(6, { t: 'tool.output', callId: 'c1', chunk: 'FAIL login.test.ts\n' }),
    journal(7, { t: 'tool.output', callId: 'c1', chunk: '1 failed, 11 passed\n' }),
    journal(8, { t: 'tool.finished', callId: 'c1', name: 'bash', ok: false, summary: 'exit 1' }),
    journal(9, { t: 'tool.started', callId: 'c2', name: 'edit', input: { filePath: '/repo/src/auth/login.ts', oldString: 'a', newString: 'b' } }),
    journal(10, { t: 'file.changed', path: 'src/auth/login.ts', kind: 'edit' }),
    journal(11, { t: 'tool.finished', callId: 'c2', name: 'edit', ok: true }),
    journal(12, { t: 'file.changed', path: 'src/auth/cookie.ts', kind: 'create' }),
    journal(13, { t: 'file.changed', path: 'src/auth/legacy.ts', kind: 'delete' }),
    journal(14, { t: 'message.delta', text: 'Fixed the ' }),
    journal(15, { t: 'message.delta', text: 'redirect bug.' }),
    journal(16, { t: 'usage', usage: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0, reasoning: 40 }, messageId: 'm1' }),
    journal(17, { t: 'turn.finished', turn: 1, reason: 'idle' }),
  ]
}

export function journalEvent(seq, payload, extra) {
  return journal(seq, payload, extra)
}

/**
 * A long, chatty run for the bounded-memory tests and the benchmark:
 * `count` log events cycling through tool starts/completions, assistant
 * text, file edits and occasional errors, with ids and timestamps.
 */
export function chattyRun(count, { startId = 10_000, outputChars = 600 } = {}) {
  const log = logAt
  const events = [progressAt(startId - 1, 'executing', 'Agent is thinking...')]
  const output = 'x'.repeat(outputChars)
  for (let i = 0; i < count; i++) {
    const id = startId + i
    const at = 1_000 + i * 250
    switch (i % 8) {
      case 0: events.push(log(id, at, 'tool', `Running: src/module-${i}.ts`)); break
      case 1: events.push(log(id, at, 'success', 'Completed: read', `${i}:${output}`)); break
      case 2: events.push(log(id, at, 'tool', 'Running: bash')); break
      case 3: events.push(log(id, at, 'success', 'Completed: bash', `${i}:${output}`)); break
      case 4: events.push(log(id, at, 'agent', `Step ${i}: looking at the next module and planning the change.`)); break
      case 5: events.push(log(id, at, 'success', `Edited file: src/module-${i % 400}.ts`)); break
      case 6: events.push(log(id, at, 'info', `Retrying: provider overloaded (${i})`)); break
      default: events.push(log(id, at, i % 64 === 7 ? 'error' : 'agent', i % 64 === 7 ? `Tool crashed at step ${i}` : `Thinking: considering step ${i}`)); break
    }
  }
  return events
}

// v2 run engine (apps/sidecar/src/run/service.ts): local SSE beats are
//   progress():          { status, message, ...data, taskId, runId, runSeq }
//   emitStateLocally():  { taskId, status: LEGACY_PROGRESS_STATUS[to], message: reason, runState: to, runId, runSeq }
// and the same beats relayed through the control plane carry runId/runSeq too,
// with a numeric outbox id on the cloud stream.
export const V2_RUN = 'run-v2-1'
const V2_STATUS = {
  queued: 'queued', preparing: 'cloning', running: 'executing', awaiting_approval: 'executing', compacting: 'executing',
  verifying: 'committing', finishing: 'committing', succeeded: 'done', failed: 'error', cancelled: 'cancelled',
  recovery_required: 'error', abandoned: 'error',
}

export function v2State(seq, runState, reason = runState, { runId = V2_RUN, cloudId = null } = {}) {
  return ['execution:progress', { taskId: TASK_ID, status: V2_STATUS[runState], message: reason, runState, runId, runSeq: seq },
    cloudId === null ? { stream: 'local' } : { stream: 'cloud', id: String(cloudId) }]
}

export function v2Beat(seq, status, message, extra = {}, { runId = V2_RUN, cloudId = null } = {}) {
  return ['execution:progress', { status, message, ...extra, taskId: TASK_ID, runId, runSeq: seq },
    cloudId === null ? { stream: 'local' } : { stream: 'cloud', id: String(cloudId) }]
}

/** A verified v2 run through every non-terminal state, ending in success. */
export function v2VerifiedRun({ runId = V2_RUN } = {}) {
  const o = { runId }
  return [
    v2State(1, 'queued', 'queued behind the parallel limit', o),
    v2State(2, 'preparing', 'accepted', o),
    v2Beat(3, 'cloning', 'Cloning repository...', {}, o),
    v2State(4, 'running', 'agent started', o),
    v2Beat(5, 'executing', 'Running: bash', {}, o),
    v2State(6, 'awaiting_approval', 'permission requested: edit', o),
    v2Beat(7, 'executing', 'Waiting for approval: edit', {}, o),
    v2State(8, 'running', 'permission granted', o),
    v2State(9, 'compacting', 'context compaction', o),
    v2State(10, 'running', 'compaction finished', o),
    v2State(11, 'verifying', 'agent turn completed; verifying the commit before publication', o),
    v2Beat(12, 'committing', 'Running check 1/2: Typecheck', { runState: 'verifying' }, o),
    v2State(13, 'finishing', 'verification passed', o),
    v2Beat(14, 'creating_pr', 'Creating pull request...', {}, o),
    v2State(15, 'succeeded', 'pull request created', o),
  ]
}
