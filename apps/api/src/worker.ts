import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../../../.env') });

import { prisma } from '@openlinear/db';
import { validateStartupEnv } from './env';
import { logger } from './logger';
import { startRealtime, stopOutboxRelay } from './events/relay';
import { stopEventBus } from './events/bus';
import { startJobLoop, startPgBoss } from './jobs';

validateStartupEnv();

await startRealtime();
logger.info('[worker] outbox relay listening');
const stopJobs = startJobLoop();
const boss = await startPgBoss();

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, '[worker] shutting down');
  stopOutboxRelay();
  stopJobs();
  if (boss) await boss.stop();
  await stopEventBus();
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, '[worker] prisma disconnect failed');
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
