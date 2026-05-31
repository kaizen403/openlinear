import { Router, Response } from 'express';
import { prisma, Prisma } from '@openlinear/db';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  assertTaskAccess,
  assertProjectAccess,
  assertTeamRole,
} from '../services/ownership';
import { getUserTeamIds } from '../services/team-scope';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { paginated, paginationSkipTake } from '../schemas/pagination';
import { ValidationError } from '../errors';

const router: Router = Router();

const querySchema = z.object({
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error);
  }
  const { taskId, projectId, teamId, page, pageSize } = parsed.data;

  if (taskId) await assertTaskAccess(taskId, req.userId!, 'view');
  if (projectId) await assertProjectAccess(projectId, req.userId!, 'view');
  if (teamId) await assertTeamRole(teamId, req.userId!, ['owner', 'admin', 'member']);

  let where: Prisma.ActivityLogWhereInput = {};

  if (taskId || projectId || teamId) {
    where = {
      ...(taskId ? { taskId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(teamId ? { teamId } : {}),
    };
  } else {
    const userId = req.userId!;
    const teamIds = await getUserTeamIds(userId);
    const projectIds = await prisma.projectAccess.findMany({
      where: { userId },
      select: { projectId: true },
    }).then((rows) => rows.map((r) => r.projectId));

    where = {
      OR: [
        { userId },
        ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : []),
        ...(projectIds.length > 0 ? [{ projectId: { in: projectIds } }] : []),
      ],
    };
  }

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
    PRISMA_TX_OPTIONS,
  );

  res.json(paginated(activities, total, page, pageSize));
  
});

export default router;
