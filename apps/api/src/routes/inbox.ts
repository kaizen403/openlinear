import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import { getUserTeamIds } from '../services/team-scope';

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
  try {
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
  } catch (error) {
    console.error('[Inbox] Error counting inbox items:', error);
    res.status(500).json({ error: 'Failed to count inbox items' });
  }
});

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const scope = await teamScope(req.userId);
    if (!scope) {
      res.json([]);
      return;
    }

    const tasks = await prisma.task.findMany({
      where: {
        ...completedOrCancelled(),
        archived: false,
        ...scope,
      },
      include: {
        labels: { include: { label: true } },
        team: { select: { id: true, name: true, key: true, color: true } },
        project: { select: { id: true, name: true, status: true, color: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const flatTasks = tasks.map(task => ({
      ...task,
      labels: task.labels.map((tl: { label: { id: string; name: string; color: string; priority: number } }) => tl.label),
    }));

    res.json(flatTasks);
  } catch (error) {
    console.error('[Inbox] Error listing inbox:', error);
    res.status(500).json({ error: 'Failed to list inbox items' });
  }
});

router.patch('/read/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.task.update({
      where: { id },
      data: { inboxRead: true },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[Inbox] Error marking read:', error);
    res.status(500).json({ error: 'Failed to mark inbox item as read' });
  }
});

router.patch('/read-all', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
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
  } catch (error) {
    console.error('[Inbox] Error marking all read:', error);
    res.status(500).json({ error: 'Failed to mark all inbox items as read' });
  }
});

export default router;
