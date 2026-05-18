import { Router, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { OwnershipError } from '../services/ownership';
import { ensureDefaultWorkspaceForUser } from '../services/workspaces';

const router: Router = Router();

async function assertWorkspaceMember(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true, role: true, invitedAt: true, joinedAt: true },
  });

  if (!membership) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }

  return membership;
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDefaultWorkspaceForUser(req.userId!);

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.userId! },
      include: {
        workspace: {
          include: {
            _count: { select: { members: true, projects: true } },
          },
        },
      },
      orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
    });

    res.json(
      memberships.map(({ workspace, role, invitedAt, joinedAt }) => ({
        ...workspace,
        role,
        invitedAt,
        joinedAt,
      })),
    );
  } catch (error) {
    next(error);
  }
});

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertWorkspaceMember(id, req.userId!);

    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: id },
      include: {
        user: { select: { id: true, username: true, email: true, avatarUrl: true } },
      },
      orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
    });

    res.json(members);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const membership = await assertWorkspaceMember(id, req.userId!);

    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        _count: { select: { members: true, projects: true } },
        projects: {
          where: {
            NOT: { access: { some: { userId: req.userId!, permission: 'deny' } } },
          },
          select: {
            id: true,
            key: true,
            name: true,
            description: true,
            status: true,
            color: true,
            icon: true,
            updatedAt: true,
            _count: { select: { tasks: true } },
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!workspace) {
      throw new OwnershipError('workspace', id, 'not_found');
    }

    res.json({
      ...workspace,
      currentMember: membership,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
