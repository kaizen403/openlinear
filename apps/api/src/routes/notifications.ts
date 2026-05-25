import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { broadcastToUser } from '../sse';
import { paginationQuerySchema, paginated, paginationSkipTake } from '../schemas/pagination';
import { HttpError, ValidationError } from '../errors';
import { getPreferences, updatePreference, shouldNotify } from '../services/notification-preferences';

const router: Router = Router();

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

  const where = {
    userId: req.userId!,
    ...(unreadOnly ? { readAt: null } : {}),
  };

  const [notifications, total, unreadCount] = await prisma.$transaction(
    async (tx) => {
      const items = await tx.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paginationSkipTake(page, pageSize),
        include: {
          actor: { select: { id: true, username: true, avatarUrl: true } },
        },
      });
      const count = await tx.notification.count({ where });
      const unread = await tx.notification.count({
        where: { userId: req.userId!, readAt: null },
      });
      return [items, count, unread] as const;
    },
    { timeout: 15000, maxWait: 5000 },
  );

  res.json({ ...paginated(notifications, total, page, pageSize), unreadCount });
  
});

router.patch(
  '/:id/read',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const id = req.params.id as string;
    const existing = await prisma.notification.findUnique({
      where: { id },
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
  actorUserId: string;
  type: 'mention' | 'assignment' | 'status_change' | 'comment';
  taskId?: string | null;
  commentId?: string | null;
  body: string;
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  if (input.recipientUserId === input.actorUserId) return;

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
    const row = await prisma.notification.create({
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
    broadcastToUser(input.recipientUserId, 'notification:created', row);
  } catch {
    // best-effort: never break the calling mutation
  }
}
