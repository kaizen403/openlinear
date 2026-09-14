import { prisma } from '@openlinear/db';
import { logger } from '../logger';

export const JOB_NAMES = {
  sessionPurge: 'session-purge',
  invitationExpiry: 'invitation-expiry',
  attachmentSweep: 'attachment-sweep',
  auditRetention: 'audit-retention',
  usageRollup: 'usage-rollup',
  githubRefresh: 'github-refresh',
  outboxPrune: 'outbox-prune',
} as const;

export async function purgeExpiredSessions(): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      revokedAt: null,
      expiresAt: { lte: new Date() },
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function expireInvitations(): Promise<number> {
  const result = await prisma.invitation.updateMany({
    where: {
      status: 'pending',
      expiresAt: { lte: new Date() },
    },
    data: { status: 'expired' },
  });
  return result.count;
}

export async function pruneOutbox(maxAgeHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  const result = await prisma.domainEvent.deleteMany({
    where: {
      publishedAt: { not: null, lte: cutoff },
    },
  });
  return result.count;
}

export async function pruneIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return result.count;
}

export async function pruneAuditLogs(retentionDays = 365): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lte: cutoff } },
  });
  return result.count;
}

export async function sweepPendingAttachments(): Promise<number> {
  const result = await prisma.chatAttachment.updateMany({
    where: {
      scanStatus: 'pending',
      createdAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    data: { scanStatus: 'expired' },
  });
  return result.count;
}

export async function runScheduledJobs(): Promise<void> {
  const sessions = await purgeExpiredSessions();
  const invitations = await expireInvitations();
  const outbox = await pruneOutbox();
  const audit = await pruneAuditLogs();
  const attachments = await sweepPendingAttachments();
  const idempotency = await pruneIdempotencyKeys();
  logger.info(
    { sessions, invitations, outbox, audit, attachments, idempotency },
    '[jobs] scheduled maintenance',
  );
}

const HOUR_MS = 60 * 60 * 1000;

export function startJobLoop(): () => void {
  if (process.env.NODE_ENV === 'test') {
    return () => undefined;
  }
  const timer = setInterval(() => {
    void runScheduledJobs().catch((err) => {
      logger.error({ err }, '[jobs] scheduled run failed');
    });
  }, HOUR_MS);
  timer.unref();
  void runScheduledJobs().catch((err) => {
    logger.error({ err }, '[jobs] initial run failed');
  });
  return () => clearInterval(timer);
}

/**
 * Optional pg-boss wiring. When `pg-boss` is installed and DATABASE_URL is set,
 * the worker prefers it; otherwise the in-process interval above is used.
 */
export async function startPgBoss(): Promise<{ stop: () => Promise<void> } | null> {
  if (process.env.NODE_ENV === 'test' || process.env.OPENLINEAR_JOBS === '0') {
    return null;
  }
  try {
    const { default: PgBoss } = await import('pg-boss');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return null;
    const boss = new PgBoss({ connectionString, schema: 'pgboss' });
    await boss.start();
    await boss.work(JOB_NAMES.sessionPurge, async () => {
      await purgeExpiredSessions();
    });
    await boss.work(JOB_NAMES.invitationExpiry, async () => {
      await expireInvitations();
    });
    await boss.work(JOB_NAMES.outboxPrune, async () => {
      await pruneOutbox();
    });
    await boss.work(JOB_NAMES.auditRetention, async () => {
      await pruneAuditLogs();
    });
    await boss.work(JOB_NAMES.attachmentSweep, async () => {
      await sweepPendingAttachments();
    });
    await boss.schedule(JOB_NAMES.sessionPurge, '0 * * * *', {});
    await boss.schedule(JOB_NAMES.invitationExpiry, '*/15 * * * *', {});
    await boss.schedule(JOB_NAMES.outboxPrune, '0 */6 * * *', {});
    await boss.schedule(JOB_NAMES.auditRetention, '0 3 * * *', {});
    await boss.schedule(JOB_NAMES.attachmentSweep, '0 4 * * *', {});
    logger.info('[jobs] pg-boss started');
    return { stop: () => boss.stop() };
  } catch (err) {
    logger.warn({ err }, '[jobs] pg-boss unavailable; using in-process interval');
    return null;
  }
}
