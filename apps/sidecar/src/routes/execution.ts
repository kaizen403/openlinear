import { Router, Response, NextFunction } from 'express';
import { prisma, decryptToken } from '@openlinear/db';
import { broadcastToTask } from '@openlinear/api/sse';
import { optionalAuth, AuthRequest } from '@openlinear/api/middleware';
import { assertTaskOwned } from '@openlinear/api/ownership';
import { executeTask, cancelTask, isTaskRunning, getExecutionLogs } from '../services/execution';

const taskInclude = {
  labels: { include: { label: true } },
  team: { select: { id: true, name: true, key: true, color: true } },
  project: { select: { id: true, name: true, status: true, color: true } },
};

interface LabelLite {
  id: string;
  name: string;
  color: string;
}

interface TaskLabelLite {
  label: LabelLite;
}

function flattenLabels<T extends { labels: TaskLabelLite[] }>(
  task: T,
): Omit<T, 'labels'> & { labels: LabelLite[] } {
  const { labels, ...rest } = task;
  return {
    ...rest,
    labels: labels.map((tl) => tl.label),
  };
}

const router: Router = Router();

// POST /:id/execute
router.post('/:id/execute', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (req.userId) {
      await assertTaskOwned(id, req.userId);
    }
    console.log(`[Tasks] Execute requested for task ${id.slice(0, 8)} (userId: ${req.userId || 'anonymous'})`);
    const result = await executeTask({ taskId: id, userId: req.userId });

    if (!result.success) {
      console.log(`[Tasks] Execute failed: ${result.error}`);
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ message: 'Task execution started' });
  } catch (error) {
    next(error);
  }
});

// POST /:id/refresh-pr
router.post('/:id/refresh-pr', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (req.userId) {
      await assertTaskOwned(id, req.userId);
    }
    const task = await prisma.task.findUnique({
      where: { id },
      select: { prUrl: true, batchId: true },
    });

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (!task.prUrl || !task.prUrl.includes('/compare/')) {
      res.json({ prUrl: task.prUrl, refreshed: false });
      return;
    }

    const match = task.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/compare\/.+\.\.\.(.+)$/);
    if (!match) {
      res.json({ prUrl: task.prUrl, refreshed: false });
      return;
    }

    const [, owner, repo, rawBranch] = match;
    const branch = decodeURIComponent(rawBranch);

    let accessToken: string | null = null;
    if (req.userId) {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { accessToken: true },
      });
      try {
        accessToken = decryptToken(user?.accessToken ?? null);
      } catch (err) {
        console.error('[execution] failed to decrypt access token:', err);
        accessToken = null;
      }
    }

    if (!accessToken) {
      res.status(400).json({ error: 'GitHub authentication required to refresh PR status' });
      return;
    }

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      res.status(502).json({ error: 'GitHub API request failed' });
      return;
    }

    const pulls = (await response.json()) as Array<{ html_url: string }>;
    if (pulls.length > 0) {
      const newPrUrl = pulls[0].html_url;
      const oldPrUrl = task.prUrl;

      const updated = await prisma.task.update({
        where: { id },
        data: { prUrl: newPrUrl },
        include: taskInclude,
      });

      if (task.batchId) {
        await prisma.task.updateMany({
          where: { batchId: task.batchId, prUrl: oldPrUrl },
          data: { prUrl: newPrUrl },
        });
      }

      broadcastToTask('task:updated', flattenLabels(updated));
      res.json({ prUrl: newPrUrl, refreshed: true });
      return;
    }

    res.json({ prUrl: task.prUrl, refreshed: false, message: 'No PR found for this branch yet' });
  } catch (error) {
    console.error('[Tasks] Error refreshing PR:', error);
    res.status(500).json({ error: 'Failed to refresh PR status' });
  }
});

// GET /:id/running
router.get('/:id/running', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (req.userId) {
      await assertTaskOwned(id, req.userId);
    }
    res.json({ running: isTaskRunning(id) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/logs', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (req.userId) {
      await assertTaskOwned(id, req.userId);
    }
    let logs = getExecutionLogs(id);

    if (logs.length === 0) {
      const result = await prisma.$queryRaw<Array<{ executionLogs: unknown }>>`
        SELECT "executionLogs" FROM tasks WHERE id = ${id}
      `;
      if (result.length > 0 && Array.isArray(result[0].executionLogs)) {
        logs = result[0].executionLogs as unknown as typeof logs;
      }
    }

    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (req.userId) {
      await assertTaskOwned(id, req.userId);
    }
    console.log(`[Tasks] Cancel requested for task ${id.slice(0, 8)}`);

    if (!isTaskRunning(id)) {
      console.log(`[Tasks] Task ${id.slice(0, 8)} is not running, cannot cancel`);
      res.status(400).json({ error: 'Task is not running' });
      return;
    }

    const result = await cancelTask(id);

    if (!result.success) {
      console.log(`[Tasks] Cancel failed: ${result.error}`);
      res.status(400).json({ error: result.error });
      return;
    }

    console.log(`[Tasks] Task ${id.slice(0, 8)} cancelled`);
    res.json({ message: 'Task cancelled' });
  } catch (error) {
    next(error);
  }
});

export default router;
