import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { broadcastToTeam, broadcastToUser } from '../sse';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { addRepositoryByUrl, addRepositoryFromCloneUrl } from '../services/github';
import { getUserTeamIds } from '../services/team-scope';
import { assertProjectAccess, assertTeamRole, OwnershipError } from '../services/ownership';
import { HttpError } from '../errors';
import { logActivity } from '../services/activity';
import { buildProjectAccessWhere, ensureDefaultWorkspaceForUser, generateProjectKey } from '../services/workspaces';
import {
  createProjectBodySchema,
  updateProjectBodySchema,
  listProjectsQuerySchema,
  projectAccessBodySchema,
  CreateProjectBody,
  UpdateProjectBody,
  ListProjectsQuery,
  ProjectAccessBody,
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
  workspace: {
    select: { id: true, name: true, slug: true, plan: true },
  },
  _count: {
    select: { tasks: true },
  },
} as const;

async function assertWorkspaceCanWrite(workspaceId: string, userId: string): Promise<void> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });

  if (!membership) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }
  if (membership.role === 'viewer') {
    throw new OwnershipError('workspace', workspaceId, 'role_required', ['owner', 'admin', 'member']);
  }
}

async function buildAccessibleProjectsWhere(
  userId: string,
  filters: { teamId?: string; workspaceId?: string },
): Promise<Record<string, unknown>> {
  const teamIds = await getUserTeamIds(userId);
  const and: Record<string, unknown>[] = [buildProjectAccessWhere(userId, teamIds)];

  if (filters.teamId) {
    and.push({ projectTeams: { some: { teamId: filters.teamId } } });
  }
  if (filters.workspaceId) {
    and.push({ workspaceId: filters.workspaceId });
  }

  return { AND: and };
}

router.get(
  '/',
  optionalAuth,
  validateQuery(listProjectsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListProjectsQuery>, res: Response, next: NextFunction) => {
    try {
      const { teamId, workspaceId } = req.validQuery ?? {};
      if (!req.userId) {
        res.json([]);
        return;
      }

      const where = await buildAccessibleProjectsWhere(req.userId, { teamId, workspaceId });
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
        workspaceId,
        key,
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

      let resolvedWorkspaceId = workspaceId;
      if (!resolvedWorkspaceId) {
        const workspace = await ensureDefaultWorkspaceForUser(req.userId!);
        if (!workspace) {
          throw new OwnershipError('user', req.userId!, 'not_found');
        }
        resolvedWorkspaceId = workspace.id;
      }
      await assertWorkspaceCanWrite(resolvedWorkspaceId, req.userId!);
      const resolvedKey = key ?? await generateProjectKey(resolvedWorkspaceId, projectData.name);

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
          workspaceId: resolvedWorkspaceId,
          key: resolvedKey,
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

      await prisma.projectAccess.upsert({
        where: { projectId_userId: { projectId: project.id, userId: req.userId! } },
        update: { permission: 'full' },
        create: { projectId: project.id, userId: req.userId!, permission: 'full' },
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

router.get('/:id/access', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertProjectAccess(id, req.userId!, 'full');

    const access = await prisma.projectAccess.findMany({
      where: { projectId: id },
      include: {
        user: { select: { id: true, username: true, email: true, avatarUrl: true } },
      },
      orderBy: { grantedAt: 'asc' },
    });

    res.json(access);
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/access',
  requireAuth,
  validateBody(projectAccessBodySchema),
  async (req: AuthRequest & ValidatedRequest<ProjectAccessBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const { userId, permission } = req.validBody!;
      await assertProjectAccess(id, req.userId!, 'full');

      const project = await prisma.project.findUnique({
        where: { id },
        select: { workspaceId: true },
      });
      if (!project) {
        throw new OwnershipError('project', id, 'not_found');
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        throw new OwnershipError('user', userId, 'not_found');
      }

      if (project.workspaceId) {
        const member = await prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
          select: { id: true },
        });
        if (!member) {
          throw new HttpError(
            400,
            'USER_NOT_WORKSPACE_MEMBER',
            'Project access can only be granted to workspace members',
          );
        }
      }

      const access = await prisma.projectAccess.upsert({
        where: { projectId_userId: { projectId: id, userId } },
        update: { permission },
        create: { projectId: id, userId, permission },
        include: {
          user: { select: { id: true, username: true, email: true, avatarUrl: true } },
        },
      });

      res.status(201).json(access);
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/:id/access/:userId', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const userId = req.params.userId as string;
    await assertProjectAccess(id, req.userId!, 'full');

    await prisma.projectAccess.upsert({
      where: { projectId_userId: { projectId: id, userId } },
      update: { permission: 'deny' },
      create: { projectId: id, userId, permission: 'deny' },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    if (!req.userId) {
      res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    await assertProjectAccess(id, req.userId, 'view');

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
      const owned = await assertProjectAccess(id, req.userId!, 'full');
      if (owned.source === 'legacy_team') {
        for (const tid of owned.teamIds) {
          await assertTeamRole(tid, req.userId!, ['owner', 'admin', 'member']);
        }
      }

      const existingProject = await prisma.project.findUnique({
        where: { id },
        select: { name: true, workspaceId: true, key: true },
      });
      if (!existingProject) {
        throw new OwnershipError('project', id, 'not_found');
      }

      const { teamIds, startDate, targetDate, repoUrl, localPath, workspaceId, key, ...updateData } = req.validBody!;

      if (teamIds !== undefined) {
        for (const tid of teamIds) {
          await assertTeamRole(tid, req.userId!, ['owner', 'admin', 'member']);
        }
      }

      let nextWorkspaceId = existingProject.workspaceId;
      if (workspaceId !== undefined) {
        if (workspaceId) {
          await assertWorkspaceCanWrite(workspaceId, req.userId!);
          nextWorkspaceId = workspaceId;
        } else {
          nextWorkspaceId = null;
        }
      }
      const workspaceChanged = workspaceId !== undefined && nextWorkspaceId !== existingProject.workspaceId;

      let nextKey: string | null | undefined;
      if (key !== undefined) {
        nextKey = key;
      } else if (workspaceChanged && existingProject.key) {
        const keyConflict = await prisma.project.findFirst({
          where: {
            workspaceId: nextWorkspaceId,
            key: existingProject.key,
            NOT: { id },
          },
          select: { id: true },
        });
        if (keyConflict) {
          nextKey = await generateProjectKey(nextWorkspaceId, updateData.name ?? existingProject.name, id);
        }
      } else if (workspaceChanged && !existingProject.key) {
        nextKey = await generateProjectKey(nextWorkspaceId, updateData.name ?? existingProject.name, id);
      }

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
        if (workspaceChanged) {
          await tx.projectAccess.deleteMany({ where: { projectId: id } });
        }
        return tx.project.update({
          where: { id },
          data: {
            ...updateData,
            ...dateFields,
            ...(workspaceId !== undefined ? { workspaceId: nextWorkspaceId } : {}),
            ...(nextKey !== undefined ? { key: nextKey } : {}),
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

    const owned = await assertProjectAccess(id, req.userId!, 'full');
    if (owned.source === 'legacy_team') {
      for (const tid of owned.teamIds) {
        await assertTeamRole(tid, req.userId!, ['owner', 'admin']);
      }
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
