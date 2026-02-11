import { Router, Request, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { broadcast } from '../sse';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router: Router = Router();

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  status: z.enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled']).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().optional(),
  startDate: z.string().datetime().optional(),
  targetDate: z.string().datetime().optional(),
  leadId: z.string().uuid().optional(),
  teamIds: z.array(z.string().uuid()).min(1).max(1),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled']).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  targetDate: z.string().datetime().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  teamIds: z.array(z.string().uuid()).min(1).max(1).optional(),
});

function transformProject(project: { projectTeams: { team: unknown }[]; [key: string]: unknown }) {
  return {
    ...project,
    teams: project.projectTeams.map((pt) => pt.team),
    projectTeams: undefined,
  };
}

const projectInclude = {
  projectTeams: {
    include: { team: true },
  },
  _count: {
    select: { tasks: true },
  },
};

router.get('/', async (req: Request, res: Response) => {
  try {
    const teamId = req.query.teamId as string | undefined;
    const where = teamId
      ? { projectTeams: { some: { teamId } } }
      : {};

    const projects = await prisma.project.findMany({
      where,
      include: projectInclude,
      orderBy: { createdAt: 'desc' },
    });

    res.json(projects.map(transformProject));
  } catch (error) {
    console.error('[Projects] Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const { teamIds, startDate, targetDate, ...projectData } = parsed.data;

    const project = await prisma.project.create({
      data: {
        ...projectData,
        startDate: startDate ? new Date(startDate) : undefined,
        targetDate: targetDate ? new Date(targetDate) : undefined,
        projectTeams: {
          create: teamIds.map((teamId) => ({ teamId })),
        },
      },
      include: projectInclude,
    });

    const result = transformProject(project);
    broadcast('project:created', result);
    res.status(201).json(result);
  } catch (error) {
    console.error('[Projects] Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await prisma.project.findUnique({
      where: { id },
      include: projectInclude,
    });

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json(transformProject(project));
  } catch (error) {
    console.error('[Projects] Error fetching project:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const { teamIds, startDate, targetDate, ...updateData } = parsed.data;

    const dateFields: Record<string, Date | null | undefined> = {};
    if (startDate !== undefined) {
      dateFields.startDate = startDate ? new Date(startDate) : null;
    }
    if (targetDate !== undefined) {
      dateFields.targetDate = targetDate ? new Date(targetDate) : null;
    }

    const project = await prisma.$transaction(async (tx) => {
      if (teamIds !== undefined) {
        await tx.projectTeam.deleteMany({ where: { projectId: id } });
        if (teamIds.length > 0) {
          await tx.projectTeam.createMany({
            data: teamIds.map((teamId) => ({ projectId: id, teamId })),
          });
        }
      }
      return tx.project.update({
        where: { id },
        data: { ...updateData, ...dateFields },
        include: projectInclude,
      });
    });

    const result = transformProject(project);
    broadcast('project:updated', result);
    res.json(result);
  } catch (error) {
    console.error('[Projects] Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await prisma.task.updateMany({
      where: { projectId: id },
      data: { projectId: null },
    });

    await prisma.project.delete({ where: { id } });

    broadcast('project:deleted', { id });
    res.status(204).send();
  } catch (error) {
    console.error('[Projects] Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

export default router;
