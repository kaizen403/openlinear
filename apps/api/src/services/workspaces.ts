import crypto from 'node:crypto';
import { Prisma, prisma } from '@openlinear/db';
import { getUserTeamIds } from './team-scope';

export type ProjectPermissionLevel = 'view' | 'full';
export type ProjectAccessSource = 'project_access' | 'workspace' | 'legacy_team';

export interface ProjectAccessResolution {
  id: string;
  workspaceId: string | null;
  teamIds: string[];
  permission: ProjectPermissionLevel;
  source: ProjectAccessSource;
}

export type ProjectAccessFailure =
  | { reason: 'not_found' }
  | { reason: 'forbidden'; id: string; workspaceId: string | null; teamIds: string[] };

export function permissionRank(permission: ProjectPermissionLevel): number {
  return permission === 'full' ? 2 : 1;
}

export function permissionAllows(
  actual: ProjectPermissionLevel,
  required: ProjectPermissionLevel,
): boolean {
  return permissionRank(actual) >= permissionRank(required);
}

function digest(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

function projectKeyBase(name: string): string {
  const clean = name.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (!clean) return 'PRJ';
  if (clean.length === 1) return `${clean}X`;
  return clean.slice(0, 4);
}

export function defaultWorkspaceIdForUser(userId: string): string {
  return `workspace-${digest(userId)}`;
}

export async function ensureDefaultWorkspaceForUser(userId: string) {
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
  });
  if (existing) return existing.workspace;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  if (!user) return null;

  const baseSlug = slugify(user.username || 'workspace');
  const workspaceId = defaultWorkspaceIdForUser(user.id);
  const workspace = await prisma.workspace.upsert({
    where: { id: workspaceId },
    update: {},
    create: {
      id: workspaceId,
      name: `${user.username || 'User'}'s Workspace`,
      slug: `${baseSlug}-${digest(user.id).slice(0, 8)}`,
    },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId,
      role: 'owner',
      joinedAt: new Date(),
    },
  });

  return workspace;
}

export async function generateProjectKey(
  workspaceId: string | null,
  name: string,
  excludeProjectId?: string,
): Promise<string> {
  const base = projectKeyBase(name);
  let candidate = base;
  let suffix = 1;

  while (true) {
    const existing = await prisma.project.findFirst({
      where: {
        workspaceId,
        key: candidate,
        ...(excludeProjectId ? { NOT: { id: excludeProjectId } } : {}),
      },
      select: { id: true },
    });

    if (!existing) return candidate;

    suffix += 1;
    candidate = `${base.slice(0, Math.max(1, 4 - String(suffix).length))}${suffix}`;
  }
}

function permissionFromWorkspaceRole(role: string): ProjectPermissionLevel {
  return role === 'viewer' ? 'view' : 'full';
}

export function buildProjectAccessWhere(userId: string, teamIds: string[] = []): Prisma.ProjectWhereInput {
  return {
    NOT: { access: { some: { userId, permission: 'deny' } } },
    OR: [
      { workspace: { members: { some: { userId } } } },
      {
        workspaceId: null,
        access: { some: { userId, permission: { in: ['full', 'view'] } } },
      },
      ...(teamIds.length > 0
        ? [{ projectTeams: { some: { teamId: { in: teamIds } } } }]
        : []),
    ],
  };
}

export function buildProjectFullAccessWhere(userId: string, teamIds: string[] = []): Prisma.ProjectWhereInput {
  const legacyTeamAccessWhere: Prisma.ProjectWhereInput[] = teamIds.length > 0
    ? [
        {
          projectTeams: { some: { teamId: { in: teamIds } } },
          NOT: { workspace: { members: { some: { userId } } } },
          OR: [
            { workspaceId: { not: null } },
            { NOT: { access: { some: { userId, permission: 'view' } } } },
          ],
        },
      ]
    : [];

  return {
    NOT: { access: { some: { userId, permission: 'deny' } } },
    OR: [
      {
        workspaceId: { not: null },
        workspace: { members: { some: { userId } } },
        access: { some: { userId, permission: 'full' } },
      },
      {
        workspaceId: { not: null },
        workspace: {
          members: {
            some: {
              userId,
              role: { in: ['owner', 'admin', 'member'] },
            },
          },
        },
        NOT: { access: { some: { userId, permission: 'view' } } },
      },
      {
        workspaceId: null,
        access: { some: { userId, permission: 'full' } },
      },
      ...legacyTeamAccessWhere,
    ],
  };
}

export async function resolveProjectAccess(
  projectId: string,
  userId: string,
): Promise<ProjectAccessResolution | ProjectAccessFailure> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      workspaceId: true,
      access: {
        where: { userId },
        select: { permission: true },
        take: 1,
      },
      workspace: {
        select: {
          members: {
            where: { userId },
            select: { role: true },
            take: 1,
          },
        },
      },
      projectTeams: {
        select: { teamId: true },
      },
    },
  });

  if (!project) {
    return { reason: 'not_found' };
  }

  const teamIds = project.projectTeams.map((pt) => pt.teamId);
  const explicit = project.access[0]?.permission;
  if (explicit === 'deny') {
    return { reason: 'forbidden', id: project.id, workspaceId: project.workspaceId, teamIds };
  }

  const workspaceRole = project.workspace?.members[0]?.role;
  if (project.workspaceId && workspaceRole) {
    if (explicit === 'full' || explicit === 'view') {
      return {
        id: project.id,
        workspaceId: project.workspaceId,
        teamIds,
        permission: explicit,
        source: 'project_access',
      };
    }

    return {
      id: project.id,
      workspaceId: project.workspaceId,
      teamIds,
      permission: permissionFromWorkspaceRole(workspaceRole),
      source: 'workspace',
    };
  }
  if (!project.workspaceId && (explicit === 'full' || explicit === 'view')) {
    return {
      id: project.id,
      workspaceId: project.workspaceId,
      teamIds,
      permission: explicit,
      source: 'project_access',
    };
  }

  if (teamIds.length > 0) {
    const userTeamIds = await getUserTeamIds(userId);
    const hasLegacyTeamAccess = teamIds.some((teamId) => userTeamIds.includes(teamId));
    if (hasLegacyTeamAccess) {
      return {
        id: project.id,
        workspaceId: project.workspaceId,
        teamIds,
        permission: 'full',
        source: 'legacy_team',
      };
    }
  }

  return { reason: 'forbidden', id: project.id, workspaceId: project.workspaceId, teamIds };
}
