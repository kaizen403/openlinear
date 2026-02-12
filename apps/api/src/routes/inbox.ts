import { Router, Request, Response } from 'express';
import { prisma } from '@openlinear/db';

const router: Router = Router();

router.get('/count', async (_req: Request, res: Response) => {
  try {
    const total = await prisma.task.count({
      where: {
        OR: [{ status: 'done' }, { status: 'cancelled' }],
        archived: false,
      },
    });
    const unread = await prisma.task.count({
      where: {
        OR: [{ status: 'done' }, { status: 'cancelled' }],
        inboxRead: false,
        archived: false,
      },
    });
    res.json({ total, unread });
  } catch (error) {
    console.error('[Inbox] Error counting inbox items:', error);
    res.status(500).json({ error: 'Failed to count inbox items' });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      where: {
        OR: [{ status: 'done' }, { status: 'cancelled' }],
        archived: false,
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

router.patch('/read/:id', async (req: Request, res: Response) => {
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

router.patch('/read-all', async (_req: Request, res: Response) => {
  try {
    await prisma.task.updateMany({
      where: {
        OR: [{ status: 'done' }, { status: 'cancelled' }],
        inboxRead: false,
        archived: false,
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
