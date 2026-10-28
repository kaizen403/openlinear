import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateQuery, ValidatedRequest } from '../middleware/validate';
import { assertTaskOwned } from '../services/ownership';
import { paginationQuerySchema, paginated, paginationSkipTake, PaginationQuery } from '../schemas/pagination';
import { inboxCounts } from '../services/task-aggregates';
import { resolvePrincipalForUser } from '../tenancy/context';
import { scopedTaskWhere } from '../tenancy/scopes';
import type { TenancyContext } from '../tenancy/types';

const router: Router = Router();

function completedOrCancelled() {
  return { OR: [{ status: 'done' as const }, { status: 'cancelled' as const }] };
}

async function inboxTenancy(req: AuthRequest): Promise<TenancyContext | null> {
  if (req.tenancy) return req.tenancy;
  if (!req.userId) return null;
  return resolvePrincipalForUser(req.userId);
}

router.get('/count', optionalAuth, async (req: AuthRequest, res: Response) => {
  const ctx = await inboxTenancy(req);
  if (!ctx) {
    res.json({ total: 0, unread: 0 });
    return;
  }

  // One FILTERed count instead of two scans (services/task-aggregates.ts).
  res.json(await inboxCounts(ctx));
});

router.get(
  '/',
  optionalAuth,
  validateQuery(paginationQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, PaginationQuery>, res: Response) => {
    const { page, pageSize } = req.validQuery!;
    const ctx = await inboxTenancy(req);
    if (!ctx) {
      res.json(paginated([], 0, page, pageSize));
      return;
    }

    const where = scopedTaskWhere(ctx, { ...completedOrCancelled(), archived: false });

    // Page and total run concurrently; the total is the inbox badge's count
    // (same predicate, one statement). The READ COMMITTED transaction they
    // used to share gave no common snapshot.
    const [tasks, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: {
          labels: { include: { label: true } },
          team: { select: { id: true, name: true, key: true, color: true } },
          project: { select: { id: true, name: true, status: true, color: true } },
        },
        orderBy: { updatedAt: 'desc' },
        ...paginationSkipTake(page, pageSize),
      }),
      inboxCounts(ctx).then((counts) => counts.total),
    ]);

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
  const ctx = await inboxTenancy(req);
  if (!ctx) {
    res.json({ success: true });
    return;
  }

  await prisma.task.updateMany({
    where: scopedTaskWhere(ctx, {
      ...completedOrCancelled(),
      inboxRead: false,
      archived: false,
    }),
    data: { inboxRead: true },
  });
  res.json({ success: true });
});

export default router;
