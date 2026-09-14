import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ValidationError } from '../errors';

const router: Router = Router();

const logSchema = z.object({
  toolName: z.string().min(1).max(100),
  success: z.boolean(),
  error: z.string().max(500).optional(),
});

router.post(
  '/log',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const parsed = logSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ValidationError.fromZod(parsed.error);
    }
    const { toolName, success, error } = parsed.data;
    await prisma.mcpToolCall.create({
      data: {
        toolName,
        userId: req.userId!,
        success,
        error: error ?? null,
      },
    });
    res.json({ success: true });
    
  },
);

router.get(
  '/usage',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const userId = req.userId!;
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    since.setUTCHours(0, 0, 0, 0);

    const [totalCalls, successes, byTool, daily] = await Promise.all([
      prisma.mcpToolCall.count({ where: { userId, createdAt: { gte: since } } }),
      prisma.mcpToolCall.count({ where: { userId, createdAt: { gte: since }, success: true } }),
      prisma.mcpToolCall.groupBy({
        by: ['toolName'],
        where: { userId, createdAt: { gte: since } },
        _count: true,
        orderBy: { _count: { toolName: 'desc' } },
        take: 10,
      }),
      prisma.mcpToolCall.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const dailyMap = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      dailyMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const d of daily) {
      const key = d.createdAt.toISOString().slice(0, 10);
      const existing = dailyMap.get(key);
      if (existing !== undefined) {
        dailyMap.set(key, existing + 1);
      }
    }

    res.json({
      totalCalls,
      successRate: totalCalls > 0 ? Math.round((successes / totalCalls) * 100) : 100,
      byTool: byTool.map((t) => ({ toolName: t.toolName, calls: (t._count as number) ?? 0 })),
      daily: Array.from(dailyMap.entries()).map(([date, calls]) => ({ date, calls })),
    });
    
  },
);

export default router;
