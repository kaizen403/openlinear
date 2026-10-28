import { prisma } from '@openlinear/db';
import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { pruneStream } from '../events/stream';
import { pruneIdempotencyRecords } from '../services/idempotency';
import { sweepLostExecutionAttempts } from '../services/execution-sweeper';
import { runDueSchedules } from '../services/schedules';
import { pruneWebhookDeliveries, runWebhookCycle } from '../services/webhooks';

export const JOB_NAMES = {
  sessionPurge: 'session-purge',
  invitationExpiry: 'invitation-expiry',
  attachmentSweep: 'attachment-sweep',
  auditRetention: 'audit-retention',
  usageRollup: 'usage-rollup',
  githubRefresh: 'github-refresh',
  outboxPrune: 'outbox-prune',
  idempotencyPrune: 'idempotency-prune',
  executionLeaseSweep: 'execution-lease-sweep',
  scheduleRun: 'schedule-run',
  webhookDeliver: 'webhook-deliver',
  webhookPrune: 'webhook-prune',
} as const;

/** W05a: the lease sweeper runs every minute (it is cheap: one indexed scan). */
export const EXECUTION_LEASE_SWEEP_INTERVAL_MS = 60 * 1000;

/** W20: recurring issues are checked every minute (slots are whole minutes). */
export const SCHEDULE_RUN_INTERVAL_MS = 60 * 1000;

/**
 * FE-14: webhook fan-out + delivery pass in interval mode (pg-boss cron runs
 * it every minute; retries are a minute or more apart either way).
 */
export const WEBHOOK_CYCLE_INTERVAL_MS = 5 * 1000;

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

/**
 * Stream retention (W04b): delete events sequenced more than `maxAgeHours`
 * ago, whether or not the bus published them, and record the highest pruned
 * id so replay from an older cursor reports truncation instead of silently
 * skipping events.
 */
export async function pruneOutbox(maxAgeHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  return pruneStream(cutoff);
}

/**
 * Legacy `idempotency_keys` rows written by API versions before W04b. No
 * current code path reads or writes the table; drop this prune together with
 * the table in a contract migration.
 */
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
  const idempotencyRecords = await pruneIdempotencyRecords();
  const webhookDeliveries = await pruneWebhookDeliveries();
  logger.info(
    { sessions, invitations, outbox, audit, attachments, idempotency, idempotencyRecords, webhookDeliveries },
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
  const sweep = setInterval(() => {
    void sweepLostExecutionAttempts().catch((err) => {
      logger.error({ err }, '[jobs] execution lease sweep failed');
    });
  }, EXECUTION_LEASE_SWEEP_INTERVAL_MS);
  sweep.unref();
  const schedules = setInterval(() => {
    void runDueSchedules().catch((err) => {
      logger.error({ err }, '[jobs] schedule run failed');
    });
  }, SCHEDULE_RUN_INTERVAL_MS);
  schedules.unref();
  const webhooks = setInterval(() => {
    void runWebhookCycle().catch((err) => {
      logger.error({ err }, '[jobs] webhook cycle failed');
    });
  }, WEBHOOK_CYCLE_INTERVAL_MS);
  webhooks.unref();
  return () => {
    clearInterval(timer);
    clearInterval(sweep);
    clearInterval(schedules);
    clearInterval(webhooks);
  };
}

/**
 * Every step of `runScheduledJobs`, as a pg-boss queue with a cron schedule.
 * pg-boss mode replaces the interval loop entirely, so anything the loop runs
 * must appear here too (the idempotency prunes used to be missing).
 * Handlers take no arguments: pg-boss passes the job batch as the first
 * argument, which must never reach parameters such as `maxAgeHours`.
 */
const PG_BOSS_SCHEDULE: ReadonlyArray<{ name: string; cron: string; run: () => Promise<unknown> }> = [
  { name: JOB_NAMES.sessionPurge, cron: '0 * * * *', run: () => purgeExpiredSessions() },
  { name: JOB_NAMES.invitationExpiry, cron: '*/15 * * * *', run: () => expireInvitations() },
  { name: JOB_NAMES.outboxPrune, cron: '0 */6 * * *', run: () => pruneOutbox() },
  { name: JOB_NAMES.auditRetention, cron: '0 3 * * *', run: () => pruneAuditLogs() },
  { name: JOB_NAMES.attachmentSweep, cron: '0 4 * * *', run: () => sweepPendingAttachments() },
  { name: JOB_NAMES.executionLeaseSweep, cron: '* * * * *', run: () => sweepLostExecutionAttempts() },
  { name: JOB_NAMES.scheduleRun, cron: '* * * * *', run: () => runDueSchedules() },
  { name: JOB_NAMES.webhookDeliver, cron: '* * * * *', run: () => runWebhookCycle() },
  { name: JOB_NAMES.webhookPrune, cron: '15 4 * * *', run: () => pruneWebhookDeliveries() },
  {
    name: JOB_NAMES.idempotencyPrune,
    cron: '30 * * * *',
    run: async () => {
      await pruneIdempotencyKeys();
      await pruneIdempotencyRecords();
    },
  },
];

/**
 * Optional pg-boss wiring. When `pg-boss` is installed and DATABASE_URL is set,
 * the worker prefers it; otherwise the in-process interval above is used.
 * Returns null — with no pg-boss handler left running — whenever pg-boss is
 * disabled or any setup step fails, so a caller can fall back to the interval
 * loop without the two ever running side by side.
 */
export async function startPgBoss(): Promise<{ stop: () => Promise<void> } | null> {
  if (process.env.NODE_ENV === 'test' || process.env.OPENLINEAR_JOBS === '0') {
    return null;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  let boss: PgBoss | null = null;
  try {
    const { default: PgBossClass } = await import('pg-boss');
    const instance = new PgBossClass({ connectionString, schema: 'pgboss' });
    boss = instance;
    // An EventEmitter 'error' without a listener throws and would crash the
    // process on the first transient database error.
    instance.on('error', (err) => {
      logger.error({ err }, '[jobs] pg-boss error');
    });
    await instance.start();
    for (const job of PG_BOSS_SCHEDULE) {
      // pg-boss v10 requires the queue to exist before work()/schedule();
      // createQueue is idempotent.
      await instance.createQueue(job.name);
      await instance.work(job.name, async () => {
        await job.run();
      });
      await instance.schedule(job.name, job.cron, {});
    }
    logger.info({ queues: PG_BOSS_SCHEDULE.map((job) => job.name) }, '[jobs] pg-boss started');
    return { stop: () => instance.stop() };
  } catch (err) {
    logger.warn({ err }, '[jobs] pg-boss unavailable; using in-process interval');
    // Workers registered before the failure would otherwise keep polling next
    // to the fallback loop and run the same maintenance twice.
    if (boss) {
      await boss.stop({ graceful: false }).catch((stopErr: unknown) => {
        logger.warn({ err: stopErr }, '[jobs] failed to stop partially started pg-boss');
      });
    }
    return null;
  }
}
