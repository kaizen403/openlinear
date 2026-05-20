import { Router, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { OwnershipError } from '../services/ownership';
import { ensureDefaultWorkspaceForUser } from '../services/workspaces';

const router: Router = Router();

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

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

router.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
      res.status(400).json({ error: 'name is required (1-100 characters)' });
      return;
    }

    const trimmed = name.trim();
    const baseSlug = slugify(trimmed);
    let slug = baseSlug;
    let suffix = 1;

    while (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } })) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }

    const workspace = await prisma.workspace.create({
      data: { name: trimmed, slug },
    });

    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: req.userId!,
        role: 'owner',
        joinedAt: new Date(),
      },
    });

    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const membership = await assertWorkspaceMember(id, req.userId!);

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      res.status(403).json({ error: 'Only owners and admins can update workspace settings' });
      return;
    }

    const { name } = req.body as { name?: string };
    const data: { name?: string } = {};

    if (name && typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 100) {
      data.name = name.trim();
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    const workspace = await prisma.workspace.update({
      where: { id },
      data,
      include: { _count: { select: { members: true, projects: true } } },
    });

    res.json(workspace);
  } catch (error) {
    next(error);
  }
});

export default router;
