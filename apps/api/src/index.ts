import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../../../.env') });

import { startTelemetry } from '@openlinear/telemetry';
import { prisma } from '@openlinear/db';
import { createApp } from './app';
import { validateStartupEnv } from './env';
import { logger } from './logger';
import { startRealtime, stopRealtime } from './events/relay';
import { stopEventBus } from './events/bus';
import { type BackgroundJobs, JOBS_RUNNER_ENV, resolveJobsRunner, startBackgroundJobs } from './jobs/runner';

validateStartupEnv();
// Background jobs belong to the worker (`node dist/worker.js`) unless
// OPENLINEAR_JOBS_RUNNER=api: a single-process deployment with no worker.
const jobsRunner = resolveJobsRunner();
startTelemetry();

const app = createApp();
const PORT = Number(process.env.API_PORT ?? 3001);

let jobs: BackgroundJobs | null = null;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, [JOBS_RUNNER_ENV]: jobsRunner }, '[API] server listening');
  void startRealtime({ role: 'api' }).catch((err) => {
    logger.error({ err }, '[API] failed to start realtime fan-out');
  });
  if (jobsRunner === 'api') {
    void startBackgroundJobs()
      .then((started) => {
        jobs = started;
      })
      .catch((err) => {
        logger.error({ err }, '[API] failed to start background jobs');
      });
  }
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, '[API] SIGTERM received, draining...');

  // Force-exit after 10s if shutdown stalls (open SSE connections, slow queries)
  const forceExit = setTimeout(() => {
    logger.fatal('[API] graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async (err) => {
    if (err) {
      logger.error({ err }, '[API] server.close error');
    }
    try {
      stopRealtime();
      if (jobs) await jobs.stop();
      await stopEventBus();
      await prisma.$disconnect();
      logger.info('[API] prisma disconnected');
    } catch (disconnectErr) {
      logger.error({ err: disconnectErr }, '[API] prisma disconnect failed');
    }
    clearTimeout(forceExit);
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[API] unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[API] uncaughtException');
  shutdown('SIGTERM');
});

export { app };
