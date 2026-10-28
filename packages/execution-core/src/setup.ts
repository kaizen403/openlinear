/**
 * W16a — environment setup recipes: commands a project runs in the run's
 * worktree after the worktree is prepared and before the agent's first
 * prompt, so the agent starts with its dependencies installed (inside its
 * sandbox it has no network and cannot install them itself).
 *
 * - Defined in the project's execution settings next to the verification
 *   checks (`executionSettings.verification.setup`), in the same spec format
 *   and with the same parser and bounds as a check (`run` or `command`, cwd
 *   inside the worktree, timeout, network `none` unless the step declares
 *   `registries` or an allowlist, `required` by default); at most 10 steps.
 * - Sealed into the attempt snapshot at start with the verification
 *   settings, so a run uses the steps as they were when it started.
 * - Executed by the sidecar in order, in the run's worktree, with the
 *   verification check executor (enforced OS sandbox, the worktree the only
 *   writable project directory, a private HOME/TMP, egress only through the
 *   per-step proxy allowlist, bounded and redacted logs, timeouts).
 * - A required step that fails or times out fails the run before any
 *   prompt (the worktree is kept); an optional step's failure is logged and
 *   the run continues.
 * - A step runs once per worktree: a step recorded as passed (same command,
 *   directory and network) by the run or by the run a follow-up continues is
 *   not run again — after a crash during setup, a follow-up resumes setup
 *   where it stopped.
 *
 * Pure: no I/O. Parsing lives with the check parser (`verification.ts`:
 * `parseSetupSteps`, `resolveSetupPlan`, `setupStepHash`).
 */
import type { VerificationCheckResult, VerificationCheckSpec } from './verification';

export const SETUP_LIMITS = {
  maxSteps: 10,
} as const;

/** The setup steps a run executes, from its sealed settings. */
export interface SetupPlan {
  steps: VerificationCheckSpec[];
  /** sha256 of the canonical steps (recorded with every step). */
  setupHash: string;
  /** Why the sealed steps could not be read: the run fails before the agent starts. */
  problems: string[];
}

/** What a step does — its identity for "already done in this worktree": command, directory and network. */
export function setupStepIdentity(step: VerificationCheckSpec): { argv: string[]; cwd: string; network: VerificationCheckSpec['network'] } {
  return { argv: step.argv, cwd: step.cwd, network: step.network };
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

type StepOutcome = Pick<VerificationCheckResult, 'name' | 'status' | 'exitCode' | 'signal' | 'detail'>;

function outcomeOf(result: StepOutcome): string {
  switch (result.status) {
    case 'passed':
      return 'passed';
    case 'timed_out':
      return result.detail ?? 'timed out';
    case 'failed':
      return result.exitCode !== null ? `exited ${result.exitCode}` : `was terminated by ${result.signal ?? 'a signal'}`;
    case 'error':
    case 'skipped':
      return `could not run${result.detail ? `: ${result.detail}` : ''}`;
  }
}

/** Why a step did not pass, e.g. "install exited 1" or "install timed out after 600 s". */
export function describeSetupFailure(result: StepOutcome): string {
  return `${result.name} ${outcomeOf(result)}`;
}

/** The run's outcome when a required step fails: "Setup failed: install exited 1". */
export function setupFailureOutcome(result: StepOutcome): string {
  return `Setup failed: ${describeSetupFailure(result)}`;
}

/** One line per finished step for the run's log, e.g. `Setup step "install" passed (exit 0 · 41.2 s)`. */
export function describeSetupStep(result: StepOutcome & Pick<VerificationCheckResult, 'required' | 'durationMs'>): string {
  const label = `Setup step "${result.name}"${result.required ? '' : ' (optional)'}`;
  if (result.status === 'passed') return `${label} passed (exit 0 · ${formatDuration(result.durationMs)})`;
  return `${label} ${outcomeOf(result)}${result.status === 'failed' ? ` (${formatDuration(result.durationMs)})` : ''}`;
}
