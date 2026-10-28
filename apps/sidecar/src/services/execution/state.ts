import { logger } from '../../lib/logger';

import type { OpencodeClient } from '@opencode-ai/sdk';
import { cleanupDeltaBuffer, flushDeltaBuffer } from '../delta-buffer';
import { assertPathInsideReposDir, buildReposPath, REPOS_DIR } from '../repo-storage';
import { getSidecarStore, type AttemptContext, type TaskFence } from '../../persistence/store';
import { detachAttemptRelay, publishTaskEvent, registerTaskOwnerResolver } from '../../events/publisher';
import type { AttemptEventRelay } from '../../events/relay';

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface TaskLabelRelation {
  taskId: string;
  labelId: string;
  label: Label;
}

export { assertPathInsideReposDir, buildReposPath, REPOS_DIR };
export const TASK_TIMEOUT_MS = 30 * 60 * 1000;

// T11 (H-12) — execution log arrays were unbounded; a chatty two-hour run
// produces tens of thousands of entries held in memory for the run's full
// lifetime. Ring-buffer them: once the cap is hit, drop the oldest entries
// rather than growing forever. This is a bound, not a replacement for
// incremental persistence (out of scope for Phase 0 — no run journal yet).
export const MAX_EXECUTION_LOG_ENTRIES = 2_000;

// T11 (M-03) — `completedToolKeys` existed purely to dedupe a counter but
// grew without bound, each key up to ~1KB of tool output. Cap both the key
// length and the set size (evict oldest — Sets iterate in insertion order).
export const MAX_COMPLETED_TOOL_KEYS = 500;
export const COMPLETED_TOOL_KEY_SOURCE_LIMIT = 200;

export interface ExecutionState {
  /**
   * W03a: the attempt this execution persists through (API mode: holds the
   * run-scoped capability client). Absent only in legacy test fixtures.
   */
  attempt?: AttemptContext;
  /** Relay of this attempt's progress/log events to the control plane. */
  relay?: AttemptEventRelay;
  heartbeatTimer?: NodeJS.Timeout | null;
  /** The claim was refused: this execution never owned the task row. */
  claimRejected?: boolean;
  /** The claim succeeded: this execution owns the attempt and its cleanup closes it. */
  claimed?: boolean;
  /** Immutable snapshot title/description used for commit and PR text. */
  taskTitle?: string;
  taskDescription?: string | null;
  /** Repository the run publishes to, from the immutable snapshot. */
  publishRepository?: { fullName: string; defaultBranch: string } | null;
  cancelUnconfirmed?: boolean;
  finalizationPending?: boolean;
  taskStatusPersisted?: 'done' | 'cancelled';
  taskProjectId?: string | null;
  promptDispatched?: boolean;
  taskId: string;
  projectId: string;
  sessionId: string;
  repoPath: string;
  branchName: string;
  userId: string | null;
  accessToken: string | null;
  // T7 (H-02) — the task's routing metadata (immutable for the run) cached at
  // execution start so every log line and progress update can broadcast
  // synchronously instead of costing a Postgres round-trip each time.
  teamId: string | null;
  creatorId: string | null;
  timeoutId: NodeJS.Timeout;
  streamTimeoutId: NodeJS.Timeout | null;
  // T4 — no-progress watchdog timer, independent from the transport watchdog
  // above (`streamTimeoutId`). See services/execution/events.ts.
  progressTimeoutId: NodeJS.Timeout | null;
  // T4 — true while a permission reply is pending; both watchdogs are
  // suspended (not armed) during this window.
  watchdogSuspended: boolean;
  // T5 — set exactly once, by whichever finalization path (event-driven
  // completion, stream-failure handling, or cancelTask) claims it first.
  // Prevents the double-finalize race from `session.promptAsync`'s
  // `.catch()` racing the event stream.
  finalized: boolean;
  eventStreamCleanup?: () => Promise<void> | void;
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error';
  logs: ExecutionLogEntry[];
  client: OpencodeClient;
  startedAt: Date;
  filesChanged: number;
  toolsExecuted: number;
  promptSent: boolean;
  backgroundTaskRunning: boolean;
  backgroundTaskFailure: string | null;
  backgroundTaskIds: string[];
  backgroundTaskResultBuffer: string;
  completedToolKeys: Set<string>;
  cancelled: boolean;
  // T8: SDK `message.updated` reports per-message TOTALS (not deltas). Keep
  // the latest snapshot per assistant messageId; sum at finalize time.
  // Includes the cache-split and reasoning breakdowns, which are frequently
  // the majority of spend — held in memory only; `AgentRun` has no columns
  // for them yet (see agent-run.ts).
  agentRunId: string | null;
  cost: { input: number; output: number; total: number };
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  messageUsage: Map<string, {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
}

export interface ExecutionLogEntry {
  timestamp: string;
  type: 'info' | 'agent' | 'tool' | 'error' | 'success';
  message: string;
  details?: string;
}

export interface ExecuteTaskParams {
  taskId: string;
  userId?: string;
  /** The request principal's credential (W03a). Memory only. */
  credential?: import('../../auth/principal').PrincipalCredential | null;
  /** W17a: run although blockers are open (else 409 TASK_BLOCKED). */
  allowBlocked?: boolean;
}

export interface PullRequestResult {
  url: string;
  type: 'pr' | 'compare';
}

// --- ExecutionStateStore: encapsulates global execution state ---

export class ExecutionStateStore {
  private executions = new Map<string, ExecutionState>();
  private sessionToTaskMap = new Map<string, string>();

  get(taskId: string): ExecutionState | undefined {
    return this.executions.get(taskId);
  }

  has(taskId: string): boolean {
    return this.executions.has(taskId);
  }

  set(taskId: string, state: ExecutionState): void {
    this.executions.set(taskId, state);
    this.sessionToTaskMap.set(state.sessionId, taskId);
  }

  getBySession(sessionId: string): ExecutionState | undefined {
    const taskId = this.sessionToTaskMap.get(sessionId);
    if (taskId) return this.executions.get(taskId);
    /* v8 ignore start -- fallback scan: unreachable via public API. */
    for (const [tid, execution] of this.executions.entries()) {
      if (execution.sessionId === sessionId) {
        this.sessionToTaskMap.set(sessionId, tid);
        return execution;
      }
    }
    /* v8 ignore stop */
    return undefined;
  }

  getTaskIdBySession(sessionId: string): string | undefined {
    const taskId = this.sessionToTaskMap.get(sessionId);
    if (taskId) return taskId;
    /* v8 ignore start -- fallback scan: unreachable via public API. */
    for (const [tid, execution] of this.executions.entries()) {
      if (execution.sessionId === sessionId) {
        this.sessionToTaskMap.set(sessionId, tid);
        return tid;
      }
    }
    /* v8 ignore stop */
    return undefined;
  }

  remove(taskId: string): void {
    const execution = this.executions.get(taskId);
    if (execution) {
      this.sessionToTaskMap.delete(execution.sessionId);
    }
    this.executions.delete(taskId);
  }

  count(): number {
    return this.executions.size;
  }

  reset(): void {
    this.executions.clear();
    this.sessionToTaskMap.clear();
  }

  setSessionMapping(sessionId: string, taskId: string): void {
    this.sessionToTaskMap.set(sessionId, taskId);
  }

  entries(): IterableIterator<[string, ExecutionState]> {
    return this.executions.entries();
  }

  values(): IterableIterator<ExecutionState> {
    return this.executions.values();
  }

  sessionEntries(): IterableIterator<[string, string]> {
    return this.sessionToTaskMap.entries();
  }
}

/** Singleton store instance — import this instead of raw Maps */
export const executionStore = new ExecutionStateStore();

// --- Backward-compatible exports (delegate to store) ---

/**
 * @deprecated Use executionStore directly.
 * Proxy that delegates Map operations to the ExecutionStateStore singleton.
 */
export const pendingExecutions = new Set<string>();
/** Owner (initiating user) of each pending execution, for local event delivery. */
export const pendingExecutionOwners = new Map<string, string>();
export const activeExecutions: Map<string, ExecutionState> = new Proxy(new Map<string, ExecutionState>(), {
  get(_target, prop: string | symbol) {
    switch (prop) {
      case 'get': return (key: string) => executionStore.get(key);
      case 'has': return (key: string) => executionStore.has(key);
      case 'set': return (key: string, value: ExecutionState) => { executionStore.set(key, value); return activeExecutions; };
      case 'delete': return (key: string) => { executionStore.remove(key); return true; };
      case 'clear': return () => { executionStore.reset(); };
      case 'size': return executionStore.count();
      case 'entries': return () => executionStore.entries();
      case 'values': return () => executionStore.values();
      case 'keys': return () => {
        const keys: string[] = [];
        for (const [k] of executionStore.entries()) keys.push(k);
        return keys[Symbol.iterator]();
      };
      case 'forEach': return (fn: (value: ExecutionState, key: string, map: Map<string, ExecutionState>) => void) => {
        for (const [k, v] of executionStore.entries()) fn(v, k, activeExecutions);
      };
      case Symbol.iterator: return () => executionStore.entries();
      case Symbol.toStringTag: return 'Map';
      default: return undefined;
    }
  },
}) as unknown as Map<string, ExecutionState>;

/**
 * @deprecated Use executionStore directly.
 * Proxy that delegates to ExecutionStateStore for session→task lookups.
 */
export const sessionToTask: Map<string, string> = new Proxy(new Map<string, string>(), {
  get(_target, prop: string | symbol) {
    switch (prop) {
      case 'get': return (sessionId: string) => executionStore.getTaskIdBySession(sessionId);
      case 'set': return (sessionId: string, taskId: string) => {
        executionStore.setSessionMapping(sessionId, taskId);
        return sessionToTask;
      };
      case 'delete': return (_sessionId: string) => {
        // no-op: managed by executionStore.remove()
        return true;
      };
      case 'clear': return () => { executionStore.reset(); };
      case 'has': return (sessionId: string) => executionStore.getTaskIdBySession(sessionId) !== undefined;
      case Symbol.iterator: return () => executionStore.sessionEntries();
      case Symbol.toStringTag: return 'Map';
      default: return undefined;
    }
  },
}) as unknown as Map<string, string>;

export function getRunningTaskCount(): number {
  return executionStore.count();
}

export function isTaskRunning(taskId: string): boolean {
  return executionStore.has(taskId);
}

export function getExecutionStatus(taskId: string): ExecutionState | undefined {
  return executionStore.get(taskId);
}

/** The initiating user of a task's single execution (active or still preparing). */
export function singleExecutionOwner(taskId: string): string | null {
  return executionStore.get(taskId)?.userId ?? pendingExecutionOwners.get(taskId) ?? null;
}

registerTaskOwnerResolver(singleExecutionOwner);

function scheduleTaskBroadcast(taskId: string, event: string, payload: Record<string, unknown>): void {
  // W03a — no per-event database or cloud lookup: local streams of the run's
  // owner get the event synchronously, and the attempt's bounded relay
  // forwards progress/log events to the control plane (which retries and
  // re-authorizes every cloud subscriber). Critical progress (done, error,
  // cancelled) is flushed immediately and kept preferentially by the relay.
  publishTaskEvent(taskId, event, payload);
}

export function broadcastProgress(taskId: string, status: string, message: string, data?: Record<string, unknown>) {
  logger.info(`[Execution] ${taskId.slice(0, 8)} → ${status}: ${message}`);
  scheduleTaskBroadcast(taskId, 'execution:progress', { taskId, status, message, ...data });
}

// --- T10 (M-13) — secret redaction ---
//
// Applied once, here, before a log entry reaches `execution.logs` (and
// therefore the SSE broadcast and the `tasks.executionLogs` JSONB column —
// every sink reads from the same array). Redaction is stateful *per task*
// across calls: a token split across two `addLogEntry` calls (e.g. a
// streamed tool-output chunk cut mid-secret) must still be caught, so a
// short tail of the previous (already-redacted) call is carried forward and
// re-scanned together with the next chunk.

const REDACTED = '[REDACTED]';
// Longest fixed-prefix/shape pattern below, rounded up — sized so a secret
// split across the boundary of two calls still lands fully inside the
// combined (carry + next chunk) scan window.
const REDACT_CARRY_LEN = 64;

const SECRET_PATTERNS: RegExp[] = [
  // Provider / VCS token prefixes.
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenLinear credentials: PATs and W03a attempt capabilities.
  /\bol_pat_[0-9a-f]{20,}\b/g,
  /\bolx_[A-Za-z0-9_-]{20,}/g,
  // JWTs (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // DB connection strings with embedded credentials.
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
  // Bearer auth headers.
  /\bAuthorization:\s*Bearer\s+\S+/gi,
  // Userinfo credentials embedded in a URL (e.g. https://user:TOKEN@host/...).
  /\bhttps?:\/\/[^\s"'<>/]*:[^\s"'<>@]{6,}@/gi,
  // Known-sensitive env-style `NAME=value` / `NAME: value` assignments.
  /\b(?:[A-Z0-9_]*_)?(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*[=:]\s*\S+/g,
  /\b(?:DATABASE_URL|JWT_SECRET|TOKEN_ENCRYPTION_KEY|GITHUB_CLIENT_SECRET|GITHUB_TOKEN|GITHUB_CLIENT_ID)\s*[=:]\s*\S+/g,
  // URL-encoded runs (likely an encoded secret/query value).
  /%[0-9A-Fa-f]{2}(?:[0-9A-Za-z%._-]){10,}/g,
  // Generic high-entropy tokens: long base64 or hex runs.
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  /\b[0-9a-fA-F]{32,}\b/g,
];

function scrubSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Stateless redaction of one string (the run journal applies it before persisting agent output). */
export function redactSecrets(input: string): string {
  return scrubSecrets(input);
}

const redactionCarry = new Map<string, string>();

function redactForTask(taskId: string, text: string | undefined): string | undefined {
  // `details` is typed as `string | undefined`, but is stored verbatim
  // (never coerced) elsewhere in this file, so defend against a caller that
  // hands in something else at runtime rather than throwing.
  if (text === undefined || typeof text !== 'string' || text.length === 0) return text;

  const carry = redactionCarry.get(taskId) || '';
  redactionCarry.set(taskId, text.slice(-REDACT_CARRY_LEN));

  if (!carry) return scrubSecrets(text);

  const scrubbedCombined = scrubSecrets(carry + text);
  const scrubbedCarryAlone = scrubSecrets(carry);
  // No secret spans the carry/chunk boundary: the combined scrub is exactly
  // "scrubbed carry" + "this chunk, scrubbed on its own" — return just the
  // chunk's portion.
  if (scrubbedCombined.startsWith(scrubbedCarryAlone)) {
    return scrubbedCombined.slice(scrubbedCarryAlone.length);
  }
  // A pattern matched across the boundary. The carry's characters were
  // already emitted in the previous call and cannot be retroactively
  // redacted, but we must not let this call complete the leak — redact the
  // entire visible remainder rather than guess at an index split.
  return REDACTED;
}

/** Clears per-task redaction carry state. Call on cleanup to avoid a leak. */
export function clearRedactionState(taskId: string): void {
  redactionCarry.delete(taskId);
}

export function addLogEntry(taskId: string, type: ExecutionLogEntry['type'], message: string, details?: string) {
  const execution = executionStore.get(taskId);
  if (!execution) {
    logger.info(`[Execution] Warning: No execution found for task ${taskId.slice(0, 8)} when adding log`);
    return;
  }

  const safeMessage = redactForTask(taskId, message) ?? message;
  const safeDetails = redactForTask(`${taskId}:details`, details);

  const entry: ExecutionLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    message: safeMessage,
    details: safeDetails,
  };

  execution.logs.push(entry);
  // T11 (H-12) — ring-buffer the log array rather than letting it grow
  // without bound for the run's full lifetime.
  if (execution.logs.length > MAX_EXECUTION_LOG_ENTRIES) {
    execution.logs.splice(0, execution.logs.length - MAX_EXECUTION_LOG_ENTRIES);
  }

  const emoji = type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'tool' ? '🔧' : type === 'agent' ? '🤖' : '→';
  const detailStr = typeof safeDetails === 'string' ? safeDetails : safeDetails ? JSON.stringify(safeDetails) : undefined;
  logger.info(`[Execution] ${taskId.slice(0, 8)} ${emoji} ${safeMessage}${detailStr ? ` (${detailStr.slice(0, 50)})` : ''}`);

  scheduleTaskBroadcast(taskId, 'execution:log', { taskId, entry });
}

export function getExecutionLogs(taskId: string): ExecutionLogEntry[] {
  const execution = executionStore.get(taskId);
  return execution?.logs || [];
}

export async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'done' | 'cancelled',
  sessionId: string | null,
  executionData?: {
    executionStartedAt?: Date;
    executionPausedAt?: Date | null;
    executionElapsedMs?: number;
    executionProgress?: number | null;
    prUrl?: string | null;
    outcome?: string | null;
  },
  expectedExecution?: ExecutionState,
): Promise<void> {
  try {
    if (expectedExecution && activeExecutions.get(taskId) !== expectedExecution) {
      throw new Error('Execution no longer owns task status');
    }
    const execution = expectedExecution ?? activeExecutions.get(taskId);
    if (status !== 'in_progress' && execution?.taskStatusPersisted === status) return;
    // The fence (session + in_progress + captured project/team/creator) is
    // applied by the store: directly in Prisma mode, server-side against the
    // attempt's recorded bindings in API mode.
    const store = await getSidecarStore();
    const task = await store.writeTaskStatus(execution?.attempt ?? null, {
      taskId,
      status,
      sessionId,
      executionData,
      fence: execution ? fenceOf(execution) : null,
    });
    if (execution && status !== 'in_progress') execution.taskStatusPersisted = status;

    if (task) {
      try { publishTaskEvent(taskId, 'task:updated', task, { ownerUserId: execution?.userId ?? null }); }
      catch (error) { logger.warn({ err: error, taskId }, '[Execution] Task status persisted; notification failed'); }
    }
  } catch (error) {
    logger.error({ err: error, taskId }, `[Execution] Failed to update task ${taskId}`);
    throw error;
  }
}

/** The W01 fence of an execution's writes. */
export function fenceOf(execution: ExecutionState): TaskFence {
  return {
    sessionId: execution.sessionId,
    ...(execution.taskProjectId !== undefined ? { projectId: execution.taskProjectId } : {}),
    teamId: execution.teamId,
    creatorId: execution.creatorId,
    ...(execution.taskStatusPersisted ? { terminalStatus: execution.taskStatusPersisted } : {}),
  };
}

export function estimateProgress(execution: ExecutionState): number {
  const baseProgress = Math.min(execution.toolsExecuted * 5, 40);
  const fileProgress = Math.min(execution.filesChanged * 10, 30);
  const elapsedMinutes = (Date.now() - execution.startedAt.getTime()) / 60000;
  const timeProgress = Math.min(elapsedMinutes * 3, 20);
  return Math.min(Math.round(baseProgress + fileProgress + timeProgress), 95);
}

export async function persistLogs(taskId: string, expectedExecution?: ExecutionState): Promise<void> {
  const execution = expectedExecution ?? executionStore.get(taskId);
  if (expectedExecution && executionStore.get(taskId) !== expectedExecution) return;
  if (!execution || execution.logs.length === 0) return;
  try {
    const store = await getSidecarStore();
    await store.persistLogs(execution.attempt ?? null, { taskId, logs: execution.logs, fence: fenceOf(execution) });
  } catch (error) {
    logger.error({ err: error, taskId }, `[Execution] Failed to persist logs for task ${taskId.slice(0, 8)}`);
  }
}

/**
 * End the attempt's control-plane lifecycle: stop the heartbeat, drain the
 * event relay (bounded), and revoke the capability. Idempotent; never throws.
 */
export async function closeExecutionAttempt(execution: ExecutionState, reason?: string): Promise<void> {
  if (execution.heartbeatTimer) {
    clearInterval(execution.heartbeatTimer);
    execution.heartbeatTimer = null;
  }
  const relay = execution.relay;
  if (relay) {
    execution.relay = undefined;
    try { await relay.close(); }
    catch (error) { logger.warn({ err: error, taskId: execution.taskId }, '[Execution] event relay did not drain'); }
    detachAttemptRelay(execution.taskId, relay);
  }
  const attempt = execution.attempt;
  if (!attempt || attempt.closed) return;
  try {
    const store = await getSidecarStore();
    await store.closeAttempt(attempt, reason);
  } catch (error) {
    logger.warn({ err: error, taskId: execution.taskId }, '[Execution] attempt close failed; capability expires on its own');
  }
}

export async function cleanupExecution(taskId: string, expectedExecution?: ExecutionState): Promise<void> {
  const execution = expectedExecution ?? executionStore.get(taskId);
  if (expectedExecution && executionStore.get(taskId) !== expectedExecution) return;
  if (execution) {
    flushDeltaBuffer(taskId);
    cleanupDeltaBuffer(taskId);
    clearRedactionState(taskId);
    clearRedactionState(`${taskId}:details`);
    clearTimeout(execution.timeoutId);
    if (execution.streamTimeoutId) {
      clearTimeout(execution.streamTimeoutId);
      execution.streamTimeoutId = null;
    }
    if (execution.progressTimeoutId) {
      clearTimeout(execution.progressTimeoutId);
      execution.progressTimeoutId = null;
    }
    if (execution.eventStreamCleanup) {
      try {
        await execution.eventStreamCleanup();
      } catch (error) {
        logger.error({ err: error, taskId }, `[Execution] Failed to clean up event stream for task ${taskId.slice(0, 8)}`);
      }
      execution.eventStreamCleanup = undefined;
    }
    if (executionStore.get(taskId) !== execution) return;
    executionStore.remove(taskId);
    execution.accessToken = null;
    await closeExecutionAttempt(execution);
    logger.info(`[Execution] Cleaned up task ${taskId.slice(0, 8)}, remaining: ${executionStore.count()}`);
  }
}

/** Title from the immutable start snapshot (no database read). */
export async function getTaskTitle(taskId: string): Promise<string> {
  return executionStore.get(taskId)?.taskTitle || 'Task';
}

export function findTaskBySessionId(sessionId: string): string | undefined {
  return executionStore.getTaskIdBySession(sessionId);
}
