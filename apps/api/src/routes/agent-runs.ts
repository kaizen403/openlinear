import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { assertTaskAccess } from '../services/ownership';
import { getUserTeamIds } from '../services/team-scope';
import { paginated, paginationSkipTake } from '../schemas/pagination';
import { HttpError, ValidationError } from '../errors';

const router: Router = Router();

const listQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  userId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get(
  '/',
  requireAuth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw ValidationError.fromZod(parsed.error);
      }
      const { taskId, userId, page, pageSize } = parsed.data;

      if (!taskId && !userId) {
        throw new HttpError(400, 'TASK_OR_USER_REQUIRED', 'taskId or userId is required');
      }

      const where: { taskId?: string; userId?: string; task?: { teamId: { in: string[] } } } = {};

      if (taskId) {
        await assertTaskAccess(taskId, req.userId!, 'view');
        where.taskId = taskId;
      } else if (userId) {
        const resolvedUserId = userId === 'me' ? req.userId! : userId;
        if (resolvedUserId !== req.userId!) {
          throw new HttpError(403, 'FORBIDDEN', 'Forbidden');
        }
        where.userId = resolvedUserId;
        const teamIds = await getUserTeamIds(req.userId!);
        if (teamIds.length === 0) {
          res.json(paginated([], 0, page, pageSize));
          return;
        }
        where.task = { teamId: { in: teamIds } };
      }

      const [runs, total] = await prisma.$transaction(
        async (tx) => {
          const items = await tx.agentRun.findMany({
            where,
            orderBy: { startedAt: 'desc' },
            ...paginationSkipTake(page, pageSize),
            select: {
              id: true,
              taskId: true,
              userId: true,
              agent: true,
              model: true,
              startedAt: true,
              endedAt: true,
              costUsd: true,
              inputTokens: true,
              outputTokens: true,
              status: true,
              prUrl: true,
              errorMessage: true,
            },
          });
          const count = await tx.agentRun.count({ where });
          return [items, count] as const;
        },
        { timeout: 15000, maxWait: 5000 },
      );

      res.json(paginated(runs, total, page, pageSize));
    } catch (error) {
      next(error);
    }
  },
);

export default router;
