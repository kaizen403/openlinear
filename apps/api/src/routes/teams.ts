import { Router, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import crypto from 'crypto';
import { broadcastToTeam, broadcastToUser } from '../sse';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { assertTeamRole, OwnershipError } from '../services/ownership';
import { logActivity } from '../services/activity';
import { HttpError } from '../errors';
import {
  createTeamBodySchema,
  updateTeamBodySchema,
  joinTeamBodySchema,
  addMemberBodySchema,
  CreateTeamBody,
  UpdateTeamBody,
  JoinTeamBody,
  AddMemberBody,
} from '../schemas/teams';

const router: Router = Router();

function generateInviteCode(key: string): string {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${key}-${random}`;
}

router.get('/', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      res.json([]);
      return;
    }

    const where = { members: { some: { userId: req.userId } } };

    const teams = await prisma.team.findMany({
      where,
      include: {
        _count: {
          select: { members: true },
        },
        projectTeams: {
          include: {
            project: {
              select: { id: true, name: true, status: true, color: true, icon: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(teams);
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
      const data = req.validBody!;

      const team = await prisma.team.create({
        data: {
          ...data,
          inviteCode: generateInviteCode(data.key),
          ...(req.userId && {
            members: {
              create: {
                userId: req.userId,
                role: 'owner',
              },
            },
          }),
        },
        include: {
          members: {
            include: { user: true },
          },
          _count: {
            select: { members: true },
          },
        },
      });

    broadcastToTeam(team.id, 'team:created', team);
    res.status(201).json(team);
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
      const { inviteCode } = req.validBody!;

      const team = await prisma.team.findUnique({
        where: { inviteCode },
      });

      if (!team) {
        throw new OwnershipError('team', inviteCode, 'not_found');
      }

      const existing = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: req.userId! } },
      });

      if (existing) {
        res.status(409).json({
          error: 'conflict',
          code: 'ALREADY_MEMBER',
          message: 'You are already a member of this team',
        });
        return;
      }

      await prisma.teamMember.create({
        data: {
          teamId: team.id,
          userId: req.userId!,
          role: 'member',
        },
      });

      const result = await prisma.team.findUnique({
        where: { id: team.id },
        include: {
          members: { include: { user: true } },
          _count: { select: { members: true } },
        },
      });

      broadcastToTeam(team.id, 'team:updated', result);
      broadcastToUser(req.userId!, 'team:updated', result);
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

      const team = await prisma.team.update({
        where: { id },
        data: req.validBody!,
        include: {
          _count: {
            select: { members: true },
          },
        },
      });

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
      memberUserIds.push(...members.map((m) => m.userId));
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
      include: {
        members: {
          include: { user: true },
        },
        projectTeams: true,
      },
    });

    if (!team) {
      throw new OwnershipError('team', id, 'not_found');
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

    const members = await prisma.teamMember.findMany({
      where: { teamId: id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    res.json(members);
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
      const { email, userId, role } = req.validBody!;

      await assertTeamRole(id, req.userId!, ['owner', 'admin']);

      let user;
      if (userId) {
        user = await prisma.user.findUnique({ where: { id: userId } });
      } else if (email) {
        user = await prisma.user.findFirst({ where: { email } });
      }

      if (!user) {
        throw new OwnershipError('team', id, 'not_found');
      }

      const member = await prisma.teamMember.create({
        data: {
          teamId: id,
          userId: user.id,
          role,
        },
        include: { user: true },
      });

      await logActivity({
        teamId: id,
        userId: req.userId!,
        action: 'team_member_added',
        payload: { addedUserId: user.id, role },
      });

      res.status(201).json(member);
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
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId: req.userId! } },
        select: { role: true },
      });
      if (!membership) {
        throw new OwnershipError('team', id, 'not_found');
      }
    }

    await prisma.teamMember.delete({
      where: {
        teamId_userId: { teamId: id, userId: targetUserId },
      },
    });

    await logActivity({
      teamId: id,
      userId: req.userId!,
      action: 'team_member_removed',
      payload: { removedUserId: targetUserId },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
