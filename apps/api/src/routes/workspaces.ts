import { Router, Response, NextFunction } from 'express';
import { Prisma, prisma, type WorkspaceRole } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { OwnershipError } from '../services/ownership';
import { assertWorkspaceRole, ensureDefaultWorkspaceForUser } from '../services/workspaces';
import { broadcastToUser, broadcastToWorkspace } from '../sse';
import { HttpError } from '../errors';
import { makeEtag } from '../lib/etag';
import {
  getIdempotencyRecord,
  parseFields,
  parsePagination,
  pickFields,
  replayIdempotencyRecord,
  storeIdempotencyRecord,
} from '../lib/http';
import {
  addWorkspaceMemberBodySchema,
  bulkWorkspaceMembersBodySchema,
  createWorkspaceBodySchema,
  updateWorkspaceBodySchema,
  updateWorkspaceMemberBodySchema,
  AddWorkspaceMemberBody,
  BulkWorkspaceMembersBody,
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceMemberBody,
} from '../schemas/workspaces';

const router: Router = Router();

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;
const memberInclude = { user: { select: userSelect } } as const;
const workspaceDetailInclude = {
  _count: { select: { members: true, projects: true } },
  projects: {
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
} satisfies Prisma.WorkspaceInclude;

const workspaceListFields = [
  'id',
  'name',
  'slug',
  'plan',
  'createdAt',
  'updatedAt',
  'role',
  'invitedAt',
  'joinedAt',
  '_count',
] as const;

const workspaceMemberFields = [
  'id',
  'workspaceId',
  'userId',
  'role',
  'invitedAt',
  'joinedAt',
  'user',
] as const;

type WorkspaceMemberWithUser = Prisma.WorkspaceMemberGetPayload<{ include: typeof memberInclude }>;
type WorkspaceDetail = Prisma.WorkspaceGetPayload<{ include: typeof workspaceDetailInclude }> & {
  currentMember: {
    id: string;
    role: WorkspaceRole;
    invitedAt: Date;
    joinedAt: Date | null;
  };
};

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

function memberToRecord(member: WorkspaceMemberWithUser): Record<string, unknown> {
  return {
    id: member.id,
    workspaceId: member.workspaceId,
    userId: member.userId,
    role: member.role,
    invitedAt: member.invitedAt,
    joinedAt: member.joinedAt,
    user: member.user,
  };
}

async function loadWorkspaceDetail(workspaceId: string, userId: string): Promise<WorkspaceDetail> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true, role: true, invitedAt: true, joinedAt: true },
  });
  if (!membership) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: workspaceDetailInclude,
  });
  if (!workspace) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }
  return { ...workspace, currentMember: membership };
}

async function ensureNotLastOwner(
  workspaceId: string,
  userId: string,
  nextRole?: WorkspaceRole,
): Promise<void> {
  const current = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!current) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }
  if (current.role !== 'owner') return;
  if (nextRole === 'owner') return;

  const ownerCount = await prisma.workspaceMember.count({
    where: { workspaceId, role: 'owner' },
  });
  if (ownerCount <= 1) {
    throw new HttpError(409, 'LAST_OWNER', 'Cannot remove or demote the last workspace owner', {
      workspaceId,
      userId,
    });
  }
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDefaultWorkspaceForUser(req.userId!);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    const fields = parseFields(req.query.fields, workspaceListFields);
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

    const data = memberships.map(({ workspace, role, invitedAt, joinedAt }) =>
      pickFields(
        {
          ...workspace,
          role,
          invitedAt,
          joinedAt,
        },
        fields,
      ),
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  requireAuth,
  validateBody(createWorkspaceBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateWorkspaceBody>, res: Response, next: NextFunction) => {
    try {
      const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/workspaces');
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      const trimmed = req.validBody!.name;
      const baseSlug = slugify(trimmed);
      let slug = baseSlug;
      let suffix = 1;

      while (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } })) {
        suffix += 1;
        slug = `${baseSlug}-${suffix}`;
      }

      const workspace = await prisma.$transaction(async (tx) => {
        const created = await tx.workspace.create({
          data: { name: trimmed, slug },
        });
        await tx.workspaceMember.create({
          data: {
            workspaceId: created.id,
            userId: req.userId!,
            role: 'owner',
            joinedAt: new Date(),
          },
        });
        return created;
      });

      const detail = await loadWorkspaceDetail(workspace.id, req.userId!);
      broadcastToUser(req.userId!, 'workspace:joined', detail);
      storeIdempotencyRecord(req, req.userId!, 'POST /api/workspaces', 201, detail);
      res.status(201).json(detail);
    } catch (error) {
      next(error);
    }
  },
);

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertWorkspaceRole(id, req.userId!, ['owner', 'admin', 'member', 'viewer']);

    const fields = parseFields(req.query.fields, workspaceMemberFields);
    const { limit, cursor } = parsePagination(req.query);
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: id },
      include: memberInclude,
      orderBy: [{ id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = members.slice(0, limit);
    const nextCursor = members.length > limit ? page.at(-1)?.id ?? null : null;

    res.json({
      data: page.map((member) => pickFields(memberToRecord(member), fields)),
      nextCursor,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/members',
  requireAuth,
  validateBody(addWorkspaceMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<AddWorkspaceMemberBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const replay = getIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members`);
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      await assertWorkspaceRole(id, req.userId!, ['owner', 'admin']);
      const { username, role } = req.validBody!;
      const user = await prisma.user.findUnique({
        where: { username },
        select: userSelect,
      });
      if (!user) {
        throw new HttpError(404, 'USER_NOT_FOUND', 'User not found', { username });
      }

      const existing = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: id, userId: user.id } },
        include: memberInclude,
      });
      if (existing) {
        storeIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members`, 200, existing);
        res.status(200).json(existing);
        return;
      }

      const member = await prisma.workspaceMember.create({
        data: {
          workspaceId: id,
          userId: user.id,
          role,
          joinedAt: new Date(),
        },
        include: memberInclude,
      });
      const workspace = await loadWorkspaceDetail(id, user.id);
      broadcastToUser(user.id, 'workspace:joined', workspace);
      broadcastToWorkspace(id, 'workspace:member-added', member);
      storeIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members`, 201, member);
      res.status(201).json(member);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/:id/members/bulk',
  requireAuth,
  validateBody(bulkWorkspaceMembersBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkWorkspaceMembersBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const replay = getIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members/bulk`);
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      const caller = await assertWorkspaceRole(id, req.userId!, ['owner', 'admin']);
      if (caller.role !== 'owner' && req.validBody!.invites.some((invite) => invite.role === 'owner')) {
        throw new OwnershipError('workspace', id, 'role_required', ['owner']);
      }

      const usernames = [...new Set(req.validBody!.invites.map((invite) => invite.username))];
      const users = await prisma.user.findMany({
        where: { username: { in: usernames } },
        select: userSelect,
      });
      const usersByUsername = new Map(users.map((user) => [user.username, user]));
      const added: WorkspaceMemberWithUser[] = [];
      const skipped: Array<{ username: string; reason: string }> = [];

      await prisma.$transaction(async (tx) => {
        for (const invite of req.validBody!.invites) {
          const user = usersByUsername.get(invite.username);
          if (!user) {
            skipped.push({ username: invite.username, reason: 'USER_NOT_FOUND' });
            continue;
          }
          const existing = await tx.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: id, userId: user.id } },
            include: memberInclude,
          });
          if (existing) {
            skipped.push({ username: invite.username, reason: 'ALREADY_MEMBER' });
            continue;
          }
          const member = await tx.workspaceMember.create({
            data: {
              workspaceId: id,
              userId: user.id,
              role: invite.role,
              joinedAt: new Date(),
            },
            include: memberInclude,
          });
          added.push(member);
        }
      });

      for (const member of added) {
        const workspace = await loadWorkspaceDetail(id, member.userId);
        broadcastToUser(member.userId, 'workspace:joined', workspace);
        broadcastToWorkspace(id, 'workspace:member-added', member);
      }
      const body = { added, skipped };
      storeIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members/bulk`, 201, body);
      res.status(201).json(body);
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/:id/members/:userId',
  requireAuth,
  validateBody(updateWorkspaceMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateWorkspaceMemberBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const targetUserId = req.params.userId as string;
      await assertWorkspaceRole(id, req.userId!, ['owner']);
      await ensureNotLastOwner(id, targetUserId, req.validBody!.role);

      const member = await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: id, userId: targetUserId } },
        data: { role: req.validBody!.role },
        include: memberInclude,
      });

      broadcastToWorkspace(id, 'workspace:member-updated', member);
      res.json(member);
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const targetUserId = req.params.userId as string;

    if (targetUserId !== req.userId) {
      await assertWorkspaceRole(id, req.userId!, ['owner']);
    } else {
      await assertWorkspaceRole(id, req.userId!, ['owner', 'admin', 'member', 'viewer']);
    }
    await ensureNotLastOwner(id, targetUserId);

    await prisma.$transaction(async (tx) => {
      await tx.projectAccess.deleteMany({
        where: {
          userId: targetUserId,
          project: { workspaceId: id },
        },
      });
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: id, userId: targetUserId } },
      });
    });

    broadcastToUser(targetUserId, 'workspace:left', { workspaceId: id });
    broadcastToWorkspace(id, 'workspace:member-removed', { userId: targetUserId });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const detail = await loadWorkspaceDetail(id, req.userId!);
    const etag = makeEtag([detail.updatedAt, detail._count.members, detail._count.projects]);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.header('If-None-Match') === etag) {
      res.status(304).send();
      return;
    }
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id',
  requireAuth,
  validateBody(updateWorkspaceBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateWorkspaceBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      await assertWorkspaceRole(id, req.userId!, ['owner', 'admin']);
      if (Object.keys(req.validBody!).length === 0) {
        throw new HttpError(400, 'NO_VALID_FIELDS', 'No valid fields to update');
      }

      await prisma.workspace.update({
        where: { id },
        data: req.validBody!,
      });

      const detail = await loadWorkspaceDetail(id, req.userId!);
      broadcastToWorkspace(id, 'workspace:updated', detail);
      res.json(detail);
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertWorkspaceRole(id, req.userId!, ['owner']);
    const projectCount = await prisma.project.count({ where: { workspaceId: id } });
    if (projectCount > 0) {
      throw new HttpError(409, 'WORKSPACE_HAS_PROJECTS', 'Cannot delete workspace with projects', {
        projectCount,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.workspaceMember.deleteMany({ where: { workspaceId: id } });
      await tx.workspace.delete({ where: { id } });
    });

    broadcastToWorkspace(id, 'workspace:deleted', { id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
