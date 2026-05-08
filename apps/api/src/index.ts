import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname, '../../../.env') });

import { prisma } from '@openlinear/db';
import { createApp } from './app';
import { validateStartupEnv } from './env';
import { logger } from './logger';

validateStartupEnv();

const app = createApp();
const PORT = Number(process.env.API_PORT ?? 3001);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, '[API] server listening');
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
