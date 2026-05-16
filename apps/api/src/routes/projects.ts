import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { broadcastToTeam, broadcastToUser } from '../sse';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { addRepositoryByUrl, addRepositoryFromCloneUrl } from '../services/github';
import { getUserTeamIds } from '../services/team-scope';
import { assertProjectOwned, assertTeamRole } from '../services/ownership';
import { HttpError } from '../errors';
import { logActivity } from '../services/activity';
import {
  createProjectBodySchema,
  updateProjectBodySchema,
  listProjectsQuerySchema,
  CreateProjectBody,
  UpdateProjectBody,
  ListProjectsQuery,
} from '../schemas/projects';

const router: Router = Router();

function isDesktopClient(req: Request): boolean {
  const header = req.header('x-openlinear-client');
  return typeof header === 'string' && header.toLowerCase() === 'desktop';
}

function transformProject(project: { projectTeams: { team: unknown }[]; repository?: unknown; [key: string]: unknown }) {
  return {
    ...project,
    teams: project.projectTeams.map((pt) => pt.team),
    projectTeams: undefined,
  };
}

function isSshRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith('git@') || trimmed.startsWith('ssh://');
}

const projectInclude = {
  projectTeams: {
    include: { team: true },
  },
  repository: {
    select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
  },
  _count: {
    select: { tasks: true },
  },
} as const;

router.get(
  '/',
  optionalAuth,
  validateQuery(listProjectsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListProjectsQuery>, res: Response, next: NextFunction) => {
    try {
      const teamId = req.validQuery?.teamId;

      let where: Record<string, unknown> = {};
      if (teamId) {
        where = { projectTeams: { some: { teamId } } };
      } else if (req.userId) {
        const teamIds = await getUserTeamIds(req.userId);
        where = { projectTeams: { some: { teamId: { in: teamIds } } } };
      } else {
        res.json([]);
        return;
      }

      const projects = await prisma.project.findMany({
        where,
        include: projectInclude,
        orderBy: { createdAt: 'desc' },
      });

      res.json(projects.map(transformProject));
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  requireAuth,
  validateBody(createProjectBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateProjectBody>, res: Response, next: NextFunction) => {
    try {
      const {
        teamIds,
        startDate,
        targetDate,
        repoUrl,
        repositoryId,
        defaultBranch,
        localPath,
        ...projectData
      } = req.validBody!;

      if (localPath && !isDesktopClient(req)) {
        throw new HttpError(403, 'DESKTOP_REQUIRED', 'localPath can only be set from the desktop app');
      }

      if (teamIds?.length) {
        for (const tid of teamIds) {
          await assertTeamRole(tid, req.userId!, ['owner', 'admin', 'member']);
        }
      }

      let resolvedRepositoryId: string | undefined;
      let resolvedRepoUrl = repoUrl || undefined;

      if (repositoryId) {
        const repo = await prisma.repository.findFirst({
          where: { id: repositoryId, userId: req.userId! },
        });

        if (!repo) {
          throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found');
        }

        resolvedRepositoryId = repo.id;
        resolvedRepoUrl = resolvedRepoUrl || `https://github.com/${repo.fullName}`;

        if (defaultBranch && defaultBranch !== repo.defaultBranch) {
          await prisma.repository.update({
            where: { id: repo.id },
            data: { defaultBranch },
          });
        }
      } else if (repoUrl) {
        if (isSshRepoUrl(repoUrl)) {
          try {
            const repo = await addRepositoryFromCloneUrl(req.userId!, repoUrl, defaultBranch || 'main');
            resolvedRepositoryId = repo.id;
            resolvedRepoUrl = repoUrl;
          } catch (err) {
            throw new HttpError(
              400,
              'REPOSITORY_CONNECT_FAILED',
              `Failed to connect repository: ${(err as Error).message}`,
            );
          }
        } else {
          try {
            const repo = await addRepositoryByUrl(repoUrl);
            resolvedRepositoryId = repo.id;
            if (defaultBranch && defaultBranch !== repo.defaultBranch) {
              await prisma.repository.update({
                where: { id: repo.id },
                data: { defaultBranch },
              });
            }
          } catch (err) {
            throw new HttpError(
              400,
              'REPOSITORY_CONNECT_FAILED',
              `Failed to connect repository: ${(err as Error).message}`,
            );
          }
        }
      }

      const project = await prisma.project.create({
        data: {
          name: projectData.name,
          description: projectData.description,
          status: projectData.status,
          color: projectData.color,
          icon: projectData.icon,
          leadId: projectData.leadId,
          startDate: startDate ? new Date(startDate) : undefined,
          targetDate: targetDate ? new Date(targetDate) : undefined,
          localPath: localPath || undefined,
          repoUrl: resolvedRepoUrl,
          repositoryId: resolvedRepositoryId,
          ...(teamIds?.length ? {
            projectTeams: {
              create: teamIds.map((teamId) => ({ teamId })),
            },
          } : {}),
        },
        include: projectInclude,
      });

      const result = transformProject(project);
      if (teamIds?.length) {
        for (const tid of teamIds) {
          broadcastToTeam(tid, 'project:created', result);
        }
      } else {
        broadcastToUser(req.userId!, 'project:created', result);
      }
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    if (!req.userId) {
      res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    await assertProjectOwned(id, req.userId);

    const project = await prisma.project.findUnique({
      where: { id },
      include: projectInclude,
    });

    if (!project) {
      res.status(404).json({ error: 'not_found', code: 'NOT_FOUND', message: 'Project not found' });
      return;
    }

    res.json(transformProject(project));
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id',
  requireAuth,
  validateBody(updateProjectBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateProjectBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const owned = await assertProjectOwned(id, req.userId!);
      for (const tid of owned.teamIds) {
        await assertTeamRole(tid, req.userId!, ['owner', 'admin', 'member']);
      }

      const { teamIds, startDate, targetDate, repoUrl, localPath, ...updateData } = req.validBody!;

      if (localPath !== undefined && !isDesktopClient(req)) {
        throw new HttpError(403, 'DESKTOP_REQUIRED', 'localPath can only be updated from the desktop app');
      }

      const dateFields: Record<string, Date | null | undefined> = {};
      if (startDate !== undefined) {
        dateFields.startDate = startDate ? new Date(startDate) : null;
      }
      if (targetDate !== undefined) {
        dateFields.targetDate = targetDate ? new Date(targetDate) : null;
      }

      let repositoryId: string | null | undefined;
      if (repoUrl !== undefined) {
        if (repoUrl) {
          try {
            const repo = await addRepositoryByUrl(repoUrl);
            repositoryId = repo.id;
          } catch (err) {
            throw new HttpError(
              400,
              'REPOSITORY_CONNECT_FAILED',
              `Failed to connect repository: ${(err as Error).message}`,
            );
          }
        } else {
          repositoryId = null;
        }
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
          data: {
            ...updateData,
            ...dateFields,
            ...(repoUrl !== undefined ? { repoUrl } : {}),
            ...(localPath !== undefined ? { localPath } : {}),
            ...(repositoryId !== undefined ? { repositoryId } : {}),
          },
          include: projectInclude,
        });
      }, { timeout: 15000, maxWait: 5000 });

      const result = transformProject(project);
      const broadcastTeamIds = (project.projectTeams as Array<{ teamId: string }>).map(
        (pt) => pt.teamId,
      );
      if (broadcastTeamIds.length > 0) {
        for (const tid of broadcastTeamIds) {
          broadcastToTeam(tid, 'project:updated', result);
        }
      } else {
        broadcastToUser(req.userId!, 'project:updated', result);
      }

      const activityTeamIds = broadcastTeamIds.length > 0 ? broadcastTeamIds : owned.teamIds;
      for (const tid of activityTeamIds) {
        await logActivity({
          projectId: id,
          teamId: tid,
          userId: req.userId!,
          action: 'project_updated',
          payload: { fields: Object.keys(req.validBody!) },
        });
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const owned = await assertProjectOwned(id, req.userId!);
    for (const tid of owned.teamIds) {
      await assertTeamRole(tid, req.userId!, ['owner', 'admin']);
    }

    await prisma.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { projectId: id },
        data: { projectId: null },
      });

      await tx.project.delete({ where: { id } });
    }, { timeout: 15000, maxWait: 5000 });

    if (owned.teamIds.length > 0) {
      for (const tid of owned.teamIds) {
        broadcastToTeam(tid, 'project:deleted', { id });
      }
    } else {
      broadcastToUser(req.userId!, 'project:deleted', { id });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
