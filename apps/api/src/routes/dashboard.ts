import { Router, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getUserTeamIds } from '../services/team-scope';

const router: Router = Router();

router.get(
  '/tasks',
  requireAuth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const teamIds = await getUserTeamIds(userId);

      const where = teamIds.length > 0
        ? { OR: [{ creatorId: userId }, { assigneeId: userId }, { teamId: { in: teamIds } }] }
        : { OR: [{ creatorId: userId }, { assigneeId: userId }] };

      const [statusCounts, priorityCounts, overdue, unassigned, total, recent] = await Promise.all([
        prisma.task.groupBy({
          by: ['status'],
          where: { ...where, archived: false },
          _count: { _all: true },
        }),
        prisma.task.groupBy({
          by: ['priority'],
          where: { ...where, archived: false },
          _count: { _all: true },
        }),
        prisma.task.count({
          where: {
            ...where,
            archived: false,
            status: { not: 'done' },
            dueDate: { lt: new Date() },
          },
        }),
        prisma.task.count({
          where: {
            ...where,
            archived: false,
            status: { not: 'done' },
            assigneeId: null,
          },
        }),
        prisma.task.count({ where: { ...where, archived: false } }),
        prisma.task.count({
          where: {
            ...where,
            archived: false,
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        }),
      ]);

      const statusMap = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
      const priorityMap = Object.fromEntries(priorityCounts.map((p) => [p.priority, p._count._all]));

      res.json({
        total,
        recent,
        overdue,
        unassigned,
        byStatus: {
          todo: statusMap.todo ?? 0,
          in_progress: statusMap.in_progress ?? 0,
          done: statusMap.done ?? 0,
          cancelled: statusMap.cancelled ?? 0,
        },
        byPriority: {
          low: priorityMap.low ?? 0,
          medium: priorityMap.medium ?? 0,
          high: priorityMap.high ?? 0,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/projects',
  requireAuth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const teamIds = await getUserTeamIds(userId);

      const where = teamIds.length > 0
        ? { OR: [{ leadId: userId }, { teams: { some: { id: { in: teamIds } } } }] }
        : { leadId: userId };

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
    } catch (err) {
      next(err);
    }
  },
);

export default router;
