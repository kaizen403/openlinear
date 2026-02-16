import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import crypto from 'crypto';
import { broadcast } from '../sse';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { getUserTeamIds } from '../services/team-scope';

const router: Router = Router();

function generateInviteCode(key: string): string {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${key}-${random}`;
}

const createTeamSchema = z.object({
  name: z.string().min(1).max(50),
  key: z.string().min(1).max(10).regex(/^[A-Z][A-Z0-9]*$/, 'Key must be uppercase alphanumeric starting with a letter'),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().optional(),
  private: z.boolean().optional(),
});

const updateTeamSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().nullable().optional(),
  private: z.boolean().optional(),
});

const addMemberSchema = z.object({
  email: z.string().email().optional(),
  userId: z.string().uuid().optional(),
  role: z.enum(['owner', 'admin', 'member']).optional().default('member'),
}).refine(data => data.email || data.userId, { message: 'Either email or userId is required' });

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
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
    console.error('[Teams] Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

router.post('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const team = await prisma.team.create({
      data: {
        ...parsed.data,
        inviteCode: generateInviteCode(parsed.data.key),
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

    broadcast('team:created', team);
    res.status(201).json(team);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ error: 'Team with this key already exists' });
      return;
    }
    console.error('[Teams] Error creating team:', error);
    res.status(500).json({ error: 'Failed to create team' });
  }
});

const joinTeamSchema = z.object({
  inviteCode: z.string().min(1),
});

router.post('/join', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = joinTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const team = await prisma.team.findUnique({
      where: { inviteCode: parsed.data.inviteCode },
    });

    if (!team) {
      res.status(404).json({ error: 'Invalid invite code' });
      return;
    }

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team.id, userId: req.userId! } },
    });

    if (existing) {
      res.status(409).json({ error: 'You are already a member of this team' });
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

    broadcast('team:updated', result);
    res.json(result);
  } catch (error) {
    console.error('[Teams] Error joining team:', error);
    res.status(500).json({ error: 'Failed to join team' });
  }
});

router.patch('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = updateTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const team = await prisma.team.update({
      where: { id },
      data: parsed.data,
      include: {
        _count: {
          select: { members: true },
        },
      },
    });

    broadcast('team:updated', team);
    res.json(team);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Record to update not found')) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ error: 'Team with this key already exists' });
      return;
    }
    console.error('[Teams] Error updating team:', error);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

router.delete('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.$transaction(async (tx) => {
      const team = await tx.team.findUnique({ where: { id } });
      if (!team) throw new Error('NOT_FOUND');
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      await tx.projectTeam.deleteMany({ where: { teamId: id } });
      await tx.task.updateMany({ where: { teamId: id }, data: { teamId: null } });
      await tx.team.delete({ where: { id } });
    });
    broadcast('team:deleted', { id });
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && (error.message === 'NOT_FOUND' || error.message.includes('Record to delete does not exist'))) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }
    console.error('[Teams] Error deleting team:', error);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
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
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    res.json(team);
  } catch (error) {
    console.error('[Teams] Error fetching team:', error);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

router.get('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const members = await prisma.teamMember.findMany({
      where: { teamId: id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    res.json(members);
  } catch (error) {
    console.error('[Teams] Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

router.post('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const { email, userId, role } = parsed.data;

    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    let user;
    if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (email) {
      user = await prisma.user.findFirst({ where: { email } });
    }

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const member = await prisma.teamMember.create({
      data: {
        teamId: id,
        userId: user.id,
        role,
      },
      include: { user: true },
    });

    res.status(201).json(member);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ error: 'User is already a member of this team' });
      return;
    }
    console.error('[Teams] Error adding team member:', error);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

router.delete('/:id/members/:userId', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id, userId } = req.params;

    await prisma.teamMember.delete({
      where: {
        teamId_userId: { teamId: id, userId },
      },
    });

    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Record to delete does not exist')) {
      res.status(404).json({ error: 'Team member not found' });
      return;
    }
    console.error('[Teams] Error removing team member:', error);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

export default router;
