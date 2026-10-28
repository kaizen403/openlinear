import { Router, Response } from 'express';
import { prisma, type Prisma } from '@openlinear/db';
import { z } from 'zod';
import { filterUsersWithTaskAccess } from '../services/ownership';
import { resolvePrincipalForUser } from '../tenancy/context';
import { scopedTaskWhere } from '../tenancy/scopes';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, userTarget } from '../events/targets';
import { paginationQuerySchema, paginated, paginationSkipTake } from '../schemas/pagination';
import { HttpError, ValidationError } from '../errors';
import { getPreferences, updatePreference, shouldNotify } from '../services/notification-preferences';
import { notificationCounts } from '../services/task-aggregates';
import type { TenancyContext } from '../tenancy/types';

const router: Router = Router();

/**
 * The caller's notifications, minus rows about tasks they can no longer read
 * (explicit project deny, removed membership, or outside a PAT's workspace).
 */
function visibleNotificationWhereFor(userId: string, principal: TenancyContext): Prisma.NotificationWhereInput {
  return {
    userId,
    OR: [{ taskId: null }, { task: scopedTaskWhere(principal) }],
  };
}

async function visibleNotificationWhere(req: AuthRequest): Promise<Prisma.NotificationWhereInput> {
  const principal = req.tenancy ?? await resolvePrincipalForUser(req.userId!);
  return visibleNotificationWhereFor(req.userId!, principal);
}

const listQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error);
  }
  const { page, pageSize, unreadOnly } = parsed.data;

  const principal = req.tenancy ?? await resolvePrincipalForUser(req.userId!);
  const visible = visibleNotificationWhereFor(req.userId!, principal);
  const where: Prisma.NotificationWhereInput = {
    AND: [visible, unreadOnly ? { readAt: null } : {}],
  };

  // The page and both counts run concurrently; the counts are one statement
  // (services/task-aggregates.ts). They used to be three sequential
  // statements in a READ COMMITTED transaction, which gave no shared snapshot.
  const [notifications, counts] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...paginationSkipTake(page, pageSize),
      include: {
        actor: { select: { id: true, username: true, avatarUrl: true } },
      },
    }),
    notificationCounts(principal, { unreadOnly }),
  ]);

  res.json({ ...paginated(notifications, counts.total, page, pageSize), unreadCount: counts.unread });
});

router.patch(
  '/:id/read',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const id = req.params.id as string;
    const existing = await prisma.notification.findFirst({
      where: { AND: [{ id }, await visibleNotificationWhere(req)] },
      select: { id: true, userId: true, readAt: true },
    });
    if (!existing || existing.userId !== req.userId) {
      throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
    }
    const updated = await prisma.notification.update({
      where: { id },
      data: { readAt: existing.readAt ?? new Date() },
    });
    res.json(updated);
    
  },
);

router.post(
  '/read-all',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const result = await prisma.notification.updateMany({
      where: { userId: req.userId!, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ updated: result.count });
    
  },
);

const updatePreferenceSchema = z.object({
  eventType: z.enum(['task_assigned', 'task_status_changed', 'task_commented', 'mentioned', 'invitation_received']),
  channel: z.literal('in_app'),
  enabled: z.boolean(),
});

router.get('/preferences', requireAuth, async (req: AuthRequest, res: Response) => {
  const prefs = await getPreferences(req.userId!);
  res.json(prefs);
});

router.put('/preferences', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = updatePreferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error);
  }
  const { eventType, channel, enabled } = parsed.data;
  const pref = await updatePreference(req.userId!, eventType, channel, enabled);
  res.json(pref);
});

export default router;

export interface CreateNotificationInput {
  recipientUserId: string;
  /** null: no person did it (e.g. an agent run finished a blocker). */
  actorUserId: string | null;
  type: 'mention' | 'assignment' | 'status_change' | 'comment';
  taskId?: string | null;
  commentId?: string | null;
  body: string;
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  if (input.actorUserId !== null && input.recipientUserId === input.actorUserId) return;

  const typeToEvent: Record<string, string> = {
    mention: 'mentioned',
    assignment: 'task_assigned',
    status_change: 'task_status_changed',
    comment: 'task_commented',
  };

  // @mentions always notify regardless of preferences (FR-6)
  if (input.type !== 'mention') {
    const eventType = typeToEvent[input.type];
    if (eventType) {
      const allowed = await shouldNotify(input.recipientUserId, eventType);
      if (!allowed) return;
    }
  }

  try {
    // Notification bodies quote task titles and comments. A recipient who can
    // no longer read the task (explicit deny, removed membership) gets none.
    if (input.taskId) {
      const visible = await filterUsersWithTaskAccess(input.taskId, [input.recipientUserId]);
      if (visible.length === 0) return;
    }
    // W04b: the row and its event commit together.
    await transactionWithEvents(async (tx) => {
      const row = await tx.notification.create({
        data: {
          userId: input.recipientUserId,
          actorUserId: input.actorUserId,
          type: input.type,
          taskId: input.taskId ?? null,
          commentId: input.commentId ?? null,
          body: input.body,
        },
        include: {
          actor: { select: { id: true, username: true, avatarUrl: true } },
        },
      });
      await appendToTarget(tx, userTarget(input.recipientUserId), 'notification:created', row, input.actorUserId);
    });
  } catch {
    // best-effort: never break the calling mutation
  }
}
