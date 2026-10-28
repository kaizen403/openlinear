import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../../../.env') });

import { startTelemetry } from '@openlinear/telemetry';
import { prisma } from '@openlinear/db';
import { validateStartupEnv } from './env';
import { logger } from './logger';
import { startRealtime, stopRealtime } from './events/relay';
import { readRealtimeConfig } from './events/config';
import { startEventBus, stopEventBus } from './events/bus';
import { type BackgroundJobs, JOBS_RUNNER_ENV, resolveJobsRunner, startBackgroundJobs } from './jobs/runner';

/**
 * Background worker: `node dist/worker.js` (same image as the API).
 *
 * - Maintenance jobs run here when OPENLINEAR_JOBS_RUNNER is `worker` (the
 *   default): pg-boss if it starts, otherwise the interval loop, never both.
 * - The outbox relay runs here only when OPENLINEAR_OUTBOX_RELAY=worker (set
 *   the same value in every container; default `api`). Relay ownership is a
 *   role, not a per-process flag: claims are leased and sequencing is
 *   serialized, so replicas of the owner role share the work. API replicas
 *   read the commit-ordered event stream from Postgres themselves (and from
 *   Redis when REDIS_URL is set), so a worker-owned relay needs no Redis.
 *   See events/config.ts.
 */

validateStartupEnv();
const jobsRunner = resolveJobsRunner();
startTelemetry();

const bus = await startEventBus();
const relayEnabled = readRealtimeConfig().relayOwner === 'worker';
if (relayEnabled) {
  await startRealtime({ role: 'worker' });
}

let jobs: BackgroundJobs | null = null;
if (jobsRunner === 'worker') {
  jobs = await startBackgroundJobs();
}

// The worker is a daemon: stay up until signalled. The interval loop and the
// relay timers are unref()'d, so without this the process would exit once the
// database pool goes idle. With nothing to do, exiting would also make the
// orchestrator restart it in a loop.
const keepAlive = setInterval(() => undefined, 60 * 60 * 1000);
if (!jobs && !relayEnabled) {
  logger.warn(
    { [JOBS_RUNNER_ENV]: jobsRunner, distributedBus: bus.distributed },
    '[worker] idle: jobs are not assigned to the worker and the outbox relay is not owned by the worker (OPENLINEAR_OUTBOX_RELAY)',
  );
}

logger.info(
  {
    jobs: jobs ? jobs.mode : 'off',
    [JOBS_RUNNER_ENV]: jobsRunner,
    outboxRelay: relayEnabled ? 'on' : 'off',
    distributedBus: bus.distributed,
  },
  '[worker] started',
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, '[worker] shutting down');

  // Container Apps sends SIGKILL 30 s after SIGTERM by default; pg-boss waits
  // up to 30 s for active jobs. Leave headroom and exit on our own terms.
  const forceExit = setTimeout(() => {
    logger.fatal('[worker] graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 25_000);
  forceExit.unref();

  clearInterval(keepAlive);
  stopRealtime();
  try {
    if (jobs) await jobs.stop();
  } catch (err) {
    logger.error({ err }, '[worker] failed to stop background jobs');
  }
  await stopEventBus();
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, '[worker] prisma disconnect failed');
  }
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[worker] unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[worker] uncaughtException');
  void shutdown('SIGTERM', 1);
});
