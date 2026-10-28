import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionEvent, ExecutionLogEntry, ExecutionRunInput, ExecutionTerminalInput, ExecutionVerificationInput } from '@openlinear/api-client';
import type { AgentEvent, AgentSession, ControlAttemptStatus, PreviousWork, StartInput } from '@openlinear/execution-core';
import type { PrincipalCredential } from '../auth/principal';
import { HttpError } from '../lib/errors';
import type { GitCredentialEffect } from '../services/git-credentials';
import type { AttemptChannel, AttemptHeartbeat, ControlPlane, StartedRun } from './control-plane';
import type { CommitInput, CommitResult, PublicationPort } from './publication';
import type { ResumeRuntimeInput, RunRuntime, StartedRuntimeSession } from './runtime';
import type { SetupPort, SetupStepInput, SetupStepOutcome } from './setup';
import type { RunSnapshot, RunWorkspace, RuntimeEndpoint } from './types';
import type { RetainedWorkspaceCheck, WorkspacePort } from './workspace';
import { SandboxUnavailableError } from '../sandbox/errors';

/**
 * In-memory doubles for the run service tests. They model the parts of the
 * real systems the run engine's guarantees depend on:
 *
 * - `FakeControlPlane`: W03a attempt semantics — capability auth and
 *   revocation, the claim, `(attempt, seq)` event deduplication, the W01
 *   terminal fence, success-needs-done, cancelled-needs-receipt, close, and a
 *   sweeper.
 * - `FakeRuntimeHost`: an agent runtime that lives OUTSIDE the sidecar
 *   process (like an OpenCode server): its sessions keep running when a
 *   run service instance "dies", events emitted with no subscriber are lost
 *   (SSE semantics), and it counts prompts and aborts.
 * - `FakePublication`: git/GitHub with observable commits, pushes and PRs.
 */

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

export interface FakeTask {
  id: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
  sessionId: string | null;
  outcome: string | null;
  prUrl: string | null;
  writes: number;
}

export interface FakeAttempt {
  id: string;
  taskId: string;
  status: ControlAttemptStatus;
  sessionId: string | null;
  terminalStatus: 'done' | 'cancelled' | null;
  lastEventSeq: number;
  cancelRequested: boolean;
  cancelAcknowledged: boolean;
  runStatus: 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
  closeReason: string | null;
  renewals: number;
  logsPersisted: number;
}

interface FakeCapability {
  attemptId: string;
  revoked: boolean;
  expiresAt: number;
}

export class FakeControlPlane implements ControlPlane {
  readonly tasks = new Map<string, FakeTask>();
  readonly attempts = new Map<string, FakeAttempt>();
  readonly capabilities = new Map<string, FakeCapability>();
  readonly delivered: Array<{ attemptId: string; seq: number; type: string; payload: Record<string, unknown> }> = [];
  readonly calls: string[] = [];
  unreachable = false;
  parallelLimit = 3;
  capabilityTtlMs = 2 * 60 * 60 * 1000;
  snapshot: (taskId: string) => RunSnapshot = (taskId) => fakeSnapshot(taskId);
  /** W10a: every git credential request (effect + attempt state at the time). */
  readonly gitCredentialRequests: Array<{ attemptId: string; effect: GitCredentialEffect; status: ControlAttemptStatus }> = [];
  /** W10a: the token issued per effect. */
  credentialFor: (effect: GitCredentialEffect) => string | null = () => 'gho_fake_token';
  /** W11a: recorded verification evidence, keyed by attempt + commit + checks hash. */
  readonly verifications = new Map<string, ExecutionVerificationInput & { attemptId: string }>();
  /** W11a: how many `verification` callbacks arrived (including replays). */
  verificationCalls = 0;
  /** W17a: "blocked by" edges; a start with an open (not done) blocker is refused unless allowBlocked. */
  readonly edges: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  /** W17a: tasks started with allowBlocked. */
  readonly allowBlockedStarts: string[] = [];
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  addTask(id: string): FakeTask {
    const task: FakeTask = { id, status: 'todo', sessionId: null, outcome: null, prUrl: null, writes: 0 };
    this.tasks.set(id, task);
    return task;
  }

  attemptFor(taskId: string): FakeAttempt | undefined {
    return [...this.attempts.values()].filter((attempt) => attempt.taskId === taskId).at(-1);
  }

  private reachable(op: string): void {
    this.calls.push(op);
    if (this.unreachable) throw new HttpError(503, 'CLOUD_API_UNREACHABLE', `OpenLinear API is unreachable (${op})`);
  }

  private mint(attemptId: string): { token: string; expiresAt: number } {
    this.counter += 1;
    const token = `olx_fake_${attemptId}_${this.counter}`;
    const expiresAt = this.now() + this.capabilityTtlMs;
    this.capabilities.set(token, { attemptId, revoked: false, expiresAt });
    return { token, expiresAt };
  }

  async start(credential: PrincipalCredential, taskId: string, options?: { allowBlocked?: boolean }): Promise<StartedRun> {
    this.reachable('start');
    const task = this.tasks.get(taskId);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
    // Like the API: held = in progress with a bound session (the board column alone is not running).
    if (task.status === 'in_progress' && task.sessionId !== null) throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already executing');
    if (options?.allowBlocked) {
      this.allowBlockedStarts.push(taskId);
    } else {
      const open = this.edges.filter((edge) => edge.taskId === taskId && this.tasks.get(edge.dependsOnTaskId)?.status !== 'done');
      if (open.length > 0) {
        throw new HttpError(409, 'TASK_BLOCKED', `This task is blocked by ${open.map((edge) => edge.dependsOnTaskId).join(', ')}`, {
          blockers: open.map((edge) => ({ id: edge.dependsOnTaskId })),
        });
      }
    }
    void credential;
    this.counter += 1;
    const attempt: FakeAttempt = {
      id: `attempt-${this.counter}`,
      taskId,
      status: 'preparing',
      sessionId: null,
      terminalStatus: null,
      lastEventSeq: 0,
      cancelRequested: false,
      cancelAcknowledged: false,
      runStatus: null,
      closeReason: null,
      renewals: 0,
      logsPersisted: 0,
    };
    this.attempts.set(attempt.id, attempt);
    return { attemptId: attempt.id, capability: this.mint(attempt.id), snapshot: this.snapshot(taskId), parallelLimit: this.parallelLimit };
  }

  async dependencyEdges(credential: PrincipalCredential, taskIds: readonly string[]): Promise<Array<{ taskId: string; dependsOnTaskId: string }>> {
    this.reachable('dependencies');
    void credential;
    const listed = new Set(taskIds);
    return this.edges.filter((edge) => listed.has(edge.taskId) && listed.has(edge.dependsOnTaskId));
  }

  /** The control-plane sweeper (heartbeat expired): release the task, fence the attempt. */
  sweep(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    for (const capability of this.capabilities.values()) if (capability.attemptId === attemptId) capability.revoked = true;
    if (attempt.status === 'running') {
      const task = this.tasks.get(attempt.taskId);
      if (task && task.status === 'in_progress' && task.sessionId === attempt.sessionId) {
        task.status = 'cancelled';
        task.sessionId = null;
        task.outcome = 'sidecar_lost';
        task.writes += 1;
      }
      attempt.runStatus = 'failed';
    }
    attempt.status = attempt.status === 'preparing' ? 'released' : 'closed';
    attempt.closeReason = 'sidecar_lost';
  }

  channel(attemptId: string, token: string): AttemptChannel {
    const authorize = (op: string, allowed?: readonly ControlAttemptStatus[]): FakeAttempt => {
      this.reachable(op);
      const capability = this.capabilities.get(token);
      if (!capability) throw new HttpError(401, 'CAPABILITY_INVALID', 'Unknown execution capability');
      if (capability.revoked) throw new HttpError(401, 'CAPABILITY_REVOKED', 'This execution capability has been revoked');
      if (capability.expiresAt <= this.now()) throw new HttpError(401, 'CAPABILITY_EXPIRED', 'This execution capability has expired');
      if (capability.attemptId !== attemptId) throw new HttpError(403, 'CAPABILITY_ATTEMPT_MISMATCH', 'Wrong attempt');
      const attempt = this.attempts.get(attemptId);
      if (!attempt) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Execution attempt not found');
      if (allowed && !allowed.includes(attempt.status)) {
        throw new HttpError(409, 'ATTEMPT_STATE_CONFLICT', `Attempt is ${attempt.status}`, { status: attempt.status, allowed });
      }
      return attempt;
    };
    const active: readonly ControlAttemptStatus[] = ['preparing', 'running', 'finishing'];
    return {
      claim: async (input) => {
        const attempt = authorize('claim', ['preparing']);
        const task = this.tasks.get(attempt.taskId);
        if (!task || (task.status === 'in_progress' && task.sessionId !== null)) {
          attempt.status = 'released';
          attempt.closeReason = 'claim_rejected';
          throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already executing');
        }
        task.status = 'in_progress';
        task.sessionId = input.sessionId;
        task.writes += 1;
        attempt.status = 'running';
        attempt.sessionId = input.sessionId;
        attempt.runStatus = 'running';
        return { agentRunId: `run-${attempt.id}`, task: { id: task.id, status: task.status } };
      },
      sendEvents: async (events: ExecutionEvent[]) => {
        const attempt = authorize('events', active);
        if (events.length > 50) throw new HttpError(400, 'VALIDATION_ERROR', 'At most 50 events per batch');
        for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
          if (event.seq <= attempt.lastEventSeq) continue;
          attempt.lastEventSeq = event.seq;
          this.delivered.push({ attemptId, seq: event.seq, type: event.type, payload: { ...event.payload } });
        }
        return { lastSeq: attempt.lastEventSeq, cancelRequested: attempt.cancelRequested };
      },
      heartbeat: async (): Promise<AttemptHeartbeat> => {
        const attempt = authorize('heartbeat', active);
        const capability = this.capabilities.get(token);
        return { status: attempt.status, cancelRequested: attempt.cancelRequested, capabilityExpiresAt: capability?.expiresAt ?? 0 };
      },
      renew: async () => {
        const attempt = authorize('renew', active);
        const previous = this.capabilities.get(token);
        if (previous) previous.expiresAt = Math.min(previous.expiresAt, this.now() + 5 * 60_000);
        attempt.renewals += 1;
        return this.mint(attempt.id);
      },
      gitCredential: async (effect) => {
        // W10a: push/pull_request need a running attempt that still owns the task.
        const attempt = authorize(`git-credential:${effect}`, effect === 'fetch' ? ['preparing', 'running'] : ['running']);
        if (effect !== 'fetch') {
          const task = this.tasks.get(attempt.taskId);
          if (task?.status !== 'in_progress' || task.sessionId !== attempt.sessionId) {
            throw new HttpError(409, 'TASK_FENCE_REJECTED', 'The task is no longer owned by this attempt; publication refused');
          }
        }
        this.gitCredentialRequests.push({ attemptId, effect, status: attempt.status });
        return this.credentialFor(effect);
      },
      writeTerminal: async (input: ExecutionTerminalInput) => {
        const attempt = authorize('terminal');
        if (attempt.status === 'finishing') {
          if (attempt.terminalStatus === input.status) return { repeated: true, task: null };
          throw new HttpError(409, 'ATTEMPT_TERMINAL_CONFLICT', `Attempt already recorded ${attempt.terminalStatus}`);
        }
        if (attempt.status !== 'running') throw new HttpError(409, 'ATTEMPT_STATE_CONFLICT', `Attempt is ${attempt.status}`, { status: attempt.status });
        if (input.status === 'done' && !input.prUrl) throw new HttpError(422, 'PUBLICATION_UNVERIFIED', 'done needs a PR');
        const task = this.tasks.get(attempt.taskId);
        if (task?.status !== 'in_progress' || task.sessionId !== attempt.sessionId) {
          throw new HttpError(409, 'TASK_FENCE_REJECTED', 'The task is no longer owned by this attempt; nothing was written');
        }
        task.status = input.status;
        task.sessionId = null;
        task.outcome = input.outcome ?? null;
        task.prUrl = input.prUrl ?? null;
        task.writes += 1;
        attempt.status = 'finishing';
        attempt.terminalStatus = input.status;
        return { repeated: false, task: { id: task.id, status: task.status } };
      },
      finalizeRun: async (input: ExecutionRunInput) => {
        const attempt = authorize('run', ['running', 'finishing']);
        if (input.status === 'succeeded' && attempt.terminalStatus !== 'done') throw new HttpError(409, 'RUN_SUCCESS_UNCONFIRMED', 'success needs done');
        if (input.status === 'cancelled' && !attempt.cancelAcknowledged) throw new HttpError(409, 'CANCEL_NOT_ACKNOWLEDGED', 'cancelled needs a stop receipt');
        if (attempt.runStatus !== 'running') return { finalized: false };
        attempt.runStatus = input.status;
        return { finalized: true };
      },
      acknowledgeCancellation: async () => {
        const attempt = authorize('cancellation', ['running', 'finishing']);
        attempt.cancelAcknowledged = true;
      },
      persistLogs: async (logs: ExecutionLogEntry[]) => {
        const attempt = authorize('logs', ['running', 'finishing']);
        attempt.logsPersisted = logs.length;
      },
      recordVerification: async (input: ExecutionVerificationInput) => {
        // W11a: like the API — idempotent per (attempt, commit, checks hash); a different body conflicts.
        authorize('verification', ['running', 'finishing']);
        this.verificationCalls += 1;
        const key = `${attemptId}:${input.commitSha}:${input.checksHash}`;
        const existing = this.verifications.get(key);
        if (existing) {
          const { attemptId: _attempt, ...body } = existing;
          if (JSON.stringify(body) !== JSON.stringify(input)) {
            throw new HttpError(409, 'VERIFICATION_CONFLICT', 'Different evidence was already recorded for this commit');
          }
          return { id: key, repeated: true };
        }
        this.verifications.set(key, { ...input, attemptId });
        return { id: key, repeated: false };
      },
      close: async (reason) => {
        const attempt = authorize('close');
        for (const capability of this.capabilities.values()) if (capability.attemptId === attemptId) capability.revoked = true;
        if (attempt.status !== 'closed' && attempt.status !== 'released') {
          attempt.closeReason = reason ?? (attempt.status === 'running' ? 'abandoned' : 'completed');
          attempt.status = attempt.status === 'preparing' ? 'released' : 'closed';
        }
        return { status: attempt.status, closeReason: attempt.closeReason };
      },
    };
  }
}

export function fakeSnapshot(taskId: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    title: `Task ${taskId}`,
    description: 'Run engine fixture',
    model: 'fake/model',
    agent: null,
    labels: [],
    projectId: 'project-1',
    teamId: 'team-1',
    creatorId: 'user-1',
    localPath: null,
    repository: { id: 'repo-1', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main' },
    ...overrides,
  };
}

export function fakeCredential(userId = 'user-1'): PrincipalCredential {
  return {
    principal: { userId, authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'hash' },
    token: 'jwt-token',
  };
}

// ---------------------------------------------------------------------------
// Runtime (out of process)
// ---------------------------------------------------------------------------

export type HostStep = AgentEvent | { hold: string } | { writeFile: string } | { disconnect: true };

type Subscriber = (event: AgentEvent | null) => void;

export class FakeHostSession {
  status: 'idle' | 'busy' = 'idle';
  errored = false;
  aborted = false;
  private readonly released = new Set<string>();
  private readonly waiters = new Map<string, () => void>();
  readonly subscribers = new Set<Subscriber>();
  readonly emitted: AgentEvent[] = [];

  constructor(readonly id: string, readonly directory: string, private steps: HostStep[], private readonly host: FakeRuntimeHost) {}

  release(name: string): void {
    this.released.add(name);
    this.waiters.get(name)?.();
  }

  emit(event: AgentEvent): void {
    this.emitted.push(event);
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }

  prompt(text?: string, steps?: HostStep[]): void {
    this.host.prompts.set(this.id, (this.host.prompts.get(this.id) ?? 0) + 1);
    if (text !== undefined) this.host.promptTexts.set(this.id, [...(this.host.promptTexts.get(this.id) ?? []), text]);
    if (steps) {
      // W07a: a follow-up turn on the same session runs its own script.
      this.steps = steps;
      this.aborted = false;
      this.errored = false;
    }
    this.status = 'busy';
    void this.run();
  }

  private async run(): Promise<void> {
    for (const step of this.steps) {
      if (this.aborted) return;
      await new Promise((resolve) => setImmediate(resolve));
      if ('hold' in step) {
        if (!this.released.has(step.hold)) await new Promise<void>((resolve) => this.waiters.set(step.hold, resolve));
        continue;
      }
      if ('disconnect' in step) {
        for (const subscriber of [...this.subscribers]) subscriber(null);
        continue;
      }
      if ('writeFile' in step) {
        try {
          writeFileSync(join(this.directory, step.writeFile), `change from ${this.id}\n`);
        } catch {
          // The test removed the directory; the "agent" just keeps going.
        }
        continue;
      }
      if (this.aborted) return;
      if (step.t === 'turn.finished' || step.t === 'error') {
        this.status = 'idle';
        this.errored = step.t === 'error' || step.reason === 'error';
      }
      this.emit(step);
    }
    this.status = 'idle';
  }

  abort(): void {
    this.host.aborts.set(this.id, (this.host.aborts.get(this.id) ?? 0) + 1);
    if (this.status === 'busy') {
      this.aborted = true;
      this.status = 'idle';
      this.emit({ t: 'turn.finished', turn: 0, reason: 'interrupted' });
    }
    for (const waiter of this.waiters.values()) waiter();
  }

  /** Events emitted after the call (SSE: nothing is replayed). */
  stream(signal: AbortSignal): AsyncIterable<AgentEvent> {
    const session = this;
    return {
      [Symbol.asyncIterator]() {
        const queue: AgentEvent[] = [];
        let wake: (() => void) | null = null;
        let closed = false;
        const subscriber: Subscriber = (event) => {
          if (event) queue.push(event);
          else closed = true;
          wake?.();
        };
        session.subscribers.add(subscriber);
        const onAbort = () => wake?.();
        signal.addEventListener('abort', onAbort, { once: true });
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
              const event = queue.shift();
              if (event) return { value: event, done: false };
              if (signal.aborted || closed) return { value: undefined, done: true };
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = null;
            }
          },
          async return(): Promise<IteratorResult<AgentEvent>> {
            session.subscribers.delete(subscriber);
            signal.removeEventListener('abort', onAbort);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

export class FakeRuntimeHost {
  readonly sessions = new Map<string, FakeHostSession>();
  readonly prompts = new Map<string, number>();
  /** Prompt texts per session, in submission order (W07a follow-up assertions). */
  readonly promptTexts = new Map<string, string[]>();
  readonly aborts = new Map<string, number>();
  reachable = true;
  /** W07a: whether saved sessions can be continued (resume). */
  resumable = true;
  failStart: Error | null = null;
  /** FE-04: the runtime's approvals capability. */
  approvals: 'interactive' | 'policy-only' = 'interactive';
  /** FE-04: the permission policy each start/resume was given, in order. */
  readonly startPermissions: Array<'allow' | 'deny' | 'ask'> = [];
  /** FE-04: listeners of withdrawn permission requests (`withdrawPermission`). */
  readonly withdrawListeners = new Set<(id: string) => void>();
  /** FE-04: every permission reply; a script step `{ hold: 'reply:<id>' }` waits for it. */
  readonly permissionReplies: Array<{ sessionId: string; id: string; decision: 'allow' | 'deny'; scope: 'once' | 'session' | undefined }> = [];
  /** Script per run id (default: one edit, then idle). */
  scripts = new Map<string, HostStep[]>();
  private counter = 0;

  defaultScript(): HostStep[] {
    return [
      { t: 'turn.started', turn: 1 },
      { t: 'message.delta', text: 'Working on it.' },
      { writeFile: 'change.txt' },
      { t: 'file.changed', path: 'change.txt', kind: 'create' },
      { t: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 1 }, cost: { usd: 0.01 }, messageId: 'm1' },
      { t: 'turn.finished', turn: 1, reason: 'idle' },
    ];
  }

  create(runId: string, directory: string): FakeHostSession {
    this.counter += 1;
    const session = new FakeHostSession(`ses_fake_${this.counter}`, directory, this.scripts.get(runId) ?? this.defaultScript(), this);
    this.sessions.set(session.id, session);
    return session;
  }

  /** FE-04: the agent withdraws a permission request (and goes on without an answer). */
  withdrawPermission(id: string): void {
    for (const listener of [...this.withdrawListeners]) listener(id);
    for (const session of this.sessions.values()) session.release(`reply:${id}`);
  }

  promptCount(sessionId: string): number {
    return this.prompts.get(sessionId) ?? 0;
  }
}

class FakeStartedSession implements AgentSession {
  constructor(
    readonly externalId: string,
    private readonly host: FakeRuntimeHost,
    private readonly signal: AbortSignal,
    private readonly submit: boolean,
    private readonly promptText?: string,
    private readonly turnSteps?: HostStep[],
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const session = self.host.sessions.get(self.externalId);
        if (!session) throw new Error('session not found');
        if (self.submit) yield { t: 'session.started', externalId: self.externalId, model: { id: 'fake/model' } } satisfies AgentEvent;
        else if (session.status === 'idle') {
          yield session.errored
            ? { t: 'error', code: 'session', message: 'ended with error', retryable: false } satisfies AgentEvent
            : { t: 'turn.finished', turn: 0, reason: 'idle' } satisfies AgentEvent;
          return;
        }
        const stream = session.stream(self.signal)[Symbol.asyncIterator]();
        try {
          if (self.submit) session.prompt(self.promptText, self.turnSteps);
          for (;;) {
            const next = await stream.next();
            if (next.done) return;
            yield next.value;
            if (next.value.t === 'turn.finished' || next.value.t === 'error') return;
          }
        } finally {
          await stream.return?.();
        }
      },
    };
  }

  async interrupt(): Promise<void> {
    this.host.sessions.get(this.externalId)?.abort();
  }

  async abort(): Promise<void> {
    if (!this.host.reachable) throw new Error('runtime unreachable');
    this.host.sessions.get(this.externalId)?.abort();
  }

  onPermissionWithdrawn(listener: (id: string) => void): () => void {
    this.host.withdrawListeners.add(listener);
    return () => {
      this.host.withdrawListeners.delete(listener);
    };
  }

  async replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void> {
    this.host.permissionReplies.push({ sessionId: this.externalId, id, decision, scope });
    this.host.sessions.get(this.externalId)?.release(`reply:${id}`);
  }
}

export class FakeRuntime implements RunRuntime {
  readonly runnerId = 'opencode' as const;
  constructor(readonly host: FakeRuntimeHost) {}

  get approvals(): 'interactive' | 'policy-only' {
    return this.host.approvals;
  }

  async start(input: StartInput): Promise<StartedRuntimeSession> {
    this.host.startPermissions.push(input.permissions.default);
    if (this.host.failStart) throw this.host.failStart;
    const session = this.host.create(input.runId, input.worktreePath);
    const endpoint: RuntimeEndpoint = { kind: 'fake', baseUrl: 'fake://runtime', directory: input.worktreePath, authorization: null, sandboxMode: 'none' };
    return { session: new FakeStartedSession(session.id, this.host, input.signal, true, input.prompt), endpoint };
  }

  /** W07a: a new turn on a saved session (null when the host cannot continue it). */
  async resume(input: ResumeRuntimeInput): Promise<StartedRuntimeSession | null> {
    this.host.startPermissions.push(input.permissions.default);
    if (this.host.failStart) throw this.host.failStart;
    const session = this.host.sessions.get(input.sessionId);
    if (!session || !this.host.resumable) return null;
    const steps = this.host.scripts.get(input.runId) ?? this.host.defaultScript();
    const endpoint: RuntimeEndpoint = {
      kind: 'fake', baseUrl: 'fake://runtime', directory: input.worktreePath, authorization: null, sandboxMode: 'none', resumedSessionId: input.sessionId,
    };
    return { session: new FakeStartedSession(session.id, this.host, input.signal, true, input.prompt, steps), endpoint };
  }

  async inspect(_endpoint: RuntimeEndpoint, sessionId: string): Promise<'busy' | 'idle' | 'idle-error' | 'missing' | 'unreachable'> {
    if (!this.host.reachable) return 'unreachable';
    const session = this.host.sessions.get(sessionId);
    if (!session) return 'missing';
    if (session.status === 'busy') return 'busy';
    return session.errored ? 'idle-error' : 'idle';
  }

  async attach(_endpoint: RuntimeEndpoint, sessionId: string, signal: AbortSignal): Promise<AgentSession> {
    return new FakeStartedSession(sessionId, this.host, signal, false);
  }

  async abort(_endpoint: RuntimeEndpoint | null, sessionId: string): Promise<boolean> {
    if (!this.host.reachable) return false;
    const session = this.host.sessions.get(sessionId);
    if (!session) return false;
    session.abort();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Workspace and publication
// ---------------------------------------------------------------------------

export class FakeWorkspace implements WorkspacePort {
  readonly released: string[] = [];
  failAcquire: Error | null = null;
  constructor(private readonly root: string) {}

  async acquire(input: { runId: string; snapshot: RunSnapshot }): Promise<RunWorkspace> {
    if (this.failAcquire) throw this.failAcquire;
    const worktreePath = join(this.root, input.runId);
    mkdirSync(worktreePath, { recursive: true });
    return { worktreePath, branch: `openlinear/${input.runId}`, baseRef: 'main', owned: true, handle: { runId: input.runId, mirrorPath: join(this.root, 'mirror.git'), dissociated: false } };
  }

  async release(workspace: RunWorkspace): Promise<void> {
    this.released.push(workspace.worktreePath);
  }

  exists(workspace: RunWorkspace): boolean {
    return existsSync(workspace.worktreePath);
  }

  /** Worktrees whose branch the test "switched" (W07a retained-workspace check). */
  readonly switched = new Set<string>();

  async inspectRetained(workspace: RunWorkspace): Promise<RetainedWorkspaceCheck> {
    if (!existsSync(workspace.worktreePath)) return { ok: false, reason: 'worktree_missing' };
    if (this.switched.has(workspace.worktreePath)) return { ok: false, reason: 'branch_changed', detail: 'checked out: main' };
    return { ok: true };
  }

  async adopt(input: { parentRunId: string; workspace: RunWorkspace }): Promise<RunWorkspace> {
    const check = await this.inspectRetained(input.workspace);
    if (!check.ok) throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'worktree not retained', { reason: check.reason });
    return { ...input.workspace, continuedFrom: input.workspace.continuedFrom ?? input.parentRunId };
  }

  async diff(workspace: RunWorkspace): Promise<PreviousWork> {
    const files = existsSync(workspace.worktreePath) ? readdirSync(workspace.worktreePath).sort() : [];
    return { base: 'base000', diff: files.map((name) => `+++ b/${name}`).join('\n'), truncated: false, untracked: [] };
  }
}

export class FakePublication implements PublicationPort {
  readonly commits: Array<{ worktree: string; sha: string; key: string }> = [];
  readonly heads = new Map<string, { sha: string; message: string }>();
  readonly remote = new Map<string, string>();
  readonly prs = new Map<string, string>();
  pushCalls = 0;
  prPosts = 0;
  private readonly committed = new Map<string, Set<string>>();

  async commit(input: CommitInput): Promise<CommitResult> {
    const files = readdirSync(input.worktree).filter((name) => !this.committed.get(input.worktree)?.has(name));
    if (files.length === 0) return { status: 'no_changes' };
    const set = this.committed.get(input.worktree) ?? new Set<string>();
    for (const file of files) set.add(file);
    this.committed.set(input.worktree, set);
    const sha = createHash('sha1').update(`${input.worktree}:${files.join(',')}:${this.commits.length}`).digest('hex');
    this.commits.push({ worktree: input.worktree, sha, key: input.key });
    this.parents.set(sha, this.heads.get(input.worktree)?.sha ?? null);
    this.heads.set(input.worktree, { sha, message: `feat\n\nOpenLinear-Effect: ${input.key}\n` });
    return { status: 'committed', sha };
  }

  /** Commit → parent commit (W07a fast-forward check). */
  readonly parents = new Map<string, string | null>();

  async isAncestor(input: { ancestor: string; descendant: string }): Promise<boolean> {
    let current: string | null | undefined = input.descendant;
    while (current) {
      if (current === input.ancestor) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  async branchHead(input: { worktree: string }): Promise<{ sha: string | null; ahead: boolean | null }> {
    const head = this.heads.get(input.worktree)?.sha ?? null;
    return { sha: head, ahead: head ? this.commits.some((commit) => commit.worktree === input.worktree) : false };
  }

  async findCommit(input: { worktree: string; key: string }): Promise<string | null> {
    const head = this.heads.get(input.worktree);
    return head?.message.includes(`OpenLinear-Effect: ${input.key}\n`) ? head.sha : null;
  }

  async remoteSha(input: { branch: string }): Promise<string | null> {
    return this.remote.get(input.branch) ?? null;
  }

  async push(input: { branch: string; sha: string; expectedRemote: string | null }): Promise<void> {
    this.pushCalls += 1;
    const current = this.remote.get(input.branch) ?? null;
    if (current !== input.expectedRemote) throw new Error('stale info (lease)');
    this.remote.set(input.branch, input.sha);
  }

  async findPullRequest(input: { branch: string }): Promise<string | null> {
    return this.prs.get(input.branch) ?? null;
  }

  async createPullRequest(input: { fullName: string; branch: string }): Promise<string> {
    this.prPosts += 1;
    const url = `https://github.com/${input.fullName}/pull/${this.prs.size + 1}`;
    this.prs.set(input.branch, url);
    return url;
  }
}

// ---------------------------------------------------------------------------
// W16a environment setup
// ---------------------------------------------------------------------------

/**
 * Scripted setup steps: exit code per step id (default 0), steps that time
 * out, steps that hold until released (or the run's signal aborts), and a
 * hook called when a step starts (ordering assertions).
 */
export class FakeSetup implements SetupPort {
  exits: Record<string, number> = {};
  /** Committable files a passing step leaves behind (step id → paths). */
  leaves: Record<string, string[]> = {};
  /** No sandbox and no covering grant: `assertRunnable` refuses. */
  sandboxUnavailable = false;
  private readonly changes = new Map<string, string>();
  readonly timeouts = new Set<string>();
  readonly holds = new Set<string>();
  readonly calls: SetupStepInput[] = [];
  readonly cleanups: string[] = [];
  onStep: ((input: SetupStepInput) => void) | null = null;
  private readonly releases = new Map<string, () => void>();

  release(stepId: string): void {
    this.holds.delete(stepId);
    this.releases.get(stepId)?.();
  }

  async runStep(input: SetupStepInput): Promise<SetupStepOutcome> {
    this.calls.push(input);
    this.onStep?.(input);
    const { step } = input;
    if (this.holds.has(step.id) && !input.signal.aborted) {
      await new Promise<void>((resolve) => {
        this.releases.set(step.id, resolve);
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    const aborted = input.signal.aborted;
    const timedOut = !aborted && this.timeouts.has(step.id);
    const exitCode = aborted ? null : timedOut ? null : this.exits[step.id] ?? 0;
    const status = aborted ? 'error' : timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed';
    if (status === 'passed') for (const path of this.leaves[step.id] ?? []) this.changes.set(path, `?? ${step.id}`);
    return {
      result: {
        id: step.id,
        name: step.name,
        required: step.required,
        status,
        exitCode,
        signal: timedOut ? 'SIGTERM' : null,
        durationMs: 25,
        timedOut,
        network: step.network.mode,
        command: step.argv.join(' '),
        log: { sha256: null, bytes: 12, truncated: false, tail: status === 'failed' ? 'ERR_PNPM_OUTDATED_LOCKFILE' : 'done', artifact: null },
        detail: aborted ? 'cancelled while running' : timedOut ? `timed out after ${Math.round(step.timeoutMs / 1000)} s` : null,
      },
      sandbox: { mode: 'enforce', provider: 'fake', providerVersion: '1', policyHash: null },
    };
  }

  cleanup(runId: string): void {
    this.cleanups.push(runId);
  }

  async fingerprint(_worktreePath: string): Promise<ReadonlyMap<string, string>> {
    return new Map(this.changes);
  }

  async assertRunnable(_worktreePath: string): Promise<void> {
    if (this.sandboxUnavailable) throw new SandboxUnavailableError('No verified sandbox is available', ['fake: no sandbox']);
  }
}
