import { logger } from '../logger';
import { startJobLoop, startPgBoss } from './index';

/**
 * Which process runs background maintenance jobs.
 *
 * `OPENLINEAR_JOBS_RUNNER` must be set to the same value on every process of a
 * deployment:
 * - `worker` (default): only `node dist/worker.js` runs jobs. The API never
 *   starts a job handler, however many replicas it has.
 * - `api`: single-process deployments without a worker. The API runs jobs
 *   itself and the worker (if one is started anyway) stays idle.
 * - `off`: nothing runs jobs.
 *
 * Within the selected process, pg-boss and the in-process interval loop are
 * mutually exclusive (see `startBackgroundJobs`).
 */
export type JobsRunner = 'worker' | 'api' | 'off';

export const JOBS_RUNNER_ENV = 'OPENLINEAR_JOBS_RUNNER';

const RUNNERS: ReadonlySet<string> = new Set<JobsRunner>(['worker', 'api', 'off']);

function isJobsRunner(value: string): value is JobsRunner {
  return RUNNERS.has(value);
}

/** Reads `OPENLINEAR_JOBS_RUNNER`. Throws on an unknown value so a typo fails at boot. */
export function resolveJobsRunner(env: NodeJS.ProcessEnv = process.env): JobsRunner {
  const raw = env[JOBS_RUNNER_ENV]?.trim().toLowerCase();
  if (!raw) return 'worker';
  if (isJobsRunner(raw)) return raw;
  throw new Error(`[jobs] ${JOBS_RUNNER_ENV} must be one of worker, api, off (got "${raw}")`);
}

export type BackgroundJobsMode = 'pg-boss' | 'interval';

export interface BackgroundJobs {
  mode: BackgroundJobsMode;
  stop: () => Promise<void>;
}

/**
 * Starts the maintenance jobs exactly once per process: pg-boss when it starts
 * cleanly, otherwise the in-process interval loop — never both.
 */
export async function startBackgroundJobs(): Promise<BackgroundJobs> {
  const boss = await startPgBoss();
  if (boss) {
    logger.info({ mode: 'pg-boss' }, '[jobs] background jobs started');
    return { mode: 'pg-boss', stop: () => boss.stop() };
  }
  const stopLoop = startJobLoop();
  logger.info({ mode: 'interval' }, '[jobs] background jobs started');
  return {
    mode: 'interval',
    stop: async () => {
      stopLoop();
    },
  };
}
