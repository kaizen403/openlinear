/**
 * W05a lease sweeper: attempts whose sidecar stopped heartbeating.
 *
 * A sidecar heartbeats every active attempt (30 s by default; events and
 * renewals also refresh `heartbeatAt`). When the newest heartbeat is older
 * than the lease (`OPENLINEAR_ATTEMPT_LEASE_MS`, default 5 min) the sidecar
 * is presumed dead and the attempt is fenced, one row lock per attempt:
 *
 * - every capability of the attempt is revoked — a sidecar that comes back
 *   gets 401 CAPABILITY_REVOKED on every callback and cannot finalize — and
 *   its GitHub App installation tokens are revoked (W10a);
 * - `preparing` (never claimed) → `released`, recoveryState `abandoned`;
 *   the task row was never touched;
 * - `running` (claimed) → the task is released with the W01 fence (still
 *   in_progress, this attempt's session, unchanged project/team/creator) to
 *   `cancelled` with an explanatory outcome, so the user can retry; the
 *   AgentRun becomes `failed`; the attempt → `closed`, recoveryState
 *   `recovery_required` (work may remain on the device). A task that
 *   already belongs to a replacement attempt is never touched (recoveryState
 *   `abandoned`);
 * - `finishing` (terminal projection already written) → `closed`; a still
 *   running AgentRun is finalized from the recorded projection.
 *
 * The heartbeat is re-checked under the row lock, so a heartbeat that lands
 * between the scan and the lock wins. Task events are appended in the same
 * transaction (W04b outbox).
 *
 * Runs as the `execution-lease-sweep` job, owned by OPENLINEAR_JOBS_RUNNER.
 */
import { prisma, type ExecutionAttempt, type Prisma } from '@openlinear/db';
import { logger } from '../logger';
import { appendDomainEvent, transactionWithEvents } from '../events/outbox';
import { appendToTarget, taskTarget } from '../events/targets';
import { attemptLeaseMs, boundTaskWhere, lockAttempt, revokeCapabilities, taskEventAudience } from './execution-control';
import { revokeAttemptGitCredentials } from './github-app-credentials';

export const LOST_SIDECAR_OUTCOME = 'Execution lost: the local agent runner stopped responding (its heartbeat expired). '
  + 'Any work stays on that device; run the task again to retry.';

export interface SweepResult {
  examined: number;
  released: number;
  recoveryRequired: number;
  closed: number;
  skipped: number;
}

export interface SweepOptions {
  now?: Date;
  leaseMs?: number;
  limit?: number;
}

type SweepOutcome = 'released' | 'recovery_required' | 'closed' | 'skipped';

function flatten(task: Prisma.TaskGetPayload<{ include: { labels: { include: { label: true } } } }>) {
  return { ...task, labels: task.labels.map((relation) => relation.label) };
}

async function sweepOne(attemptId: string, cutoff: Date, now: Date): Promise<SweepOutcome> {
  return transactionWithEvents(async (tx) => {
    const attempt: ExecutionAttempt = await lockAttempt(tx, attemptId);
    const active = attempt.status === 'preparing' || attempt.status === 'running' || attempt.status === 'finishing';
    if (!active || attempt.heartbeatAt.getTime() >= cutoff.getTime()) return 'skipped';
    await revokeCapabilities(tx, attempt.id, now);

    if (attempt.status === 'preparing') {
      await tx.executionAttempt.update({
        where: { id: attempt.id },
        data: { status: 'released', closedAt: now, closeReason: 'sidecar_lost', recoveryState: 'abandoned', sweptAt: now },
      });
      return 'released';
    }

    if (attempt.status === 'finishing') {
      if (attempt.agentRunId) {
        await tx.agentRun.updateMany({
          where: { id: attempt.agentRunId, status: 'running' },
          data: { status: attempt.terminalStatus === 'done' ? 'succeeded' : 'failed', endedAt: now, errorMessage: attempt.terminalStatus === 'done' ? null : 'sidecar_lost' },
        });
      }
      await tx.executionAttempt.update({
        where: { id: attempt.id },
        data: { status: 'closed', closedAt: now, closeReason: 'sidecar_lost_after_terminal', sweptAt: now },
      });
      return 'closed';
    }

    // running: release the task under the W01 fence.
    const released = await tx.task.updateMany({
      where: boundTaskWhere(attempt),
      data: { status: 'cancelled', sessionId: null, executionPausedAt: now, outcome: LOST_SIDECAR_OUTCOME },
    });
    if (attempt.agentRunId) {
      await tx.agentRun.updateMany({
        where: { id: attempt.agentRunId, status: 'running' },
        data: { status: 'failed', endedAt: now, errorMessage: 'sidecar_lost' },
      });
    }
    await tx.executionAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'closed',
        closedAt: now,
        closeReason: 'sidecar_lost',
        sweptAt: now,
        finishedAt: now,
        ...(released.count === 1
          ? { terminalStatus: 'cancelled', recoveryState: 'recovery_required' }
          : { recoveryState: 'abandoned' }),
      },
    });
    if (released.count !== 1) return 'closed';

    const task = await tx.task.findUnique({ where: { id: attempt.taskId }, include: { labels: { include: { label: true } } } });
    if (task) {
      const target = await taskTarget(tx, task);
      await appendToTarget(tx, target, 'task:updated', flatten(task), attempt.userId);
      if (target) {
        await appendDomainEvent(tx, {
          type: 'execution:progress',
          payload: {
            taskId: attempt.taskId,
            status: 'error',
            message: LOST_SIDECAR_OUTCOME,
            reason: 'sidecar_lost',
            runState: 'recovery_required',
            attemptId: attempt.id,
          },
          actorId: attempt.userId,
          audience: taskEventAudience(attempt),
          resource: target.resource,
          workspaceId: target.resource.workspaceId ?? attempt.workspaceId,
        });
      }
    }
    return 'recovery_required';
  });
}

/** One sweep pass. Each attempt is fenced in its own transaction; one failure does not stop the pass. */
export async function sweepLostExecutionAttempts(options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.leaseMs ?? attemptLeaseMs()));
  const candidates = await prisma.executionAttempt.findMany({
    where: { status: { in: ['preparing', 'running', 'finishing'] }, heartbeatAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { heartbeatAt: 'asc' },
    take: options.limit ?? 200,
  });
  const result: SweepResult = { examined: candidates.length, released: 0, recoveryRequired: 0, closed: 0, skipped: 0 };
  for (const candidate of candidates) {
    try {
      const outcome = await sweepOne(candidate.id, cutoff, now);
      // W10a: repository tokens die with a fenced attempt, as at a normal
      // close (outside the row-lock transaction: it calls GitHub; never throws).
      if (outcome !== 'skipped') await revokeAttemptGitCredentials(candidate.id);
      if (outcome === 'released') result.released += 1;
      else if (outcome === 'recovery_required') result.recoveryRequired += 1;
      else if (outcome === 'closed') result.closed += 1;
      else result.skipped += 1;
    } catch (err) {
      result.skipped += 1;
      logger.error({ err, attemptId: candidate.id }, '[executions] lease sweep failed for one attempt');
    }
  }
  if (result.examined > 0) logger.warn(result, '[executions] fenced attempts whose sidecar stopped heartbeating');
  return result;
}
