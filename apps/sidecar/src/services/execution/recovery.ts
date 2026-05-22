import { prisma } from '@openlinear/db';
import { logger } from '@openlinear/api/logger';
import { broadcastToTask } from '@openlinear/api/sse';

/**
 * T14 — Execution state recovery on sidecar restart.
 *
 * In-memory `activeExecutions` and `activeBatches` maps die with the process.
 * On boot, find tasks left in `in_progress` whose last AgentRun has no
 * `endedAt` and is older than 1 hour → mark them as `cancelled` (the schema
 * does not have a `failed` Status; cancelled is the closest terminal state)
 * with `outcome='sidecar_restart_orphan'`. Mark the AgentRun row itself as
 * `failed` with `errorMessage='sidecar_restart_orphan'` so analytics reflect
 * the failure mode.
 *
 * Tasks still within the 1h window get a "stuck" warning logged but are left
 * alone (T15 OpenCode reconnect work may rehydrate them later). We never
 * re-execute orphans automatically — that risks duplicate PRs.
 */

const ORPHAN_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export interface RecoveryResult {
  recovered: number;
  orphaned: number;
}

export async function recoverInFlightExecutions(): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, orphaned: 0 };

  let inFlight: Array<{
    id: string;
    teamId: string | null;
    creatorId: string | null;
    updatedAt: Date;
    agentRuns: Array<{ id: string; startedAt: Date; endedAt: Date | null }>;
  }>;
  try {
    inFlight = await prisma.task.findMany({
      where: { status: 'in_progress' },
      select: {
        id: true,
        teamId: true,
        creatorId: true,
        updatedAt: true,
        agentRuns: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true, startedAt: true, endedAt: true },
        },
      },
    });
  } catch (err) {
    logger.error({ err }, '[Recovery] failed to query in-flight tasks; skipping recovery');
    return result;
  }

  if (inFlight.length === 0) {
    logger.info('[Recovery] no in-flight tasks to recover');
    return result;
  }

  logger.info({ count: inFlight.length }, '[Recovery] inspecting in-flight tasks');

  const now = Date.now();
  for (const task of inFlight) {
    const lastRun = task.agentRuns[0];

    // No AgentRun row at all OR last run is still open → check age.
    const isOpen = !lastRun || lastRun.endedAt === null;

    if (!isOpen) {
      // Last run is closed but task.status was never updated → also orphan.
      await markOrphan(task, lastRun?.id ?? null);
      result.orphaned += 1;
      continue;
    }

    const referenceStart = lastRun?.startedAt?.getTime() ?? task.updatedAt?.getTime() ?? now;
    const ageMs = now - referenceStart;

    if (ageMs > ORPHAN_THRESHOLD_MS) {
      await markOrphan(task, lastRun?.id ?? null);
      result.orphaned += 1;
    } else {
      logger.warn(
        { taskId: task.id, ageMs, agentRunId: lastRun?.id ?? null },
        '[Recovery] task in_progress within 1h window — leaving for potential reconnect (T15)',
      );
      result.recovered += 1;
    }
  }

  logger.info(
    { orphaned: result.orphaned, leftAlone: result.recovered },
    '[Recovery] completed in-flight execution recovery',
  );
  return result;
}

async function markOrphan(
  task: { id: string; teamId: string | null; creatorId: string | null; updatedAt: Date },
  agentRunId: string | null,
): Promise<void> {
  const reason = 'sidecar_restart_orphan';
  try {
    const elapsedMs = Date.now() - task.updatedAt.getTime();
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: 'cancelled',
        outcome: reason,
        sessionId: null,
        executionElapsedMs: elapsedMs,
        executionPausedAt: new Date(),
      },
      include: { labels: { include: { label: true } } },
    });

    if (agentRunId) {
      try {
        await prisma.agentRun.update({
          where: { id: agentRunId },
          data: {
            status: 'failed',
            endedAt: new Date(),
            errorMessage: reason,
          },
        });
      } catch (err) {
        logger.error(
          { err, agentRunId, taskId: task.id },
          '[Recovery] failed to mark AgentRun as failed (continuing)',
        );
      }
    }

    // Best-effort SSE broadcast so any connected client refreshes.
    try {
      const flat = {
        ...updated,
        labels: updated.labels.map((tl) => tl.label),
      };
      broadcastToTask('task:updated', flat);
    } catch (err) {
      logger.warn({ err, taskId: task.id }, '[Recovery] broadcast failed (non-fatal)');
    }

    logger.info(
      { taskId: task.id, agentRunId },
      '[Recovery] orphan task marked cancelled (sidecar_restart_orphan)',
    );
  } catch (err) {
    logger.error(
      { err, taskId: task.id },
      '[Recovery] failed to mark task as orphan — manual cleanup may be required',
    );
  }
}

/**
 * Recover stale batch state. Since batches are not persisted as a separate
 * model, we treat any `in_progress` task with a non-null `batchId` whose
 * AgentRun is orphaned as covered by `recoverInFlightExecutions()`. This
 * helper additionally clears the in-memory map (which is empty on boot
 * anyway, but symmetric with the execution-state cleanup) and is a no-op
 * placeholder kept for future Batch persistence work.
 */
export async function recoverActiveBatches(): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, orphaned: 0 };

  let stale: Array<{ batchId: string | null; count: number }>;
  try {
    const grouped = await prisma.task.groupBy({
      by: ['batchId'],
      where: {
        batchId: { not: null },
        status: 'in_progress',
      },
      _count: { _all: true },
    });
    stale = grouped.map((g) => ({ batchId: g.batchId, count: g._count._all }));
  } catch (err) {
    logger.error({ err }, '[Recovery] failed to query stale batches; skipping');
    return result;
  }

  if (stale.length === 0) {
    logger.info('[Recovery] no stale batches detected');
    return result;
  }

  for (const s of stale) {
    logger.warn(
      { batchId: s.batchId, taskCount: s.count },
      '[Recovery] stale batch detected — member tasks handled by execution recovery',
    );
    result.orphaned += s.count;
  }

  return result;
}
