import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { broadcastToTeam, broadcastToUser } from '../sse';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import {
  assertTaskOwned,
  assertTaskAccess,
  assertCommentOwned,
  assertTeamRole,
  OwnershipError,
} from '../services/ownership';
import { logActivity } from '../services/activity';
import {
  createCommentSchema,
  updateCommentSchema,
  listCommentsQuerySchema,
  extractMentionedUsernames,
  type CreateCommentInput,
  type UpdateCommentInput,
  type ListCommentsQuery,
} from '../schemas/comments';

type AuthValidated<TBody = unknown, TQuery = unknown> = AuthRequest &
  ValidatedRequest<TBody, TQuery>;

const router: Router = Router();

const COMMENT_AUTHOR_SELECT = {
  id: true,
  username: true,
  avatarUrl: true,
} as const;

router.get(
  '/tasks/:taskId/comments',
  requireAuth,
  validateQuery(listCommentsQuerySchema),
  async (
    req: AuthValidated<unknown, ListCommentsQuery>,
    res: Response,
  ) => {

    const taskId = req.params.taskId as string;
    const { page, pageSize } = req.validQuery!;

    await assertTaskAccess(taskId, req.userId!, 'view');

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: COMMENT_AUTHOR_SELECT } },
      }),
      prisma.comment.count({ where: { taskId } }),
    ]);

    res.json({ comments, page, pageSize, total });
    
  },
);

router.post(
  '/tasks/:taskId/comments',
  requireAuth,
  validateBody(createCommentSchema),
  async (
    req: AuthValidated<CreateCommentInput>,
    res: Response,
  ) => {

    const taskId = req.params.taskId as string;
    const body = req.validBody!.body;

    const task = await assertTaskOwned(taskId, req.userId!);

    const usernames = extractMentionedUsernames(body);

    let mentionedUsers: { id: string; username: string }[] = [];
    if (usernames.length > 0) {
      mentionedUsers = await prisma.user.findMany({
        where: { username: { in: usernames } },
        select: { id: true, username: true },
      });

      const found = new Set(mentionedUsers.map((u) => u.username));
      const missing = usernames.filter((u) => !found.has(u));
      if (missing.length > 0) {
        (
          req as AuthRequest & {
            log?: { warn: (obj: unknown, msg: string) => void };
          }
        ).log?.warn(
          { missing, taskId, userId: req.userId },
          '[comments] @mention skipped — user(s) not found',
        );
      }
    }

    const recipientIds = Array.from(
      new Set(
        mentionedUsers.map((u) => u.id).filter((id) => id !== req.userId),
      ),
    );

    const result = await prisma.$transaction(async (tx) => {
      const comment = await tx.comment.create({
        data: {
          taskId,
          userId: req.userId!,
          body,
          mentions: recipientIds,
        },
        include: { user: { select: COMMENT_AUTHOR_SELECT } },
      });

      if (recipientIds.length > 0) {
        await tx.commentMention.createMany({
          data: recipientIds.map((userId) => ({
            commentId: comment.id,
            userId,
          })),
          skipDuplicates: true,
        });
      }

      const notifications =
        recipientIds.length > 0
          ? await Promise.all(
              recipientIds.map((recipientId) =>
                tx.notification.create({
                  data: {
                    userId: recipientId,
                    type: 'mention',
                    taskId,
                    commentId: comment.id,
                    actorUserId: req.userId!,
                    body,
                  },
                }),
              ),
            )
          : [];

      return { comment, notifications };
    });

    if (task.teamId) {
      broadcastToTeam(task.teamId, 'comment:created', {
        taskId,
        comment: result.comment,
      });
    } else {
      broadcastToUser(req.userId!, 'comment:created', {
        taskId,
        comment: result.comment,
      });
    }

    for (const notification of result.notifications) {
      broadcastToUser(notification.userId, 'notification:created', notification);
    }

    await logActivity({
      taskId,
      teamId: task.teamId,
      userId: req.userId!,
      action: 'comment_created',
      payload: {
        commentId: result.comment.id,
        mentionCount: result.notifications.length,
      },
    });

    res.status(201).json(result.comment);
    
  },
);

router.patch(
  '/comments/:id',
  requireAuth,
  validateBody(updateCommentSchema),
  async (
    req: AuthValidated<UpdateCommentInput>,
    res: Response,
  ) => {

    const id = req.params.id as string;
    const body = req.validBody!.body;

    const existing = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        taskId: true,
        task: { select: { teamId: true } },
      },
    });
    if (!existing) {
      throw new OwnershipError('comment', id, 'not_found');
    }
    if (existing.userId !== req.userId) {
      throw new OwnershipError('comment', id, 'forbidden');
    }

    const usernames = extractMentionedUsernames(body);
    let mentionedUsers: { id: string; username: string }[] = [];
    if (usernames.length > 0) {
      mentionedUsers = await prisma.user.findMany({
        where: { username: { in: usernames } },
        select: { id: true, username: true },
      });
    }
    const recipientIds = Array.from(
      new Set(
        mentionedUsers.map((u) => u.id).filter((id) => id !== req.userId),
      ),
    );

    const updated = await prisma.comment.update({
      where: { id },
      data: { body, mentions: recipientIds },
      include: { user: { select: COMMENT_AUTHOR_SELECT } },
    });

    if (existing.task?.teamId) {
      broadcastToTeam(existing.task.teamId, 'comment:updated', {
        taskId: existing.taskId,
        comment: updated,
      });
    } else {
      broadcastToUser(req.userId!, 'comment:updated', {
        taskId: existing.taskId,
        comment: updated,
      });
    }
    res.json(updated);
    
  },
);

router.delete(
  '/comments/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const id = req.params.id as string;

    const owned = await assertCommentOwned(id, req.userId!);

    const task = await prisma.task.findUnique({
      where: { id: owned.taskId },
      select: { teamId: true },
    });

    if (owned.userId !== req.userId) {
      if (!task?.teamId) {
        throw new OwnershipError('comment', id, 'forbidden');
      }
      await assertTeamRole(task.teamId, req.userId!, ['owner', 'admin']);
    }

    await prisma.comment.delete({ where: { id } });

    if (task?.teamId) {
      broadcastToTeam(task.teamId, 'comment:deleted', {
        id,
        taskId: owned.taskId,
      });
    } else {
      broadcastToUser(req.userId!, 'comment:deleted', {
        id,
        taskId: owned.taskId,
      });
    }
    res.status(204).send();
    
  },
);

export default router;
