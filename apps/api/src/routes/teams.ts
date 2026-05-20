import { Router, Response, NextFunction } from 'express';
import { Prisma, prisma, type TeamRole } from '@openlinear/db';
import crypto from 'crypto';
import { broadcastToTeam, broadcastToUser } from '../sse';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { assertTeamRole, OwnershipError } from '../services/ownership';
import { logActivity } from '../services/activity';
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
  createTeamBodySchema,
  updateTeamBodySchema,
  joinTeamBodySchema,
  addMemberBodySchema,
  updateTeamMemberBodySchema,
  CreateTeamBody,
  UpdateTeamBody,
  JoinTeamBody,
  AddMemberBody,
  UpdateTeamMemberBody,
} from '../schemas/teams';

const router: Router = Router();

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;
const memberInclude = { user: { select: userSelect } } as const;
const teamFullInclude = {
  members: { include: memberInclude },
  _count: { select: { members: true } },
  projectTeams: {
    include: {
      project: {
        select: { id: true, name: true, status: true, color: true, icon: true },
      },
    },
  },
} satisfies Prisma.TeamInclude;
const teamDetailInclude = {
  members: { include: { user: true } },
  projectTeams: true,
  _count: { select: { members: true, projectTeams: true } },
} satisfies Prisma.TeamInclude;

const teamListFields = [
  'id',
  'name',
  'key',
  'description',
  'color',
  'icon',
  'private',
  'inviteCode',
  'nextIssueNumber',
  'createdAt',
  'updatedAt',
  'members',
  'projectTeams',
  '_count',
] as const;

const teamMemberFields = ['id', 'teamId', 'userId', 'role', 'sortOrder', 'createdAt', 'user'] as const;

type TeamMemberWithUser = Prisma.TeamMemberGetPayload<{ include: typeof memberInclude }>;

function generateInviteCode(key: string): string {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${key}-${random}`;
}

function teamMemberToRecord(member: TeamMemberWithUser): Record<string, unknown> {
  return {
    id: member.id,
    teamId: member.teamId,
    userId: member.userId,
    role: member.role,
    sortOrder: member.sortOrder,
    createdAt: member.createdAt,
    user: member.user,
  };
}

async function loadTeamFull(teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: teamFullInclude,
  });
  if (!team) {
    throw new OwnershipError('team', teamId, 'not_found');
  }
  return team;
}

async function ensureNotLastOwner(teamId: string, userId: string, nextRole?: TeamRole): Promise<void> {
  const current = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });
  if (!current) {
    throw new OwnershipError('team', teamId, 'not_found');
  }
  if (current.role !== 'owner') return;
  if (nextRole === 'owner') return;

  const ownerCount = await prisma.teamMember.count({ where: { teamId, role: 'owner' } });
  if (ownerCount <= 1) {
    throw new HttpError(409, 'LAST_OWNER', 'Cannot remove or demote the last team owner', {
      teamId,
      userId,
    });
  }
}

router.get('/', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (!req.userId) {
      res.json([]);
      return;
    }

    const fields = parseFields(req.query.fields, teamListFields);
    const teams = await prisma.team.findMany({
      where: { members: { some: { userId: req.userId } } },
      include: teamFullInclude,
      orderBy: { createdAt: 'asc' },
    });
    res.json(teams.map((team) => pickFields({ ...team }, fields)));
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  requireAuth,
  validateBody(createTeamBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateTeamBody>, res: Response, next: NextFunction) => {
    try {
      const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/teams');
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      const data = req.validBody!;
      const created = await prisma.team.create({
        data: {
          ...data,
          inviteCode: generateInviteCode(data.key),
          members: {
            create: {
              userId: req.userId!,
              role: 'owner',
            },
          },
        },
        include: teamFullInclude,
      });

      broadcastToTeam(created.id, 'team:created', created);
      broadcastToUser(req.userId!, 'team:created', created);
      storeIdempotencyRecord(req, req.userId!, 'POST /api/teams', 201, created);
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/join',
  requireAuth,
  validateBody(joinTeamBodySchema),
  async (req: AuthRequest & ValidatedRequest<JoinTeamBody>, res: Response, next: NextFunction) => {
    try {
      const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/teams/join');
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      const { inviteCode } = req.validBody!;
      const team = await prisma.team.findUnique({ where: { inviteCode } });
      if (!team) {
        throw new OwnershipError('team', inviteCode, 'not_found');
      }

      const existing = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: req.userId! } },
      });
      if (existing) {
        throw new HttpError(409, 'ALREADY_MEMBER', 'You are already a member of this team');
      }

      await prisma.teamMember.create({
        data: { teamId: team.id, userId: req.userId!, role: 'member' },
      });

      const result = await loadTeamFull(team.id);
      broadcastToTeam(team.id, 'team:updated', result);
      broadcastToUser(req.userId!, 'team:updated', result);
      storeIdempotencyRecord(req, req.userId!, 'POST /api/teams/join', 200, result);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/:id',
  requireAuth,
  validateBody(updateTeamBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateTeamBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      await assertTeamRole(id, req.userId!, ['owner', 'admin']);

      const existing = await prisma.team.findUnique({ where: { id } });
      if (!existing) {
        throw new OwnershipError('team', id, 'not_found');
      }

      const body = req.validBody!;
      const updateData: Prisma.TeamUpdateInput = { ...body };
      if (body.key && body.key !== existing.key) {
        updateData.inviteCode = generateInviteCode(body.key);
      }

      await prisma.team.update({ where: { id }, data: updateData });
      const team = await loadTeamFull(id);
      broadcastToTeam(team.id, 'team:updated', team);
      res.json(team);
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertTeamRole(id, req.userId!, ['owner']);
    const memberUserIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      const team = await tx.team.findUnique({ where: { id } });
      if (!team) throw new OwnershipError('team', id, 'not_found');
      const members = await tx.teamMember.findMany({
        where: { teamId: id },
        select: { userId: true },
      });
      const taskCount = await tx.task.count({ where: { teamId: id } });
      if (taskCount > 0) {
        throw new HttpError(409, 'TEAM_HAS_TASKS', 'Cannot delete a team that still has tasks');
      }
      memberUserIds.push(...members.map((member) => member.userId));
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      await tx.projectTeam.deleteMany({ where: { teamId: id } });
      await tx.team.delete({ where: { id } });
    }, { timeout: 15000, maxWait: 5000 });
    for (const uid of memberUserIds) {
      broadcastToUser(uid, 'team:deleted', { id });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertTeamRole(id, req.userId!, ['owner', 'admin', 'member']);

    const team = await prisma.team.findUnique({
      where: { id },
      include: teamDetailInclude,
    });
    if (!team) {
      throw new OwnershipError('team', id, 'not_found');
    }

    const etag = makeEtag([team.updatedAt, team._count.members, team._count.projectTeams]);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.header('If-None-Match') === etag) {
      res.status(304).send();
      return;
    }
    res.json(team);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertTeamRole(id, req.userId!, ['owner', 'admin', 'member']);
    const fields = parseFields(req.query.fields, teamMemberFields);
    const { limit, cursor } = parsePagination(req.query);

    const members = await prisma.teamMember.findMany({
      where: { teamId: id },
      include: memberInclude,
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = members.slice(0, limit);
    const nextCursor = members.length > limit ? page.at(-1)?.id ?? null : null;
    res.json({
      data: page.map((member) => pickFields(teamMemberToRecord(member), fields)),
      nextCursor,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/members',
  requireAuth,
  validateBody(addMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<AddMemberBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const replay = getIdempotencyRecord(req, req.userId!, `POST /api/teams/${id}/members`);
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      const { email, userId, role } = req.validBody!;
      const caller = await assertTeamRole(id, req.userId!, ['owner', 'admin']);
      if (role === 'owner' && caller.role !== 'owner') {
        throw new OwnershipError('team', id, 'role_required', ['owner']);
      }

      const user = userId
        ? await prisma.user.findUnique({ where: { id: userId }, select: userSelect })
        : email
          ? await prisma.user.findFirst({ where: { email }, select: userSelect })
          : null;
      if (!user) {
        throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      }

      const member = await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: id, userId: user.id } },
        update: {},
        create: { teamId: id, userId: user.id, role },
        include: memberInclude,
      });

      await logActivity({
        teamId: id,
        userId: req.userId!,
        action: 'team_member_added',
        payload: { addedUserId: user.id, role: member.role },
      });

      broadcastToTeam(id, 'team:member-added', member);
      broadcastToUser(user.id, 'team:joined', { teamId: id });
      storeIdempotencyRecord(req, req.userId!, `POST /api/teams/${id}/members`, 201, member);
      res.status(201).json(member);
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/:id/members/:userId',
  requireAuth,
  validateBody(updateTeamMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateTeamMemberBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const targetUserId = req.params.userId as string;
      const caller = await assertTeamRole(id, req.userId!, ['owner', 'admin']);
      const nextRole = req.validBody!.role;
      if (nextRole === 'owner' && caller.role !== 'owner') {
        throw new OwnershipError('team', id, 'role_required', ['owner']);
      }
      await ensureNotLastOwner(id, targetUserId, nextRole);

      const member = await prisma.teamMember.update({
        where: { teamId_userId: { teamId: id, userId: targetUserId } },
        data: { role: nextRole },
        include: memberInclude,
      });
      broadcastToTeam(id, 'team:member-updated', member);
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
      await assertTeamRole(id, req.userId!, ['owner']);
    } else {
      await assertTeamRole(id, req.userId!, ['owner', 'admin', 'member']);
    }
    await ensureNotLastOwner(id, targetUserId);

    await prisma.teamMember.delete({
      where: { teamId_userId: { teamId: id, userId: targetUserId } },
    });

    await logActivity({
      teamId: id,
      userId: req.userId!,
      action: 'team_member_removed',
      payload: { removedUserId: targetUserId },
    });

    broadcastToTeam(id, 'team:member-removed', { userId: targetUserId });
    broadcastToUser(targetUserId, 'team:left', { teamId: id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
