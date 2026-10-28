import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, teamOrUserTarget, userTarget } from '../events/targets';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import {
  assertTaskOwned,
  assertTaskAccess,
  assertCommentAccess,
  filterUsersWithTaskAccess,
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

    // A mention must not deliver the comment body to someone who cannot read the task.
    const recipientIds = await filterUsersWithTaskAccess(
      taskId,
      Array.from(
        new Set(
          mentionedUsers.map((u) => u.id).filter((id) => id !== req.userId),
        ),
      ),
    );

    // W04b: the comment, mentions, notifications and their events commit together.
    const result = await transactionWithEvents(async (tx) => {
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

      await appendToTarget(
        tx,
        await teamOrUserTarget(tx, task.teamId, req.userId!),
        'comment:created',
        { taskId, comment },
        req.userId!,
      );
      for (const notification of notifications) {
        await appendToTarget(tx, userTarget(notification.userId), 'notification:created', notification, req.userId!);
      }

      return { comment, notifications };
    });

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

    // Author only, and only while the author still has full task access.
    const existing = await assertCommentAccess(id, req.userId!, 'update');

    const usernames = extractMentionedUsernames(body);
    let mentionedUsers: { id: string; username: string }[] = [];
    if (usernames.length > 0) {
      mentionedUsers = await prisma.user.findMany({
        where: { username: { in: usernames } },
        select: { id: true, username: true },
      });
    }
    const recipientIds = await filterUsersWithTaskAccess(
      existing.taskId,
      Array.from(
        new Set(
          mentionedUsers.map((u) => u.id).filter((id) => id !== req.userId),
        ),
      ),
    );

    const updated = await transactionWithEvents(async (tx) => {
      const comment = await tx.comment.update({
        where: { id },
        data: { body, mentions: recipientIds },
        include: { user: { select: COMMENT_AUTHOR_SELECT } },
      });
      await appendToTarget(
        tx,
        await teamOrUserTarget(tx, existing.task.teamId, req.userId!),
        'comment:updated',
        { taskId: existing.taskId, comment },
        req.userId!,
      );
      return comment;
    });
    res.json(updated);
    
  },
);

router.delete(
  '/comments/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const id = req.params.id as string;

    // Current full task access, then author or team owner/admin.
    const owned = await assertCommentAccess(id, req.userId!, 'delete');
    const task = owned.task;

    await transactionWithEvents(async (tx) => {
      await tx.comment.delete({ where: { id } });
      await appendToTarget(
        tx,
        await teamOrUserTarget(tx, task.teamId, req.userId!),
        'comment:deleted',
        { id, taskId: owned.taskId },
        req.userId!,
      );
    });
    res.status(204).send();
    
  },
);

export default router;
