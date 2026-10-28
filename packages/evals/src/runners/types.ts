import type { FeatureReceipt, TrialPhase } from '../features/types';
import type { Termination } from '../grading/outcome';
import type { Configuration, EvalManifest } from '../manifest/schema';
import type { LoadedTask } from '../tasks/types';
import type { TimedEvent } from '../trajectory/types';
import type { RawUsage } from '../usage/cost';

/** Everything a harness runner gets for one trial. The worktree is a fresh, independent checkout. */
export interface TrialContext {
  trialId: string;
  attempt: number;
  repeat: number;
  task: LoadedTask;
  configuration: Configuration;
  manifest: EvalManifest;
  /** Fresh checkout at `baseSha`; the runner's only writable project directory. */
  worktree: string;
  baseSha: string;
  /** Private scratch directory for this trial (HOME, XDG, recordings) — never the worktree. */
  scratchDir: string;
  /** Agent-facing prompt (the task instruction; never grader content). */
  prompt: string;
  /** System contract given to OpenLinear runs (hashed into the manifest). */
  systemContract: string;
  /** Sealed holdout trial: memory/promotion must stay disabled. */
  sealed: boolean;
  signal: AbortSignal;
  /**
   * Which session of the trial this is (W21 reviewer ablation): `review`
   * runs with a deny permission policy in a disposable checkout. Default `run`.
   */
  phase?: TrialPhase;
  /** USD cap for this session when it differs from `manifest.budgets.maxUsdPerTask` (what is left of the per-task cap). */
  budgetUsd?: number | null;
}

/** What a harness runner can apply itself (W21). Absent = nothing: features are refused for it. */
export interface FeatureSupport {
  /** The prompt the harness hands over is the prompt the agent gets (knowledge / repository context sections). */
  promptSections: boolean;
  /** Separate sessions per trial phase, with the review session under a deny policy. */
  reviewPhases: boolean;
}

export interface RunnerResult {
  termination: Termination;
  terminationDetail: string;
  events: TimedEvent[];
  /** Raw stdout protocol lines for native CLIs (kept verbatim for audit). */
  nativeLines: string[];
  usage: RawUsage;
  /** Agent phase only: from start to the terminal event/exit. */
  agentMs: number;
  /** Time to the first tool call (first agent action), null when none. */
  firstActionMs: number | null;
  /** Model id reported by the runner, if it reports one. */
  observedModel: string | null;
  observedRunnerVersion: string | null;
  /** What was (or, in FAKE mode, would have been) launched. */
  invocation: { command: string; args: string[]; fake: boolean } | null;
  logs: string[];
  /** Runner start failure code (e.g. SANDBOX_UNAVAILABLE), for faithful replay. */
  startErrorCode?: string;
  /** Native CLI exit code, for faithful replay. */
  exitCode?: number | null;
  /** The prompt actually sent when features changed it (W21). */
  prompt?: string;
  /** What the features applied (W21); absent for configurations without features. */
  features?: FeatureReceipt;
}

export interface HarnessRunner {
  /** Short label for logs and reports. */
  readonly kind: string;
  readonly featureSupport?: FeatureSupport;
  run(context: TrialContext): Promise<RunnerResult>;
}

export function firstActionMs(events: readonly TimedEvent[]): number | null {
  return events.find((timed) => timed.event.t === 'tool.started')?.atMs ?? null;
}
