import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';

const router: Router = Router();

router.get('/:workspaceId/audit-log', requireAuth, async (req: AuthRequest, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const userId = req.userId!;

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { userId, workspaceId } },
  });

  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Owner or admin role required'));
    return;
  }

  const { action, actorId, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { workspaceId };
  if (action && typeof action === 'string') where.action = action;
  if (actorId && typeof actorId === 'string') where.actorId = actorId;
  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from && typeof from === 'string') createdAt.gte = new Date(from);
    if (to && typeof to === 'string') createdAt.lte = new Date(to);
    where.createdAt = createdAt;
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ items, total, page, limit });
});

export default router;
