import crypto from 'node:crypto';
import { Prisma, prisma, type WorkspaceRole } from '@openlinear/db';
import { broadcastToWorkspace } from '../sse';
import { getUserTeamIds } from './team-scope';
import { OwnershipError } from './ownership';

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

export async function assertWorkspaceRole(
  workspaceId: string,
  userId: string,
  roles: ReadonlyArray<WorkspaceRole>,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });

  if (!membership) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }

  if (!roles.includes(membership.role)) {
    throw new OwnershipError('workspace', workspaceId, 'role_required', roles);
  }

  return { workspaceId, userId, role: membership.role };
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
        ? [{ teams: { some: { id: { in: teamIds } } } }]
        : []),
    ],
  };
}

export function buildProjectFullAccessWhere(userId: string, teamIds: string[] = []): Prisma.ProjectWhereInput {
  const legacyTeamAccessWhere: Prisma.ProjectWhereInput[] = teamIds.length > 0
    ? [
        {
          teams: { some: { id: { in: teamIds } } },
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
      teams: {
        select: { id: true },
      },
    },
  });

  if (!project) {
    return { reason: 'not_found' };
  }

  const teamIds = project.teams.map((t) => t.id);
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

const workspaceDetailInclude = {
  _count: { select: { members: true, projects: true } },
  projects: {
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      status: true,
      color: true,
      icon: true,
      updatedAt: true,
      _count: { select: { tasks: true } },
    },
    orderBy: { updatedAt: 'desc' },
  },
} satisfies Prisma.WorkspaceInclude;

export async function listWorkspacesForUser(userId: string) {
  await ensureDefaultWorkspaceForUser(userId);
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: {
      workspace: {
        include: {
          _count: { select: { members: true, projects: true } },
        },
      },
    },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
  });

  return memberships.map(({ workspace, role, invitedAt, joinedAt }) => ({
    ...workspace,
    role,
    invitedAt,
    joinedAt,
  }));
}

export async function getWorkspaceForUser(workspaceId: string, userId: string) {
  const membership = await assertWorkspaceRole(workspaceId, userId, ['owner', 'admin', 'member', 'viewer']);
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: workspaceDetailInclude,
  });
  if (!workspace) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }
  return { ...workspace, currentMember: membership };
}

export async function updateWorkspace(input: {
  workspaceId: string;
  userId: string;
  name?: string;
}) {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin']);
  const data: Prisma.WorkspaceUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;

  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data,
  });

  const workspace = await getWorkspaceForUser(input.workspaceId, input.userId);
  broadcastToWorkspace(input.workspaceId, 'workspace:updated', workspace);
  return workspace;
}

// ─── Route-facing functions ──────────────────────────────────────────────────

import { HttpError } from '../errors';
import { broadcastToUser } from '../sse';
import { userSelect } from '../lib/selects';

const memberInclude = { user: { select: userSelect } } as const;

const workspaceStructureInclude = {
  _count: { select: { members: true, projects: true } },
  members: {
    include: memberInclude,
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
  },
  projects: {
    include: {
      repository: {
        select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
      },
      teams: {
        include: {
          members: {
            include: memberInclude,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          },
          _count: { select: { members: true, tasks: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      _count: { select: { tasks: true } },
    },
    orderBy: { updatedAt: 'desc' },
  },
} satisfies Prisma.WorkspaceInclude;

type WorkspaceMemberWithUser = Prisma.WorkspaceMemberGetPayload<{ include: typeof memberInclude }>;

async function loadWorkspaceDetail(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true, role: true, invitedAt: true, joinedAt: true },
  });
  if (!membership) throw new OwnershipError('workspace', workspaceId, 'not_found');

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: workspaceDetailInclude,
  });
  if (!workspace) throw new OwnershipError('workspace', workspaceId, 'not_found');
  return { ...workspace, currentMember: membership };
}

async function ensureNotLastOwner(workspaceId: string, userId: string, nextRole?: WorkspaceRole): Promise<void> {
  const current = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!current) throw new OwnershipError('workspace', workspaceId, 'not_found');
  if (current.role !== 'owner') return;
  if (nextRole === 'owner') return;

  const ownerCount = await prisma.workspaceMember.count({ where: { workspaceId, role: 'owner' } });
  if (ownerCount <= 1) {
    throw new HttpError(409, 'LAST_OWNER', 'Cannot remove or demote the last workspace owner', { workspaceId, userId });
  }
}

export async function createWorkspaceRoute(input: { userId: string; name: string }) {
  const trimmed = input.name;
  const baseSlug = slugify(trimmed);
  let slug = baseSlug;
  let suffix = 1;

  while (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } })) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  const workspace = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace.create({ data: { name: trimmed, slug } });
    await tx.workspaceMember.create({
      data: { workspaceId: created.id, userId: input.userId, role: 'owner', joinedAt: new Date() },
    });
    return created;
  });

  const detail = await loadWorkspaceDetail(workspace.id, input.userId);
  broadcastToUser(input.userId, 'workspace:joined', detail);
  return detail;
}

export async function getWorkspaceStructure(input: { workspaceId: string; userId: string }) {
  const currentMember = await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin', 'member', 'viewer']);
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    include: workspaceStructureInclude,
  });
  if (!workspace) throw new OwnershipError('workspace', input.workspaceId, 'not_found');
  return {
    ...workspace,
    role: currentMember.role,
    currentMember: workspace.members.find((m) => m.userId === input.userId) ?? null,
  };
}

export async function listWorkspaceMembers(input: {
  workspaceId: string;
  userId: string;
  limit: number;
  cursor?: string;
}) {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin', 'member', 'viewer']);
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: input.workspaceId },
    include: memberInclude,
    orderBy: [{ id: 'asc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = members.slice(0, input.limit);
  return { data: page, nextCursor: members.length > input.limit ? page.at(-1)?.id ?? null : null };
}

export async function addWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  username: string;
  role: 'admin' | 'member' | 'viewer';
}): Promise<{ member: WorkspaceMemberWithUser; isNew: boolean }> {
  await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner', 'admin']);
  const user = await prisma.user.findUnique({ where: { username: input.username }, select: userSelect });
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found', { username: input.username });

  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
    include: memberInclude,
  });
  if (existing) return { member: existing, isNew: false };

  const member = await prisma.workspaceMember.create({
    data: { workspaceId: input.workspaceId, userId: user.id, role: input.role, joinedAt: new Date() },
    include: memberInclude,
  });
  const workspace = await loadWorkspaceDetail(input.workspaceId, user.id);
  broadcastToUser(user.id, 'workspace:joined', workspace);
  broadcastToWorkspace(input.workspaceId, 'workspace:member-added', member);
  return { member, isNew: true };
}

export async function bulkAddWorkspaceMembers(input: {
  workspaceId: string;
  actorUserId: string;
  invites: Array<{ username: string; role: WorkspaceRole }>;
}) {
  const caller = await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner', 'admin']);
  if (caller.role !== 'owner' && input.invites.some((i) => i.role === 'owner')) {
    throw new OwnershipError('workspace', input.workspaceId, 'role_required', ['owner']);
  }

  const usernames = [...new Set(input.invites.map((i) => i.username))];
  const users = await prisma.user.findMany({ where: { username: { in: usernames } }, select: userSelect });
  const usersByUsername = new Map(users.map((u) => [u.username, u]));
  const added: WorkspaceMemberWithUser[] = [];
  const skipped: Array<{ username: string; reason: string }> = [];

  await prisma.$transaction(async (tx) => {
    for (const invite of input.invites) {
      const user = usersByUsername.get(invite.username);
      if (!user) { skipped.push({ username: invite.username, reason: 'USER_NOT_FOUND' }); continue; }
      const existing = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
        include: memberInclude,
      });
      if (existing) { skipped.push({ username: invite.username, reason: 'ALREADY_MEMBER' }); continue; }
      const member = await tx.workspaceMember.create({
        data: { workspaceId: input.workspaceId, userId: user.id, role: invite.role, joinedAt: new Date() },
        include: memberInclude,
      });
      added.push(member);
    }
  });

  for (const member of added) {
    const workspace = await loadWorkspaceDetail(input.workspaceId, member.userId);
    broadcastToUser(member.userId, 'workspace:joined', workspace);
    broadcastToWorkspace(input.workspaceId, 'workspace:member-added', member);
  }
  return { added, skipped };
}

export async function updateWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceRole;
}) {
  await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner']);
  await ensureNotLastOwner(input.workspaceId, input.targetUserId, input.role);

  const member = await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
    data: { role: input.role },
    include: memberInclude,
  });
  broadcastToWorkspace(input.workspaceId, 'workspace:member-updated', member);
  return member;
}

export async function removeWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  if (input.targetUserId !== input.actorUserId) {
    await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner']);
  } else {
    await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner', 'admin', 'member', 'viewer']);
  }
  await ensureNotLastOwner(input.workspaceId, input.targetUserId);

  await prisma.$transaction(async (tx) => {
    await tx.projectAccess.deleteMany({ where: { userId: input.targetUserId, project: { workspaceId: input.workspaceId } } });
    await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } } });
  });

  broadcastToUser(input.targetUserId, 'workspace:left', { workspaceId: input.workspaceId });
  broadcastToWorkspace(input.workspaceId, 'workspace:member-removed', { userId: input.targetUserId });
}

export async function deleteWorkspaceRoute(input: { workspaceId: string; userId: string }): Promise<void> {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner']);
  const projectCount = await prisma.project.count({ where: { workspaceId: input.workspaceId } });
  if (projectCount > 0) {
    throw new HttpError(409, 'WORKSPACE_HAS_PROJECTS', 'Cannot delete workspace with projects', { projectCount });
  }

  await prisma.$transaction(async (tx) => {
    await tx.workspaceMember.deleteMany({ where: { workspaceId: input.workspaceId } });
    await tx.workspace.delete({ where: { id: input.workspaceId } });
  });

  broadcastToWorkspace(input.workspaceId, 'workspace:deleted', { id: input.workspaceId });
}

export async function updateWorkspaceRoute(input: {
  workspaceId: string;
  userId: string;
  data: Record<string, unknown>;
}) {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin']);
  if (Object.keys(input.data).length === 0) {
    throw new HttpError(400, 'NO_VALID_FIELDS', 'No valid fields to update');
  }

  await prisma.workspace.update({ where: { id: input.workspaceId }, data: input.data });
  const detail = await loadWorkspaceDetail(input.workspaceId, input.userId);
  broadcastToWorkspace(input.workspaceId, 'workspace:updated', detail);
  return detail;
}
