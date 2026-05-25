import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router: Router = Router();

router.get(
  '/search',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const q = (req.query.q as string | undefined) ?? '';
    const workspaceId = req.query.workspaceId as string | undefined;

    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required', code: 'MISSING_WORKSPACE_ID' });
      return;
    }

    // Verify requesting user is a member of this workspace
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: req.userId!,
        },
      },
    });

    if (!membership) {
      res.status(403).json({ error: 'Not a member of this workspace', code: 'FORBIDDEN' });
      return;
    }

    const prefix = q.trim().toLowerCase();

    const members = await prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        user: prefix
          ? {
              OR: [
                { username: { startsWith: prefix, mode: 'insensitive' } },
                { displayName: { startsWith: prefix, mode: 'insensitive' } },
              ],
            }
          : undefined,
      },
      take: 20,
      select: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    res.json({ members: members.map((m) => m.user) });
  },
);

export default router;
