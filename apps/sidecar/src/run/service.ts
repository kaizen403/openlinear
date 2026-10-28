import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionEvent, ExecutionLogEntry, ExecutionRunInput, ExecutionTerminalInput } from '@openlinear/api-client';
import {
  AGENT_RUN_STATES,
  LEGACY_PROGRESS_STATUS,
  RUN_STATES,
  RunTransitionError,
  admitRunRequest,
  buildFollowUpPrompt,
  decideRunRecovery,
  describeSetupStep,
  describeVerification,
  isTerminalRunState,
  manifestRequiresVerification,
  processAgentEvent,
  resolveSetupPlan,
  resolveVerificationManifest,
  runEffectKey,
  setupFailureOutcome,
  setupStepHash,
  verificationPublicationDecision,
  type AgentAction,
  type AgentEvent,
  type AgentSession,
  type ControlAttemptStatus,
  type ControlPlaneProbe,
  type EventProcessorState,
  type FollowUpMode,
  type FollowUpRequest,
  type RunEffectKind,
  type RunEffectRecord,
  type RunRecoveryDecision,
  type RunState,
  type RuntimeProbe,
  type VerificationCheckResult,
  type VerificationEnvironment,
  type VerificationManifest,
  type VerificationResult,
} from '@openlinear/execution-core';
import type { ExecutionVerificationInput } from '@openlinear/api-client';
import type { PrincipalCredential } from '../auth/principal';
import { resolveAgentId } from '../engine/resolve-agent';
import { EXECUTION_SYSTEM_CONTRACT } from '../engine/system-contract';
import {
  approvalDeadlineExceeded,
  checkWatchdogs,
  createWatchdogState,
  defaultBudgets,
  touchProgress,
  touchTransport,
  type WatchdogBudgets,
  type WatchdogState,
  type WatchdogTrip,
} from '../engine/watchdogs';
import type { AppendInput, DurableRunJournal, EffectIntent, RunRecord } from '../journal/durable';
import { HttpError, isHttpError } from '../lib/errors';
import { SandboxUnavailableError } from '../sandbox/errors';
import { logger } from '../lib/logger';
import { redactSecrets } from '../services/execution/state';
import {
  isAuthorityLost,
  isTransientControlError,
  type AttemptChannel,
  type ControlPlane,
} from './control-plane';
import { ApprovalBroker, DEFAULT_APPROVAL_TIMEOUT_MS, type ApprovalDecision, type ApprovalOutcome, type ApprovalScope, type PendingApproval } from './approvals';
import { describeContextReceipt, repositoryKeyFor, type RepositoryContextInput, type RepositoryContextResult } from '../context';
import type { FaultHook } from './faults';
import { runPhaseTimings, type RunPhaseTimings } from './phases';
import type { ReviewSubjectResult } from './reviewer';
import type { PublicationPort } from './publication';
import type { RunRuntime, StartedRuntimeSession } from './runtime';
import { changedPaths, createLocalSetup, type SetupPort, type WorktreeFingerprint } from './setup';
import {
  emptyCounters,
  setupStepRecordSchema,
  sumUsage,
  verificationResultSchema,
  type RunFollowUp,
  type RunTerminal,
  type RunUsage,
  type RunWorkspace,
  type SetupStepRecord,
} from './types';
import type { VerificationPort, VerificationProgress } from './verification';
import type { WorkspacePort } from './workspace';
import { appReposDir } from '../workspace/local-worktree';
import { sweepRetainedWorktrees, type RetentionPolicy, type RetentionSweepReport } from '../workspace/retention';

/**
 * W05a/W06a — one durable run service for single-task execution.
 *
 * Drives one control-plane attempt through
 *   queued → preparing → running ↔ awaiting_approval/compacting → finishing → terminal
 * with the SQLite journal as the local source of truth (see
 * `@openlinear/execution-core` run-contract for the state machine, effect
 * ledger and recovery policy, and docs/reports/revamp-2026-10-26/runengine.md).
 *
 * Invariants enforced here:
 * - durable acceptance before execute is acknowledged (`journal.createRun`);
 * - every runner event is journaled with a sequence before it is relayed to
 *   the control plane (`/attempts/:id/events`, keyed by that sequence) or
 *   delivered to local SSE;
 * - every external effect is journaled (intent) before dispatch and settled
 *   (receipt) after; recovery reconciles pending effects;
 * - every reducer action is handled (exhaustive switch);
 * - exactly one terminal decision (journal compare-and-set), and the local
 *   reservation is released in a `finally` whatever await failed.
 */

export type TerminalRunState = Extract<RunState, 'succeeded' | 'failed' | 'cancelled' | 'recovery_required' | 'abandoned'>;

export interface RunEventSink {
  publish(taskId: string, ownerUserId: string, event: string, payload: Record<string, unknown>): void;
}

export interface RunServiceOptions {
  heartbeatMs: number;
  /** Renew the capability when it expires sooner than this. */
  renewBeforeMs: number;
  maxQueued: number;
  /** How long execute waits for the run to start (claim + prompt journaled) before answering 202. */
  startWaitMs: number;
  /** Cancellation: interrupt, wait this long, then abort. */
  interruptGraceMs: number;
  /** Positive stop receipt attempts before a cancellation is reported unconfirmed. */
  abortAttempts: number;
  relayDelayMs: number;
  relayRetryBaseMs: number;
  relayRetryMaxMs: number;
  /** Retry interval for control-plane effects and recovery while the API is unreachable. */
  retryBaseMs: number;
  retryMaxMs: number;
  watchdog: WatchdogBudgets;
  watchdogIntervalMs: number;
  permissionPolicy: 'allow' | 'deny';
  /** FE-04: how long a permission request waits for the person in "ask" mode before it is denied. */
  approvalTimeoutMs: number;
  /** Finished runs are pruned from the journal after this long. */
  retentionMs: number;
  logRing: number;
}

export function defaultRunServiceOptions(env: NodeJS.ProcessEnv = process.env): RunServiceOptions {
  const heartbeat = Number.parseInt(env.OPENLINEAR_ATTEMPT_HEARTBEAT_MS ?? '', 10);
  return {
    heartbeatMs: Number.isFinite(heartbeat) ? Math.min(Math.max(heartbeat, 1_000), 300_000) : 30_000,
    renewBeforeMs: 30 * 60_000,
    maxQueued: 10,
    startWaitMs: 60_000,
    interruptGraceMs: env.NODE_ENV === 'test' ? 0 : 5_000,
    abortAttempts: 3,
    relayDelayMs: 200,
    relayRetryBaseMs: 500,
    relayRetryMaxMs: 15_000,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
    watchdog: defaultBudgets(),
    watchdogIntervalMs: 1_000,
    permissionPolicy: 'allow',
    approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    retentionMs: 14 * 24 * 60 * 60_000,
    logRing: 2_000,
  };
}

export interface RunServiceDeps {
  journal: DurableRunJournal;
  controlPlane: ControlPlane;
  runtimes: ReadonlyMap<string, RunRuntime>;
  publication: PublicationPort;
  workspace: WorkspacePort;
  events?: RunEventSink;
  faults?: FaultHook | null;
  /** Task without a model: the runtime's default model, or a problem that blocks execution. */
  modelPreflight?: (userId: string) => Promise<{ model: string | null; problem: string | null }>;
  /**
   * W11a: check resolution (before the prompt) and execution (after the
   * candidate commit). Absent = no verification step (runs go
   * running → finishing exactly as before W11a).
   */
  verification?: VerificationPort;
  /**
   * W16a: runs the project's environment setup steps in the worktree before
   * the agent starts. Absent = the local sandboxed executor (created on the
   * first run that has setup steps).
   */
  setup?: SetupPort;
  /** W16b: bounded "Repository context" for the prompt (relevant files at the base commit). Absent = no section. Never throws. */
  repositoryContext?: (input: RepositoryContextInput) => Promise<RepositoryContextResult>;
  /** W11a: where retained worktrees live (`<repos>`; the sweep scans `<repos>/worktrees`). */
  reposRoot?: () => string;
  options?: Partial<RunServiceOptions>;
  bootId?: string;
  now?: () => number;
}

export interface SubmitResult {
  runId: string;
  attemptId: string | null;
  state: RunState;
}

export interface CancelResult {
  success: boolean;
  error?: string;
  state?: RunState;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const result: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: (value) => {
      if (result.settled) return;
      result.settled = true;
      resolve(value);
    },
    reject: (error) => {
      if (result.settled) return;
      result.settled = true;
      reject(error);
    },
    settled: false,
  };
  result.promise.catch(() => undefined);
  return result;
}

type PumpInterrupt = { kind: 'cancel' } | { kind: 'abandon'; reason: string } | { kind: 'watchdog'; trip: WatchdogTrip | { kind: 'approval-timeout' } };

type PumpOutcome =
  | { kind: 'finished' }
  | { kind: 'failed'; reason: string; detail?: string }
  | { kind: 'cancelled' }
  | { kind: 'abandoned'; reason: string }
  /** W07a: the runner could not confirm a requested stop (`cancel_unconfirmed`). */
  | { kind: 'unconfirmed-stop'; detail: string };

/** W16a: a required setup step failed; the terminal decision is already journaled. */
class SetupFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupFailed';
  }
}

class RunSignal extends Error {
  constructor(readonly signal: 'cancel' | 'abandon', message: string) {
    super(message);
    this.name = 'RunSignal';
  }
}

class ServiceStopped extends Error {
  constructor() {
    super('Run service stopped');
    this.name = 'ServiceStopped';
  }
}

interface ActiveRun {
  runId: string;
  taskId: string;
  userId: string;
  record: RunRecord;
  channel: AttemptChannel | null;
  runtime: RunRuntime | null;
  session: AgentSession | null;
  controller: AbortController;
  claimed: boolean;
  parallelLimit: number;
  cancelRequested: boolean;
  abandonReason: string | null;
  interrupt: Deferred<PumpInterrupt>;
  cancelWaiters: Array<(result: CancelResult) => void>;
  heartbeat: NodeJS.Timeout | null;
  heartbeatBusy: boolean;
  logs: ExecutionLogEntry[];
  text: string;
  reasoning: string;
  reducer: EventProcessorState;
  watchdog: WatchdogState;
  approvalSince: number | null;
  /** FE-04: tools the owner allowed for the rest of this run (not asked again). */
  allowedTools: Set<string>;
  started: Deferred<SubmitResult>;
  done: Deferred<RunRecord>;
}

/**
 * Control-plane projections, in dispatch order. W11a: verification evidence
 * goes first — it needs the attempt open, and the capability dies at close.
 */
const CONTROL_EFFECT_ORDER: readonly RunEffectKind[] = ['verification.record', 'cancel.ack', 'task.terminal', 'run.finalize', 'attempt.close'];

/** W11a: the run-state view of verification (consumed by the desktop review checks panel). */
export interface RunVerificationView {
  status: 'passed' | 'failed' | 'error' | 'skipped' | 'running' | 'pending';
  /** The commit the checks ran (or run) against; evidence is bound to it. */
  commit: string | null;
  runId: string;
  checksHash: string | null;
  policy: VerificationManifest['policy'] | null;
  source: VerificationManifest['source'] | null;
  publication: 'allowed' | 'blocked' | null;
  checks: Array<{ id: string; name: string; required: boolean; status: 'passed' | 'failed' | 'error' | 'skipped' | 'running' | 'pending'; summary: string }>;
  environment: VerificationEnvironment | null;
  warnings: string[];
  detail: string | null;
  finishedAt: string | null;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

function checkSummary(check: VerificationCheckResult): string {
  if (check.status === 'timed_out') return check.detail ?? 'timed out';
  if (check.status === 'error' || check.status === 'skipped') return check.detail ?? check.status;
  const exit = check.exitCode === null ? `terminated (${check.signal ?? 'signal'})` : `exit ${check.exitCode}`;
  return `${exit} · ${formatDuration(check.durationMs)}${check.required ? '' : ' · informational'}`;
}

function viewCheckStatus(status: VerificationCheckResult['status']): RunVerificationView['checks'][number]['status'] {
  return status === 'timed_out' ? 'failed' : status;
}

/** Evidence body for the control plane: bounded, no local paths. */
export function verificationEvidence(result: VerificationResult, runId: string, publication: 'allowed' | 'blocked'): ExecutionVerificationInput {
  return {
    runId,
    commitSha: result.commitSha,
    baseSha: result.baseCommit,
    checksHash: result.checksHash,
    policy: result.policy,
    status: result.status,
    publication,
    source: result.source,
    runner: result.runner.slice(0, 64),
    environment: result.environment,
    checks: result.checks.map((check) => ({
      id: check.id,
      name: check.name,
      required: check.required,
      status: check.status,
      exitCode: check.exitCode,
      signal: check.signal,
      durationMs: check.durationMs,
      network: check.network,
      command: check.command,
      logSha256: check.log.sha256,
      logBytes: check.log.bytes,
      logTruncated: check.log.truncated,
      logTail: check.log.tail,
      detail: check.detail,
    })),
    warnings: result.warnings.slice(0, 20).map((warning) => warning.slice(0, 500)),
    detail: result.detail ? result.detail.slice(0, 1_000) : null,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}
const MAX_TEXT_BUFFER = 4_000;
const MAX_LOG_MESSAGE = 8_000;
const MAX_LOG_DETAILS = 16_000;
const MAX_PROGRESS_FIELD = 2_000;

/**
 * W19b: the project knowledge section of the first prompt — written or
 * approved by the team, so it is guidance (unlike repository content), but
 * it never overrides the execution contract or the task itself.
 */
export function projectKnowledgeSection(entries: ReadonlyArray<{ kind: string; title: string; body: string }>): string | null {
  if (entries.length === 0) return null;
  const items = entries.map((entry) => `### ${entry.title} (${entry.kind})\n${entry.body.trim()}`);
  return ['## Project knowledge', 'Written or approved by the team for this project. Follow it unless the task says otherwise.', '', ...items.flatMap((item) => [item, ''])].join('\n').trimEnd();
}

/** FE-04: the run log line for an answered approval request. */
function approvalLogLine(tool: string, outcome: ApprovalOutcome): string {
  if (outcome.by === 'user' && outcome.decision === 'allow' && outcome.scope === 'run') return `Approved for the rest of this run: ${tool}`;
  if (outcome.by === 'user') return `${outcome.decision === 'allow' ? 'Approved' : 'Denied'}: ${tool}`;
  if (outcome.by === 'timeout') return `Denied (no answer in time): ${tool}`;
  if (outcome.by === 'withdrawn') return `Withdrawn by the agent (no answer needed): ${tool}`;
  return `Denied (run stopping): ${tool}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  return isHttpError(error) ? error.code : null;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value.length > MAX_LOG_DETAILS ? `${value.slice(0, MAX_LOG_DETAILS)}…` : value);
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, redactValue(item, depth + 1)]));
}

function agentEventPayload(event: AgentEvent): Record<string, unknown> {
  const redacted = redactValue(event);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? Object.fromEntries(Object.entries(redacted)) : { t: event.t };
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_PROGRESS_FIELD);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

export class RunService {
  readonly bootId: string;
  private readonly journal: DurableRunJournal;
  private readonly cp: ControlPlane;
  private readonly options: RunServiceOptions;
  private readonly now: () => number;
  /** taskId → runId: held from submit until the terminal decision. */
  private readonly reservations = new Map<string, string>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly settledListeners = new Set<(record: RunRecord) => void>();
  /** Runs holding a slot (preparing … finishing). */
  private readonly active = new Set<string>();
  private readonly queue: string[] = [];
  private readonly projections = new Map<string, Promise<void>>();
  private readonly relays = new Map<string, { inFlight: Promise<void> | null; timer: NodeJS.Timeout | null; failures: number }>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private parallelLimit = 3;
  private localSetup: SetupPort | null = null;
  /** FE-04: permission requests waiting for the person who started the run. */
  private readonly approvals: ApprovalBroker;
  /** Other users of `<repos>/verify` entries (W19a reviews) the retention sweep must keep. */
  private readonly activeCheckouts = new Set<(entry: string) => boolean>();

  constructor(private readonly deps: RunServiceDeps) {
    this.journal = deps.journal;
    this.cp = deps.controlPlane;
    this.options = { ...defaultRunServiceOptions(), ...deps.options };
    this.now = deps.now ?? Date.now;
    this.bootId = deps.bootId ?? randomUUID();
    this.approvals = new ApprovalBroker({
      now: this.now,
      onChange: (approval, outcome) => this.deps.events?.publish(approval.taskId, approval.ownerUserId, 'approval:changed', {
        taskId: approval.taskId,
        runId: approval.runId,
        approvalId: approval.id,
        state: outcome ? (outcome.decision === 'allow' ? 'allowed' : 'denied') : 'pending',
        ...(outcome ? { by: outcome.by } : {}),
      }),
    });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  isRunning(taskId: string): boolean {
    return this.reservations.has(taskId);
  }

  ownerOf(taskId: string): string | null {
    const runId = this.reservations.get(taskId);
    return runId ? this.runs.get(runId)?.userId ?? null : null;
  }

  /**
   * W19a: what an independent reviewer reviews — the task's newest run once
   * it has finished, with its worktree (the reviewer clones its HEAD) and
   * base commit.
   */
  reviewSubject(taskId: string): ReviewSubjectResult {
    if (this.reservations.has(taskId)) return { ok: false, status: 409, code: 'REVIEW_RUN_ACTIVE', message: 'The task is still running; review it when the run has finished' };
    const record = this.journal.latestForTask(taskId);
    if (!record) return { ok: false, status: 404, code: 'RUN_NOT_FOUND', message: 'No run of this task is recorded on this device' };
    if (!isTerminalRunState(record.state)) return { ok: false, status: 409, code: 'REVIEW_RUN_ACTIVE', message: 'The task\'s run has not finished yet' };
    if (!record.workspace) return { ok: false, status: 409, code: 'REVIEW_WORKSPACE_GONE', message: 'The run has no checkout to review' };
    return {
      ok: true,
      subject: {
        runId: record.runId,
        userId: record.userId,
        runner: record.runner,
        model: record.snapshot.model,
        worktreePath: record.workspace.worktreePath,
        baseCommit: record.workspace.baseCommit ?? null,
        task: { title: record.snapshot.title, description: record.snapshot.description, labels: record.snapshot.labels },
        maxUsd: record.snapshot.budgets?.maxUsd ?? null,
      },
    };
  }

  /** W19a: checkouts outside the journal (agent reviews) that the retention sweep must not remove while in use. */
  registerActiveCheckouts(inUse: (entry: string) => boolean): void {
    this.activeCheckouts.add(inUse);
  }

  /** FE-04: a task's pending permission requests, as their owner sees them (nobody else does). */
  pendingApprovals(taskId: string, userId: string): Array<PendingApproval & { taskTitle: string | null }> {
    return this.approvals.pendingFor(taskId)
      .filter((approval) => approval.ownerUserId === userId)
      .map((approval) => ({ ...approval, taskTitle: this.runs.get(approval.runId)?.record.snapshot.title ?? null }));
  }

  /** FE-04: every request waiting on this user, oldest first (approval inbox). */
  approvalsWaitingOn(userId: string): Array<PendingApproval & { taskTitle: string | null }> {
    const taskIds = new Set([...this.runs.values()].filter((run) => run.userId === userId).map((run) => run.taskId));
    return [...taskIds]
      .flatMap((taskId) => this.pendingApprovals(taskId, userId))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** FE-04: the owner's answer to the operation they were shown (see ApprovalBroker.decide). */
  decideApproval(input: { taskId: string; approvalId: string; decision: ApprovalDecision; scope?: ApprovalScope; digest: string; userId: string }): ApprovalOutcome {
    return this.approvals.decide(input);
  }

  activeCount(): number {
    return this.active.size;
  }

  reservationCount(): number {
    return this.reservations.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  /** The newest run of a task, live state first (UI run-state contract). */
  describe(taskId: string): {
    runId: string; state: RunState; attemptId: string | null; lastSeq: number; relayAckSeq: number;
    terminal: RunTerminal | null; effects: Array<Pick<RunEffectRecord, 'key' | 'kind' | 'status'>>;
    /** W07a (additive): the runner, and the follow-up this run is (null for a first run). */
    runner: string;
    followUp: { parentRunId: string; mode: FollowUpMode | null } | null;
    /**
     * W11a (additive): the task's latest verification evidence on this
     * device, bound to the commit it ran against (this run's, or an earlier
     * run's when this one has none yet — the commit says which).
     */
    verification: RunVerificationView | null;
    /** W11a (additive): the run's worktree was cleaned up by the retention sweep. */
    workspaceExpired: { at: string; reason: string } | null;
    /** W15a (additive): the run's budgets, as sealed at start (null = none). */
    budgets: { maxUsd?: number; maxTokens?: number } | null;
    /** W15 (additive): where the run spent its time, from its journal. */
    phases: RunPhaseTimings;
    /** W19b (additive): the project knowledge revisions the run was given. */
    knowledge: Array<{ id: string; version: number; kind: string; title: string }>;
  } | null {
    const runId = this.reservations.get(taskId);
    const record = (runId ? this.journal.get(runId) : null) ?? this.journal.latestForTask(taskId);
    if (!record) return null;
    const followUp = record.snapshot.followUp;
    const cleanup = record.workspace ? this.journal.workspaceCleanup(record.workspace.worktreePath) : null;
    return {
      // W15a (additive): the run's sealed budgets (FE-08 shows spend against them).
      budgets: record.snapshot.budgets ?? null,
      phases: runPhaseTimings({ events: this.journal.timingEvents(record.runId), createdAt: record.createdAt, finishedAt: record.finishedAt, now: this.now(), currentState: record.state }),
      knowledge: record.snapshot.followUp ? [] : (record.snapshot.knowledge ?? []).map(({ id, version, kind, title }) => ({ id, version, kind, title })),
      verification: this.verificationFor(record),
      workspaceExpired: cleanup?.status === 'removed' && cleanup.removedAt !== null
        ? { at: new Date(cleanup.removedAt).toISOString(), reason: cleanup.reason }
        : null,
      runId: record.runId,
      state: record.state,
      attemptId: record.attemptId,
      lastSeq: record.lastSeq,
      relayAckSeq: record.relayAckSeq,
      terminal: record.terminal,
      effects: this.journal.effects(record.runId).map(({ key, kind, status }) => ({ key, kind, status })),
      runner: record.runner,
      followUp: followUp
        ? { parentRunId: followUp.parentRunId, mode: record.runtime ? (record.runtime.resumedSessionId ? 'resume' : 'seeded') : null }
        : null,
    };
  }

  /** The verification view of `record`, else of the task's earlier runs (newest first). */
  private verificationFor(record: RunRecord): RunVerificationView | null {
    const own = this.verificationView(record);
    if (own) return own;
    for (const earlier of this.journal.runsForTask(record.taskId, 6)) {
      if (earlier.runId === record.runId) continue;
      const view = this.verificationView(earlier);
      if (view) return view;
    }
    return null;
  }

  private committedSha(runId: string): string | null {
    const commit = this.journal.effect(runId, runEffectKey(runId, 'git.commit'));
    return commit?.status === 'confirmed' && typeof commit.receipt?.sha === 'string' ? commit.receipt.sha : null;
  }

  private verificationView(record: RunRecord): RunVerificationView | null {
    const manifest = record.verification?.manifest ?? null;
    const base = {
      runId: record.runId,
      checksHash: manifest?.checksHash ?? null,
      policy: manifest?.policy ?? null,
      source: manifest?.source ?? null,
    };
    const effect = this.journal.latestEffect(record.runId, 'verify.run');
    if (record.state === 'verifying' && effect?.status !== 'confirmed') {
      const commit = typeof effect?.intent.sha === 'string' ? effect.intent.sha : this.committedSha(record.runId);
      return {
        ...base,
        status: 'running',
        commit,
        publication: null,
        checks: (manifest?.checks ?? []).map((check) => ({ id: check.id, name: check.name, required: check.required, status: 'pending' as const, summary: 'waiting to run' })),
        environment: null,
        warnings: [],
        detail: null,
        finishedAt: null,
      };
    }
    if (effect?.status === 'confirmed') {
      const parsed = verificationResultSchema.safeParse(effect.receipt?.result);
      if (!parsed.success) return null;
      const result = parsed.data;
      return {
        ...base,
        checksHash: result.checksHash,
        policy: result.policy,
        source: result.source,
        status: result.status,
        commit: result.commitSha,
        publication: verificationPublicationDecision(result.policy, result.status).allowed ? 'allowed' : 'blocked',
        checks: result.checks.map((check) => ({ id: check.id, name: check.required ? check.name : `${check.name} (informational)`, required: check.required, status: viewCheckStatus(check.status), summary: checkSummary(check) })),
        environment: result.environment,
        warnings: result.warnings,
        detail: result.detail,
        finishedAt: result.finishedAt,
      };
    }
    // A run that published without a verification step (none configured, or policy off).
    if (manifest && !manifestRequiresVerification(manifest) && record.state === 'succeeded') {
      return {
        ...base,
        status: 'skipped',
        commit: this.committedSha(record.runId) ?? (typeof this.journal.latestEffect(record.runId, 'git.push')?.intent.sha === 'string' ? String(this.journal.latestEffect(record.runId, 'git.push')?.intent.sha) : null),
        publication: 'allowed',
        checks: [],
        environment: null,
        warnings: manifest.warnings,
        detail: manifest.policy === 'off' ? 'verification is off for this project' : 'no verification checks are configured',
        finishedAt: record.finishedAt !== null ? new Date(record.finishedAt).toISOString() : null,
      };
    }
    return null;
  }

  logsFor(taskId: string): ExecutionLogEntry[] {
    const runId = this.reservations.get(taskId);
    const live = runId ? this.runs.get(runId) : undefined;
    if (live && live.logs.length > 0) return [...live.logs];
    const record = runId ? this.journal.get(runId) : this.journal.latestForTask(taskId);
    return record ? this.journalLogs(record.runId) : [];
  }

  /** The run's log entries from the journal (survives restarts), bounded. */
  private journalLogs(runId: string): ExecutionLogEntry[] {
    const entries: ExecutionLogEntry[] = [];
    let after = 0;
    for (;;) {
      const page = this.journal.events(runId, after, 1_000);
      if (page.length === 0) break;
      for (const event of page) {
        if (event.kind === 'log') {
          const entry = this.toLogEntry(event.payload);
          if (entry) entries.push(entry);
        }
        after = event.seq;
      }
    }
    return entries.slice(-this.options.logRing);
  }

  /**
   * Execute: authorize with the control plane (attempt + capability +
   * snapshot), admit locally (pending work counts), journal the acceptance,
   * then drive in the background. Waits (bounded) until the run started —
   * claimed and its prompt journaled — or failed during setup, so setup
   * failures keep their HTTP status (e.g. 503 SANDBOX_UNAVAILABLE).
   */
  /** `allowBlocked` (W17a): run although blockers are open (else 409 TASK_BLOCKED from the control plane). */
  async submit(input: { credential: PrincipalCredential; taskId: string; allowBlocked?: boolean }): Promise<SubmitResult> {
    if (this.stopped) throw new HttpError(503, 'RUN_ENGINE_STOPPED', 'The run engine is shutting down');
    const { taskId, credential } = input;
    if (this.reservations.has(taskId)) throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already running');
    const runId = randomUUID();
    this.reservations.set(taskId, runId);
    return this.startRun({ runId, credential, taskId, followUp: null, allowBlocked: input.allowBlocked === true });
  }

  /**
   * W07a follow-up turn (`POST /api/tasks/:id/follow-up`): the task's latest
   * run must be finished with its worktree retained. The turn is a new run
   * (new control-plane attempt, journaled like any run) that adopts that
   * worktree and branch, continues the runner's saved session where it can
   * and otherwise seeds a fresh one with the previous diff; publication
   * updates the same branch and reuses its open pull request.
   *
   * `parentRunId` (W12, optional): the run the caller means to continue. When
   * it isn't the task's latest run on this device (a run from another device,
   * or a newer run here), the follow-up is refused before anything is probed,
   * aborted or started: 409 FOLLOW_UP_RUN_MISMATCH `{ expected, latest }`.
   *
   * Errors: 409 RUN_ACTIVE (a turn is in progress), 409
   * FOLLOW_UP_RUN_MISMATCH, 409 FOLLOW_UP_UNSUPPORTED (no finished run with a
   * retained worktree), plus everything execute can answer (control plane
   * 401/403/404, 503 SANDBOX_UNAVAILABLE / CLOUD_API_UNREACHABLE, runner
   * preflight codes).
   */
  async followUp(input: { credential: PrincipalCredential; taskId: string; request: FollowUpRequest; parentRunId?: string }): Promise<SubmitResult> {
    if (this.stopped) throw new HttpError(503, 'RUN_ENGINE_STOPPED', 'The run engine is shutting down');
    const { taskId, credential, request } = input;
    if (this.reservations.has(taskId)) throw new HttpError(409, 'RUN_ACTIVE', 'A turn is already in progress for this task');
    const runId = randomUUID();
    this.reservations.set(taskId, runId);
    let handedOff = false;
    try {
      const parent = this.journal.latestForTask(taskId);
      if (input.parentRunId !== undefined && parent?.runId !== input.parentRunId) {
        throw new HttpError(409, 'FOLLOW_UP_RUN_MISMATCH', 'The run to continue is not the latest run of this task on this device', {
          expected: input.parentRunId,
          latest: parent?.runId ?? null,
        });
      }
      if (!parent) {
        throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'No finished run is recorded for this task on this device', { reason: 'no_run' });
      }
      if (!isTerminalRunState(parent.state)) {
        throw new HttpError(409, 'RUN_ACTIVE', 'The previous turn is still being recovered', { runId: parent.runId, state: parent.state });
      }
      await this.assertParentAgentStopped(parent);
      if (!parent.workspace) {
        throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'The previous run has no retained worktree', { reason: 'no_workspace', parentRunId: parent.runId });
      }
      const retained = await this.deps.workspace.inspectRetained(parent.workspace);
      const cleanup = retained.ok ? null : this.journal.workspaceCleanup(parent.workspace.worktreePath);
      if (cleanup?.status === 'removed') {
        // W11a: say so honestly — the retention sweep removed it (with a receipt).
        throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'The previous run\'s workspace expired and was cleaned up', {
          reason: 'workspace_expired',
          parentRunId: parent.runId,
          cleanupReason: cleanup.reason,
          ...(cleanup.removedAt !== null ? { cleanedAt: new Date(cleanup.removedAt).toISOString() } : {}),
        });
      }
      if (!retained.ok) {
        throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'The previous run\'s worktree is no longer retained', {
          reason: retained.reason,
          parentRunId: parent.runId,
          ...(retained.detail ? { detail: retained.detail } : {}),
        });
      }
      const followUp: RunFollowUp = {
        parentRunId: parent.runId,
        message: request.message,
        comments: request.comments.map((comment) => ({
          path: comment.path,
          body: comment.body,
          ...(comment.line !== undefined ? { line: comment.line } : {}),
          ...(comment.side !== undefined ? { side: comment.side } : {}),
        })),
      };
      handedOff = true;
      // A follow-up continues work the user already started: blockers don't apply.
      return await this.startRun({ runId, credential, taskId, followUp, allowBlocked: true });
    } finally {
      if (!handedOff && this.reservations.get(taskId) === runId) this.reservations.delete(taskId);
    }
  }

  /**
   * W12: a turn that ended without a confirmed stop (`recovery_required`,
   * `abandoned`) may still have a live agent in its session and worktree.
   * Prompting another turn into it would race that agent (and publish its
   * partial edits), so the session must be idle, gone, or confirmed stopped now.
   */
  private async assertParentAgentStopped(parent: RunRecord): Promise<void> {
    if (parent.state !== 'recovery_required' && parent.state !== 'abandoned') return;
    if (!parent.sessionId || !this.journal.effect(parent.runId, runEffectKey(parent.runId, 'prompt.submit'))) return;
    const runtime = this.deps.runtimes.get(parent.runner);
    const probe = runtime && parent.runtime ? await runtime.inspect(parent.runtime, parent.sessionId).catch(() => 'unreachable' as const) : null;
    if (probe === 'idle' || probe === 'idle-error' || probe === 'missing') return;
    const stopped = runtime ? await runtime.abort(parent.runtime ?? null, parent.sessionId).catch(() => false) : false;
    if (stopped) return;
    throw new HttpError(409, 'AGENT_MAY_BE_RUNNING', "The previous turn's agent could not be confirmed stopped, so it can't be continued; start a new run instead", {
      parentRunId: parent.runId,
      state: parent.state,
      ...(probe ? { probe } : {}),
    });
  }

  /** Authorize, admit, durably accept and drive one run (`runId` is already reserved for the task). */
  private async startRun(args: { runId: string; credential: PrincipalCredential; taskId: string; followUp: RunFollowUp | null; allowBlocked: boolean }): Promise<SubmitResult> {
    const { runId, credential, taskId, followUp } = args;
    let accepted = false;
    try {
      const started = await this.step(runId, 'control:start', () => this.cp.start(credential, taskId, args.allowBlocked ? { allowBlocked: true } : undefined)).catch((error: unknown) => {
        // W11a retention: an archived or deleted task closes its retained workspaces.
        if (isHttpError(error) && (error.code === 'TASK_ARCHIVED' || error.code === 'TASK_NOT_FOUND')) {
          try {
            this.journal.noteTaskClosed(taskId, error.code.toLowerCase(), this.now());
          } catch (hintError) {
            logger.debug({ err: hintError, taskId }, '[RunEngine] task closure hint not recorded');
          }
        }
        // For a follow-up, a task the control plane still sees running is a turn in progress.
        if (followUp && isHttpError(error) && error.code === 'TASK_ALREADY_RUNNING') {
          throw new HttpError(409, 'RUN_ACTIVE', 'A turn is already in progress for this task', error.details);
        }
        throw error;
      });
      this.parallelLimit = started.parallelLimit;
      const channel = this.cp.channel(started.attemptId, started.capability.token);
      let runner: string;
      try {
        runner = this.runnerFor(started.snapshot.agent);
        // W07a: unsupported runner/model/credential combinations fail here,
        // before anything is journaled or dispatched.
        await this.deps.runtimes.get(runner)?.preflight?.({ model: started.snapshot.model, env: {} });
      } catch (error) {
        await this.closeUnaccepted(runId, channel, isHttpError(error) ? error.code.toLowerCase() : 'runner_not_supported');
        throw error;
      }
      const admission = admitRunRequest({
        active: this.active.size,
        queued: this.queue.length,
        parallelLimit: started.parallelLimit,
        maxQueued: this.options.maxQueued,
      });
      if (admission.kind === 'reject') {
        await this.closeUnaccepted(runId, channel, 'admission_rejected');
        throw new HttpError(400, 'PARALLEL_LIMIT_REACHED', admission.reason);
      }
      const state = admission.kind === 'start' ? 'preparing' : 'queued';
      // Durable acceptance: nothing is acknowledged before this commit.
      const record = this.journal.createRun({
        runId,
        taskId,
        userId: credential.principal.userId,
        attemptId: started.attemptId,
        capability: started.capability.token,
        capabilityExpiresAt: started.capability.expiresAt,
        runner,
        model: started.snapshot.model,
        state,
        // A follow-up's request is part of the durable acceptance.
        snapshot: followUp ? { ...started.snapshot, followUp } : started.snapshot,
        bootId: this.bootId,
      }, {
        attemptId: started.attemptId,
        taskId,
        runner,
        admission: admission.kind,
        ...(followUp ? { followUpOf: followUp.parentRunId, comments: followUp.comments.length } : {}),
      });
      accepted = true;
      const run = this.track(record, channel, started.parallelLimit);
      this.startHeartbeat(run);
      this.emitStateLocally(run, state, 'accepted');
      this.scheduleRelay(run.runId);
      if (state === 'queued') {
        this.queue.push(runId);
        return { runId, attemptId: started.attemptId, state };
      }
      this.active.add(runId);
      void this.drive(run, 'fresh');
      return await this.awaitStart(run);
    } catch (error) {
      if (!accepted && this.reservations.get(taskId) === runId) this.reservations.delete(taskId);
      throw error;
    }
  }

  /**
   * Cancel in any live state. queued: removed, attempt released. preparing:
   * setup stops at the next checkpoint. running: interrupt → grace → abort
   * with a positive stop receipt. finishing: no new publication effect is
   * dispatched; an effect already dispatched is reported, never rolled back.
   */
  /**
   * W12 "stop and redirect": stop the running turn (its work is retained, as
   * on any cancel) and continue the task with the user's instruction as a
   * follow-up turn on the same worktree/branch. Nothing running: just the
   * follow-up. 409 REDIRECT_PENDING when the turn hasn't stopped within
   * `waitMs` (the cancel stays requested; retry the redirect).
   */
  async redirect(input: { credential: PrincipalCredential; taskId: string; request: FollowUpRequest; waitMs?: number }): Promise<SubmitResult> {
    const activeRunId = this.reservations.get(input.taskId);
    if (activeRunId) {
      // A turn without a worktree yet (queued, preparing) has nothing to
      // continue: refuse instead of cancelling it and losing the instruction.
      const active = this.journal.get(activeRunId);
      if (!active?.workspace) {
        throw new HttpError(409, 'REDIRECT_NOT_READY', "The agent hasn't started working yet; stop it, or redirect once it is running", { state: active?.state ?? null });
      }
      const stopped = await this.cancel(input.taskId, 'redirected by user', input.waitMs ?? 30_000);
      if (!stopped.success && this.reservations.has(input.taskId)) {
        throw new HttpError(409, 'REDIRECT_PENDING', "The agent hasn't stopped yet; try the redirect again in a moment", { state: stopped.state ?? null });
      }
    }
    return this.followUp({ credential: input.credential, taskId: input.taskId, request: input.request });
  }

  /**
   * FE-03: a trust grant ended (revoked or expired) while runs it let start
   * without OS isolation may still be going: cancel the ones still active
   * here. Returns the run ids a cancellation was started for.
   */
  cancelRuns(runIds: readonly string[], reason: string): string[] {
    const cancelled: string[] = [];
    for (const runId of new Set(runIds)) {
      const run = this.runs.get(runId);
      const record = this.journal.get(runId);
      if (!run || !record || isTerminalRunState(record.state) || this.reservations.get(run.taskId) !== runId) continue;
      cancelled.push(runId);
      void this.cancel(run.taskId, reason).catch(() => undefined);
    }
    return cancelled;
  }

  async cancel(taskId: string, reason = 'cancelled by user', waitMs = 30_000): Promise<CancelResult> {
    const runId = this.reservations.get(taskId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!runId) return { success: false, error: 'Task is not running' };
    if (!run) {
      // Recovering (e.g. waiting for the control plane): record the request;
      // the recovery decision applies it.
      const pending = this.journal.get(runId);
      if (pending && !isTerminalRunState(pending.state)) {
        this.journal.update(runId, { cancelRequestedAt: this.now(), cancelReason: reason });
        return { success: false, error: 'Cancellation is still in progress', state: pending.state };
      }
      return { success: false, error: 'Task is not running' };
    }
    const record = this.journal.get(runId);
    if (!record || isTerminalRunState(record.state)) return { success: false, error: 'Task is already finalizing' };
    const result = new Promise<CancelResult>((resolve) => run.cancelWaiters.push(resolve));
    if (!run.cancelRequested) {
      run.cancelRequested = true;
      this.journal.update(runId, { cancelRequestedAt: this.now(), cancelReason: reason });
    }
    if (record.state === 'queued') {
      const index = this.queue.indexOf(runId);
      if (index >= 0) this.queue.splice(index, 1);
      void this.finishQueuedCancel(run);
    } else {
      run.controller.abort();
      run.interrupt.resolve({ kind: 'cancel' });
      this.approvals.cancelRun(runId);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CancelResult>((resolve) => {
      timer = setTimeout(() => resolve({ success: false, error: 'Cancellation is still in progress' }), waitMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([result, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Startup: prune, then recover every journaled run another boot left unfinished. */
  async recover(): Promise<{ recovered: number }> {
    try {
      this.journal.pruneFinished(this.options.retentionMs, this.now());
    } catch (error) {
      logger.warn({ err: error }, '[RunEngine] journal retention prune failed');
    }
    const records = this.journal.listRecoverable().filter((record) => record.bootId !== this.bootId);
    for (const record of records) {
      if (this.reservations.has(record.taskId) && this.reservations.get(record.taskId) !== record.runId) continue;
      const adopted = this.journal.update(record.runId, { bootId: this.bootId });
      if (!isTerminalRunState(adopted.state)) this.reservations.set(adopted.taskId, adopted.runId);
      void this.recoverRun(adopted).catch((error: unknown) => {
        logger.error({ err: error, runId: adopted.runId }, '[RunEngine] recovery failed');
      });
    }
    return { recovered: records.length };
  }

  /**
   * W11a: journal-aware worktree retention (workspace/retention.ts). Runs in
   * flight in this process — and every non-terminal journaled run — keep
   * their worktrees; removals are receipted so follow-ups can say the
   * workspace expired. Never throws.
   */
  async sweepRetention(policy?: Partial<RetentionPolicy>): Promise<RetentionSweepReport | null> {
    if (this.stopped) return null;
    try {
      return await sweepRetainedWorktrees({
        journal: this.journal,
        reposRoot: (this.deps.reposRoot ?? appReposDir)(),
        policy,
        now: this.now(),
        isActive: (runId) => this.runs.has(runId) || [...this.reservations.values()].includes(runId) || [...this.activeCheckouts].some((inUse) => inUse(runId)),
        removeWorkspace: (workspace) => this.deps.workspace.release(workspace),
      });
    } catch (error) {
      logger.warn({ err: error }, '[RunEngine] worktree retention sweep failed');
      return null;
    }
  }

  /** Stop timers (tests and shutdown). The journal stays consistent: every write is synchronous. */
  stop(): void {
    this.stopped = true;
    for (const run of this.runs.values()) {
      if (run.heartbeat) clearInterval(run.heartbeat);
      run.heartbeat = null;
      run.controller.abort();
      run.interrupt.resolve({ kind: 'abandon', reason: 'service stopped' });
      this.approvals.cancelRun(run.runId);
    }
    for (const relay of this.relays.values()) if (relay.timer) clearTimeout(relay.timer);
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  /** Settles when every in-flight projection for `runId` is done (tests). */
  async idle(runId: string): Promise<void> {
    await this.runs.get(runId)?.done.promise.catch(() => undefined);
    await this.projections.get(runId);
    await this.relays.get(runId)?.inFlight;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private async step<T>(runId: string, point: string, fn: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new ServiceStopped();
    await this.deps.faults?.('before', point, runId);
    const result = await fn();
    if (this.stopped) throw new ServiceStopped();
    await this.deps.faults?.('after', point, runId);
    return result;
  }

  private runnerFor(agent: string | null): string {
    const id = resolveAgentId({ taskAgent: agent });
    if (!this.deps.runtimes.has(id)) {
      throw new HttpError(400, 'RUNNER_NOT_SUPPORTED', `The run engine does not support ${id}`, {
        runner: id,
        supportedRunners: [...this.deps.runtimes.keys()],
      });
    }
    return id;
  }

  private async closeUnaccepted(runId: string, channel: AttemptChannel, reason: string): Promise<void> {
    try {
      await this.step(runId, 'control:close-unaccepted', () => channel.close(reason));
    } catch (error) {
      logger.warn({ err: error, runId }, '[RunEngine] attempt release not confirmed; its capability expires on its own');
    }
  }

  private track(record: RunRecord, channel: AttemptChannel | null, parallelLimit: number): ActiveRun {
    const run: ActiveRun = {
      runId: record.runId,
      taskId: record.taskId,
      userId: record.userId,
      record,
      channel,
      runtime: this.deps.runtimes.get(record.runner) ?? null,
      session: null,
      controller: new AbortController(),
      claimed: false,
      parallelLimit,
      cancelRequested: record.cancelRequestedAt !== null,
      abandonReason: null,
      interrupt: deferred<PumpInterrupt>(),
      cancelWaiters: [],
      heartbeat: null,
      heartbeatBusy: false,
      logs: [],
      text: '',
      reasoning: '',
      reducer: {
        taskId: record.taskId,
        sessionId: record.sessionId ?? '',
        promptSent: record.counters.promptSent,
        cancelled: false,
        status: 'executing',
        backgroundTaskRunning: false,
        backgroundTaskFailure: null,
        completedToolKeys: new Set(),
        toolsExecuted: record.counters.toolsExecuted,
        filesChanged: record.counters.filesChanged,
        suspendWatchdogs: false,
      },
      watchdog: createWatchdogState(this.now()),
      approvalSince: null,
      allowedTools: new Set<string>(),
      started: deferred<SubmitResult>(),
      done: deferred<RunRecord>(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  private refresh(run: ActiveRun): RunRecord {
    const record = this.journal.get(run.runId);
    if (record) run.record = record;
    return run.record;
  }

  private async awaitStart(run: ActiveRun): Promise<SubmitResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<SubmitResult>((resolve) => {
      timer = setTimeout(() => resolve({ runId: run.runId, attemptId: run.record.attemptId, state: this.refresh(run).state }), this.options.startWaitMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run.started.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- events ----------------------------------------------------------------

  private appendEvent(run: ActiveRun, input: AppendInput): number | null {
    return this.journal.append(run.runId, input);
  }

  private toLogEntry(payload: Record<string, unknown>): ExecutionLogEntry | null {
    const entry = payload.entry;
    if (!entry || typeof entry !== 'object') return null;
    const timestamp = 'timestamp' in entry && typeof entry.timestamp === 'string' ? entry.timestamp : new Date(this.now()).toISOString();
    const type = 'type' in entry ? entry.type : undefined;
    const message = 'message' in entry && typeof entry.message === 'string' ? entry.message : '';
    const details = 'details' in entry && typeof entry.details === 'string' ? entry.details : undefined;
    if (type !== 'info' && type !== 'agent' && type !== 'tool' && type !== 'error' && type !== 'success') return null;
    return { timestamp, type, message, ...(details !== undefined ? { details } : {}) };
  }

  /** Journal a log entry (relayed), then deliver it locally. */
  private log(run: ActiveRun, type: ExecutionLogEntry['type'], message: string, details?: string, critical = false): void {
    const entry: ExecutionLogEntry = {
      timestamp: new Date(this.now()).toISOString(),
      type,
      message: redactSecrets(message).slice(0, MAX_LOG_MESSAGE),
      ...(details !== undefined ? { details: redactSecrets(details).slice(0, MAX_LOG_DETAILS) } : {}),
    };
    const seq = this.appendEvent(run, { kind: 'log', payload: { entry }, relay: true, critical: critical || type === 'error' });
    if (seq === null) return;
    run.logs.push(entry);
    if (run.logs.length > this.options.logRing) run.logs.splice(0, run.logs.length - this.options.logRing);
    this.deps.events?.publish(run.taskId, run.userId, 'execution:log', { taskId: run.taskId, entry, runId: run.runId, runSeq: seq });
    this.scheduleRelay(run.runId);
  }

  /** Journal a progress event (relayed), then deliver it locally. */
  private progress(run: ActiveRun, status: string, message: string, data: Record<string, unknown> = {}, critical = false): void {
    const payload: Record<string, unknown> = { status: status.slice(0, 64), message: redactSecrets(message).slice(0, MAX_LOG_MESSAGE) };
    for (const [key, value] of Object.entries(data)) {
      const safe = scalar(value);
      if (safe !== undefined && key !== 'taskId') payload[key] = safe;
    }
    const seq = this.appendEvent(run, { kind: 'progress', payload, relay: true, critical });
    if (seq === null) return;
    this.deps.events?.publish(run.taskId, run.userId, 'execution:progress', { ...payload, taskId: run.taskId, runId: run.runId, runSeq: seq });
    this.scheduleRelay(run.runId, critical ? 0 : undefined);
  }

  private emitStateLocally(run: ActiveRun, to: RunState, reason: string): void {
    const record = this.refresh(run);
    this.deps.events?.publish(run.taskId, run.userId, 'execution:progress', {
      taskId: run.taskId,
      status: LEGACY_PROGRESS_STATUS[to],
      message: reason,
      runState: to,
      runId: run.runId,
      runSeq: record.lastSeq,
    });
  }

  private transition(run: ActiveRun, to: RunState, reason: string, extra: Partial<Parameters<DurableRunJournal['transition']>[1]> = {}): RunRecord {
    const from = this.refresh(run).state;
    const result = this.journal.transition(run.runId, { from, to, reason, ...extra });
    run.record = result.record;
    this.emitStateLocally(run, to, reason);
    this.scheduleRelay(run.runId, 0);
    return result.record;
  }

  // --- relay (W06: journal → control plane, acknowledged cursor persisted) ---

  private toExecutionEvent(event: { seq: number; kind: string; payload: Record<string, unknown> }, runId: string): ExecutionEvent | null {
    if (event.kind === 'log') {
      const entry = this.toLogEntry(event.payload);
      return entry ? { seq: event.seq, type: 'execution:log', payload: { entry } } : null;
    }
    if (event.kind === 'progress' || event.kind === 'run.state') {
      const payload: Record<string, string | number | boolean | null> = {};
      if (event.kind === 'run.state') {
        const to = typeof event.payload.to === 'string' ? event.payload.to : 'running';
        const status = RUN_STATES.find((state) => state === to);
        payload.status = status ? LEGACY_PROGRESS_STATUS[status] : 'executing';
        payload.message = typeof event.payload.reason === 'string' ? event.payload.reason.slice(0, MAX_LOG_MESSAGE) : to;
        payload.runState = to;
      } else {
        for (const [key, value] of Object.entries(event.payload)) {
          const safe = scalar(value);
          if (safe !== undefined && key !== 'taskId') payload[key] = safe;
        }
        if (typeof payload.status !== 'string' || !payload.status) payload.status = 'executing';
        if (typeof payload.message !== 'string') payload.message = '';
      }
      // (runId, runSeq) identifies the event across reconnects and replays (UI de-duplication).
      payload.runId = runId;
      payload.runSeq = event.seq;
      const status = String(payload.status).slice(0, 64);
      const message = String(payload.message).slice(0, MAX_LOG_MESSAGE);
      return { seq: event.seq, type: 'execution:progress', payload: { ...payload, status, message } };
    }
    return null;
  }

  private channelFor(runId: string): AttemptChannel | null {
    const live = this.runs.get(runId);
    if (live?.channel) return live.channel;
    const record = this.journal.get(runId);
    if (!record?.attemptId || !record.capability) return null;
    return this.cp.channel(record.attemptId, record.capability);
  }

  private scheduleRelay(runId: string, delayMs = this.options.relayDelayMs): void {
    if (this.stopped) return;
    const relay = this.relays.get(runId) ?? { inFlight: null, timer: null, failures: 0 };
    this.relays.set(runId, relay);
    if (relay.inFlight) return;
    if (relay.timer) {
      if (delayMs > 0) return;
      clearTimeout(relay.timer);
    }
    relay.timer = setTimeout(() => {
      relay.timer = null;
      void this.flushRelay(runId);
    }, delayMs);
    relay.timer.unref?.();
  }

  /** Send unacknowledged journal events (≤ 50 per request) until none remain. Never throws. */
  private flushRelay(runId: string): Promise<void> {
    const relay = this.relays.get(runId) ?? { inFlight: null, timer: null, failures: 0 };
    this.relays.set(runId, relay);
    if (relay.inFlight) return relay.inFlight;
    relay.inFlight = (async () => {
      // Never settle synchronously: a flush with nothing to send would run
      // its `finally` (clearing `inFlight`) before this assignment stored
      // the settled promise, leaving the relay looking busy forever (W07a
      // soak finding: a queued run's events were never delivered).
      await Promise.resolve();
      try {
        for (;;) {
          if (this.stopped) return;
          const channel = this.channelFor(runId);
          if (!channel) return;
          const batch = this.journal.unrelayed(runId, 50);
          if (batch.length === 0) return;
          const lastSeq = batch[batch.length - 1]?.seq ?? 0;
          const events = batch.map((event) => this.toExecutionEvent(event, runId)).filter((event): event is ExecutionEvent => event !== null);
          if (events.length === 0) {
            this.journal.ackRelay(runId, lastSeq);
            continue;
          }
          try {
            const result = await this.step(runId, 'relay:send', () => channel.sendEvents(events));
            this.journal.ackRelay(runId, lastSeq);
            relay.failures = 0;
            if (result.cancelRequested) {
              const run = this.runs.get(runId);
              if (run && !run.cancelRequested) void this.cancel(run.taskId, 'cancellation requested through the control plane');
            }
          } catch (error) {
            if (error instanceof ServiceStopped) return;
            if (isAuthorityLost(error)) {
              const current = this.journal.get(runId);
              if (current && isTerminalRunState(current.state)) this.journal.ackRelay(runId, current.lastSeq);
              this.onAuthorityLost(runId, error);
              return;
            }
            if (!isTransientControlError(error)) {
              // A batch the control plane refuses (validation) is not retried forever.
              logger.warn({ err: error, runId, lastSeq }, '[RunEngine] control plane refused an event batch; skipped');
              this.journal.ackRelay(runId, lastSeq);
              continue;
            }
            relay.failures += 1;
            const backoff = Math.min(this.options.relayRetryBaseMs * 2 ** (relay.failures - 1), this.options.relayRetryMaxMs);
            setTimeout(() => this.scheduleRelay(runId, 0), backoff).unref?.();
            return;
          }
        }
      } catch (error) {
        logger.warn({ err: error, runId }, '[RunEngine] relay stopped');
      } finally {
        relay.inFlight = null;
      }
    })();
    return relay.inFlight;
  }

  // --- heartbeat, renewal, authority -----------------------------------------

  private startHeartbeat(run: ActiveRun): void {
    if (!run.channel || run.heartbeat) return;
    run.heartbeat = setInterval(() => {
      void this.beat(run);
    }, this.options.heartbeatMs);
    run.heartbeat.unref?.();
  }

  private stopHeartbeat(run: ActiveRun): void {
    if (run.heartbeat) clearInterval(run.heartbeat);
    run.heartbeat = null;
  }

  private async beat(run: ActiveRun): Promise<void> {
    if (run.heartbeatBusy || !run.channel || this.stopped) return;
    run.heartbeatBusy = true;
    try {
      const beat = await run.channel.heartbeat();
      if (beat.status === 'closed' || beat.status === 'released') {
        this.onAuthorityLost(run.runId, new HttpError(409, 'ATTEMPT_STATE_CONFLICT', `Attempt is ${beat.status}`));
        return;
      }
      if (beat.cancelRequested && !run.cancelRequested) {
        void this.cancel(run.taskId, 'cancellation requested through the control plane');
      }
      if (beat.capabilityExpiresAt - this.now() < this.options.renewBeforeMs) await this.renew(run);
    } catch (error) {
      if (isAuthorityLost(error)) this.onAuthorityLost(run.runId, error);
      else logger.debug({ err: error, runId: run.runId }, '[RunEngine] heartbeat failed');
    } finally {
      run.heartbeatBusy = false;
    }
  }

  /** Rotate the capability; the new token is journaled before it is used. */
  private async renew(run: ActiveRun): Promise<void> {
    if (!run.channel || !run.record.attemptId) return;
    const renewed = await run.channel.renew();
    this.journal.update(run.runId, { capability: renewed.token, capabilityExpiresAt: renewed.expiresAt });
    run.channel = this.cp.channel(run.record.attemptId, renewed.token);
    this.refresh(run);
    logger.info({ runId: run.runId, expiresAt: new Date(renewed.expiresAt).toISOString() }, '[RunEngine] attempt capability renewed');
  }

  private onAuthorityLost(runId: string, error: unknown): void {
    const run = this.runs.get(runId);
    logger.warn({ runId, code: errorCode(error) }, '[RunEngine] control plane no longer accepts this attempt; fencing the run');
    if (!run) return;
    if (run.abandonReason) return;
    run.abandonReason = `control plane refused the attempt (${errorCode(error) ?? 'unknown'})`;
    this.stopHeartbeat(run);
    run.controller.abort();
    run.interrupt.resolve({ kind: 'abandon', reason: run.abandonReason });
    if (this.refresh(run).state === 'queued') void this.finishQueuedAbandon(run);
  }

  private checkpoint(run: ActiveRun): void {
    if (run.abandonReason) throw new RunSignal('abandon', run.abandonReason);
    if (run.cancelRequested) throw new RunSignal('cancel', 'Execution cancelled');
  }

  // -------------------------------------------------------------------------
  // Driving a run
  // -------------------------------------------------------------------------

  private async drive(run: ActiveRun, mode: 'fresh' | RunRecoveryDecision['action']): Promise<void> {
    try {
      if (mode === 'fresh') {
        await this.step(run.runId, 'accepted', async () => undefined);
        await this.prepare(run);
        const outcome = await this.pump(run, false);
        await this.afterPump(run, outcome);
      } else if (mode === 'reattach') {
        const outcome = await this.pump(run, true);
        await this.afterPump(run, outcome);
      } else if (mode === 'finish' || mode === 'resume-finishing') {
        await this.publish(run);
      }
    } catch (error) {
      await this.decideFromError(run, error);
    } finally {
      await this.settle(run);
    }
  }

  private async prepare(run: ActiveRun): Promise<void> {
    const record = this.refresh(run);
    const runtime = run.runtime;
    if (!runtime) throw new HttpError(400, 'RUNNER_NOT_SUPPORTED', `The run engine does not support ${record.runner}`);
    const channel = run.channel;
    if (!channel) throw new HttpError(409, 'ATTEMPT_REQUIRED', 'The run has no control-plane attempt');
    let modelId = record.snapshot.model;
    const preflight = this.deps.modelPreflight;
    // The OpenCode default-model preflight; Claude Code and Codex fall back to their own default.
    if (!modelId && preflight && record.runner === 'opencode') {
      const result = await this.step(run.runId, 'prepare:model-preflight', () => preflight(run.userId));
      if (result.problem) throw new HttpError(400, 'MODEL_NOT_CONFIGURED', result.problem);
      modelId = result.model;
      if (modelId) run.record = this.journal.update(run.runId, { model: modelId });
    }
    this.checkpoint(run);
    const followUp = record.snapshot.followUp ?? null;
    const parent = followUp ? this.journal.get(followUp.parentRunId) : null;
    let workspace: RunWorkspace;
    if (followUp) {
      const retained = parent?.workspace;
      if (!retained) throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'The previous run has no retained worktree', { reason: 'no_workspace' });
      this.progress(run, 'cloning', 'Reusing the previous run\'s worktree...');
      workspace = await this.step(run.runId, 'prepare:workspace', () => this.deps.workspace.adopt({ parentRunId: followUp.parentRunId, workspace: retained }));
      run.record = this.journal.update(run.runId, { workspace });
      this.log(run, 'info', `Follow-up on ${workspace.branch} in ${workspace.worktreePath}`);
    } else {
      this.progress(run, 'cloning', record.snapshot.localPath ? 'Preparing local repository...' : 'Cloning repository...');
      // W10a: fetch-only credential (contents:read), requested right before the clone.
      const token = await this.step(run.runId, 'prepare:git-credential', () => channel.gitCredential('fetch'));
      this.checkpoint(run);
      workspace = await this.step(run.runId, 'prepare:workspace', () => this.deps.workspace.acquire({ runId: run.runId, snapshot: record.snapshot, token }));
      run.record = this.journal.update(run.runId, { workspace });
      if (record.snapshot.localPath) {
        // W08a: the run works in an isolated copy; the folder itself is not modified.
        this.log(run, 'info', `Working in an isolated copy of ${record.snapshot.localPath}${workspace.baseCommit ? ` at ${workspace.baseCommit.slice(0, 12)}` : ''}; your folder is not modified`);
        if (workspace.sourceDirty) {
          this.log(run, 'info', 'The folder has uncommitted changes; they are not part of this run (commit them first to include them)');
        }
      } else {
        this.log(run, 'info', 'Repository cloned successfully');
      }
      this.log(run, 'info', `Branch created: ${workspace.branch}`);
    }
    this.checkpoint(run);
    // W11a: seal what the run will be graded with BEFORE the agent can touch
    // the workspace (journaled; recovery and verification read it back).
    await this.sealVerification(run, workspace);
    this.checkpoint(run);
    // W16a: the project's environment setup, in the worktree, before the
    // agent exists — nothing is started, claimed or prompted until it passed.
    await this.runSetup(run, workspace);
    this.checkpoint(run);
    // W16b: the files most relevant to the task, indexed at the base commit
    // (never the agent's tree), as untrusted data in the first prompt only.
    let repositoryContext: string | null = null;
    const contextPort = this.deps.repositoryContext;
    if (!followUp && contextPort) {
      const snapshot = this.refresh(run).snapshot;
      const context = await this.step(run.runId, 'prepare:repository-context', () => contextPort({
        worktreePath: workspace.worktreePath,
        commitSha: workspace.baseCommit ?? null,
        repositoryKey: repositoryKeyFor(snapshot),
        task: { title: snapshot.title, description: snapshot.description, labels: snapshot.labels },
        signal: run.controller.signal,
      }));
      repositoryContext = context.section;
      this.log(run, 'info', describeContextReceipt(context));
      this.checkpoint(run);
    }
    // W19b: which knowledge revisions the agent is given (first prompt only).
    const knowledge = this.refresh(run).snapshot.knowledge ?? [];
    if (!followUp && knowledge.length > 0) {
      this.log(run, 'info', `Project knowledge: ${knowledge.length} entr${knowledge.length === 1 ? 'y' : 'ies'} given to the agent`, knowledge.map((entry) => `${entry.title} (v${entry.version})`).join(', '));
    }
    this.progress(run, 'executing', 'Starting agent...');
    const model = modelId ? { id: modelId, provider: modelId.split('/')[0] } : undefined;
    const started = followUp && parent
      ? await this.startFollowUpSession(run, runtime, workspace, parent, followUp, model)
      : await this.step(run.runId, 'prepare:runtime-start', () => runtime.start({
          runId: run.runId,
          worktreePath: workspace.worktreePath,
          systemContract: EXECUTION_SYSTEM_CONTRACT,
          prompt: this.promptFor(run, repositoryContext),
          ...(model ? { model } : {}),
          budgets: { wallClockMs: this.options.watchdog.wallClockMs },
          permissions: this.permissionsFor(run, runtime),
          sandbox: { cwd: workspace.worktreePath, env: {} },
          env: {},
          signal: run.controller.signal,
        }));
    run.session = started.session;
    run.reducer.sessionId = started.session.externalId;
    if (this.refresh(run).snapshot.approvalMode === 'ask' && runtime.runnerId === 'opencode' && started.endpoint?.sandboxMode === 'trusted-host') {
      this.log(run, 'info', 'This run uses the shared OpenCode server without the sandbox, which cannot pause for your approval; its actions are not held for review');
    }
    run.record = this.journal.update(run.runId, { runtime: started.endpoint, sessionId: started.session.externalId });
    this.checkpoint(run);

    // Claim: the only in_progress transition (W01/W03a fence), journaled first.
    const claim = await this.effect(run, {
      key: runEffectKey(run.runId, 'attempt.claim'),
      kind: 'attempt.claim',
      intent: { sessionId: started.session.externalId, runner: record.runner, model: modelId ?? 'unknown' },
    }, async () => {
      const claimed = await channel.claim({ sessionId: started.session.externalId, runner: record.runner, model: modelId ?? 'unknown' });
      if (claimed.task) this.deps.events?.publish(run.taskId, run.userId, 'task:updated', claimed.task);
      return { agentRunId: claimed.agentRunId };
    });
    if (claim.status !== 'confirmed') throw new HttpError(409, 'CLAIM_FAILED', 'The control plane did not confirm the claim');
    run.claimed = true;
    const agentRunId = typeof claim.receipt?.agentRunId === 'string' ? claim.receipt.agentRunId : null;
    run.record = this.journal.update(run.runId, { counters: { ...run.record.counters, agentRunId } });
    this.checkpoint(run);
    // The prompt intent commits with the running state: from here on a crash
    // means "the prompt may have been submitted" and recovery never resends it.
    this.transition(run, 'running', 'claimed; prompt submission starting', {
      effects: [{ key: runEffectKey(run.runId, 'prompt.submit'), kind: 'prompt.submit', intent: { sessionId: started.session.externalId } }],
    });
    this.log(run, 'info', 'Agent started');
    run.started.resolve({ runId: run.runId, attemptId: run.record.attemptId, state: 'running' });
  }

  /** W11a: resolve and journal the verification manifest (never fails the run: problems are recorded). */
  private async sealVerification(run: ActiveRun, workspace: RunWorkspace): Promise<void> {
    const port = this.deps.verification;
    if (!port) return;
    const record = this.refresh(run);
    let manifest: VerificationManifest;
    try {
      manifest = await this.step(run.runId, 'prepare:verification-manifest', () => port.resolveManifest({ runId: run.runId, snapshot: record.snapshot, workspace }));
    } catch (error) {
      if (error instanceof ServiceStopped) throw error;
      const message = errorMessage(error).slice(0, 300);
      logger.warn({ err: error, runId: run.runId }, '[RunEngine] verification manifest could not be resolved');
      manifest = resolveVerificationManifest({
        projectSettings: record.snapshot.verificationSettings ?? null,
        projectSettingsSha256: null,
        baseCommit: workspace.baseCommit ?? null,
        repositoryFile: { text: null, sha256: null, error: message },
        autoDetect: () => null,
        hash: (text) => sha256Hex(text),
        now: () => new Date(this.now()).toISOString(),
      });
    }
    run.record = this.journal.update(run.runId, { verification: { manifest } });
    if (manifest.policy === 'off') {
      this.log(run, 'info', 'Verification is off for this project');
    } else if (manifest.checks.length > 0) {
      const base = manifest.baseCommit ? ` (base ${manifest.baseCommit.slice(0, 12)})` : '';
      this.log(run, 'info', `Verification sealed: ${manifest.checks.length} check${manifest.checks.length === 1 ? '' : 's'} from ${manifest.source === 'repository' ? `.openlinear/checks.json${base}` : manifest.source === 'project' ? 'project settings' : 'auto-detection'}; policy ${manifest.policy}`,
        manifest.checks.map((check) => check.name).join(', '));
    } else if (manifest.problems.length > 0) {
      this.log(run, 'error', 'Verification checks are misconfigured', manifest.problems.join('\n'));
    } else {
      this.log(run, 'info', `No verification checks are configured (policy ${manifest.policy})`);
    }
    for (const warning of manifest.warnings) this.log(run, 'info', warning);
  }

  /** The local sandboxed setup executor, created on the first run with setup steps. */
  private localSetupPort(): SetupPort {
    if (!this.localSetup) this.localSetup = createLocalSetup(this.deps.reposRoot ? { reposRoot: this.deps.reposRoot } : {});
    return this.localSetup;
  }

  /**
   * W16a: the setup steps sealed with the run (`snapshot.verificationSettings
   * .setup`), in order, in the worktree, each through the setup port's
   * sandboxed executor; journaled (start, then result) on the run's progress
   * events and streamed to its logs. A required step that does not pass
   * fails the run here — before any runtime, claim or prompt, the worktree
   * kept for inspection or a follow-up; an optional one is logged and the
   * run continues. A step already done in this worktree (this run, or the
   * run a follow-up continues, e.g. one that crashed mid-setup) is not run
   * again. Cancellation stops the running step and cancels the run.
   */
  private async runSetup(run: ActiveRun, workspace: RunWorkspace): Promise<void> {
    const record = this.refresh(run);
    const plan = resolveSetupPlan(record.snapshot.verificationSettings ?? null, sha256Hex);
    if (plan.problems.length > 0) this.failSetup(run, workspace, 'Setup failed: the project\'s setup steps are invalid', plan.problems.join('\n'));
    if (plan.steps.length === 0) return;
    const port = this.deps.setup ?? this.localSetupPort();
    try {
      await port.assertRunnable?.(workspace.worktreePath);
    } catch (error) {
      if (!(error instanceof SandboxUnavailableError)) throw error;
      // Before the early answer: execute reports 503 SANDBOX_UNAVAILABLE itself.
      this.log(run, 'error', 'Setup failed: no sandbox to run the setup steps in', error.message);
      this.decide(run, { state: 'failed', reason: 'setup failed', outcome: `Setup failed: ${error.message}` });
      run.started.reject(error);
      throw new SetupFailed(error.message);
    }
    // Accepted and preparing: execute answers now rather than after the install.
    run.started.resolve({ runId: run.runId, attemptId: run.record.attemptId, state: 'preparing' });
    const done = this.completedSetupSteps(record, workspace);
    const total = plan.steps.length;
    // Taken before the first step that runs; compared after the last one.
    let before: WorktreeFingerprint | null | undefined;
    this.log(run, 'info', `Setting up the environment: ${total} step${total === 1 ? '' : 's'} before the agent starts`, plan.steps.map((step) => step.name).join(', '));
    try {
      for (const [index, step] of plan.steps.entries()) {
        this.checkpoint(run);
        const stepHash = setupStepHash(step, sha256Hex);
        const base = { setupHash: plan.setupHash, stepHash, index, total };
        const prior = done.get(stepHash);
        if (prior) {
          const result = { ...prior.result, id: step.id, name: step.name, required: step.required };
          this.recordSetup(run, { phase: 'end', ...base, result, sandbox: null, reusedFrom: prior.runId }, `Setup ${index + 1}/${total}: ${step.name} already done`);
          this.log(run, 'info', `Setup step "${step.name}" already completed in this worktree${prior.runId === run.runId ? '' : ` (run ${prior.runId.slice(0, 8)})`}; not run again`);
          continue;
        }
        if (before === undefined) before = (await port.fingerprint?.(workspace.worktreePath)) ?? null;
        this.recordSetup(run, { phase: 'start', ...base, step }, `Setup ${index + 1}/${total}: ${step.name}`);
        const outcome = await this.step(run.runId, `prepare:setup:${step.id}`, () => port.runStep({ runId: run.runId, step, index, workspace, signal: run.controller.signal }));
        const result = outcome.result;
        const line = describeSetupStep(result);
        this.recordSetup(run, { phase: 'end', ...base, result, sandbox: outcome.sandbox, reusedFrom: null }, line);
        const passed = result.status === 'passed';
        this.log(run, passed ? 'success' : step.required ? 'error' : 'info', line, passed ? undefined : result.log.tail.slice(-2_000) || result.detail || undefined);
        await this.step(run.runId, `prepare:setup:${step.id}:recorded`, async () => undefined);
        // A cancelled or fenced run stopped the step: that is the run's outcome, not a setup failure.
        this.checkpoint(run);
        if (passed) continue;
        if (step.required) this.failSetup(run, workspace, setupFailureOutcome(result));
        this.log(run, 'info', `Optional setup step "${step.name}" did not pass; continuing`);
      }
      if (before) {
        const after = await port.fingerprint?.(workspace.worktreePath) ?? null;
        const changed = after ? changedPaths(before, after) : [];
        if (changed.length > 0) {
          const listed = `${changed.slice(0, 20).join('\n')}${changed.length > 20 ? `\n… and ${changed.length - 20} more` : ''}`;
          this.failSetup(run, workspace, 'Setup failed: setup changed files that would be published as the agent\'s work',
            `${listed}\n\nSetup must leave the repository unchanged: ignore generated files (.gitignore) or install from the lockfile (pnpm install --frozen-lockfile, npm ci).`);
        }
      }
    } finally {
      port.cleanup(run.runId);
    }
    this.log(run, 'success', 'Environment ready; starting the agent');
  }

  /** W16a: the run fails before the agent starts; its worktree is kept (the step's output may be needed). */
  private failSetup(run: ActiveRun, workspace: RunWorkspace, line: string, details?: string): never {
    this.log(run, 'error', line, details);
    this.decide(run, { state: 'failed', reason: 'setup failed', outcome: `${line}. Worktree kept on ${workspace.branch} at ${workspace.worktreePath}` });
    // Before the early answer (unreadable steps): execute reports the failure itself.
    run.started.reject(new HttpError(422, 'SETUP_FAILED', line, details ? { details } : undefined));
    throw new SetupFailed(line);
  }

  /** W16a: journal a setup record on a relayed progress event; the scalar fields drive the UI and the control plane. */
  private recordSetup(run: ActiveRun, record: SetupStepRecord, message: string): void {
    const result = record.phase === 'end' ? record.result : null;
    const fields: Record<string, string | number | boolean | null> = {
      runState: 'preparing',
      setupPhase: record.phase,
      setupStep: record.phase === 'start' ? record.step.id : record.result.id,
      setupIndex: record.index,
      setupTotal: record.total,
      ...(result ? {
        setupStatus: result.status,
        setupRequired: result.required,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logSha256: result.log.sha256,
        logBytes: result.log.bytes,
        reused: record.phase === 'end' && record.reusedFrom !== null,
      } : {}),
    };
    const status = LEGACY_PROGRESS_STATUS.preparing;
    const text = redactSecrets(message).slice(0, MAX_LOG_MESSAGE);
    const seq = this.appendEvent(run, { kind: 'progress', payload: { status, message: text, ...fields, setupRecord: record }, relay: true, critical: true });
    if (seq === null) return;
    this.deps.events?.publish(run.taskId, run.userId, 'execution:progress', { status, message: text, ...fields, taskId: run.taskId, runId: run.runId, runSeq: seq });
    this.scheduleRelay(run.runId);
  }

  /** W16a: a run's journaled setup records, in order (unreadable ones skipped). */
  private setupRecords(runId: string): SetupStepRecord[] {
    const records: SetupStepRecord[] = [];
    let after = 0;
    for (;;) {
      const page = this.journal.events(runId, after, 1_000);
      if (page.length === 0) break;
      for (const event of page) {
        after = event.seq;
        if (event.kind !== 'progress' || event.payload.setupRecord === undefined) continue;
        const parsed = setupStepRecordSchema.safeParse(event.payload.setupRecord);
        if (parsed.success) records.push(parsed.data);
      }
    }
    return records;
  }

  /**
   * W16a: steps that passed in this worktree, by step hash — recorded by this
   * run or by the runs its follow-up chain continues in the same worktree
   * (newest first). The result is the original one; `runId` is where it ran.
   */
  private completedSetupSteps(record: RunRecord, workspace: RunWorkspace): Map<string, { runId: string; result: VerificationCheckResult }> {
    const done = new Map<string, { runId: string; result: VerificationCheckResult }>();
    let current: RunRecord | null = record;
    for (let hops = 0; current && hops < 20; hops += 1) {
      if (current.runId === record.runId || current.workspace?.worktreePath === workspace.worktreePath) {
        for (const entry of this.setupRecords(current.runId)) {
          if (entry.phase !== 'end' || entry.result.status !== 'passed' || done.has(entry.stepHash)) continue;
          done.set(entry.stepHash, { runId: entry.reusedFrom ?? current.runId, result: entry.result });
        }
      }
      const parentRunId: string | undefined = current.snapshot.followUp?.parentRunId;
      current = parentRunId ? this.journal.get(parentRunId) : null;
    }
    return done;
  }

  private promptFor(run: ActiveRun, repositoryContext: string | null = null): string {
    const snapshot = run.record.snapshot;
    let prompt = snapshot.title;
    if (snapshot.description) prompt += `\n\n${snapshot.description}`;
    if (snapshot.labels.length > 0) prompt += `\n\nLabels: ${snapshot.labels.join(', ')}`;
    const knowledge = projectKnowledgeSection(snapshot.knowledge ?? []);
    if (knowledge) prompt += `\n\n${knowledge}`;
    if (repositoryContext) prompt += `\n\n${repositoryContext}`;
    return prompt;
  }

  /**
   * W07a: the follow-up turn's session. Same runner and a saved session →
   * resume it with the review prompt (OpenCode session continue, Claude
   * `--resume`, Codex thread resume). Otherwise — another runner was chosen,
   * the runner cannot resume, or the session is gone — a fresh session in
   * the same worktree, seeded with the previous diff. Like `start`, nothing
   * is dispatched until the returned session's events are consumed.
   */
  private async startFollowUpSession(
    run: ActiveRun,
    runtime: RunRuntime,
    workspace: RunWorkspace,
    parent: RunRecord,
    followUp: RunFollowUp,
    model: { id: string; provider?: string } | undefined,
  ): Promise<StartedRuntimeSession> {
    const record = this.refresh(run);
    const request: FollowUpRequest = { message: followUp.message, comments: followUp.comments };
    const permissions = this.permissionsFor(run, runtime);
    const parentSession = parent.sessionId;
    if (parent.runner === record.runner && parentSession && runtime.resume) {
      const resume = runtime.resume.bind(runtime);
      const resumed = await this.step(run.runId, 'prepare:runtime-resume', () => resume({
        runId: run.runId,
        sessionId: parentSession,
        worktreePath: workspace.worktreePath,
        prompt: buildFollowUpPrompt({ mode: 'resume', request, branch: workspace.branch }),
        ...(model ? { model } : {}),
        permissions,
        env: {},
        signal: run.controller.signal,
      }));
      if (resumed) {
        this.log(run, 'info', `Continuing the previous ${record.runner} session ${parentSession}`);
        return resumed;
      }
      this.log(run, 'info', `The previous ${record.runner} session cannot be continued here; starting a new session seeded with the previous changes`);
    } else {
      this.log(run, 'info', parent.runner === record.runner
        ? 'No saved session to continue; starting a new session seeded with the previous changes'
        : `The task now runs on ${record.runner} (previously ${parent.runner}); starting a new session seeded with the previous changes`);
    }
    this.checkpoint(run);
    const previous = await this.step(run.runId, 'prepare:previous-work', () => this.deps.workspace.diff(workspace));
    const prompt = buildFollowUpPrompt({
      mode: 'seeded',
      request,
      branch: workspace.branch,
      task: { title: record.snapshot.title, description: record.snapshot.description, labels: record.snapshot.labels },
      previous,
    });
    return this.step(run.runId, 'prepare:runtime-start', () => runtime.start({
      runId: run.runId,
      worktreePath: workspace.worktreePath,
      systemContract: EXECUTION_SYSTEM_CONTRACT,
      prompt,
      ...(model ? { model } : {}),
      budgets: { wallClockMs: this.options.watchdog.wallClockMs },
      permissions,
      sandbox: { cwd: workspace.worktreePath, env: {} },
      env: {},
      signal: run.controller.signal,
    }));
  }

  /**
   * Journal → dispatch → receipt. A pending effect found from an earlier
   * attempt (restart) is reconciled first when a probe is given; otherwise it
   * is dispatched again only when the effect kind allows it.
   */
  private async effect(
    run: ActiveRun,
    intent: EffectIntent,
    dispatch: () => Promise<Record<string, unknown>>,
    reconcile?: () => Promise<Record<string, unknown> | null>,
  ): Promise<RunEffectRecord> {
    const existing = this.journal.effect(run.runId, intent.key);
    const record = existing ?? this.journal.recordEffect(run.runId, intent);
    if (record.status !== 'pending') return record;
    if (existing && reconcile) {
      const found = await this.step(run.runId, `effect:${intent.kind}:reconcile`, reconcile);
      if (found) {
        const settled = this.journal.settleEffect(run.runId, intent.key, 'confirmed', { ...found, reconciled: true });
        this.appendEvent(run, { kind: 'recovery', payload: { effect: intent.key, outcome: 'reconciled-present' }, critical: true });
        return settled;
      }
      this.appendEvent(run, { kind: 'recovery', payload: { effect: intent.key, outcome: 'reconciled-absent' }, critical: true });
    }
    this.journal.markDispatched(run.runId, intent.key);
    let receipt: Record<string, unknown>;
    try {
      receipt = await this.step(run.runId, `effect:${intent.kind}:dispatch`, dispatch);
    } catch (error) {
      if (!(error instanceof ServiceStopped) && !isTransientControlError(error)) {
        this.journal.settleEffect(run.runId, intent.key, 'failed', { code: errorCode(error), message: errorMessage(error).slice(0, 1_000) });
      }
      throw error;
    }
    const settled = this.journal.settleEffect(run.runId, intent.key, 'confirmed', receipt);
    await this.step(run.runId, `effect:${intent.kind}:receipt`, async () => undefined);
    return settled;
  }

  // --- event pump --------------------------------------------------------------

  private async pump(run: ActiveRun, reattached: boolean): Promise<PumpOutcome> {
    const record = this.refresh(run);
    if (reattached) {
      if (!run.runtime || !record.runtime || !record.sessionId) return { kind: 'failed', reason: 'No runtime to reattach to' };
      run.session = await this.step(run.runId, 'recovery:attach', () => {
        const runtime = run.runtime;
        const endpoint = run.record.runtime;
        const sessionId = run.record.sessionId;
        if (!runtime || !endpoint || !sessionId) throw new Error('No runtime to reattach to');
        return runtime.attach(endpoint, sessionId, run.controller.signal);
      });
      run.reducer.promptSent = true;
      run.reducer.sessionId = record.sessionId;
      this.log(run, 'info', 'Reattached to the running agent after a sidecar restart', undefined, true);
    }
    const session = run.session;
    if (!session) return { kind: 'failed', reason: 'No agent session' };
    const iterator = session.events[Symbol.asyncIterator]();
    run.watchdog = createWatchdogState(this.now());
    const watchdog = setInterval(() => {
      if (run.approvalSince !== null && approvalDeadlineExceeded(run.approvalSince, this.now())) {
        run.interrupt.resolve({ kind: 'watchdog', trip: { kind: 'approval-timeout' } });
        return;
      }
      // W15a: the run's own budgets (sealed with its snapshot) on top of the service watchdogs.
      const budgets = run.record.snapshot.budgets;
      const trip = checkWatchdogs(run.watchdog, {
        ...this.options.watchdog,
        ...(budgets?.maxUsd !== undefined ? { maxUsd: budgets.maxUsd } : {}),
        ...(budgets?.maxTokens !== undefined ? { maxTokens: budgets.maxTokens } : {}),
      }, this.now());
      if (trip) run.interrupt.resolve({ kind: 'watchdog', trip });
    }, this.options.watchdogIntervalMs);
    watchdog.unref?.();
    let promptSettled = this.journal.effect(run.runId, runEffectKey(run.runId, 'prompt.submit'))?.status !== 'pending';
    // A pull that lost the race to an interrupt stays pending: reuse it, or
    // the event it resolves with would be skipped.
    let pending: Promise<IteratorResult<AgentEvent>> | null = null;
    try {
      for (;;) {
        if (run.abandonReason) return { kind: 'abandoned', reason: run.abandonReason };
        const pull: Promise<IteratorResult<AgentEvent>> = pending ?? iterator.next();
        pending = pull;
        const next = await this.step(run.runId, 'pump:next', () => Promise.race([
          pull.then((result: IteratorResult<AgentEvent>) => ({ kind: 'event' as const, result })),
          run.interrupt.promise.then((interrupt) => ({ kind: 'interrupt' as const, interrupt })),
        ]));
        if (next.kind === 'event') pending = null;
        if (next.kind === 'interrupt') {
          const handled = await this.handleInterrupt(run, next.interrupt);
          if (handled) {
            // W07a: journal the runner's stop receipt (cancel.receipt) the stream still carries.
            if (handled.kind === 'cancelled') await this.drainAfterStop(run, iterator, pending);
            return handled;
          }
          continue;
        }
        if (next.result.done) {
          this.flushText(run);
          if (run.cancelRequested) {
            const stopped = await this.stopAgent(run);
            return stopped ? { kind: 'cancelled' } : { kind: 'failed', reason: 'Agent event stream ended during cancellation' };
          }
          return { kind: 'failed', reason: 'Agent event stream ended without a result' };
        }
        const event = next.result.value;
        if (!promptSettled && event.t !== 'session.started' && event.t !== 'heartbeat') {
          promptSettled = true;
          const key = runEffectKey(run.runId, 'prompt.submit');
          if (event.t === 'error' && event.code === 'prompt') {
            this.journal.settleEffect(run.runId, key, 'failed', { message: event.message.slice(0, 1_000) });
          } else {
            this.journal.settleEffect(run.runId, key, 'confirmed', { firstEvent: event.t });
            await this.step(run.runId, 'prompt:confirmed', async () => undefined);
          }
        }
        const outcome = await this.handleEvent(run, event);
        if (outcome) return outcome;
      }
    } finally {
      clearInterval(watchdog);
      // FE-04: whatever ended the agent, nothing it asked for stays pending.
      this.approvals.cancelRun(run.runId);
      if (iterator.return) await Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }

  /**
   * After a confirmed stop: journal what the stream still delivers (the
   * runner's `cancel.receipt` and its terminal), without interpreting it.
   * Bounded: a stream that never ends does not hold the decision.
   */
  private async drainAfterStop(run: ActiveRun, iterator: AsyncIterator<AgentEvent>, pending: Promise<IteratorResult<AgentEvent>> | null, budgetMs = 1_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    let pull = pending;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || this.stopped) return;
        pull ??= iterator.next();
        let timer: NodeJS.Timeout | undefined;
        const next = await Promise.race([
          pull,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), remaining);
            timer.unref?.();
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (!next || next.done) return;
        pull = null;
        const event = next.value;
        if (event.t !== 'message.delta' && event.t !== 'reasoning.delta' && event.t !== 'heartbeat') {
          this.appendEvent(run, { kind: 'agent', payload: agentEventPayload(event), critical: event.t === 'cancel.receipt' || event.t === 'turn.finished' });
        }
        if (event.t === 'turn.finished') return;
      }
    } catch (error) {
      logger.debug({ err: error, runId: run.runId }, '[RunEngine] stream drain after stop ended');
    }
  }

  private async handleInterrupt(run: ActiveRun, interrupt: PumpInterrupt): Promise<PumpOutcome | null> {
    run.interrupt = deferred<PumpInterrupt>();
    if (interrupt.kind === 'abandon') {
      await this.stopAgent(run, false);
      return { kind: 'abandoned', reason: interrupt.reason };
    }
    if (interrupt.kind === 'cancel') {
      this.log(run, 'info', 'Execution cancelled by user', undefined, true);
      const stopped = await this.stopAgent(run);
      if (stopped) return { kind: 'cancelled' };
      this.log(run, 'error', 'Cancellation could not be confirmed; execution remains reserved');
      this.resolveCancelWaiters(run, { success: false, error: 'Cancellation could not be confirmed; execution remains reserved' });
      run.cancelRequested = false;
      this.journal.update(run.runId, { cancelRequestedAt: null, cancelReason: null });
      return null;
    }
    const trip = interrupt.trip;
    const reason = trip.kind === 'budget' ? this.budgetReason(run, trip.reason) : trip.kind === 'approval-timeout'
      ? 'permission request was not answered in time' : `watchdog: ${trip.kind}`;
    this.log(run, 'error', `Stopping the agent: ${reason}`);
    await this.stopAgent(run);
    return { kind: 'failed', reason: `Agent stopped: ${reason}` };
  }

  /** W15a: which budget stopped the run, with the numbers (the work is kept; a follow-up can continue). */
  private budgetReason(run: ActiveRun, which: 'tokens' | 'usd' | 'wall-clock'): string {
    const budgets = run.record.snapshot.budgets;
    if (which === 'usd' && budgets?.maxUsd !== undefined) {
      return `it reached this run's cost budget ($${run.watchdog.usd.toFixed(2)} of $${budgets.maxUsd.toFixed(2)}); its work was kept — raise the budget in Settings → Execution or send a follow-up`;
    }
    if (which === 'tokens' && budgets?.maxTokens !== undefined) {
      return `it reached this run's token budget (${run.watchdog.tokens.toLocaleString('en-US')} of ${budgets.maxTokens.toLocaleString('en-US')} tokens); its work was kept — raise the budget in Settings → Execution or send a follow-up`;
    }
    return `budget exhausted (${which})`;
  }

  /** Interrupt → grace → abort; true only with a positive stop receipt. */
  private async stopAgent(run: ActiveRun, interruptFirst = true): Promise<boolean> {
    const session = run.session;
    const runtime = run.runtime;
    const record = this.refresh(run);
    const prompt = this.journal.effect(run.runId, runEffectKey(run.runId, 'prompt.submit'));
    if (!session && !record.sessionId) return true;
    if (!prompt) {
      // Nothing was submitted: the session is idle; abort is best effort.
      if (runtime && record.sessionId) await runtime.abort(record.runtime, record.sessionId).catch(() => false);
      return true;
    }
    if (interruptFirst && session) {
      await this.step(run.runId, 'stop:interrupt', () => session.interrupt()).catch(() => undefined);
      if (this.options.interruptGraceMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.interruptGraceMs));
    }
    for (let attempt = 0; attempt < this.options.abortAttempts; attempt += 1) {
      const confirmed = await this.step(run.runId, 'stop:abort', async () => {
        if (runtime && record.runtime && record.sessionId) return runtime.abort(record.runtime, record.sessionId);
        if (!session) return false;
        try {
          await session.abort();
          return true;
        } catch {
          return false;
        }
      }).catch(() => false);
      if (confirmed) return true;
    }
    return false;
  }

  private async handleEvent(run: ActiveRun, event: AgentEvent): Promise<PumpOutcome | null> {
    touchTransport(run.watchdog, this.now());
    if (event.t === 'heartbeat') return null;
    touchProgress(run.watchdog, this.now());
    if (event.t !== 'message.delta' && event.t !== 'reasoning.delta') {
      this.appendEvent(run, { kind: 'agent', payload: agentEventPayload(event), critical: event.t === 'error' || event.t === 'turn.finished' });
    }
    // W07a: some runtimes learn their resumable id only now (Codex thread
    // id); journal it so a follow-up can continue that session.
    if (event.t === 'session.started' && event.externalId && event.externalId !== 'unknown' && event.externalId !== this.refresh(run).sessionId) {
      run.record = this.journal.update(run.runId, { sessionId: event.externalId });
      run.reducer.sessionId = event.externalId;
    }
    for (const action of processAgentEvent(event, run.reducer)) {
      const outcome = await this.interpret(run, action);
      if (outcome) return outcome;
    }
    // After the reducer (which suspends the watchdogs for both).
    if (event.t === 'permission.requested') await this.onPermission(run, event);
    if (event.t === 'compaction') this.onCompaction(run, event.phase);
    return null;
  }

  /**
   * FE-04: "ask" when the run's sealed approval mode asks and its runner can
   * hold a request for an answer (Claude Code, OpenCode); otherwise the
   * service policy answers. Codex is policy-only: the log says so.
   */
  private permissionsFor(run: ActiveRun, runtime: RunRuntime): { default: 'allow' | 'deny' | 'ask' } {
    if (this.refresh(run).snapshot.approvalMode !== 'ask') return { default: this.options.permissionPolicy };
    if (runtime.approvals === 'interactive') return { default: 'ask' };
    this.log(run, 'info', `${runtime.runnerId} cannot pause for your approval; it runs under the sandbox policy instead`);
    return { default: this.options.permissionPolicy };
  }

  private async onPermission(run: ActiveRun, event: Extract<AgentEvent, { t: 'permission.requested' }>): Promise<void> {
    if (AGENT_RUN_STATES.includes(this.refresh(run).state) && run.record.state === 'running') {
      this.transition(run, 'awaiting_approval', `permission requested: ${event.tool}`);
    }
    const session = run.session;
    if (!session) return;
    const asks = run.record.snapshot.approvalMode === 'ask' && run.runtime?.approvals === 'interactive';
    let decision: ApprovalDecision = this.options.permissionPolicy;
    if (asks && run.allowedTools.has(event.tool)) {
      decision = 'allow';
      this.log(run, 'info', `Allowed (you allowed ${event.tool} for this run)`, event.detail || undefined);
    } else if (asks) {
      // The pump waits here (its watchdogs are suspended); a cancel or stop
      // denies the request so the interrupt is handled next.
      const interrupt = run.interrupt.promise;
      const { approval, outcome } = this.approvals.request({
        runId: run.runId,
        taskId: run.taskId,
        ownerUserId: run.userId,
        requestId: event.id,
        tool: event.tool,
        detail: event.detail,
        timeoutMs: this.options.approvalTimeoutMs,
      });
      this.log(run, 'info', `Waiting for your approval: ${event.tool}`, event.detail || undefined, true);
      void interrupt.then(() => this.approvals.cancelRun(run.runId));
      // The runner may withdraw the request (Claude Code control_cancel_request).
      const unsubscribe = session.onPermissionWithdrawn?.((id) => {
        if (id === event.id) this.approvals.withdraw(approval.id);
      });
      const answered = await outcome;
      unsubscribe?.();
      decision = answered.decision;
      // "For this run" is kept here, not in the runner: a runner-side
      // session grant (OpenCode `always`) would outlive the run into a
      // follow-up on the same session.
      if (answered.decision === 'allow' && answered.scope === 'run') run.allowedTools.add(event.tool);
      this.log(run, 'info', approvalLogLine(event.tool, answered), `request ${approval.id}, operation ${approval.digest.slice(0, 12)}`, true);
      if (answered.by === 'cancel') return;
      if (answered.by === 'withdrawn') {
        // Nothing waits for a reply; the agent carries on.
        run.watchdog.suspended = false;
        touchProgress(run.watchdog, this.now());
        if (this.refresh(run).state === 'awaiting_approval') this.transition(run, 'running', 'permission request withdrawn');
        return;
      }
    } else {
      run.approvalSince = this.now();
    }
    await this.step(run.runId, 'permission:reply', () => session.replyPermission(event.id, decision, 'once'));
    if (!asks) this.log(run, 'info', `Permission ${decision === 'allow' ? 'granted' : 'denied'} by policy: ${event.tool}`);
    run.approvalSince = null;
    run.watchdog.suspended = false;
    touchProgress(run.watchdog, this.now());
    if (this.refresh(run).state === 'awaiting_approval') this.transition(run, 'running', 'permission answered');
  }

  private onCompaction(run: ActiveRun, phase: 'start' | 'end'): void {
    const state = this.refresh(run).state;
    if (phase === 'start' && state === 'running') this.transition(run, 'compacting', 'context compaction started');
    if (phase === 'end' && state === 'compacting') this.transition(run, 'running', 'context compaction finished');
  }

  private flushText(run: ActiveRun): void {
    if (run.text.trim()) this.log(run, 'agent', run.text.trim());
    if (run.reasoning.trim()) this.log(run, 'agent', `Thinking: ${run.reasoning.trim()}`);
    run.text = '';
    run.reasoning = '';
  }

  private updateCounters(run: ActiveRun, patch: Partial<RunRecord['counters']>): void {
    run.record = this.journal.update(run.runId, { counters: { ...emptyCounters(), ...this.refresh(run).counters, ...patch } });
  }

  /** Every reducer action, exhaustively. */
  private async interpret(run: ActiveRun, action: AgentAction): Promise<PumpOutcome | null> {
    switch (action.type) {
      case 'ignore':
        return null;
      case 'log':
        this.flushText(run);
        this.log(run, action.level, action.message, action.details);
        return null;
      case 'broadcastProgress':
        this.progress(run, action.status, action.message, action.data ?? {});
        return null;
      case 'flushDeltaBuffer':
        this.flushText(run);
        return null;
      case 'appendTextDelta':
        run.text += action.delta;
        if (run.text.length >= MAX_TEXT_BUFFER) this.flushText(run);
        return null;
      case 'appendReasoningDelta':
        run.reasoning += action.delta;
        if (run.reasoning.length >= MAX_TEXT_BUFFER) this.flushText(run);
        return null;
      case 'markThinking':
        this.progress(run, 'executing', 'Agent is thinking...');
        return null;
      case 'setPromptSent':
        run.reducer.promptSent = true;
        if (!run.record.counters.promptSent) this.updateCounters(run, { promptSent: true });
        return null;
      case 'incrementFilesChanged':
        run.reducer.filesChanged += 1;
        this.updateCounters(run, { filesChanged: run.reducer.filesChanged });
        return null;
      case 'noteToolCompleted':
        run.reducer.toolsExecuted += 1;
        this.updateCounters(run, { toolsExecuted: run.reducer.toolsExecuted });
        return null;
      case 'resetEventStreamTimeout':
        touchProgress(run.watchdog, this.now());
        return null;
      case 'handleSessionComplete':
        this.flushText(run);
        return { kind: 'finished' };
      case 'failExecution':
        this.flushText(run);
        if (run.cancelRequested && action.message === 'Run interrupted') {
          return (await this.stopAgent(run, false)) ? { kind: 'cancelled' } : { kind: 'failed', reason: action.message };
        }
        return { kind: 'failed', reason: action.message, ...(action.details ? { detail: action.details } : {}) };
      case 'sessionError':
        this.flushText(run);
        this.log(run, 'error', action.headline, action.errorDetail);
        if (action.errorDetail === 'cancel_unconfirmed') return { kind: 'unconfirmed-stop', detail: action.headline };
        return { kind: 'failed', reason: action.isAuthError ? 'Invalid API key — update it in Settings → AI Providers' : action.headline, detail: action.errorDetail };
      case 'replyPermission': {
        const session = run.session;
        if (session) {
          const decision = action.reply === 'reject' ? 'deny' : 'allow';
          await this.step(run.runId, 'permission:reply', () => session.replyPermission(action.permissionId, decision, action.reply === 'always' ? 'session' : 'once'));
        }
        return null;
      }
      case 'suspendWatchdog':
        run.watchdog.suspended = true;
        return null;
      case 'resumeWatchdog':
        run.watchdog.suspended = false;
        touchProgress(run.watchdog, this.now());
        return null;
      case 'recordUsage': {
        const usage: RunUsage = run.record.usage ?? { messages: {} };
        usage.messages[action.messageId] = {
          cost: action.cost,
          input: action.inputTokens,
          output: action.outputTokens,
          reasoning: action.reasoningTokens,
          cacheRead: action.cacheReadTokens,
          cacheWrite: action.cacheWriteTokens,
        };
        run.record = this.journal.update(run.runId, { usage });
        run.watchdog.tokens = Object.values(usage.messages).reduce((sum, message) => sum + message.input + message.output, 0);
        run.watchdog.usd = Object.values(usage.messages).reduce((sum, message) => sum + message.cost, 0);
        return null;
      }
      case 'checkpointThenStop':
        this.flushText(run);
        await this.stopAgent(run);
        return { kind: 'failed', reason: `Agent stopped: ${action.reason}` };
      case 'touchHeartbeat':
        touchTransport(run.watchdog, this.now());
        return null;
      default: {
        const unhandled: never = action;
        throw new Error(`Unhandled reducer action ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private async afterPump(run: ActiveRun, outcome: PumpOutcome): Promise<void> {
    switch (outcome.kind) {
      case 'finished':
        await this.publish(run);
        return;
      case 'cancelled':
        this.decide(run, { state: 'cancelled', reason: 'cancelled', outcome: this.retainedOutcome(run, 'Execution cancelled') });
        return;
      case 'abandoned':
        this.decide(run, { state: 'abandoned', reason: outcome.reason, outcome: null });
        return;
      case 'failed': {
        await this.stopAgent(run, false);
        const message = outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason;
        this.log(run, 'error', outcome.reason, outcome.detail);
        this.decide(run, { state: 'failed', reason: outcome.reason, outcome: this.retainedOutcome(run, message) });
        return;
      }
      case 'unconfirmed-stop': {
        // The runner ended its stream without confirming the stop the user
        // asked for. Try once more; a positive receipt makes it a
        // cancellation, otherwise the agent may still be running: never
        // publish, never call it cancelled — recovery_required, work retained.
        if (await this.stopAgent(run, false)) {
          this.decide(run, { state: 'cancelled', reason: 'cancelled (stop confirmed on retry)', outcome: this.retainedOutcome(run, 'Execution cancelled') });
          return;
        }
        this.decide(run, {
          state: 'recovery_required',
          reason: 'the agent could not be confirmed stopped',
          outcome: this.retainedOutcome(run, `Cancellation could not be confirmed (${outcome.detail}); the agent may still have been running`),
        });
        return;
      }
    }
  }

  private retainedOutcome(run: ActiveRun, message: string): string {
    const workspace = this.refresh(run).workspace;
    const dispatched = this.journal.effect(run.runId, runEffectKey(run.runId, 'prompt.submit')) !== null;
    return dispatched && workspace ? `${message}. Work retained on ${workspace.branch} at ${workspace.worktreePath}` : message;
  }

  // --- publication (finishing) ------------------------------------------------

  private async publish(run: ActiveRun): Promise<void> {
    const entered = this.refresh(run).state;
    const manifest = run.record.verification?.manifest ?? null;
    // W11a: verify before publishing when the sealed manifest asks for it.
    const verify = Boolean(this.deps.verification) && manifestRequiresVerification(manifest);
    if (entered !== 'finishing' && entered !== 'verifying') {
      this.transition(run, verify ? 'verifying' : 'finishing', verify ? 'agent turn completed; verifying the commit before publication' : 'agent turn completed');
    }
    const record = run.record;
    const workspace = record.workspace;
    if (!workspace) throw new Error('No workspace to publish');
    const channel = run.channel;
    if (!channel) throw new HttpError(409, 'ATTEMPT_REQUIRED', 'The run has no control-plane attempt');
    this.checkpoint(run);
    const followUp = record.snapshot.followUp ?? null;
    this.progress(run, 'committing', 'Committing changes...');
    const commitKey = runEffectKey(run.runId, 'git.commit');
    const commitTitle = followUp ? `address review on ${record.snapshot.title}` : record.snapshot.title;
    const commit = await this.effect(run, { key: commitKey, kind: 'git.commit', intent: { branch: workspace.branch } },
      async () => {
        const result = await this.deps.publication.commit({ worktree: workspace.worktreePath, title: commitTitle, runId: run.runId, key: commitKey });
        return result.status === 'committed' ? { status: 'committed', sha: result.sha } : { status: 'no_changes' };
      },
      async () => {
        const sha = await this.deps.publication.findCommit({ worktree: workspace.worktreePath, key: commitKey });
        return sha ? { status: 'committed', sha } : null;
      });
    let sha: string | null;
    let changedThisTurn = true;
    if (commit.receipt?.status === 'no_changes') {
      // W07a: a follow-up turn that changed nothing still publishes the
      // branch as it stands when earlier turns left commits on it (e.g. a
      // push or PR that failed before): the PR is reused or created.
      const head = followUp
        ? await this.step(run.runId, 'publish:branch-head', () => this.deps.publication.branchHead({ worktree: workspace.worktreePath, baseRef: workspace.baseRef }))
        : null;
      if (!head?.sha || head.ahead === false) {
        const outcome = followUp ? 'Follow-up finished without code changes' : 'Agent finished without making code changes';
        this.log(run, 'error', outcome);
        this.decide(run, { state: 'failed', reason: 'no changes', outcome });
        return;
      }
      sha = head.sha;
      changedThisTurn = false;
      this.log(run, 'info', `No new changes in this turn; publishing ${workspace.branch} at ${sha.slice(0, 12)}`);
    } else {
      sha = typeof commit.receipt?.sha === 'string' ? commit.receipt.sha : null;
      if (commit.status !== 'confirmed' || !sha) throw new Error('Commit was not confirmed');
      this.log(run, 'info', `Committed ${sha.slice(0, 12)} on ${workspace.branch}`);
    }
    const commitSha = sha;
    this.checkpoint(run);

    if (this.refresh(run).state === 'verifying') {
      if (!manifest) throw new Error('No verification manifest for a verifying run');
      const allowed = await this.verifyCommit(run, workspace, commitSha, manifest);
      if (!allowed) return;
      this.checkpoint(run);
    }

    // Re-authorizes the initiator and requires the task to still be bound to this attempt.
    // W10a: push-only credential (contents:write) for ls-remote + push.
    const token = await this.step(run.runId, 'publish:git-credential', () => channel.gitCredential('push'));
    this.checkpoint(run);
    const pushKey = runEffectKey(run.runId, 'git.push', commitSha);
    const push = await this.effect(run, { key: pushKey, kind: 'git.push', intent: { branch: workspace.branch, sha: commitSha } },
      async () => {
        const remote = await this.deps.publication.remoteSha({ worktree: workspace.worktreePath, branch: workspace.branch, token });
        if (remote === commitSha) return { sha: commitSha, remote, alreadyPresent: true };
        // Only ever fast-forward (W07a: a follow-up builds on the branch an
        // earlier turn pushed); a branch someone else moved is never clobbered.
        if (remote && !(await this.deps.publication.isAncestor({ worktree: workspace.worktreePath, ancestor: remote, descendant: commitSha }))) {
          throw new Error(`Remote branch ${workspace.branch} moved to ${remote.slice(0, 12)}; refusing to overwrite it`);
        }
        await this.deps.publication.push({ worktree: workspace.worktreePath, branch: workspace.branch, sha: commitSha, token, expectedRemote: remote });
        return { sha: commitSha, ...(remote ? { fastForwardFrom: remote } : {}) };
      },
      async () => {
        const remote = await this.deps.publication.remoteSha({ worktree: workspace.worktreePath, branch: workspace.branch, token });
        return remote === commitSha ? { sha: commitSha } : null;
      });
    if (push.status !== 'confirmed') throw new Error('Push was not confirmed');
    this.log(run, 'info', `Pushed ${workspace.branch}`);
    this.checkpoint(run);

    const repository = record.snapshot.repository;
    if (!repository) {
      const outcome = 'Changes committed but no repository linked to create PR';
      this.log(run, 'error', outcome);
      this.decide(run, { state: 'failed', reason: 'no repository', outcome });
      return;
    }
    this.progress(run, 'creating_pr', 'Creating pull request...');
    // W10a: the PR API gets its own credential (pull_requests:write), requested right before use.
    const prToken = await this.step(run.runId, 'publish:pr-credential', () => channel.gitCredential('pull_request'));
    this.checkpoint(run);
    const pr = await this.effect(run, {
      key: runEffectKey(run.runId, 'pr.create', workspace.branch),
      kind: 'pr.create',
      intent: { fullName: repository.fullName, branch: workspace.branch, base: repository.defaultBranch },
    },
    async () => {
      const existing = await this.deps.publication.findPullRequest({ fullName: repository.fullName, branch: workspace.branch, base: repository.defaultBranch, token: prToken });
      if (existing) return { url: existing, reused: true };
      const url = await this.deps.publication.createPullRequest({
        fullName: repository.fullName,
        branch: workspace.branch,
        base: repository.defaultBranch,
        title: record.snapshot.title || 'Task',
        body: record.snapshot.description || `Automated PR created by OpenLinear\n\n## Task\n${record.snapshot.title}`,
        token: prToken,
      });
      return { url };
    },
    async () => {
      const url = await this.deps.publication.findPullRequest({ fullName: repository.fullName, branch: workspace.branch, base: repository.defaultBranch, token: prToken });
      return url ? { url } : null;
    });
    const prUrl = typeof pr.receipt?.url === 'string' ? pr.receipt.url : null;
    if (pr.status !== 'confirmed' || !prUrl) throw new Error('Pull request creation was not confirmed; pushed branch retained');
    if (run.cancelRequested) {
      // The PR landed before the cancellation could stop it: report it, do not succeed.
      this.decide(run, { state: 'cancelled', reason: 'cancelled after publication', outcome: `Execution cancelled; pull request already created: ${prUrl}`, prUrl });
      return;
    }
    const reused = pr.receipt?.reused === true;
    this.log(run, 'success', reused ? 'Pull request updated' : 'Pull request created', prUrl);
    const counters = this.refresh(run).counters;
    const summary = `${counters.filesChanged} file${counters.filesChanged !== 1 ? 's' : ''} changed, ${counters.toolsExecuted} tools executed`;
    const verified = this.verificationNote(run.runId, commitSha);
    const outcome = followUp
      ? `Follow-up: ${changedThisTurn ? summary : 'no new changes'}; pull request ${reused ? 'updated' : 'created'}`
      : summary;
    this.decide(run, {
      state: 'succeeded',
      reason: reused ? 'pull request updated' : 'pull request created',
      outcome: verified ? `${outcome}; ${verified}` : outcome,
      prUrl,
    });
  }

  /** W11a: one clause for the success outcome ("verified on abc… (3/3 checks)" / "verification failed …"). */
  private verificationNote(runId: string, commitSha: string): string | null {
    const effect = this.journal.effect(runId, runEffectKey(runId, 'verify.run', commitSha));
    if (effect?.status !== 'confirmed') return null;
    const parsed = verificationResultSchema.safeParse(effect.receipt?.result);
    if (!parsed.success) return null;
    const line = describeVerification(parsed.data);
    return parsed.data.status === 'passed' ? line.replace(/^Verification passed/, 'verified') : `${line.charAt(0).toLowerCase()}${line.slice(1)} (policy: ${parsed.data.policy})`;
  }

  /**
   * W11a verification step (state `verifying`): run the sealed checks against
   * `commitSha` in a pristine checkout (journaled effect `verify.run`, keyed by
   * the commit: a recorded result is reused after a restart, a pending one is
   * re-run), persist the evidence (journal receipt + `verification.record`
   * projection), then apply the publication policy. Returns whether
   * publication may proceed; when it may not, the terminal decision is made.
   */
  private async verifyCommit(run: ActiveRun, workspace: RunWorkspace, commitSha: string, manifest: VerificationManifest): Promise<boolean> {
    const port = this.deps.verification;
    if (!port) throw new Error('verification port missing');
    const record = this.refresh(run);
    const key = runEffectKey(run.runId, 'verify.run', commitSha);
    const prior = this.journal.effect(run.runId, key);
    if (prior?.status === 'pending') this.log(run, 'info', `Re-running verification of ${commitSha.slice(0, 12)} (the previous attempt did not record a result)`, undefined, true);
    if (prior?.status !== 'confirmed') {
      this.progress(run, 'committing', `Verifying ${commitSha.slice(0, 12)}: ${manifest.checks.length} check${manifest.checks.length === 1 ? '' : 's'}...`, { runState: 'verifying' });
    }
    const effect = await this.effect(run, {
      key,
      kind: 'verify.run',
      intent: { sha: commitSha, checksHash: manifest.checksHash, policy: manifest.policy, checks: manifest.checks.map((check) => check.id).join(',') },
    }, async () => {
      const result = await port.run({
        runId: run.runId,
        manifest,
        workspace,
        commitSha,
        runner: record.runner,
        signal: run.controller.signal,
        onProgress: (progress) => this.onVerificationProgress(run, progress),
      });
      return { result };
    });
    const parsed = verificationResultSchema.safeParse(effect.receipt?.result);
    if (effect.status !== 'confirmed' || !parsed.success) throw new Error('Verification did not record a result');
    const result = parsed.data;
    if (prior?.status === 'confirmed') this.log(run, 'info', `Reusing the recorded verification of ${commitSha.slice(0, 12)} (${result.status})`, undefined, true);
    for (const warning of result.warnings) this.log(run, 'info', `Verification note: ${warning}`);
    const decision = verificationPublicationDecision(result.policy, result.status);
    // Evidence first (journaled before any publication effect), projected now and again at the terminal.
    const recordKey = runEffectKey(run.runId, 'verification.record', commitSha);
    this.journal.recordEffect(run.runId, {
      key: recordKey,
      kind: 'verification.record',
      intent: { sha: commitSha, publication: decision.allowed ? 'allowed' : 'blocked' },
    });
    await this.projectVerification(run, recordKey);
    const line = describeVerification(result);
    if (!decision.allowed) {
      this.log(run, 'error', `${line}; nothing will be published`, decision.reason);
      this.decide(run, {
        state: 'failed',
        reason: 'verification failed',
        outcome: this.retainedOutcome(run, `${line}; nothing was published (policy: require-pass)`),
      });
      return false;
    }
    this.log(run, result.status === 'passed' ? 'success' : 'error', result.status === 'passed' ? line : `${line}; publishing anyway (policy: ${result.policy})`, result.detail ?? undefined);
    this.checkpoint(run);
    this.transition(run, 'finishing', result.status === 'passed' ? 'verification passed' : `verification ${result.status}; publishing (policy: ${result.policy})`, {
      payload: { verification: result.status, commit: commitSha, checksHash: result.checksHash },
    });
    return true;
  }

  private onVerificationProgress(run: ActiveRun, progress: VerificationProgress): void {
    if (progress.phase === 'start') {
      this.progress(run, 'committing', `Running check ${progress.index + 1}/${progress.total}: ${progress.check.name}`, { runState: 'verifying' });
      return;
    }
    const result = progress.result;
    if (!result) return;
    const label = `Check "${result.name}"${result.required ? '' : ' (informational)'}`;
    const verdict = result.status === 'passed' ? 'passed' : result.status === 'timed_out' ? 'timed out' : result.status === 'error' ? 'could not run' : result.status;
    this.log(run, result.status === 'passed' ? 'success' : 'error', `${label} ${verdict} (${checkSummary(result)})`, result.status === 'passed' ? undefined : result.log.tail.slice(-2_000) || result.detail || undefined);
  }

  /** Best-effort immediate projection of the evidence; a pending record is re-driven with the terminal projection. */
  private async projectVerification(run: ActiveRun, key: string): Promise<void> {
    const effect = this.journal.effect(run.runId, key);
    const channel = run.channel;
    if (effect?.status !== 'pending' || !channel) return;
    try {
      this.journal.markDispatched(run.runId, key);
      const receipt = await this.step(run.runId, 'effect:verification.record:dispatch', () => this.dispatchControl(this.refresh(run), channel, effect));
      this.journal.settleEffect(run.runId, key, 'confirmed', receipt);
    } catch (error) {
      if (error instanceof ServiceStopped) throw error;
      if (isAuthorityLost(error)) throw error;
      if (isTransientControlError(error)) {
        logger.warn({ err: error, runId: run.runId }, '[RunEngine] verification evidence not recorded yet; retried with the terminal projection');
        return;
      }
      this.journal.settleEffect(run.runId, key, 'failed', { code: errorCode(error), message: errorMessage(error).slice(0, 1_000) });
      logger.warn({ err: error, runId: run.runId }, '[RunEngine] the control plane refused the verification evidence');
    }
  }

  // --- terminal decision and projection --------------------------------------

  /**
   * W12a: the pull request a follow-up's parent run published, if the task
   * should keep it when this turn doesn't succeed. Not under a sealed
   * require-pass policy: there `done` needs this attempt's own passing
   * verification, so the turn projects `cancelled` as before.
   */
  private publishedBeforeFollowUp(record: RunRecord): string | null {
    const parentRunId = record.snapshot.followUp?.parentRunId;
    if (!parentRunId) return null;
    if (record.verification?.manifest.policy === 'require-pass') return null;
    let parentId: string | undefined = parentRunId;
    // Walk back through earlier follow-ups to the turn that published.
    for (let hops = 0; parentId && hops < 20; hops += 1) {
      const parent = this.journal.get(parentId);
      if (!parent) return null;
      if (parent.state === 'succeeded' && parent.terminal?.prUrl) return parent.terminal.prUrl;
      if (parent.terminal?.prUrl && parent.snapshot.followUp) return parent.terminal.prUrl;
      parentId = parent.snapshot.followUp?.parentRunId;
    }
    return null;
  }

  private decide(run: ActiveRun, input: { state: TerminalRunState; reason: string; outcome: string | null; prUrl?: string | null; claimed?: boolean }): boolean {
    const record = this.refresh(run);
    if (isTerminalRunState(record.state)) return false;
    // A pending claim may have landed: project as claimed (a refused
    // projection is definitive and harmless; a missing one leaves the task stuck).
    const claimStatus = this.journal.effect(run.runId, runEffectKey(run.runId, 'attempt.claim'))?.status;
    const claimed = input.claimed ?? (run.claimed || claimStatus === 'confirmed' || claimStatus === 'pending');
    const effects: EffectIntent[] = [];
    if (input.state !== 'abandoned' && record.attemptId && record.capability) {
      if (claimed) {
        if (input.state === 'cancelled') effects.push({ key: runEffectKey(run.runId, 'cancel.ack'), kind: 'cancel.ack', intent: {} });
        // W12a: a follow-up turn that failed or was cancelled leaves the task's
        // published pull request as it was: the task stays done with that PR.
        const keptPr = input.state === 'failed' || input.state === 'cancelled' ? this.publishedBeforeFollowUp(record) : null;
        if (keptPr) {
          // Truthful about the PR: a turn cancelled after its push already updated it.
          const pushed = this.journal.effects(run.runId).some((effect) => effect.kind === 'git.push' && effect.status === 'confirmed');
          const detail = input.state === 'failed' && input.outcome ? `: ${input.outcome}` : '';
          input = {
            ...input,
            prUrl: input.prUrl ?? keptPr,
            outcome: `Follow-up ${input.state === 'cancelled' ? 'cancelled' : 'failed'}${detail}; ${pushed ? 'the pull request includes the commits this turn pushed' : 'the pull request is unchanged'}`,
          };
        }
        const terminalStatus = input.state === 'succeeded' || keptPr ? 'done' : 'cancelled';
        const elapsedMs = Math.max(0, Math.round(this.now() - record.createdAt));
        const body: ExecutionTerminalInput = {
          status: terminalStatus,
          executionElapsedMs: Math.min(elapsedMs, 2_147_483_647),
          executionProgress: input.state === 'succeeded' ? 100 : this.estimateProgress(record),
          ...(input.state === 'succeeded' ? {} : { executionPausedAt: new Date(this.now()).toISOString() }),
          ...(input.prUrl ? { prUrl: input.prUrl } : {}),
          ...(input.outcome ? { outcome: input.outcome.slice(0, 4_000) } : {}),
        };
        effects.push({ key: runEffectKey(run.runId, 'task.terminal', terminalStatus), kind: 'task.terminal', intent: { ...body } });
        const runStatus: ExecutionRunInput['status'] = input.state === 'succeeded' ? 'succeeded' : input.state === 'cancelled' ? 'cancelled' : 'failed';
        const usage = sumUsage(record.usage);
        const runBody: ExecutionRunInput = {
          status: runStatus,
          usage: {
            ...(usage.costUsd > 0 ? { costUsd: Number(usage.costUsd.toFixed(6)) } : {}),
            ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
            ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
            ...(usage.cachedInputTokens > 0 ? { cachedInputTokens: usage.cachedInputTokens } : {}),
            ...(usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          },
          ...(input.prUrl ? { prUrl: input.prUrl } : {}),
          ...(runStatus === 'failed' ? { errorMessage: (input.outcome ?? input.reason).slice(0, 1_000) } : {}),
          ...(runStatus === 'cancelled' ? { errorMessage: 'cancelled by user' } : {}),
        };
        effects.push({ key: runEffectKey(run.runId, 'run.finalize', runStatus), kind: 'run.finalize', intent: { ...runBody } });
      }
      effects.push({ key: runEffectKey(run.runId, 'attempt.close'), kind: 'attempt.close', intent: { reason: input.state === 'succeeded' ? 'completed' : input.state } });
    }
    try {
      this.transition(run, input.state, input.reason, {
        terminal: { state: input.state, reason: input.reason.slice(0, 1_000), outcome: input.outcome, prUrl: input.prUrl ?? null, claimed },
        effects,
      });
    } catch (error) {
      if (error instanceof RunTransitionError) return false;
      throw error;
    }
    // Local effects nobody will reconcile after the decision: settle them as
    // unreconciled (the outcome already says the work is retained).
    for (const effect of this.journal.effects(run.runId)) {
      if (effect.status === 'pending' && !CONTROL_EFFECT_ORDER.includes(effect.kind)) {
        this.journal.settleEffect(run.runId, effect.key, 'failed', { unreconciled: true, dispatches: effect.dispatches, reason: 'run reached a terminal decision' });
      }
    }
    return true;
  }

  private estimateProgress(record: RunRecord): number {
    const base = Math.min(record.counters.toolsExecuted * 5, 40);
    const files = Math.min(record.counters.filesChanged * 10, 30);
    const minutes = (this.now() - record.createdAt) / 60_000;
    return Math.min(Math.round(base + files + Math.min(minutes * 3, 20)), 95);
  }

  /** Decide the terminal outcome for an error thrown anywhere in the drive. */
  private async decideFromError(run: ActiveRun, error: unknown): Promise<void> {
    if (error instanceof ServiceStopped || this.stopped) return;
    try {
      await this.decideFromErrorUnsafe(run, error);
    } catch (decisionError) {
      logger.error({ err: decisionError, runId: run.runId }, '[RunEngine] terminal decision after an error failed');
    }
  }

  private async decideFromErrorUnsafe(run: ActiveRun, error: unknown): Promise<void> {
    const record = this.refresh(run);
    if (isTerminalRunState(record.state)) return;
    if (error instanceof RunSignal && error.signal === 'abandon') {
      await this.stopAgent(run, false).catch(() => false);
      this.decide(run, { state: 'abandoned', reason: error.message, outcome: null });
      return;
    }
    if (isAuthorityLost(error)) {
      await this.stopAgent(run, false).catch(() => false);
      this.decide(run, { state: 'abandoned', reason: `control plane refused the attempt (${errorCode(error) ?? 'unknown'})`, outcome: null });
      return;
    }
    if (error instanceof RunSignal && error.signal === 'cancel') {
      const stopped = await this.stopAgent(run).catch(() => false);
      // W11a: in `verifying` the agent's turn is already over; only checks were running (stopped by the abort).
      if (stopped || record.state === 'finishing' || record.state === 'verifying' || record.state === 'preparing' || record.state === 'queued') {
        const published = this.publishedSummary(run);
        this.decide(run, { state: 'cancelled', reason: 'cancelled', outcome: this.retainedOutcome(run, published ? `Execution cancelled; ${published}` : 'Execution cancelled') });
        return;
      }
    }
    const message = errorMessage(error);
    logger.error({ err: error, runId: run.runId, state: record.state }, '[RunEngine] run failed');
    if (record.state === 'preparing' || record.state === 'queued') {
      this.log(run, 'error', 'Failed to start the agent', message);
      const claimed = this.journal.effect(run.runId, runEffectKey(run.runId, 'attempt.claim'))?.status === 'confirmed';
      if (claimed || run.session) await this.stopAgent(run, false).catch(() => false);
      this.decide(run, { state: 'failed', reason: message, outcome: `Failed to initialize agent execution: ${message}` });
      run.started.reject(error);
      // A follow-up's adopted worktree holds earlier work: never released here.
      if (!this.journal.effect(run.runId, runEffectKey(run.runId, 'prompt.submit')) && record.workspace?.owned && !record.workspace.continuedFrom) {
        await this.deps.workspace.release(record.workspace).catch((releaseError: unknown) => {
          logger.warn({ err: releaseError, runId: run.runId }, '[RunEngine] setup workspace retained after a failed release');
        });
      }
      return;
    }
    await this.stopAgent(run, false).catch(() => false);
    this.log(run, 'error', record.state === 'finishing' ? 'Post-execution failed' : 'Execution failed', message);
    this.decide(run, { state: 'failed', reason: message, outcome: this.retainedOutcome(run, message) });
  }

  private publishedSummary(run: ActiveRun): string | null {
    const pushed = this.journal.latestEffect(run.runId, 'git.push');
    const pr = this.journal.latestEffect(run.runId, 'pr.create');
    if (pr?.status === 'confirmed' && typeof pr.receipt?.url === 'string') return `pull request already created: ${pr.receipt.url}`;
    if (pr?.status === 'pending') return 'a pull request request was already sent and may exist';
    if (pushed?.status === 'confirmed') return 'branch already pushed';
    if (pushed?.status === 'pending') return 'a push was already dispatched and may have landed';
    return null;
  }

  /** Project the terminal decision to the control plane (idempotent; retried while unreachable). */
  private project(runId: string): Promise<void> {
    const existing = this.projections.get(runId);
    if (existing) return existing;
    const projection = (async () => {
      try {
        await this.projectOnce(runId);
      } finally {
        this.projections.delete(runId);
      }
    })();
    this.projections.set(runId, projection);
    return projection;
  }

  private async projectOnce(runId: string): Promise<void> {
    const record = this.journal.get(runId);
    if (!record || !isTerminalRunState(record.state)) return;
    const channel = this.channelFor(runId);
    if (record.state === 'abandoned' || !channel) {
      // Fenced or attempt-less: nothing can be delivered under this attempt any more.
      this.journal.ackRelay(runId, record.lastSeq);
      for (const effect of this.journal.effects(runId).filter((candidate) => candidate.status === 'pending' && CONTROL_EFFECT_ORDER.includes(candidate.kind))) {
        this.journal.settleEffect(runId, effect.key, 'failed', { code: 'ATTEMPT_REQUIRED' });
      }
      return;
    }
    const pending = this.journal.effects(runId)
      .filter((effect) => effect.status === 'pending' && CONTROL_EFFECT_ORDER.includes(effect.kind))
      .sort((a, b) => CONTROL_EFFECT_ORDER.indexOf(a.kind) - CONTROL_EFFECT_ORDER.indexOf(b.kind));
    for (const effect of pending) {
      if (effect.kind === 'attempt.close') {
        await this.flushRelay(runId);
        if (this.journal.unrelayed(runId, 1).length > 0) {
          // The relay could not drain (control plane unreachable or rate
          // limiting): closing now would strand those events forever. Retry
          // the projection later; the close waits for the relay.
          this.retryLater(() => this.project(runId), this.relays.get(runId)?.failures ?? 1);
          return;
        }
        const logs = this.journalLogs(runId);
        if (logs.length > 0) {
          await channel.persistLogs(logs).catch((error: unknown) => {
            logger.warn({ err: error, runId }, '[RunEngine] log snapshot not persisted');
          });
        }
      }
      try {
        this.journal.markDispatched(runId, effect.key);
        const receipt = await this.step(runId, `effect:${effect.kind}:dispatch`, () => this.dispatchControl(record, channel, effect));
        this.journal.settleEffect(runId, effect.key, 'confirmed', receipt);
        await this.step(runId, `effect:${effect.kind}:receipt`, async () => undefined);
      } catch (error) {
        if (error instanceof ServiceStopped) return;
        if (isAuthorityLost(error)) {
          for (const rest of this.journal.effects(runId).filter((candidate) => candidate.status === 'pending' && CONTROL_EFFECT_ORDER.includes(candidate.kind))) {
            this.journal.settleEffect(runId, rest.key, 'failed', { code: errorCode(error) ?? 'AUTHORITY_LOST', message: errorMessage(error).slice(0, 500) });
          }
          return;
        }
        if (isTransientControlError(error)) {
          this.retryLater(() => this.project(runId), effect.dispatches);
          return;
        }
        this.journal.settleEffect(runId, effect.key, 'failed', { code: errorCode(error), message: errorMessage(error).slice(0, 1_000) });
      }
    }
    // Close confirmed (or refused): anything still unrelayed can no longer be delivered.
    const close = this.journal.effect(runId, runEffectKey(runId, 'attempt.close'));
    if (close?.status !== 'pending') {
      const remaining = this.journal.unrelayed(runId, 1);
      if (remaining.length > 0) {
        const last = this.journal.get(runId)?.lastSeq ?? 0;
        if (close) logger.warn({ runId, undelivered: last - (this.journal.get(runId)?.relayAckSeq ?? 0) }, '[RunEngine] events after the attempt closed were not relayed');
        else await this.flushRelay(runId);
        if (close) this.journal.ackRelay(runId, last);
      }
    }
  }

  private async dispatchControl(record: RunRecord, channel: AttemptChannel, effect: RunEffectRecord): Promise<Record<string, unknown>> {
    switch (effect.kind) {
      case 'cancel.ack':
        await channel.acknowledgeCancellation();
        return { acknowledged: true };
      case 'task.terminal': {
        const status = effect.intent.status === 'done' ? 'done' : 'cancelled';
        const body: ExecutionTerminalInput = { status };
        if (typeof effect.intent.executionElapsedMs === 'number') body.executionElapsedMs = effect.intent.executionElapsedMs;
        if (typeof effect.intent.executionProgress === 'number') body.executionProgress = effect.intent.executionProgress;
        if (typeof effect.intent.executionPausedAt === 'string') body.executionPausedAt = effect.intent.executionPausedAt;
        if (typeof effect.intent.prUrl === 'string') body.prUrl = effect.intent.prUrl;
        if (typeof effect.intent.outcome === 'string') body.outcome = effect.intent.outcome;
        const result = await channel.writeTerminal(body);
        if (result.task) this.deps.events?.publish(record.taskId, record.userId, 'task:updated', result.task);
        return { status, repeated: result.repeated };
      }
      case 'run.finalize': {
        const status = effect.intent.status === 'succeeded' ? 'succeeded' : effect.intent.status === 'cancelled' ? 'cancelled' : 'failed';
        const usage = effect.intent.usage && typeof effect.intent.usage === 'object' ? effect.intent.usage : {};
        const body: ExecutionRunInput = { status, usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === 'number')) };
        if (typeof effect.intent.prUrl === 'string') body.prUrl = effect.intent.prUrl;
        if (typeof effect.intent.errorMessage === 'string') body.errorMessage = effect.intent.errorMessage;
        const result = await channel.finalizeRun(body);
        return { status, finalized: result.finalized };
      }
      case 'attempt.close': {
        const closed = await channel.close(typeof effect.intent.reason === 'string' ? effect.intent.reason : undefined);
        return { status: closed.status, closeReason: closed.closeReason };
      }
      case 'verification.record': {
        // Rebuilt from the journaled verify.run receipt for the same commit:
        // deterministic, so every resend carries the identical body.
        const sha = typeof effect.intent.sha === 'string' ? effect.intent.sha : '';
        const source = this.journal.effect(record.runId, runEffectKey(record.runId, 'verify.run', sha));
        const parsed = verificationResultSchema.safeParse(source?.receipt?.result);
        if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'no recorded verification result for this commit');
        const publication = effect.intent.publication === 'blocked' ? 'blocked' : 'allowed';
        const recorded = await channel.recordVerification(verificationEvidence(parsed.data, record.runId, publication));
        return { id: recorded.id, repeated: recorded.repeated };
      }
      case 'attempt.claim':
      case 'prompt.submit':
      case 'git.commit':
      case 'git.push':
      case 'pr.create':
      case 'verify.run':
        throw new Error(`${effect.kind} is not a control-plane projection`);
    }
  }

  private retryLater(fn: () => Promise<unknown>, attempt: number): void {
    if (this.stopped) return;
    const delay = Math.min(this.options.retryBaseMs * 2 ** Math.min(attempt, 10), this.options.retryMaxMs);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void fn().catch((error: unknown) => logger.warn({ err: error }, '[RunEngine] retry failed'));
    }, delay);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  private resolveCancelWaiters(run: ActiveRun, result: CancelResult): void {
    const waiters = run.cancelWaiters.splice(0);
    for (const waiter of waiters) waiter(result);
  }

  /** Release the reservation and slot, project the decision, refill the queue. Never throws. */
  private async settle(run: ActiveRun): Promise<void> {
    try {
      if (this.stopped) throw new ServiceStopped();
      const record = this.refresh(run);
      this.stopHeartbeat(run);
      if (!isTerminalRunState(record.state) && !(this.stopped)) {
        // Defensive: a drive must never end without a decision.
        this.decide(run, { state: 'failed', reason: 'run ended without a terminal decision', outcome: this.retainedOutcome(run, 'Execution ended unexpectedly') });
      }
    } catch (error) {
      if (!(error instanceof ServiceStopped)) logger.error({ err: error, runId: run.runId }, '[RunEngine] terminal decision could not be journaled');
    } finally {
      this.active.delete(run.runId);
      const queued = this.queue.indexOf(run.runId);
      if (queued >= 0) this.queue.splice(queued, 1);
      if (this.reservations.get(run.taskId) === run.runId) this.reservations.delete(run.taskId);
      this.runs.delete(run.runId);
      const record = this.journal.isClosed || this.stopped ? run.record : this.refresh(run);
      run.started.resolve({ runId: run.runId, attemptId: record.attemptId, state: record.state });
      run.done.resolve(record);
      const endpoint = record.runtime;
      if (!this.stopped && endpoint && run.runtime?.release && isTerminalRunState(record.state)) {
        await run.runtime.release(endpoint).catch((error: unknown) => logger.warn({ err: error, runId: run.runId }, '[RunEngine] runtime release failed'));
      }
      if (!this.stopped && !this.journal.isClosed) {
        await this.project(run.runId).catch((error: unknown) => logger.warn({ err: error, runId: run.runId }, '[RunEngine] projection failed'));
      }
      // W07a: a cancel answers after the first projection attempt, so a
      // reachable control plane already shows the task cancelled when the
      // caller hears "cancelled" (the legacy path's ordering). An
      // unreachable one keeps retrying in the background.
      this.resolveCancelWaiters(run, record.state === 'cancelled'
        ? { success: true, state: record.state }
        : { success: false, error: `Execution ended as ${record.state}`, state: record.state });
      this.pumpQueue();
      if (!this.stopped) this.notifySettled(record);
    }
  }

  /**
   * W13a: observe runs reaching their end in this process (the batch
   * coordinator advances queues on it). Listeners must not throw; a throwing
   * one is logged and skipped. Returns the unsubscribe function.
   */
  onRunSettled(listener: (record: RunRecord) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  private notifySettled(record: RunRecord): void {
    for (const listener of [...this.settledListeners]) {
      try {
        listener(record);
      } catch (error) {
        logger.warn({ err: error, runId: record.runId }, '[RunEngine] run-settled listener failed');
      }
    }
  }

  /** W13a: a run's journaled record (batch status). */
  runRecord(runId: string): RunRecord | null {
    return this.journal.get(runId);
  }

  private pumpQueue(): void {
    while (!this.stopped && this.queue.length > 0 && this.active.size < Math.max(1, this.parallelLimit)) {
      const runId = this.queue.shift();
      const run = runId ? this.runs.get(runId) : undefined;
      if (!run) continue;
      try {
        this.transition(run, 'preparing', 'slot available');
      } catch (error) {
        logger.warn({ err: error, runId }, '[RunEngine] queued run could not start');
        continue;
      }
      this.active.add(run.runId);
      void this.drive(run, 'fresh');
    }
  }

  private async finishQueuedCancel(run: ActiveRun): Promise<void> {
    try {
      this.decide(run, { state: 'cancelled', reason: 'cancelled while queued', outcome: 'Execution cancelled before it started', claimed: false });
    } catch (error) {
      logger.error({ err: error, runId: run.runId }, '[RunEngine] queued cancellation could not be journaled');
    } finally {
      await this.settle(run);
    }
  }

  private async finishQueuedAbandon(run: ActiveRun): Promise<void> {
    const index = this.queue.indexOf(run.runId);
    if (index >= 0) this.queue.splice(index, 1);
    try {
      this.decide(run, { state: 'abandoned', reason: run.abandonReason ?? 'authority lost', outcome: null });
    } finally {
      await this.settle(run);
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private async probeControlPlane(channel: AttemptChannel | null): Promise<{ probe: ControlPlaneProbe; status: ControlAttemptStatus | null; cancelRequested: boolean; expiresAt: number | null }> {
    if (!channel) return { probe: 'lost', status: null, cancelRequested: false, expiresAt: null };
    try {
      const beat = await channel.heartbeat();
      if (beat.status === 'closed' || beat.status === 'released') return { probe: 'lost', status: beat.status, cancelRequested: beat.cancelRequested, expiresAt: beat.capabilityExpiresAt };
      return { probe: 'active', status: beat.status, cancelRequested: beat.cancelRequested, expiresAt: beat.capabilityExpiresAt };
    } catch (error) {
      if (isAuthorityLost(error)) return { probe: 'lost', status: null, cancelRequested: false, expiresAt: null };
      return { probe: 'unreachable', status: null, cancelRequested: false, expiresAt: null };
    }
  }

  private async recoverRun(record: RunRecord, attempt = 0): Promise<void> {
    if (this.stopped) return;
    if (isTerminalRunState(record.state)) {
      await this.project(record.runId);
      return;
    }
    const channel = record.attemptId && record.capability ? this.cp.channel(record.attemptId, record.capability) : null;
    const cp = await this.step(record.runId, 'recovery:probe-control-plane', () => this.probeControlPlane(channel));
    const prompt = this.journal.effect(record.runId, runEffectKey(record.runId, 'prompt.submit'));
    const needsRuntime = cp.probe === 'active' && !cp.cancelRequested && !record.cancelRequestedAt
      && AGENT_RUN_STATES.includes(record.state) && prompt !== null;
    const runtime = this.deps.runtimes.get(record.runner) ?? null;
    let runtimeProbe: RuntimeProbe = 'not-probed';
    if (needsRuntime && runtime && record.runtime && record.sessionId) {
      const endpoint = record.runtime;
      const sessionId = record.sessionId;
      runtimeProbe = await this.step(record.runId, 'recovery:probe-runtime', () => runtime.inspect(endpoint, sessionId));
    }
    const decision = decideRunRecovery({
      state: record.state,
      controlPlane: cp.probe,
      controlStatus: cp.status,
      cancelRequested: cp.cancelRequested || record.cancelRequestedAt !== null,
      promptEffect: prompt?.status ?? 'absent',
      runtime: runtimeProbe,
    });
    this.journal.append(record.runId, {
      kind: 'recovery',
      payload: { decision: decision.action, controlPlane: cp.probe, controlStatus: cp.status, runtime: runtimeProbe, prompt: prompt?.status ?? 'absent', bootId: this.bootId },
      critical: true,
    });
    logger.info({ runId: record.runId, taskId: record.taskId, decision: decision.action, runtime: runtimeProbe, controlPlane: cp.probe }, '[RunEngine] recovery decision');

    if (decision.action === 'wait') {
      this.retryLater(async () => {
        const fresh = this.journal.get(record.runId);
        if (fresh) await this.recoverRun(fresh, attempt + 1);
      }, attempt);
      return;
    }
    const run = this.track(record, channel, this.parallelLimit);
    run.claimed = cp.status === 'running' || cp.status === 'finishing'
      || this.journal.effect(record.runId, runEffectKey(record.runId, 'attempt.claim'))?.status === 'confirmed';
    run.cancelRequested = cp.cancelRequested || record.cancelRequestedAt !== null;
    this.reservations.set(record.taskId, record.runId);
    if (cp.expiresAt !== null && cp.expiresAt - this.now() < this.options.renewBeforeMs && cp.probe === 'active') {
      await this.renew(run).catch((error: unknown) => logger.warn({ err: error, runId: run.runId }, '[RunEngine] renewal after restart failed'));
    }
    switch (decision.action) {
      case 'terminalize':
        await this.settle(run);
        return;
      case 'abandon':
        run.abandonReason = decision.reason;
        if (runtime && record.sessionId) await runtime.abort(record.runtime, record.sessionId).catch(() => false);
        this.decide(run, { state: 'abandoned', reason: decision.reason, outcome: null });
        this.log(run, 'error', 'The control plane released this attempt while the sidecar was down; local work is retained', record.workspace?.worktreePath);
        await this.settle(run);
        return;
      case 'cancel': {
        this.startHeartbeat(run);
        const stopped = record.sessionId && runtime && prompt ? await runtime.abort(record.runtime, record.sessionId) : true;
        if (!stopped) {
          this.decide(run, { state: 'recovery_required', reason: 'cancellation requested but the agent could not be stopped', outcome: this.retainedOutcome(run, 'Cancellation could not be confirmed after a sidecar restart') });
        } else {
          this.decide(run, { state: 'cancelled', reason: 'cancelled (recovered)', outcome: this.retainedOutcome(run, 'Execution cancelled') });
        }
        await this.settle(run);
        return;
      }
      case 'fail':
        if (runtime && record.sessionId) await runtime.abort(record.runtime, record.sessionId).catch(() => false);
        this.decide(run, { state: 'failed', reason: decision.reason, outcome: this.retainedOutcome(run, `Execution stopped: ${decision.reason}`) });
        await this.settle(run);
        return;
      case 'recovery-required':
        // W07a: stop an orphan that may still be running (a process runtime
        // the previous sidecar spawned) before the worktree is handed back
        // for salvage or a follow-up. Best effort: the decision stands.
        if (runtime && record.sessionId) await runtime.abort(record.runtime, record.sessionId).catch(() => false);
        this.decide(run, { state: 'recovery_required', reason: decision.reason, outcome: this.retainedOutcome(run, `Agent state unknown after a sidecar restart (${decision.reason}); nothing was published`) });
        await this.settle(run);
        return;
      case 'reattach':
      case 'finish':
      case 'resume-finishing':
        this.active.add(run.runId);
        this.startHeartbeat(run);
        this.scheduleRelay(run.runId, 0);
        await this.drive(run, decision.action);
        return;
    }
  }
}
