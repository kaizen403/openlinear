import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { dashboardTaskStats, type DashboardTaskStats } from '../services/task-aggregates';
import { scopedProjectWhere } from '../tenancy/scopes';
import { resolvePrincipalForUser } from '../tenancy/context';
import type { TenancyContext } from '../tenancy/types';

const router: Router = Router();

async function dashboardTenancy(req: AuthRequest): Promise<TenancyContext> {
  if (req.tenancy) return req.tenancy;
  return resolvePrincipalForUser(req.userId!);
}

router.get(
  '/tasks',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const ctx = await dashboardTenancy(req);
    // One FILTERed aggregate instead of six scans (services/task-aggregates.ts).
    // As before, a failed read degrades to zeros rather than failing the card.
    let stats: DashboardTaskStats;
    try {
      stats = await dashboardTaskStats(ctx);
    } catch (err) {
      logger.warn({ err }, '[dashboard] task stats failed; returning zeros');
      stats = {
        total: 0,
        recent: 0,
        overdue: 0,
        unassigned: 0,
        byStatus: { todo: 0, in_progress: 0, done: 0, cancelled: 0 },
        byPriority: { low: 0, medium: 0, high: 0 },
      };
    }
    res.json(stats);
  },
);

router.get(
  '/projects',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const ctx = await dashboardTenancy(req);
    const where = scopedProjectWhere(ctx);

    const [statusCounts, total, projects] = await Promise.all([
      prisma.project.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          color: true,
          targetDate: true,
          _count: {
            select: {
              tasks: { where: { archived: false } },
            },
          },
        },
        take: 20,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const statusMap = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    const overdueProjects = projects.filter(
      (p) => p.targetDate && new Date(p.targetDate) < new Date() && p.status !== 'completed' && p.status !== 'cancelled',
    ).length;

    const projectIds = projects.map((p) => p.id);
    const taskStats = projectIds.length
      ? await prisma.task.groupBy({
          by: ['projectId', 'status'],
          where: { projectId: { in: projectIds }, archived: false },
          _count: { _all: true },
        })
      : [];

    const taskMap = new Map<string, { total: number; done: number }>();
    for (const p of projects) {
      taskMap.set(p.id, { total: p._count.tasks, done: 0 });
    }
    for (const t of taskStats) {
      const current = taskMap.get(t.projectId!);
      if (current && t.status === 'done') {
        current.done = t._count._all;
      }
    }

    const projectsWithHealth = projects.map((p) => {
      const stats = taskMap.get(p.id)!;
      const completionRate = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
      const isOverdue = p.targetDate
        ? new Date(p.targetDate) < new Date() && p.status !== 'completed' && p.status !== 'cancelled'
        : false;

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        color: p.color,
        targetDate: p.targetDate?.toISOString() ?? null,
        totalTasks: stats.total,
        completedTasks: stats.done,
        completionRate,
        isOverdue,
      };
    });

    res.json({
      total,
      overdue: overdueProjects,
      byStatus: {
        planned: statusMap.planned ?? 0,
        in_progress: statusMap.in_progress ?? 0,
        paused: statusMap.paused ?? 0,
        completed: statusMap.completed ?? 0,
        cancelled: statusMap.cancelled ?? 0,
      },
      projects: projectsWithHealth,
    });
  },
);

export default router;
