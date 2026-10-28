import type { ActivityAction, Prisma } from '@openlinear/db';
import { logger } from '../logger';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, teamTarget, userTarget } from '../events/targets';

export interface LogActivityInput {
  taskId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  userId: string;
  action: ActivityAction;
  payload: Prisma.InputJsonValue;
}

/**
 * Best-effort write to ActivityLog. Never throws — failures are logged and
 * swallowed so they cannot break the calling mutation handler. Also emits
 * an `activity:created` SSE event scoped to the most specific recipient
 * (team if known, otherwise the user themselves).
 *
 * W04b: the row and its event commit in one transaction (no row without
 * its event, no event for a row that rolled back). Callers still log after
 * their own mutation commits, so the activity row itself is not atomic with
 * the mutation.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    await transactionWithEvents(async (tx) => {
      const row = await tx.activityLog.create({
        data: {
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          teamId: input.teamId ?? null,
          userId: input.userId,
          action: input.action,
          payload: input.payload,
        },
      });
      // Team scope when known; else the actor.
      const target = input.teamId ? await teamTarget(tx, input.teamId) : userTarget(input.userId);
      await appendToTarget(tx, target, 'activity:created', row, input.userId);
    });
  } catch (err) {
    logger.warn(
      {
        err,
        action: input.action,
        taskId: input.taskId,
        projectId: input.projectId,
        teamId: input.teamId,
      },
      '[activity] failed to log — continuing',
    );
  }
}
