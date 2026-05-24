import { prisma, type Prisma, type ProjectPermission, type ProjectStatus } from '@openlinear/db';
import { HttpError } from '../errors';
import { broadcastToProject, broadcastToTeam, broadcastToUser, broadcastToWorkspace } from '../sse';
import { logActivity } from './activity';
import { getUserTeamIds } from './team-scope';
import { assertProjectAccess, assertTeamRole, OwnershipError } from './ownership';
import {
  buildProjectAccessWhere,
  ensureDefaultWorkspaceForUser,
  generateProjectKey,
  assertWorkspaceRole,
} from './workspaces';
import { addRepositoryByUrl, addRepositoryFromCloneUrl } from './github';

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;

export const projectInclude = {
  teams: true,
  repository: {
    select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
  },
  workspace: {
    select: { id: true, name: true, slug: true, plan: true },
  },
  _count: { select: { tasks: true } },
} satisfies Prisma.ProjectInclude;

export const projectAccessInclude = { user: { select: userSelect } } satisfies Prisma.ProjectAccessInclude;

export type ProjectWithInclude = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

function teamKeyFromProjectKey(key: string | null): string {
  const cleaned = (key ?? 'TEAM').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10);
  return cleaned || 'TEAM';
}

async function assertWorkspaceCanWrite(workspaceId: string, userId: string): Promise<void> {
  await assertWorkspaceRole(workspaceId, userId, ['owner', 'admin', 'member']);
}

function isSshRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith('git@') || trimmed.startsWith('ssh://');
}

// ─── List Projects (route-facing, with field selection support) ───────────────

export async function buildAccessibleProjectsWhere(
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

// ─── Chat-tool-facing list (paginated) ───────────────────────────────────────

export async function listProjects(input: {
  userId: string;
  workspaceId?: string;
  teamId?: string;
  limit?: number;
  cursor?: string;
}) {
  const and: Prisma.ProjectWhereInput[] = [];
  if (input.workspaceId) {
    and.push(
      { workspaceId: input.workspaceId },
      { workspace: { members: { some: { userId: input.userId } } } },
      { NOT: { access: { some: { userId: input.userId, permission: 'deny' } } } },
    );
  } else {
    const teamIds = await getUserTeamIds(input.userId);
    and.push(buildProjectAccessWhere(input.userId, teamIds));
  }
  if (input.teamId) and.push({ teams: { some: { id: input.teamId } } });

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const projects = await prisma.project.findMany({
    where: { AND: and },
    include: projectInclude,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = projects.slice(0, limit);
  return { data: page, nextCursor: projects.length > limit ? page.at(-1)?.id ?? null : null };
}

// ─── Get Project ─────────────────────────────────────────────────────────────

export async function getProject(input: { projectId: string; userId: string; includeTasks?: boolean }) {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, include: projectInclude });
  if (!project) throw new OwnershipError('project', input.projectId, 'not_found');
  if (!input.includeTasks) return project;
  const tasks = await prisma.task.findMany({
    where: { projectId: input.projectId, archived: false },
    select: { id: true, identifier: true, title: true, status: true, priority: true, assigneeId: true, teamId: true },
    orderBy: [{ updatedAt: 'desc' }],
    take: 200,
  });
  return { ...project, tasks };
}

// ─── List Project Access ─────────────────────────────────────────────────────

export async function listProjectAccess(input: { projectId: string; userId: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'full');
  return prisma.projectAccess.findMany({
    where: { projectId: input.projectId },
    include: projectAccessInclude,
    orderBy: { grantedAt: 'asc' },
  });
}

// ─── Create Project (chat-tool simple version) ───────────────────────────────

export async function createProject(input: {
  userId: string;
  workspaceId?: string;
  key?: string;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
  createDefaultTeam?: boolean;
}) {
  let workspaceId = input.workspaceId;
  if (!workspaceId) {
    const workspace = await ensureDefaultWorkspaceForUser(input.userId);
    if (!workspace) throw new OwnershipError('user', input.userId, 'not_found');
    workspaceId = workspace.id;
  }
  await assertWorkspaceCanWrite(workspaceId, input.userId);

  const resolvedKey = input.key ?? await generateProjectKey(workspaceId, input.name);
  const createDefaultTeam = input.createDefaultTeam ?? true;

  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        workspaceId,
        key: resolvedKey,
        name: input.name,
        description: input.description ?? undefined,
        status: input.status ?? 'planned',
        color: input.color ?? undefined,
        icon: input.icon ?? undefined,
        leadId: input.leadId ?? undefined,
      },
    });

    await tx.projectAccess.upsert({
      where: { projectId_userId: { projectId: created.id, userId: input.userId } },
      update: { permission: 'full' },
      create: { projectId: created.id, userId: input.userId, permission: 'full' },
    });

    if (createDefaultTeam) {
      await tx.team.create({
        data: {
          projectId: created.id,
          name: `${input.name} Team`,
          key: teamKeyFromProjectKey(resolvedKey),
          members: { create: { userId: input.userId, role: 'owner' } },
        },
      });
    }

    await tx.label.createMany({
      data: [
        { name: 'Bug', color: '#ef4444', priority: 5, projectId: created.id },
        { name: 'Feature', color: '#3b82f6', priority: 4, projectId: created.id },
        { name: 'Frontend', color: '#8b5cf6', priority: 3, projectId: created.id },
        { name: 'Backend', color: '#22c55e', priority: 3, projectId: created.id },
        { name: 'Docs', color: '#eab308', priority: 2, projectId: created.id },
        { name: 'Urgent', color: '#f97316', priority: 6, projectId: created.id },
      ],
      skipDuplicates: true,
    });

    return tx.project.findUniqueOrThrow({ where: { id: created.id }, include: projectInclude });
  }, { timeout: 15000, maxWait: 5000 });

  await broadcastToProject(project.id, 'project:created', project);
  await logActivity({
    projectId: project.id,
    teamId: project.teams[0]?.id ?? null,
    userId: input.userId,
    action: 'project_created',
    payload: { name: project.name, key: project.key, source: 'chat' },
  });
  return project;
}

// ─── Create Project (full route version) ─────────────────────────────────────

export async function createProjectFull(input: {
  userId: string;
  isDesktopClient: boolean;
  workspaceId?: string;
  key?: string;
  teamIds?: string[];
  startDate?: string | null;
  targetDate?: string | null;
  repoUrl?: string | null;
  repositoryId?: string;
  defaultBranch?: string;
  localPath?: string | null;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
}): Promise<ProjectWithInclude> {
  const { userId, isDesktopClient, teamIds, startDate, targetDate, repoUrl, repositoryId, defaultBranch, localPath } = input;

  if (localPath && !isDesktopClient) {
    throw new HttpError(403, 'DESKTOP_REQUIRED', 'localPath can only be set from the desktop app');
  }

  if (teamIds?.length) {
    for (const tid of teamIds) {
      await assertTeamRole(tid, userId, ['owner', 'admin', 'member']);
    }
  }

  let resolvedWorkspaceId = input.workspaceId;
  if (!resolvedWorkspaceId) {
    const workspace = await ensureDefaultWorkspaceForUser(userId);
    if (!workspace) throw new OwnershipError('user', userId, 'not_found');
    resolvedWorkspaceId = workspace.id;
  }
  await assertWorkspaceCanWrite(resolvedWorkspaceId, userId);
  const resolvedKey = input.key ?? await generateProjectKey(resolvedWorkspaceId, input.name);

  let resolvedRepositoryId: string | undefined;
  let resolvedRepoUrl = repoUrl || undefined;

  if (repositoryId) {
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId, userId },
    });
    if (!repo) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found');
    resolvedRepositoryId = repo.id;
    resolvedRepoUrl = resolvedRepoUrl || `https://github.com/${repo.fullName}`;
    if (defaultBranch && defaultBranch !== repo.defaultBranch) {
      await prisma.repository.update({ where: { id: repo.id }, data: { defaultBranch } });
    }
  } else if (repoUrl) {
    if (isSshRepoUrl(repoUrl)) {
      try {
        const repo = await addRepositoryFromCloneUrl(userId, repoUrl, defaultBranch || 'main');
        resolvedRepositoryId = repo.id;
        resolvedRepoUrl = repoUrl;
      } catch (err) {
        throw new HttpError(400, 'REPOSITORY_CONNECT_FAILED', `Failed to connect repository: ${(err as Error).message}`);
      }
    } else {
      try {
        const repo = await addRepositoryByUrl(repoUrl);
        resolvedRepositoryId = repo.id;
        if (defaultBranch && defaultBranch !== repo.defaultBranch) {
          await prisma.repository.update({ where: { id: repo.id }, data: { defaultBranch } });
        }
      } catch (err) {
        throw new HttpError(400, 'REPOSITORY_CONNECT_FAILED', `Failed to connect repository: ${(err as Error).message}`);
      }
    }
  }

  const project = await prisma.project.create({
    data: {
      workspaceId: resolvedWorkspaceId,
      key: resolvedKey,
      name: input.name,
      description: input.description,
      status: input.status,
      color: input.color,
      icon: input.icon,
      leadId: input.leadId,
      startDate: startDate ? new Date(startDate) : undefined,
      targetDate: targetDate ? new Date(targetDate) : undefined,
      localPath: localPath || undefined,
      repoUrl: resolvedRepoUrl,
      repositoryId: resolvedRepositoryId,
    },
    include: projectInclude,
  });

  await prisma.label.createMany({
    data: [
      { name: 'Bug', color: '#ef4444', priority: 5, projectId: project.id },
      { name: 'Feature', color: '#3b82f6', priority: 4, projectId: project.id },
      { name: 'Frontend', color: '#8b5cf6', priority: 3, projectId: project.id },
      { name: 'Backend', color: '#22c55e', priority: 3, projectId: project.id },
      { name: 'Docs', color: '#eab308', priority: 2, projectId: project.id },
      { name: 'Urgent', color: '#f97316', priority: 6, projectId: project.id },
    ],
    skipDuplicates: true,
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
        where: { projectId_userId: { projectId: project.id, userId } },
        update: { permission: 'full' },
        create: { projectId: project.id, userId, permission: 'full' },
      });
      await broadcastToProject(project.id, 'project:created', updatedProject);
      return updatedProject;
    }
  }

  await prisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: project.id, userId } },
    update: { permission: 'full' },
    create: { projectId: project.id, userId, permission: 'full' },
  });

  await broadcastToProject(project.id, 'project:created', project);
  return project;
}

// ─── Update Project (chat-tool simple version) ───────────────────────────────

export async function updateProject(input: {
  userId: string;
  projectId: string;
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}) {
  const owned = await assertProjectAccess(input.projectId, input.userId, 'full');
  if (owned.source === 'legacy_team') {
    for (const teamId of owned.teamIds) {
      await assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member']);
    }
  }

  const data: Prisma.ProjectUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.status !== undefined) data.status = input.status;
  if (input.color !== undefined) data.color = input.color;
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.leadId !== undefined) data.lead = input.leadId ? { connect: { id: input.leadId } } : { disconnect: true };
  if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null;
  if (input.targetDate !== undefined) data.targetDate = input.targetDate ? new Date(input.targetDate) : null;

  const project = await prisma.project.update({ where: { id: input.projectId }, data, include: projectInclude });
  await broadcastToProject(input.projectId, 'project:updated', project);
  await logActivity({
    projectId: input.projectId,
    teamId: project.teams[0]?.id ?? owned.teamIds[0] ?? null,
    userId: input.userId,
    action: 'project_updated',
    payload: { fields: Object.keys(data), source: 'chat' },
  });
  return project;
}

// ─── Update Project (full route version) ─────────────────────────────────────

export async function updateProjectFull(input: {
  userId: string;
  projectId: string;
  isDesktopClient: boolean;
  bodyFields: string[];
  teamIds?: string[];
  startDate?: string | null;
  targetDate?: string | null;
  repoUrl?: string | null;
  localPath?: string | null;
  workspaceId?: string | null;
  key?: string | null;
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
}): Promise<ProjectWithInclude> {
  const { userId, projectId, isDesktopClient, teamIds, startDate, targetDate, repoUrl, localPath, workspaceId, key } = input;

  const owned = await assertProjectAccess(projectId, userId, 'full');
  if (owned.source === 'legacy_team') {
    for (const tid of owned.teamIds) {
      await assertTeamRole(tid, userId, ['owner', 'admin', 'member']);
    }
  }

  const existingProject = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, workspaceId: true, key: true },
  });
  if (!existingProject) throw new OwnershipError('project', projectId, 'not_found');

  if (teamIds !== undefined) {
    for (const tid of teamIds) {
      await assertTeamRole(tid, userId, ['owner', 'admin', 'member']);
    }
  }

  let nextWorkspaceId = existingProject.workspaceId;
  if (workspaceId !== undefined) {
    if (workspaceId) {
      await assertWorkspaceCanWrite(workspaceId, userId);
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
      where: { workspaceId: nextWorkspaceId, key: existingProject.key, NOT: { id: projectId } },
      select: { id: true },
    });
    if (keyConflict) {
      nextKey = await generateProjectKey(nextWorkspaceId, input.name ?? existingProject.name, projectId);
    }
  } else if (workspaceChanged && !existingProject.key) {
    nextKey = await generateProjectKey(nextWorkspaceId, input.name ?? existingProject.name, projectId);
  }

  if (localPath !== undefined && !isDesktopClient) {
    throw new HttpError(403, 'DESKTOP_REQUIRED', 'localPath can only be updated from the desktop app');
  }

  const dateFields: Record<string, Date | null | undefined> = {};
  if (startDate !== undefined) dateFields.startDate = startDate ? new Date(startDate) : null;
  if (targetDate !== undefined) dateFields.targetDate = targetDate ? new Date(targetDate) : null;

  let repositoryId: string | null | undefined;
  if (repoUrl !== undefined) {
    if (repoUrl) {
      try {
        const repo = await addRepositoryByUrl(repoUrl);
        repositoryId = repo.id;
      } catch (err) {
        throw new HttpError(400, 'REPOSITORY_CONNECT_FAILED', `Failed to connect repository: ${(err as Error).message}`);
      }
    } else {
      repositoryId = null;
    }
  }

  const updateData: Record<string, unknown> = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.color !== undefined) updateData.color = input.color;
  if (input.icon !== undefined) updateData.icon = input.icon;
  if (input.leadId !== undefined) updateData.leadId = input.leadId;

  const project = await prisma.$transaction(async (tx) => {
    if (teamIds !== undefined) {
      await tx.team.updateMany({ where: { projectId }, data: { projectId } });
      if (teamIds.length > 0) {
        const conflicting = await tx.team.findMany({
          where: { id: { in: teamIds }, projectId: { not: projectId } },
          select: { id: true },
        });
        if (conflicting.length > 0) {
          throw new HttpError(409, 'TEAM_PROJECT_CONFLICT', 'One or more teams already belong to a different project');
        }
        await tx.team.updateMany({
          where: { id: { in: teamIds } },
          data: { projectId },
        });
      }
    }
    if (workspaceChanged) {
      await tx.projectAccess.deleteMany({ where: { projectId } });
    }
    return tx.project.update({
      where: { id: projectId },
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

  await broadcastToProject(projectId, 'project:updated', project);

  const broadcastTeamIds = project.teams.map((t) => t.id);
  const activityTeamIds = broadcastTeamIds.length > 0 ? broadcastTeamIds : owned.teamIds;
  for (const tid of activityTeamIds) {
    await logActivity({
      projectId,
      teamId: tid,
      userId,
      action: 'project_updated',
      payload: { fields: input.bodyFields },
    });
  }

  return project;
}

// ─── Delete Project ──────────────────────────────────────────────────────────

export async function deleteProject(input: { projectId: string; userId: string }): Promise<void> {
  const { projectId, userId } = input;

  const owned = await assertProjectAccess(projectId, userId, 'full');
  if (owned.source === 'legacy_team') {
    for (const tid of owned.teamIds) {
      await assertTeamRole(tid, userId, ['owner', 'admin']);
    }
  }

  const recipients = await prisma.project.findUnique({
    where: { id: projectId },
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
    await tx.task.updateMany({ where: { projectId }, data: { projectId: null } });
    await tx.project.delete({ where: { id: projectId } });
  }, { timeout: 15000, maxWait: 5000 });

  const payload = { id: projectId };
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
    broadcastToUser(userId, 'project:deleted', payload);
  }
}

// ─── Grant Project Access (single) ──────────────────────────────────────────

export async function grantProjectAccess(input: {
  projectId: string;
  actorUserId: string;
  userId: string;
  permission: ProjectPermission;
}): Promise<{ access: Prisma.ProjectAccessGetPayload<{ include: typeof projectAccessInclude }>; isNew: boolean }> {
  await assertProjectAccess(input.projectId, input.actorUserId, 'full');

  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (!project) throw new OwnershipError('project', input.projectId, 'not_found');

  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
  if (!user) throw new OwnershipError('user', input.userId, 'not_found');

  if (project.workspaceId) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: project.workspaceId, userId: input.userId } },
      select: { id: true },
    });
    if (!member) {
      throw new HttpError(400, 'USER_NOT_WORKSPACE_MEMBER', 'Project access can only be granted to workspace members');
    }
  }

  const existing = await prisma.projectAccess.findUnique({
    where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
    select: { id: true },
  });

  const access = await prisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
    update: { permission: input.permission },
    create: { projectId: input.projectId, userId: input.userId, permission: input.permission },
    include: projectAccessInclude,
  });

  await broadcastToProject(input.projectId, 'project:access-changed', { projectId: input.projectId, access });
  return { access, isNew: !existing };
}

// ─── Grant Project Access (bulk) ─────────────────────────────────────────────

export async function grantProjectAccessBulk(input: {
  projectId: string;
  actorUserId: string;
  grants: Array<{ userId: string; permission: ProjectPermission }>;
}): Promise<{
  granted: Prisma.ProjectAccessGetPayload<{ include: typeof projectAccessInclude }>[];
  skipped: Array<{ userId: string; reason: string }>;
}> {
  await assertProjectAccess(input.projectId, input.actorUserId, 'full');

  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (!project) throw new OwnershipError('project', input.projectId, 'not_found');

  const grantsByUser = new Map<string, { userId: string; permission: ProjectPermission }>();
  for (const grant of input.grants) {
    grantsByUser.set(grant.userId, grant);
  }
  const grants = Array.from(grantsByUser.values());
  const userIds = grants.map((g) => g.userId);

  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
  const foundUserIds = new Set(users.map((u) => u.id));
  const skipped: Array<{ userId: string; reason: string }> = grants
    .filter((g) => !foundUserIds.has(g.userId))
    .map((g) => ({ userId: g.userId, reason: 'USER_NOT_FOUND' }));

  let allowedUserIds = foundUserIds;
  if (project.workspaceId) {
    const memberships = await prisma.workspaceMember.findMany({
      where: { workspaceId: project.workspaceId, userId: { in: Array.from(foundUserIds) } },
      select: { userId: true },
    });
    allowedUserIds = new Set(memberships.map((m) => m.userId));
    for (const uid of foundUserIds) {
      if (!allowedUserIds.has(uid)) {
        skipped.push({ userId: uid, reason: 'USER_NOT_WORKSPACE_MEMBER' });
      }
    }
  }

  const grantable = grants.filter((g) => allowedUserIds.has(g.userId));
  const granted = await prisma.$transaction(
    grantable.map((g) =>
      prisma.projectAccess.upsert({
        where: { projectId_userId: { projectId: input.projectId, userId: g.userId } },
        update: { permission: g.permission },
        create: { projectId: input.projectId, userId: g.userId, permission: g.permission },
        include: projectAccessInclude,
      }),
    ),
  );

  await broadcastToProject(input.projectId, 'project:access-changed', {
    projectId: input.projectId,
    access: granted,
    skipped,
  });

  return { granted, skipped };
}

// ─── Revoke Project Access (deny) ────────────────────────────────────────────

export async function revokeProjectAccess(input: {
  projectId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  await assertProjectAccess(input.projectId, input.actorUserId, 'full');

  await prisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: input.projectId, userId: input.targetUserId } },
    update: { permission: 'deny' },
    create: { projectId: input.projectId, userId: input.targetUserId, permission: 'deny' },
  });

  const payload = { projectId: input.projectId, userId: input.targetUserId, permission: 'deny' };
  await broadcastToProject(input.projectId, 'project:access-changed', payload);
  broadcastToUser(input.targetUserId, 'project:access-changed', payload);
}
