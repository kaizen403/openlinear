import type { AgentSession, PermissionPolicy, RunnerId, RuntimeProbe, StartInput } from '@openlinear/execution-core';
import type { RuntimeEndpoint } from './types';

/**
 * The agent runtime as the run service needs it: the `AgentRunner`
 * contract (start → session whose event stream submits the prompt) plus the
 * three things durable recovery needs and the runner contract does not
 * have yet:
 *
 * - `endpoint`: where the session lives, journaled at start so a restarted
 *   sidecar can find it (W09a per-attempt server URL + password, or the
 *   trusted-host shared server; for process runtimes the process identity);
 * - `inspect`: busy / idle / gone, without prompting. Process runtimes
 *   (Claude Code, Codex) answer `detached`: their output died with the
 *   previous sidecar and cannot be re-attached (W07a);
 * - `attach`: the session's event stream without submitting anything
 *   (`AgentRunner.resume` re-sends a turn on OpenCode, so it is not used);
 * - `abort`: a positive stop receipt (true only when the provider confirmed).
 *
 * Every runtime's event stream submits the prompt when it is first
 * consumed, never at `start`: the run service journals the prompt intent in
 * between (journal before dispatch).
 */
export interface StartedRuntimeSession {
  session: AgentSession;
  endpoint: RuntimeEndpoint | null;
}

/** W07a: continue a runner's saved session with a new turn (follow-up). */
export interface ResumeRuntimeInput {
  runId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  model?: StartInput['model'];
  permissions: PermissionPolicy;
  env: Record<string, string>;
  signal: AbortSignal;
}

export interface RunRuntime {
  readonly runnerId: RunnerId;
  /**
   * FE-04: `interactive` = a session started with `permissions.default:
   * 'ask'` emits `permission.requested` and waits for `replyPermission`;
   * absent or `policy-only` = the start policy decides (no person is asked).
   */
  readonly approvals?: 'interactive' | 'policy-only';
  /**
   * W07a: refuse what `start` would refuse, without spawning or dispatching
   * anything (unsupported model for this runner, missing binary, no
   * reachable credential). Throws the HTTP error the caller returns:
   * RUNNER_NOT_SUPPORTED (400), RUNNER_UNAVAILABLE (503),
   * RUNNER_AUTH_UNAVAILABLE (412).
   */
  preflight?(input: { model: string | null; env: Record<string, string> }): Promise<void>;
  start(input: StartInput): Promise<StartedRuntimeSession>;
  /**
   * W07a: a new turn on the runner's own saved session (OpenCode session
   * continue, Claude `--resume`, Codex thread resume). Null when the session
   * cannot be continued here (not saved, gone, unknown id) — the caller
   * then seeds a fresh session instead. Nothing is dispatched before the
   * returned session's events are consumed.
   */
  resume?(input: ResumeRuntimeInput): Promise<StartedRuntimeSession | null>;
  inspect(endpoint: RuntimeEndpoint, sessionId: string): Promise<Exclude<RuntimeProbe, 'not-probed'>>;
  attach(endpoint: RuntimeEndpoint, sessionId: string, signal: AbortSignal): Promise<AgentSession>;
  abort(endpoint: RuntimeEndpoint | null, sessionId: string): Promise<boolean>;
  /** After the terminal decision: free per-attempt runtime resources (W09a attempt server). */
  release?(endpoint: RuntimeEndpoint): Promise<void>;
}
