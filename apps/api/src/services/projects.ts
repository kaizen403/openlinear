import { prisma, type Prisma, type ProjectPermission, type ProjectStatus } from '@openlinear/db';
import { HttpError } from '../errors';
import { broadcastToProject, broadcastToUser } from '../sse';
import { logActivity } from './activity';
import { getUserTeamIds } from './team-scope';
import { assertProjectAccess, assertTeamRole, OwnershipError } from './ownership';
import {
  buildProjectAccessWhere,
  ensureDefaultWorkspaceForUser,
  generateProjectKey,
  assertWorkspaceRole,
} from './workspaces';

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;
const projectInclude = {
  teams: true,
  repository: {
    select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
  },
  workspace: {
    select: { id: true, name: true, slug: true, plan: true },
  },
  _count: { select: { tasks: true } },
} satisfies Prisma.ProjectInclude;
const projectAccessInclude = { user: { select: userSelect } } satisfies Prisma.ProjectAccessInclude;

function teamKeyFromProjectKey(key: string | null): string {
  const cleaned = (key ?? 'TEAM').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10);
  return cleaned || 'TEAM';
}

async function assertWorkspaceCanWrite(workspaceId: string, userId: string): Promise<void> {
  await assertWorkspaceRole(workspaceId, userId, ['owner', 'admin', 'member']);
}

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

export async function listProjectAccess(input: { projectId: string; userId: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'full');
  return prisma.projectAccess.findMany({
    where: { projectId: input.projectId },
    include: projectAccessInclude,
    orderBy: { grantedAt: 'asc' },
  });
}

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

export async function grantProjectAccess(input: {
  projectId: string;
  actorUserId: string;
  userId: string;
  permission: ProjectPermission;
}) {
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

  const access = await prisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
    update: { permission: input.permission },
    create: { projectId: input.projectId, userId: input.userId, permission: input.permission },
    include: projectAccessInclude,
  });
  await broadcastToProject(input.projectId, 'project:access-changed', { projectId: input.projectId, access });
  broadcastToUser(input.userId, 'project:access-changed', { projectId: input.projectId, access });
  return access;
}
