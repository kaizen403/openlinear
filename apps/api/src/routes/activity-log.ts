import { Router, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  assertTaskAccess,
  assertProjectAccess,
  assertTeamRole,
} from '../services/ownership';
import { paginated, paginationSkipTake } from '../schemas/pagination';
import { ValidationError } from '../errors';

const router: Router = Router();

const querySchema = z
  .object({
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((v) => Boolean(v.taskId || v.projectId || v.teamId), {
    message: 'one of taskId, projectId, teamId is required',
  });

router.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw ValidationError.fromZod(parsed.error);
    }
    const { taskId, projectId, teamId, page, pageSize } = parsed.data;

    if (taskId) await assertTaskAccess(taskId, req.userId!, 'view');
    if (projectId) await assertProjectAccess(projectId, req.userId!, 'view');
    if (teamId) await assertTeamRole(teamId, req.userId!, ['owner', 'admin', 'member']);

    const where = {
      ...(taskId ? { taskId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(teamId ? { teamId } : {}),
    };

    const [activities, total] = await prisma.$transaction(
      async (tx) => {
        const items = await tx.activityLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          ...paginationSkipTake(page, pageSize),
          include: {
            user: { select: { id: true, username: true, avatarUrl: true } },
          },
        });
        const count = await tx.activityLog.count({ where });
        return [items, count] as const;
      },
      { timeout: 15000, maxWait: 5000 },
    );

    res.json(paginated(activities, total, page, pageSize));
  } catch (error) {
    next(error);
  }
});

export default router;
