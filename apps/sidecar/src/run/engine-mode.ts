import { logger } from '../lib/logger';
import type { RunService } from './service';

/**
 * `OPENLINEAR_RUN_ENGINE` selects the single-task execution engine:
 * - unset / `v2` (default since W07a): the durable run service
 *   (W05a/W06a/W07a) — OpenCode, Claude Code and Codex, follow-up turns —
 *   in API persistence mode; outside it (Prisma test/`--with-cloud-api`
 *   mode) execution falls back to the legacy engine;
 * - `legacy` (or `v1`): the W01/W03a lifecycle path, still selectable.
 *   Batches always use the legacy batch engine (501 in API mode).
 *
 * Kept free of heavy imports: routes consult it on every request, and the
 * run service itself is loaded lazily the first time v2 is used.
 */
export const RUN_ENGINE_ENV = 'OPENLINEAR_RUN_ENGINE';
export type RunEngineMode = 'legacy' | 'v2';
export const DEFAULT_RUN_ENGINE: RunEngineMode = 'v2';

let warned = false;

export function resolveRunEngineMode(env: NodeJS.ProcessEnv = process.env): RunEngineMode {
  const raw = env[RUN_ENGINE_ENV]?.trim().toLowerCase();
  if (!raw) return DEFAULT_RUN_ENGINE;
  if (raw === 'legacy' || raw === 'v1') return 'legacy';
  if (raw === 'v2') return 'v2';
  if (!warned) {
    warned = true;
    logger.warn({ value: raw }, `[RunEngine] unknown ${RUN_ENGINE_ENV}; using the default (${DEFAULT_RUN_ENGINE}) engine`);
  }
  return DEFAULT_RUN_ENGINE;
}

/** Whether the engine was chosen explicitly (an explicit v2 outside API mode is worth a warning; the default is not). */
export function runEngineExplicit(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[RUN_ENGINE_ENV]?.trim());
}

export type RunServiceHandle = Pick<RunService, 'isRunning' | 'ownerOf' | 'cancel' | 'logsFor' | 'describe' | 'submit' | 'followUp'>
  & Partial<Pick<RunService, 'pendingApprovals' | 'approvalsWaitingOn' | 'decideApproval'>>;

let current: RunServiceHandle | null = null;

/** Set by the run engine factory (and tests). */
export function registerRunService(handle: RunServiceHandle | null): void {
  current = handle;
}

/** The live run service, if v2 has been started in this process. */
export function currentRunService(): RunServiceHandle | null {
  return current;
}
