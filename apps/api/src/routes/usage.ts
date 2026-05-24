import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateQuery, ValidatedRequest } from '../middleware/validate';
import { getUserTeamIds } from '../services/team-scope';

const router: Router = Router();

/**
 * Build the canonical scoping filter for AgentRun queries:
 * - runs whose task is in one of the user's teams, OR
 * - runs the user owns directly (userId match).
 *
 * If the user has no teams, we still allow rows where userId === req.userId.
 * If both lists are empty (no teams) we still pass the userId clause so the
 * query stays correct even for users that aren't on any team yet.
 */
function buildScopeWhere(userId: string, teamIds: string[]): Prisma.AgentRunWhereInput {
  const ors: Prisma.AgentRunWhereInput[] = [{ userId }];
  if (teamIds.length > 0) {
    ors.push({ task: { teamId: { in: teamIds } } });
  }
  return { OR: ors };
}

function decimalToNumber(d: Prisma.Decimal | null | undefined): number {
  if (d === null || d === undefined) return 0;
  // Prisma Decimal has .toNumber(); fall back via toString to be safe.
  const asUnknown = d as unknown as { toNumber?: () => number };
  if (typeof asUnknown.toNumber === 'function') return asUnknown.toNumber();
  return Number(d.toString());
}

router.get(
  '/summary',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const userId = req.userId!;
    const teamIds = await getUserTeamIds(userId);
    const where = buildScopeWhere(userId, teamIds);

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    since.setUTCHours(0, 0, 0, 0);

    const scopedSince: Prisma.AgentRunWhereInput = {
      AND: [where, { startedAt: { gte: since } }],
    };

    const [totals, runs] = await Promise.all([
      prisma.agentRun.aggregate({
        where: scopedSince,
        _sum: { costUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      prisma.agentRun.findMany({
        where: scopedSince,
        select: { startedAt: true, costUsd: true },
        orderBy: { startedAt: 'asc' },
      }),
    ]);

    const totalCostUsd = decimalToNumber(totals._sum.costUsd);
    const totalInputTokens = totals._sum.inputTokens ?? 0;
    const totalOutputTokens = totals._sum.outputTokens ?? 0;
    const totalRuns = totals._count._all;
    const avgCostPerRun = totalRuns > 0 ? totalCostUsd / totalRuns : 0;

    const dailyMap = new Map<string, { costUsd: number; runs: number }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      dailyMap.set(d.toISOString().slice(0, 10), { costUsd: 0, runs: 0 });
    }
    for (const r of runs) {
      const key = r.startedAt.toISOString().slice(0, 10);
      const bucket = dailyMap.get(key);
      if (!bucket) continue;
      bucket.costUsd += decimalToNumber(r.costUsd);
      bucket.runs += 1;
    }
    const daily = Array.from(dailyMap.entries()).map(([date, v]) => ({
      date,
      costUsd: Number(v.costUsd.toFixed(6)),
      runs: v.runs,
    }));

    res.json({
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalRuns,
      totalInputTokens,
      totalOutputTokens,
      avgCostPerRun: Number(avgCostPerRun.toFixed(6)),
      daily,
    });
    
  },
);

const byTaskQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['cost', 'runs', 'recent']).default('cost'),
});
type ByTaskQuery = z.infer<typeof byTaskQuerySchema>;

router.get(
  '/by-task',
  requireAuth,
  validateQuery(byTaskQuerySchema),
  async (
    req: ValidatedRequest<unknown, ByTaskQuery> & AuthRequest,
    res: Response,
  ) => {

    const userId = req.userId!;
    const { page, pageSize, sort } = req.validQuery!;
    const teamIds = await getUserTeamIds(userId);
    const where = buildScopeWhere(userId, teamIds);

    // Aggregate per task. Sorting on the aggregate is supported by Prisma
    // via _sum/_count/_max in orderBy.
    const orderBy =
      sort === 'cost'
        ? ({ _sum: { costUsd: 'desc' } } as const)
        : sort === 'runs'
          ? ({ _count: { taskId: 'desc' } } as const)
          : ({ _max: { startedAt: 'desc' } } as const);

    const groups = await prisma.agentRun.groupBy({
      by: ['taskId'],
      where,
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
      _max: { startedAt: true },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const totalGroupsRaw = await prisma.agentRun.groupBy({
      by: ['taskId'],
      where,
      _count: { _all: true },
    });

    const taskIds = groups.map((g) => g.taskId);
    const tasks = taskIds.length
      ? await prisma.task.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, title: true, identifier: true, teamId: true },
        })
      : [];
    const titleMap = new Map(tasks.map((t) => [t.id, t]));

    const items = groups.map((g) => {
      const t = titleMap.get(g.taskId);
      return {
        taskId: g.taskId,
        taskTitle: t?.title ?? '(deleted task)',
        taskIdentifier: t?.identifier ?? null,
        runs: g._count._all,
        totalCostUsd: Number(decimalToNumber(g._sum.costUsd).toFixed(6)),
        totalInputTokens: g._sum.inputTokens ?? 0,
        totalOutputTokens: g._sum.outputTokens ?? 0,
        lastRunAt: g._max.startedAt,
      };
    });

    res.json({
      items,
      page,
      pageSize,
      total: totalGroupsRaw.length,
      sort,
    });
    
  },
);

export default router;
