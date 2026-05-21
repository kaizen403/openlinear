import { Router, Request, Response, NextFunction } from 'express';
import { Prisma, prisma } from '@openlinear/db';
import { broadcastToProject, broadcastToTeam, broadcastToUser, broadcastToWorkspace } from '../sse';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { addRepositoryByUrl, addRepositoryFromCloneUrl } from '../services/github';
import { getUserTeamIds } from '../services/team-scope';
import { assertProjectAccess, assertTeamRole, OwnershipError } from '../services/ownership';
import { HttpError } from '../errors';
import { makeEtag } from '../lib/etag';
import {
  getIdempotencyRecord,
  parseFields,
  pickFields,
  replayIdempotencyRecord,
  storeIdempotencyRecord,
} from '../lib/http';
import { logActivity } from '../services/activity';
import { buildProjectAccessWhere, ensureDefaultWorkspaceForUser, generateProjectKey } from '../services/workspaces';
import {
  bulkProjectAccessBodySchema,
  createProjectBodySchema,
  updateProjectBodySchema,
  listProjectsQuerySchema,
  projectAccessBodySchema,
  BulkProjectAccessBody,
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

function isSshRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith('git@') || trimmed.startsWith('ssh://');
}

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;

const projectInclude = {
  teams: true,
  repository: {
    select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
  },
  workspace: {
    select: { id: true, name: true, slug: true, plan: true },
  },
  _count: {
    select: { tasks: true },
  },
} satisfies Prisma.ProjectInclude;

const projectAccessInclude = {
  user: { select: userSelect },
} satisfies Prisma.ProjectAccessInclude;

type ProjectWithInclude = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

const projectListFields = [
  'id',
  'workspaceId',
  'key',
  'name',
  'description',
  'status',
  'color',
  'icon',
  'startDate',
  'targetDate',
  'leadId',
  'repositoryId',
  'localPath',
  'repoUrl',
  'createdAt',
  'updatedAt',
  'teams',
  'repository',
  'workspace',
  '_count',
] as const;

const projectScalarFields = new Set<string>([
  'id',
  'workspaceId',
  'key',
  'name',
  'description',
  'status',
  'color',
  'icon',
  'startDate',
  'targetDate',
  'leadId',
  'repositoryId',
  'localPath',
  'repoUrl',
  'createdAt',
  'updatedAt',
]);

function buildProjectSelect(fields: string[]): Prisma.ProjectSelect {
  const select: Prisma.ProjectSelect = {};
  for (const field of fields) {
    if (projectScalarFields.has(field)) {
      (select as Record<string, unknown>)[field] = true;
      continue;
    }
    if (field === 'teams') {
      select.teams = true;
    } else if (field === 'repository') {
      select.repository = {
        select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
      };
    } else if (field === 'workspace') {
      select.workspace = {
        select: { id: true, name: true, slug: true, plan: true },
      };
    } else if (field === '_count') {
      select._count = { select: { tasks: true } };
    }
  }
  return select;
}

function applyProjectFields(project: ProjectWithInclude, fields: string[] | null): ProjectWithInclude | Record<string, unknown> {
  if (!fields) return project;
  return pickFields(project as unknown as Record<string, unknown>, fields);
}

function matchesEtag(req: Request, etag: string): boolean {
  return req
    .header('if-none-match')
    ?.split(',')
    .map((value) => value.trim())
    .includes(etag) ?? false;
}

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
): Promise<Prisma.ProjectWhereInput> {
  const and: Prisma.ProjectWhereInput[] = [];

  if (filters.workspaceId) {
    and.push(
      { workspaceId: filters.workspaceId },
      { workspace: { members: { some: { userId } } } },
      { NOT: { access: { some: { userId, permission: 'deny' } } } },
    );
  } else {
    const teamIds = await getUserTeamIds(userId);
    and.push(buildProjectAccessWhere(userId, teamIds));
  }

  if (filters.teamId) {
    and.push({ teams: { some: { id: filters.teamId } } });
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
      const fields = parseFields(req.query.fields, projectListFields);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      if (!req.userId) {
        res.json([]);
        return;
      }

      const where = await buildAccessibleProjectsWhere(req.userId, { teamId, workspaceId });
      const projects = fields
        ? await prisma.project.findMany({
            where,
            select: buildProjectSelect(fields),
            orderBy: { createdAt: 'desc' },
          })
        : await prisma.project.findMany({
            where,
            include: projectInclude,
            orderBy: { createdAt: 'desc' },
          });

      res.json(fields ? projects : projects.map((project) => applyProjectFields(project, fields)));
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
      const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/projects');
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

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
          ...(teamIds?.length ? {} : {}),
        },
        include: projectInclude,
      });

      if (teamIds?.length) {
        const conflicting = await prisma.team.findMany({
          where: { id: { in: teamIds }, projectId: { not: project.id } },
          select: { id: true, projectId: true },
        });
        if (conflicting.length > 0) {
          await prisma.project.delete({ where: { id: project.id } });
          throw new HttpError(409, 'TEAM_PROJECT_CONFLICT', 'One or more teams already belong to a different project');
        }
        await prisma.team.updateMany({
          where: { id: { in: teamIds } },
          data: { projectId: project.id },
        });
        const updatedProject = await prisma.project.findUnique({
          where: { id: project.id },
          include: projectInclude,
        });
        if (updatedProject) {
          await prisma.projectAccess.upsert({
            where: { projectId_userId: { projectId: project.id, userId: req.userId! } },
            update: { permission: 'full' },
            create: { projectId: project.id, userId: req.userId!, permission: 'full' },
          });
          const result = applyProjectFields(updatedProject, null);
          await broadcastToProject(project.id, 'project:created', result);
          storeIdempotencyRecord(req, req.userId!, 'POST /api/projects', 201, result);
          res.status(201).json(result);
          return;
        }
      }

      await prisma.projectAccess.upsert({
        where: { projectId_userId: { projectId: project.id, userId: req.userId! } },
        update: { permission: 'full' },
        create: { projectId: project.id, userId: req.userId!, permission: 'full' },
      });

      const result = applyProjectFields(project, null);
      await broadcastToProject(project.id, 'project:created', result);
      storeIdempotencyRecord(req, req.userId!, 'POST /api/projects', 201, result);
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
      include: projectAccessInclude,
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
      const replay = getIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access`);
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

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

      const existing = await prisma.projectAccess.findUnique({
        where: { projectId_userId: { projectId: id, userId } },
        select: { id: true },
      });
      const access = await prisma.projectAccess.upsert({
        where: { projectId_userId: { projectId: id, userId } },
        update: { permission },
        create: { projectId: id, userId, permission },
        include: projectAccessInclude,
      });

      const status = existing ? 200 : 201;
      await broadcastToProject(id, 'project:access-changed', { projectId: id, access });
      storeIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access`, status, access);
      res.status(status).json(access);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/:id/access/bulk',
  requireAuth,
  validateBody(bulkProjectAccessBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkProjectAccessBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const replay = getIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access/bulk`);
      if (replay) {
        replayIdempotencyRecord(res, replay);
        return;
      }

      await assertProjectAccess(id, req.userId!, 'full');
      const project = await prisma.project.findUnique({
        where: { id },
        select: { workspaceId: true },
      });
      if (!project) {
        throw new OwnershipError('project', id, 'not_found');
      }

      const grantsByUser = new Map<string, BulkProjectAccessBody['grants'][number]>();
      for (const grant of req.validBody!.grants) {
        grantsByUser.set(grant.userId, grant);
      }
      const grants = Array.from(grantsByUser.values());
      const userIds = grants.map((grant) => grant.userId);

      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true },
      });
      const foundUserIds = new Set(users.map((user) => user.id));
      const skipped: Array<{ userId: string; reason: string }> = grants
        .filter((grant) => !foundUserIds.has(grant.userId))
        .map((grant) => ({ userId: grant.userId, reason: 'USER_NOT_FOUND' }));

      let allowedUserIds = foundUserIds;
      if (project.workspaceId) {
        const memberships = await prisma.workspaceMember.findMany({
          where: { workspaceId: project.workspaceId, userId: { in: Array.from(foundUserIds) } },
          select: { userId: true },
        });
        allowedUserIds = new Set(memberships.map((member) => member.userId));
        for (const userId of foundUserIds) {
          if (!allowedUserIds.has(userId)) {
            skipped.push({ userId, reason: 'USER_NOT_WORKSPACE_MEMBER' });
          }
        }
      }

      const grantable = grants.filter((grant) => allowedUserIds.has(grant.userId));
      const granted = await prisma.$transaction(
        grantable.map((grant) =>
          prisma.projectAccess.upsert({
            where: { projectId_userId: { projectId: id, userId: grant.userId } },
            update: { permission: grant.permission },
            create: { projectId: id, userId: grant.userId, permission: grant.permission },
            include: projectAccessInclude,
          }),
        ),
      );

      const body = { granted, skipped };
      await broadcastToProject(id, 'project:access-changed', { projectId: id, access: granted, skipped });
      storeIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access/bulk`, 200, body);
      res.json(body);
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

    const payload = { projectId: id, userId, permission: 'deny' };
    await broadcastToProject(id, 'project:access-changed', payload);
    broadcastToUser(userId, 'project:access-changed', payload);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    if (!req.userId) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    await assertProjectAccess(id, req.userId, 'view');

    const project = await prisma.project.findUnique({
      where: { id },
      include: projectInclude,
    });

    if (!project) {
      throw new OwnershipError('project', id, 'not_found');
    }

    const etag = makeEtag([project.updatedAt, project._count.tasks, project.teams.length]);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (matchesEtag(req, etag)) {
      res.status(304).send();
      return;
    }

    res.json(applyProjectFields(project, null));
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
          await tx.team.updateMany({ where: { projectId: id }, data: { projectId: id } });
          if (teamIds.length > 0) {
            const conflicting = await tx.team.findMany({
              where: { id: { in: teamIds }, projectId: { not: id } },
              select: { id: true },
            });
            if (conflicting.length > 0) {
              throw new HttpError(409, 'TEAM_PROJECT_CONFLICT', 'One or more teams already belong to a different project');
            }
            await tx.team.updateMany({
              where: { id: { in: teamIds } },
              data: { projectId: id },
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

      const result = applyProjectFields(project, null);
      const broadcastTeamIds = project.teams.map((t) => t.id);
      await broadcastToProject(id, 'project:updated', result);

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

    const recipients = await prisma.project.findUnique({
      where: { id },
      select: {
        workspaceId: true,
        teams: { select: { id: true } },
        access: {
          where: { permission: { in: ['full', 'view'] } },
          select: { userId: true },
        },
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { projectId: id },
        data: { projectId: null },
      });

      await tx.project.delete({ where: { id } });
    }, { timeout: 15000, maxWait: 5000 });

    const payload = { id };
    if (recipients?.workspaceId) {
      broadcastToWorkspace(recipients.workspaceId, 'project:deleted', payload);
    }
    for (const team of recipients?.teams ?? []) {
      broadcastToTeam(team.id, 'project:deleted', payload);
    }
    for (const access of recipients?.access ?? []) {
      broadcastToUser(access.userId, 'project:deleted', payload);
    }
    if (!recipients?.workspaceId && !recipients?.teams.length && !recipients?.access.length) {
      broadcastToUser(req.userId!, 'project:deleted', { id });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
