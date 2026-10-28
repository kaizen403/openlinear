import { apiFetch } from './fetch';

/**
 * The review loop's local-execution calls (all served by the sidecar; see
 * SIDECAR_ROUTES in ./routes.ts):
 *
 * - `GET  /api/tasks/:id/diff?base=` — what the agent changed in the task's
 *   attempt worktree, against its base commit (committed, staged, unstaged
 *   and untracked changes). Bounded server-side; `truncated` flags say where.
 * - `POST /api/tasks/:id/follow-up` — send review comments + a message back to
 *   the agent as a new attempt. `202 { runId, attemptId, state }`.
 * - `GET  /api/tasks/:id/run` — the v2 run state (runengine §12): terminal
 *   decision, publication effects and, once W11 lands, verification.
 *
 * Diff content is untrusted text from an agent-controlled worktree. Callers
 * render it as React text nodes only (never HTML).
 */

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number;
  newNo?: number;
  text: string;
  /** The line was cut at the server's `limits.maxLineChars`. */
  truncated?: true;
  /** "\ No newline at end of file" followed this line. */
  noEol?: true;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  /** Exact totals (numstat), even when `hunks` were cut. */
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated?: true;
  /** Rename similarity, 0–100. */
  similarity?: number;
  /** Not yet tracked by git (a new file the agent created). */
  untracked?: true;
}

export interface TaskDiffLimits {
  maxFiles: number;
  maxLinesPerFile: number;
  maxTotalLines: number;
  maxLineChars: number;
  maxPatchBytes: number;
  maxUntrackedFileBytes: number;
}

export interface TaskDiffResponse {
  base: { ref: string; sha: string };
  head: { ref: string | null; sha: string | null; dirty: boolean };
  /** Content fingerprint: unchanged when nothing in the diff changed. */
  revision: string;
  source: 'legacy-live' | 'v2' | 'legacy-disk';
  files: DiffFile[];
  truncated: boolean;
  stats: {
    files: number;
    additions: number;
    deletions: number;
    shownFiles: number;
    binaryFiles: number;
    untrackedFiles: number;
  };
  limits: TaskDiffLimits;
}

export interface FetchTaskDiffOptions {
  /** A branch/tag name or commit sha to diff against (default: the run's base). */
  base?: string | null;
  signal?: AbortSignal;
}

export async function fetchTaskDiff(taskId: string, options: FetchTaskDiffOptions = {}): Promise<TaskDiffResponse> {
  const query = options.base ? `?base=${encodeURIComponent(options.base)}` : '';
  return apiFetch<TaskDiffResponse>(`/api/tasks/${encodeURIComponent(taskId)}/diff${query}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** One inline review comment, anchored to a diff line (or to a whole file when `line` is absent). */
export interface FollowUpComment {
  path: string;
  line?: number;
  side?: 'old' | 'new';
  body: string;
}

export interface FollowUpRequest {
  message: string;
  comments?: FollowUpComment[];
  /**
   * W12: the run being continued (the run on screen). The sidecar refuses
   * with 409 FOLLOW_UP_RUN_MISMATCH when it isn't this device's latest run of
   * the task. Review follow-ups omit it and continue the latest run.
   */
  parentRunId?: string;
}

export interface FollowUpResponse {
  runId: string;
  attemptId: string | null;
  state: string;
}

/**
 * Errors (mapped by components/review/review-errors.ts over lib/api/errors.ts):
 * 404 TASK_NOT_FOUND · 409 RUN_ACTIVE · 409 FOLLOW_UP_UNSUPPORTED ·
 * 409 FOLLOW_UP_RUN_MISMATCH (`parentRunId` isn't the latest local run) · 400 validation ·
 * 503 SANDBOX_UNAVAILABLE / CLOUD_API_UNREACHABLE · 404 without a code = the
 * sidecar predates the route ("update the desktop app").
 */
/** W12: the follow-up that continues a run interrupted before its outcome was known. */
export const CONTINUE_INTERRUPTED_MESSAGE =
  "The previous turn was interrupted before it finished (OpenLinear restarted or lost track of the agent). Check the repository's current state first, then finish the task. Don't redo work that is already done.";

export async function sendTaskFollowUp(taskId: string, request: FollowUpRequest): Promise<FollowUpResponse> {
  return apiFetch<FollowUpResponse>(`/api/tasks/${encodeURIComponent(taskId)}/follow-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/**
 * W12 "stop and redirect": stop the running turn (its work is kept) and
 * continue with this instruction as a follow-up turn. 409 REDIRECT_PENDING
 * when the turn hasn't stopped yet.
 */
export async function redirectTask(taskId: string, message: string): Promise<FollowUpResponse> {
  return apiFetch<FollowUpResponse>(`/api/tasks/${encodeURIComponent(taskId)}/redirect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export type RunEffectStatus = 'pending' | 'confirmed' | 'failed';

export interface RunEffectSummary {
  key: string;
  kind: string;
  status: RunEffectStatus;
}

export interface RunTerminalSummary {
  state: 'succeeded' | 'failed' | 'cancelled' | 'recovery_required' | 'abandoned';
  reason: string;
  outcome: string | null;
  prUrl: string | null;
  claimed: boolean;
}

export type VerificationStatus = 'passed' | 'failed' | 'running' | 'pending' | 'skipped' | 'error';

export interface VerificationCheck {
  id?: string;
  name: string;
  status: VerificationStatus;
  /** False for informational checks: their failure does not fail verification. */
  required?: boolean;
  summary?: string;
  url?: string;
}

/** Where the checks ran (W11a evidence names the environment, not only the commit). */
export interface VerificationEnvironment {
  sandboxMode: 'enforce' | 'trusted-host' | 'none';
  provider: string | null;
  providerVersion: string | null;
  platform: string;
  arch: string;
  checkout: 'pristine-clone';
}

/**
 * W11a verification (sidecar run state): the checks sealed before the agent
 * ran, executed against `commit` in a pristine sandboxed checkout. A report
 * for another commit is stale. Fields past `checks` are additive.
 */
export interface RunVerification {
  status: VerificationStatus;
  commit?: string | null;
  checks: VerificationCheck[];
  policy?: 'require-pass' | 'warn' | 'off' | null;
  source?: 'project' | 'repository' | 'auto-detect' | 'none' | null;
  publication?: 'allowed' | 'blocked' | null;
  environment?: VerificationEnvironment | null;
  warnings?: string[];
  detail?: string | null;
  finishedAt?: string | null;
}

export interface TaskRunState {
  runId: string;
  state: string;
  attemptId: string | null;
  lastSeq: number;
  relayAckSeq: number;
  terminal: RunTerminalSummary | null;
  effects: RunEffectSummary[];
  /** W07a (additive): the runner the attempt actually uses, and the follow-up this run is. */
  runner?: string;
  followUp?: { parentRunId: string; mode: 'resume' | 'seeded' | null } | null;
  verification?: RunVerification | null;
  /** W11a: the run's worktree was removed by the retention sweep (follow-ups can't continue it). */
  workspaceExpired?: { at: string; reason: string } | null;
  /** W15a: the run's budgets, sealed at start (null = no limit). */
  budgets?: { maxUsd?: number; maxTokens?: number } | null;
  /** W15: where the run spent its time (from the sidecar's journal). */
  phases?: RunPhaseTimings | null;
  /** W19b: the project knowledge revisions the run was given (first runs only). */
  knowledge?: Array<{ id: string; version: number; kind: string; title: string }>;
}

/** W15: milliseconds per phase; setup is part of preparing, approval wait part of the agent. */
export interface RunPhaseTimings {
  queuedMs: number;
  preparingMs: number;
  setupMs: number;
  agentMs: number;
  approvalWaitMs: number;
  verifyingMs: number;
  finishingMs: number;
  totalMs: number;
  live: boolean;
}

export async function fetchTaskRunState(taskId: string): Promise<{ run: TaskRunState }> {
  return apiFetch<{ run: TaskRunState }>(`/api/tasks/${encodeURIComponent(taskId)}/run`);
}
