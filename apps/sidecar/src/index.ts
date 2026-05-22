import express from 'express';
import type { Server } from 'node:http';
import { prisma } from '@openlinear/db';
import { logger } from '@openlinear/api/logger';
import { createSidecarApp } from './app';
import { initOpenCode, registerShutdownHandlers } from './services/opencode';
import {
  recoverInFlightExecutions,
  recoverActiveBatches,
} from './services/execution/recovery';

const PORT = Number(process.env.API_PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const OAUTH_INTERCEPTOR_PORT = Number(process.env.OAUTH_INTERCEPTOR_PORT ?? 1455);
const BIND_HOST = process.env.SIDECAR_BIND_HOST || '127.0.0.1';

export async function loadDotenvIfPresent() {
  if (process.env.OPENLINEAR_SKIP_DOTENV === '1') return;
  try {
    const dotenv = await import('dotenv');
    const { resolve } = await import('node:path');
    const dirname = (import.meta as { dirname?: string }).dirname;
    let cwd = dirname;
    /* v8 ignore start -- package snapshot fallback; Vitest always provides import.meta.dirname. */
    if (!cwd) cwd = process.cwd();
    /* v8 ignore stop */
    dotenv.config({ path: resolve(cwd, '../../../.env'), quiet: true });
  } catch {
    // dotenv missing or path unresolvable (e.g. inside pkg snapshot) — skip silently.
  }
}

export function printOpenCodeSingleTenantBanner() {
  const banner = [
    '================================================================',
    '  OpenCode runs in SINGLE-TENANT mode.',
    '  All authenticated OpenLinear users share one OpenCode process,',
    '  one provider auth store, and one session namespace.',
    '  See docs/limitations.md for details.',
    '================================================================',
  ].join('\n');
  process.stdout.write(banner + '\n');
  logger.warn('[Sidecar] OpenCode runs in single-tenant mode — see docs/limitations.md');
}

export function closeServer(server: Server, name: string): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((err?: Error & { code?: string }) => {
      if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
        logger.error({ err }, `[Sidecar] ${name}.close error`);
      }
      resolve();
    });
  });
}

export async function start() {
  await loadDotenvIfPresent();
  const app = createSidecarApp();
  registerShutdownHandlers();

  const server = app.listen(PORT, BIND_HOST, () => {
    logger.info({ host: BIND_HOST, port: PORT }, '[Sidecar] server listening');
  });

  const interceptApp = express();
  interceptApp.get('/auth/callback', (req, res) => {
    const searchParams = new URLSearchParams(req.query as Record<string, string>);
    res.redirect(`${FRONTEND_URL}/auth/callback?${searchParams.toString()}`);
  });

  const interceptServer = interceptApp
    .listen(OAUTH_INTERCEPTOR_PORT, BIND_HOST, () => {
      logger.info(
        { host: BIND_HOST, port: OAUTH_INTERCEPTOR_PORT },
        '[Sidecar] OAuth Interceptor listening',
      );
    })
    .on('error', (err) => {
      logger.warn(
        { err: err.message, port: OAUTH_INTERCEPTOR_PORT },
        '[Sidecar] could not start OAuth Interceptor',
      );
    });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '[Sidecar] shutdown received, draining...');

    const forceExit = setTimeout(() => {
      logger.fatal('[Sidecar] graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    void (async () => {
      await closeServer(interceptServer, 'oauth interceptor');
      await closeServer(server, 'server');
      try {
        await prisma.$disconnect();
        logger.info('[Sidecar] prisma disconnected');
      } catch (disconnectErr) {
        logger.error({ err: disconnectErr }, '[Sidecar] prisma disconnect failed');
      }
      clearTimeout(forceExit);
      process.exit(0);
    })().catch((err: unknown) => {
      logger.error({ err }, '[Sidecar] graceful shutdown failed');
      clearTimeout(forceExit);
      process.exit(1);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '[Sidecar] unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '[Sidecar] uncaughtException');
    shutdown('SIGTERM');
  });

  try {
    await prisma.$connect();
    await recoverInFlightExecutions();
    await recoverActiveBatches();
  } catch (err) {
    logger.error({ err }, '[Sidecar] recovery sweep failed (continuing boot)');
  }

  // OpenCode runs in single-tenant mode (one shared subprocess for all users).
  // See docs/limitations.md. Refuse to boot in obvious multi-user setups unless
  // the operator has explicitly acknowledged the shared-state risk.
  printOpenCodeSingleTenantBanner();
  try {
    const userCount = await prisma.user.count();
    const allowShared = process.env.OPENLINEAR_ALLOW_SHARED_OPENCODE === '1';
    if (userCount > 1 && !allowShared) {
      logger.fatal(
        { userCount },
        '[Sidecar] Multi-user database detected but OpenCode runs in single-tenant mode. ' +
          'All users would share OpenCode provider credentials and sessions. ' +
          'Set OPENLINEAR_ALLOW_SHARED_OPENCODE=1 to acknowledge and proceed, ' +
          'or run one sidecar instance per user. See docs/limitations.md.',
      );
      await prisma.$disconnect().catch(() => undefined);
      process.exit(2);
    }
    if (userCount > 1 && allowShared) {
      logger.warn(
        { userCount },
        '[Sidecar] Multi-user database with OPENLINEAR_ALLOW_SHARED_OPENCODE=1 — ' +
          'users WILL share OpenCode auth state. See docs/limitations.md.',
      );
    }
  } catch (err) {
    logger.error({ err }, '[Sidecar] Failed to count users for single-tenant guard (continuing)');
  }

  try {
    await initOpenCode();
    logger.info('[Sidecar] OpenCode agent ready');
  } catch (error) {
    logger.error({ err: error }, '[Sidecar] Failed to initialize OpenCode');
    logger.warn('[Sidecar] Continuing without OpenCode — task execution will fail until restart');
  }
}

if (process.env.OPENLINEAR_SIDECAR_AUTOSTART !== '0') {
  start().catch((err) => {
    logger.fatal({ err }, '[Sidecar] Fatal startup error');
    process.exit(1);
  });
}

export { createSidecarApp };
