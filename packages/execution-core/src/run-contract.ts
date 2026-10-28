/**
 * W05a/W06a — the durable single-attempt run contract.
 *
 * One run is one local execution of one control-plane attempt. The local
 * SQLite journal is the source of truth for the run; the control plane is
 * the source of truth for the task row and the attempt's authority.
 *
 * Three rules make a run recoverable after SIGKILL:
 *
 * 1. Durable acceptance. A run row (state + snapshot + attempt identity) is
 *    committed before execute is acknowledged.
 * 2. Journal before effect. A state transition, its event and any effect
 *    intent commit in one SQLite transaction before the effect is
 *    dispatched. The receipt is recorded after. A crash between dispatch and
 *    receipt leaves the effect `pending`, which means "possibly dispatched";
 *    recovery reconciles it (`EFFECT_RECOVERY`) instead of assuming rollback.
 * 3. One terminal decision. The terminal transition is a compare-and-set on
 *    the run's state version; terminal states have no outgoing transitions.
 *    Control-plane effects that project the decision (terminal, run, close)
 *    are journaled with the decision and re-driven until confirmed or
 *    definitively refused.
 *
 * Pure: no I/O, no Node APIs. The sidecar implements the journal and the
 * interpreter; this module defines what they must agree on.
 */

// ---------------------------------------------------------------------------
// Run states
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'awaiting_approval',
  'compacting',
  /** W11a: the agent's commit is checked in a pristine checkout before publication. */
  'verifying',
  'finishing',
  'succeeded',
  'failed',
  'cancelled',
  'recovery_required',
  'abandoned',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'recovery_required',
  'abandoned',
];

/** States in which an agent session exists and the prompt may have been dispatched. */
export const AGENT_RUN_STATES: readonly RunState[] = ['running', 'awaiting_approval', 'compacting'];

/**
 * Allowed transitions. Terminal states have none: a run decides its
 * terminal outcome exactly once.
 *
 * - `queued`: admitted by the control plane (attempt started, capability
 *   issued) but waiting for a local slot. Heartbeats keep the lease.
 * - `preparing`: workspace, runtime session and claim. The task row is
 *   untouched until the claim succeeds.
 * - `running` ↔ `awaiting_approval` / `compacting`: the agent turn.
 * - `verifying` (W11a): the agent's work is committed (candidate commit) and
 *   the checks captured before the agent ran are executed against that exact
 *   commit in a pristine checkout. Entered only when the run's verification
 *   manifest asks for it; otherwise `running → finishing` as before.
 * - `finishing`: commit → push → pull request (publication effects). After
 *   `verifying`, the commit already exists and is the one that was verified.
 * - `succeeded`: publication confirmed and the done projection written.
 * - `failed`: the run ended without the requested result (setup failure,
 *   agent error, no changes, publication failure, watchdog or budget).
 * - `cancelled`: stopped on request, with a positive provider stop receipt.
 * - `recovery_required`: after a restart the agent's fate is unknown (its
 *   runtime is gone); work is retained for salvage, never auto-published.
 * - `abandoned`: this sidecar lost authority (capability revoked/expired,
 *   attempt closed by the control-plane sweeper). Fenced: writes nothing.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['preparing', 'cancelled', 'failed', 'abandoned'],
  preparing: ['running', 'cancelled', 'failed', 'abandoned'],
  running: ['awaiting_approval', 'compacting', 'verifying', 'finishing', 'cancelled', 'failed', 'recovery_required', 'abandoned'],
  awaiting_approval: ['running', 'cancelled', 'failed', 'recovery_required', 'abandoned'],
  compacting: ['running', 'cancelled', 'failed', 'recovery_required', 'abandoned'],
  verifying: ['finishing', 'cancelled', 'failed', 'recovery_required', 'abandoned'],
  finishing: ['succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned'],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovery_required: [],
  abandoned: [],
};

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export class RunTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState, message?: string) {
    super(message ?? `Run cannot move from ${from} to ${to}`);
    this.name = 'RunTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new RunTransitionError(from, to);
}

/**
 * Control-plane attempt status a local state corresponds to (W03a enum).
 * `finishing` stays `running` until the terminal projection is written.
 */
export type ControlAttemptStatus = 'preparing' | 'running' | 'finishing' | 'closed' | 'released';

export const CONTROL_STATUS_FOR_STATE: Readonly<Record<RunState, readonly ControlAttemptStatus[]>> = {
  queued: ['preparing'],
  preparing: ['preparing', 'running'],
  running: ['running'],
  awaiting_approval: ['running'],
  compacting: ['running'],
  verifying: ['running'],
  finishing: ['running', 'finishing'],
  succeeded: ['finishing', 'closed'],
  failed: ['preparing', 'running', 'finishing', 'closed', 'released'],
  cancelled: ['running', 'finishing', 'closed', 'released'],
  recovery_required: ['running', 'finishing', 'closed'],
  abandoned: ['closed', 'released'],
};

/**
 * Legacy progress status the existing UI understands, per run state. Run
 * state events are relayed as `execution:progress` with this status plus the
 * additive fields `runState`, `runId` and `runSeq`.
 */
export const LEGACY_PROGRESS_STATUS: Readonly<Record<RunState, string>> = {
  queued: 'queued',
  preparing: 'cloning',
  running: 'executing',
  awaiting_approval: 'executing',
  compacting: 'executing',
  // The candidate commit exists; the UI's legacy phase closest to "checking
  // it before publication". `runState: 'verifying'` rides along additively.
  verifying: 'committing',
  finishing: 'committing',
  succeeded: 'done',
  failed: 'error',
  cancelled: 'cancelled',
  recovery_required: 'error',
  abandoned: 'error',
};

// ---------------------------------------------------------------------------
// Effect ledger
// ---------------------------------------------------------------------------

/**
 * Every effect outside the sidecar process that must survive a crash. Each
 * is journaled (intent, `pending`) in the same transaction as the state it
 * belongs to, before dispatch; its receipt moves it to `confirmed` or
 * `failed`.
 */
export const RUN_EFFECT_KINDS = [
  'attempt.claim',
  'prompt.submit',
  'git.commit',
  'git.push',
  'pr.create',
  'cancel.ack',
  'task.terminal',
  'run.finalize',
  'attempt.close',
  /** W11a: the run's checks executed against one commit (local, re-runnable). */
  'verify.run',
  /** W11a: the verification evidence recorded with the control plane (projection). */
  'verification.record',
] as const;
export type RunEffectKind = (typeof RUN_EFFECT_KINDS)[number];

/**
 * - `pending`: intent journaled; the effect may or may not have been
 *   dispatched (a crash can land between dispatch and receipt).
 * - `confirmed`: a positive receipt was recorded (or reconciled).
 * - `failed`: a definitive negative receipt (never redispatched).
 */
export type RunEffectStatus = 'pending' | 'confirmed' | 'failed';

export interface RunEffectRecord {
  runId: string;
  key: string;
  kind: RunEffectKind;
  status: RunEffectStatus;
  intent: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
  /** How many times the effect was handed to its dispatcher. */
  dispatches: number;
  createdAt: number;
  updatedAt: number;
}

export function isRunEffectKind(value: unknown): value is RunEffectKind {
  return typeof value === 'string' && (RUN_EFFECT_KINDS as readonly string[]).includes(value);
}

/**
 * Deterministic idempotency key: `<runId>:<kind>[:<discriminator>]`. The
 * discriminator names the artifact the effect is about (commit SHA for a
 * push, branch for a pull request, terminal status for a projection), so a
 * replay targets the same artifact and a different artifact is a different
 * effect.
 */
export function runEffectKey(runId: string, kind: RunEffectKind, discriminator?: string | null): string {
  if (!runId || runId.includes(':')) throw new Error('runEffectKey: runId must be non-empty and contain no colon');
  return discriminator ? `${runId}:${kind}:${discriminator}` : `${runId}:${kind}`;
}

export type EffectRecoveryAction =
  /** Ask the control plane: the attempt status says whether the claim landed. */
  | 'probe-control-plane'
  /** Inspect the provider session. A prompt is never submitted twice. */
  | 'probe-runtime'
  /** The HEAD commit carries the effect key in an `OpenLinear-Effect:` trailer. */
  | 'probe-commit-trailer'
  /** `git ls-remote` shows the branch at the intended commit. */
  | 'probe-remote-ref'
  /** GitHub lists an open pull request for the branch (W01 reconciliation). */
  | 'probe-pull-request'
  /** Control-plane callbacks are idempotent and fenced: resend the same body. */
  | 'resend-idempotent'
  /**
   * W11a: a confirmed verification receipt for the same commit and checks
   * hash is reused; a pending one (the sidecar died while checks ran) is run
   * again from scratch in a fresh pristine checkout. Checks are expected to
   * be free of external effects (network is off unless a check asks for it).
   */
  | 'rerun-verification';

export interface EffectRecoveryRule {
  action: EffectRecoveryAction;
  /** May the effect be dispatched again when the probe proves it absent? */
  redispatchWhenAbsent: boolean;
  /** What the rule protects against; recorded in the ledger. */
  note: string;
}

export const EFFECT_RECOVERY: Readonly<Record<RunEffectKind, EffectRecoveryRule>> = {
  'attempt.claim': {
    action: 'probe-control-plane',
    redispatchWhenAbsent: false,
    note: 'running with this session = claimed; still preparing = never landed (setup is not resumed: the run fails and the attempt is released)',
  },
  'prompt.submit': {
    action: 'probe-runtime',
    redispatchWhenAbsent: false,
    note: 'never resubmitted: busy = reattach without a prompt, idle = turn finished while away, gone = recovery_required',
  },
  'git.commit': {
    action: 'probe-commit-trailer',
    redispatchWhenAbsent: true,
    note: 'HEAD carrying the effect trailer is the receipt; otherwise nothing was committed and the commit is made once',
  },
  'git.push': {
    action: 'probe-remote-ref',
    redispatchWhenAbsent: true,
    note: 'remote branch at the commit = pushed; otherwise push again with the same lease (same commit, idempotent)',
  },
  'pr.create': {
    action: 'probe-pull-request',
    redispatchWhenAbsent: true,
    note: 'an open PR for the branch is reused; a PR POST is never blindly retried',
  },
  'cancel.ack': {
    action: 'resend-idempotent',
    redispatchWhenAbsent: true,
    note: 'positive stop receipt; the control plane records it once',
  },
  'task.terminal': {
    action: 'resend-idempotent',
    redispatchWhenAbsent: true,
    note: 'same terminal = repeated:true; a lost W01 fence = TASK_FENCE_REJECTED (definitive)',
  },
  'run.finalize': {
    action: 'resend-idempotent',
    redispatchWhenAbsent: true,
    note: 'AgentRun updateMany where running: a second write changes nothing',
  },
  'attempt.close': {
    action: 'resend-idempotent',
    redispatchWhenAbsent: true,
    note: 'closing a closed attempt only re-revokes its capabilities',
  },
  'verify.run': {
    action: 'rerun-verification',
    redispatchWhenAbsent: true,
    note: 'confirmed = the recorded result for this commit is reused; pending = the checks run again in a fresh pristine checkout (no result is ever invented)',
  },
  'verification.record': {
    action: 'resend-idempotent',
    redispatchWhenAbsent: true,
    note: 'keyed by (attempt, commit, checks hash); the same body replays, a different body is a conflict',
  },
};

/** Commit trailer that makes a commit its own receipt. */
export const EFFECT_COMMIT_TRAILER = 'OpenLinear-Effect';

/** True when `message` carries `OpenLinear-Effect: <key>` on its own line. */
export function commitCarriesEffect(message: string, key: string): boolean {
  return message.split(/\r?\n/).some((line) => line.trim() === `${EFFECT_COMMIT_TRAILER}: ${key}`);
}

// ---------------------------------------------------------------------------
// Journal event envelope
// ---------------------------------------------------------------------------

/**
 * Kinds of journal events. Sequence numbers are per run, gap-free and
 * stable across restarts (the journal assigns them in the append
 * transaction). Relayed events are sent to the control plane with their
 * journal sequence, so the control plane's `(attempt, seq)` high-water mark
 * deduplicates replays after a restart.
 */
export const RUN_EVENT_KINDS = ['run.accepted', 'run.state', 'agent', 'log', 'progress', 'effect', 'recovery'] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export interface RunEventEnvelope {
  runId: string;
  seq: number;
  at: number;
  kind: RunEventKind;
  /** Relayed to the control plane (`log` and `progress` only). */
  relay: boolean;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Recovery decision
// ---------------------------------------------------------------------------

export type ControlPlaneProbe =
  /** Heartbeat accepted: the attempt is active and this capability is valid. */
  | 'active'
  /** Capability revoked/expired/invalid, or the attempt is closed/released. */
  | 'lost'
  /** Network failure or 5xx: decide nothing yet. */
  | 'unreachable';

export type RuntimeProbe =
  | 'busy'
  /** Session exists and is idle; its last turn ended without an error. */
  | 'idle'
  /** Session exists and is idle; its last turn ended with an error. */
  | 'idle-error'
  /** The runtime answered and the session does not exist. */
  | 'missing'
  /** No runtime answers at the recorded endpoint. */
  | 'unreachable'
  /**
   * W07a (additive): the runtime is a child process of the previous sidecar
   * (Claude Code, Codex over stdio). Its output stream died with that
   * process and cannot be re-attached, so the agent's fate is unknowable
   * from here: never `busy` (nothing to attach to), never `idle` (a turn
   * result may have been lost with the pipe).
   */
  | 'detached'
  | 'not-probed';

export interface RunRecoveryInput {
  state: RunState;
  controlPlane: ControlPlaneProbe;
  /** Attempt status reported by the heartbeat (when `active`). */
  controlStatus?: ControlAttemptStatus | null;
  cancelRequested: boolean;
  promptEffect: RunEffectStatus | 'absent';
  runtime: RuntimeProbe;
}

export type RunRecoveryDecision =
  /** Terminal already decided: re-drive its pending control-plane effects. */
  | { action: 'terminalize' }
  /** Control plane unreachable: keep the run, retry later. */
  | { action: 'wait' }
  /** Authority lost: stop the agent, write nothing (fenced). */
  | { action: 'abandon'; reason: string }
  /** Cancellation requested before or during the outage. */
  | { action: 'cancel' }
  /** Nothing ran (setup or claim only): fail, release or project the failure. */
  | { action: 'fail'; reason: string }
  /** The agent is still working: attach to its event stream without a prompt. */
  | { action: 'reattach' }
  /** The turn ended while the sidecar was down: continue with publication. */
  | { action: 'finish' }
  /** Publication was in progress: reconcile its effects, then continue. */
  | { action: 'resume-finishing' }
  /** The agent's fate is unknown; retain the work for salvage. */
  | { action: 'recovery-required'; reason: string };

/**
 * Pure recovery policy for one journaled run after a restart. The probes
 * run first (control plane heartbeat; runtime inspection only when the
 * policy needs it — callers pass `not-probed` otherwise).
 */
export function decideRunRecovery(input: RunRecoveryInput): RunRecoveryDecision {
  if (isTerminalRunState(input.state)) return { action: 'terminalize' };
  if (input.controlPlane === 'unreachable') return { action: 'wait' };
  if (input.controlPlane === 'lost') return { action: 'abandon', reason: 'control plane revoked this attempt' };
  if (input.cancelRequested) return { action: 'cancel' };
  if (input.state === 'queued' || input.state === 'preparing') {
    return { action: 'fail', reason: 'the sidecar restarted before the agent started' };
  }
  // W11a: `verifying` resumes like `finishing` — the commit is reconciled from
  // its trailer, a recorded verification result is reused and a pending one
  // is re-run before any publication effect is dispatched.
  if (input.state === 'finishing' || input.state === 'verifying') return { action: 'resume-finishing' };
  if (input.promptEffect === 'absent') {
    return { action: 'fail', reason: 'the sidecar restarted before the prompt was submitted' };
  }
  switch (input.runtime) {
    case 'busy':
      return { action: 'reattach' };
    case 'idle':
      return { action: 'finish' };
    case 'idle-error':
      return { action: 'fail', reason: 'the agent ended with an error while the sidecar was down' };
    case 'detached':
      return { action: 'recovery-required', reason: 'agent runtime cannot be re-attached after the sidecar restarted (its process output died with the sidecar)' };
    case 'missing':
    case 'unreachable':
    case 'not-probed':
      return { action: 'recovery-required', reason: `agent runtime ${input.runtime} after the sidecar restarted` };
  }
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface RunAdmissionInput {
  /** Runs holding a slot (preparing … finishing), this request excluded. */
  active: number;
  /** Runs waiting for a slot. */
  queued: number;
  parallelLimit: number;
  maxQueued: number;
}

export type RunAdmission = { kind: 'start' } | { kind: 'queue' } | { kind: 'reject'; reason: string };

/** Pending work counts: a slot is held from acceptance until the terminal decision. */
export function admitRunRequest(input: RunAdmissionInput): RunAdmission {
  const limit = Math.max(1, Math.floor(input.parallelLimit));
  if (input.active < limit && input.queued === 0) return { kind: 'start' };
  if (input.queued < Math.max(0, Math.floor(input.maxQueued))) return { kind: 'queue' };
  return { kind: 'reject', reason: `Parallel limit reached (${limit} tasks max, ${input.queued} queued)` };
}
