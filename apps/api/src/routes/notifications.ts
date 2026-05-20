import { Router, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { broadcastToUser } from '../sse';
import { paginationQuerySchema, paginated, paginationSkipTake } from '../schemas/pagination';
import { HttpError, ValidationError } from '../errors';

const router: Router = Router();

const listQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id/read',
  requireAuth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
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
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/read-all',
  requireAuth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await prisma.notification.updateMany({
        where: { userId: req.userId!, readAt: null },
        data: { readAt: new Date() },
      });
      res.json({ updated: result.count });
    } catch (error) {
      next(error);
    }
  },
);

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
