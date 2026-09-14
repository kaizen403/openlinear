export type RecoveryAction = 'RESUME' | 'SALVAGE' | 'FAIL' | 'COMPLETE_IDEMPOTENT';

export type JournalRunStatus = 'running' | 'completing' | 'succeeded' | 'failed' | 'cancelled';

export interface JournalRun {
  id: string;
  taskId: string;
  batchId: string | null;
  runner: string;
  externalSessionId: string | null;
  worktreePath: string | null;
  status: JournalRunStatus;
  startedAt: number;
  heartbeatAt: number;
  finishedAt: number | null;
  budgetsJson: string;
  usageJson: string | null;
}

export interface JournalEventRow {
  runId: string;
  seq: number;
  at: number;
  type: string;
  payloadJson: string;
}

export function decideRecovery(input: {
  status: JournalRunStatus;
  heartbeatAt: number;
  now: number;
  runnerFound: boolean;
  runnerBusy: boolean;
  hasDiff: boolean;
}): RecoveryAction {
  if (input.status === 'completing') return 'COMPLETE_IDEMPOTENT';
  if (input.status !== 'running') return 'FAIL';
  const stale = input.now - input.heartbeatAt > 2 * 60 * 1000;
  if (!input.runnerFound) return 'FAIL';
  if (!stale && input.runnerBusy) return 'RESUME';
  if (stale && input.hasDiff) return 'SALVAGE';
  if (!stale && !input.runnerBusy && input.hasDiff) return 'SALVAGE';
  return 'FAIL';
}

export interface AdmissionDecision {
  admitted: boolean;
  queued: boolean;
}

export function admitRun(input: {
  liveRuns: number;
  liveBatches: number;
  liveWorktrees: number;
  maxRuns: number;
  maxBatches: number;
  maxWorktrees: number;
  isBatch: boolean;
}): AdmissionDecision {
  if (input.liveRuns >= input.maxRuns) return { admitted: false, queued: true };
  if (input.isBatch && input.liveBatches >= input.maxBatches) return { admitted: false, queued: true };
  if (input.liveWorktrees >= input.maxWorktrees) return { admitted: false, queued: true };
  return { admitted: true, queued: false };
}
