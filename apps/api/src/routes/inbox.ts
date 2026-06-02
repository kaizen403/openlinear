import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateQuery, ValidatedRequest } from '../middleware/validate';
import { getUserTeamIds } from '../services/team-scope';
import { assertTaskOwned } from '../services/ownership';
import { paginationQuerySchema, paginated, paginationSkipTake, PaginationQuery } from '../schemas/pagination';
import { PRISMA_TX_OPTIONS } from '../lib/constants';

const router: Router = Router();

function completedOrCancelled() {
  return { OR: [{ status: 'done' as const }, { status: 'cancelled' as const }] };
}

async function teamScope(userId?: string): Promise<Record<string, unknown> | null> {
  if (!userId) return null;
  const teamIds = await getUserTeamIds(userId);
  return { teamId: { in: teamIds } };
}

router.get('/count', optionalAuth, async (req: AuthRequest, res: Response) => {

  const scope = await teamScope(req.userId);
  if (!scope) {
    res.json({ total: 0, unread: 0 });
    return;
  }

  const baseWhere = { ...completedOrCancelled(), archived: false, ...scope };

  const total = await prisma.task.count({ where: baseWhere });
  const unread = await prisma.task.count({
    where: { ...baseWhere, inboxRead: false },
  });
  res.json({ total, unread });
  
});

router.get(
  '/',
  optionalAuth,
  validateQuery(paginationQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, PaginationQuery>, res: Response) => {

    const { page, pageSize } = req.validQuery!;
    const scope = await teamScope(req.userId);
    if (!scope) {
      res.json(paginated([], 0, page, pageSize));
      return;
    }

    const where = {
      ...completedOrCancelled(),
      archived: false,
      ...scope,
    };

    const [tasks, total] = await prisma.$transaction(
      async (tx) => {
        const items = await tx.task.findMany({
          where,
          include: {
            labels: { include: { label: true } },
            team: { select: { id: true, name: true, key: true, color: true } },
            project: { select: { id: true, name: true, status: true, color: true } },
          },
          orderBy: { updatedAt: 'desc' },
          ...paginationSkipTake(page, pageSize),
        });
        const count = await tx.task.count({ where });
        return [items, count] as const;
      },
      PRISMA_TX_OPTIONS,
    );

    const flatTasks = tasks.map(task => ({
      ...task,
      labels: task.labels.map((tl: { label: { id: string; name: string; color: string; priority: number } }) => tl.label),
    }));

    res.json(paginated(flatTasks, total, page, pageSize));
    
  },
);

router.patch('/read/:id', requireAuth, async (req: AuthRequest, res: Response) => {

  const id = req.params.id as string;
  await assertTaskOwned(id, req.userId!);
  await prisma.task.update({
    where: { id },
    data: { inboxRead: true },
  });
  res.json({ success: true });
  
});

router.patch('/read-all', optionalAuth, async (req: AuthRequest, res: Response) => {

  const scope = await teamScope(req.userId);
  if (!scope) {
    res.json({ success: true });
    return;
  }

  await prisma.task.updateMany({
    where: {
      ...completedOrCancelled(),
      inboxRead: false,
      archived: false,
      ...scope,
    },
    data: { inboxRead: true },
  });
  res.json({ success: true });
  
});

export default router;
