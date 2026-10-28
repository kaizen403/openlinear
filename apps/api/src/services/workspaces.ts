import crypto from 'node:crypto';
import { Prisma, prisma, type WorkspaceRole } from '@openlinear/db';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, userTarget, workspaceTarget } from '../events/targets';
import { runCommand, runCommandWithStatus, type IdempotentCommand } from './idempotency';
import { OwnershipError, assertPrincipalMayEnterWorkspace, assertPrincipalWorkspace } from './ownership';
import { projectAccessWhere } from '../tenancy/scopes';
import { invalidateTenancyCache, workspaceRestrictionFor } from '../tenancy/context';

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
  // A workspace-bound PAT is refused before membership is consulted, so it
  // cannot probe which other workspaces its owner belongs to.
  assertPrincipalWorkspace(userId, workspaceId, 'workspace', workspaceId);

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
  // A workspace-bound PAT resolves to its own workspace and never creates one.
  const restriction = workspaceRestrictionFor(userId);
  if (restriction) {
    const bound = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: restriction, userId } },
      include: { workspace: true },
    });
    return bound?.workspace ?? null;
  }

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
  return role === 'owner' || role === 'admin' ? 'full' : 'view';
}

export function buildProjectAccessWhere(userId: string, teamIds: string[] = []): Prisma.ProjectWhereInput {
  return projectAccessWhere(userId, teamIds, 'view');
}

export function buildProjectFullAccessWhere(userId: string, teamIds: string[] = []): Prisma.ProjectWhereInput {
  return projectAccessWhere(userId, teamIds, 'full');
}

interface ProjectAccessRow {
  id: string;
  workspaceId: string | null;
  explicit: 'full' | 'view' | 'deny' | null;
  workspaceRole: WorkspaceRole | null;
  teamIds: string[];
  legacyTeamMember: boolean;
}

/**
 * Facts for one project access decision, read live on every call (no
 * caching: a revoked membership or a new deny takes effect on the next
 * request, on every replica).
 *
 * One statement (P95 Phase 1, perf1). The nested Prisma select it replaces
 * ran as five statements (project, grant, workspace, membership, teams) plus
 * a sixth `team_members` read (`getUserTeamIds`) for legacy team access. The
 * legacy check keeps `getUserTeamIds`' workspace binding: a bound principal
 * only counts teams whose project is in its workspace, which for this
 * project's own teams means `project.workspaceId = restriction`.
 */
async function loadProjectAccessRow(projectId: string, userId: string): Promise<ProjectAccessRow | null> {
  const restriction = workspaceRestrictionFor(userId);
  const legacyBinding = restriction ? Prisma.sql`AND p."workspaceId" = ${restriction}` : Prisma.empty;
  const rows = await prisma.$queryRaw<ProjectAccessRow[]>(Prisma.sql`
    SELECT p."id",
           p."workspaceId" AS "workspaceId",
           (SELECT pa."permission"::text FROM "project_access" pa
             WHERE pa."projectId" = p."id" AND pa."userId" = ${userId} LIMIT 1) AS "explicit",
           (SELECT wm."role"::text FROM "workspace_members" wm
             WHERE wm."workspaceId" = p."workspaceId" AND wm."userId" = ${userId} LIMIT 1) AS "workspaceRole",
           ARRAY(SELECT t."id" FROM "teams" t WHERE t."project_id" = p."id"
                  ORDER BY t."createdAt" ASC, t."id" ASC) AS "teamIds",
           EXISTS (SELECT 1 FROM "team_members" tm JOIN "teams" mt ON mt."id" = tm."teamId"
                    WHERE mt."project_id" = p."id" AND tm."userId" = ${userId} ${legacyBinding}) AS "legacyTeamMember"
      FROM "linear_projects" p
     WHERE p."id" = ${projectId}
  `);
  return rows[0] ?? null;
}

export async function resolveProjectAccess(
  projectId: string,
  userId: string,
): Promise<ProjectAccessResolution | ProjectAccessFailure> {
  const project = await loadProjectAccessRow(projectId, userId);

  if (!project) {
    return { reason: 'not_found' };
  }

  const teamIds = project.teamIds;
  const explicit = project.explicit;
  if (explicit === 'deny') {
    return { reason: 'forbidden', id: project.id, workspaceId: project.workspaceId, teamIds };
  }

  const workspaceRole = project.workspaceRole;
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

  if (teamIds.length > 0 && project.legacyTeamMember) {
    return {
      id: project.id,
      workspaceId: project.workspaceId,
      teamIds,
      permission: 'full',
      source: 'legacy_team',
    };
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

/**
 * The caller's workspaces. A user with no membership at all gets a default
 * workspace first (never a workspace-bound PAT). The membership list is read
 * first and the default is only ensured when it comes back empty, which is
 * the same outcome as ensuring up front (ensuring is a no-op for anyone with
 * a membership) without its two extra statements on every call (perf1).
 */
export async function listWorkspacesForUser(userId: string) {
  const restriction = workspaceRestrictionFor(userId);
  const loadMemberships = () => prisma.workspaceMember.findMany({
    where: { userId, ...(restriction ? { workspaceId: restriction } : {}) },
    include: {
      workspace: {
        include: {
          _count: { select: { members: true, projects: true } },
        },
      },
    },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
  });
  let memberships = await loadMemberships();
  if (memberships.length === 0 && !restriction) {
    await ensureDefaultWorkspaceForUser(userId);
    memberships = await loadMemberships();
  }

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
  const membership = await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin']);
  const data: Prisma.WorkspaceUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;

  // W04b: `workspace:updated` commits with the update. Same payload as
  // before (`getWorkspaceForUser`: the workspace + the caller's membership).
  return transactionWithEvents(async (tx) => {
    const updated = await tx.workspace.update({
      where: { id: input.workspaceId },
      data,
      include: workspaceDetailInclude,
    });
    const workspace = { ...updated, currentMember: membership };
    await appendToTarget(tx, workspaceTarget(input.workspaceId), 'workspace:updated', workspace, input.userId);
    return workspace;
  });
}

// ─── Route-facing functions ──────────────────────────────────────────────────

import { HttpError } from '../errors';
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

type WorkspaceDb = Prisma.TransactionClient | typeof prisma;

async function loadWorkspaceDetail(workspaceId: string, userId: string, db: WorkspaceDb = prisma) {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true, role: true, invitedAt: true, joinedAt: true },
  });
  if (!membership) throw new OwnershipError('workspace', workspaceId, 'not_found');

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    include: workspaceDetailInclude,
  });
  if (!workspace) throw new OwnershipError('workspace', workspaceId, 'not_found');
  return { ...workspace, currentMember: membership };
}

type WorkspaceDetail = Awaited<ReturnType<typeof loadWorkspaceDetail>>;

/** `workspace:joined` to the new member and `workspace:member-added` to the workspace. */
async function appendMemberJoined(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  member: WorkspaceMemberWithUser,
  actorUserId: string,
): Promise<void> {
  const detail = await loadWorkspaceDetail(workspaceId, member.userId, tx);
  await appendToTarget(tx, userTarget(member.userId), 'workspace:joined', detail, actorUserId);
  await appendToTarget(tx, workspaceTarget(workspaceId), 'workspace:member-added', member, actorUserId);
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

/**
 * POST /api/workspaces as a command (W04b). A new workspace has no owning
 * workspace yet, so the idempotency scope uses the empty workspace
 * partition. The workspace, the owner membership and `workspace:joined`
 * commit together.
 */
export async function authorizeCreateWorkspace(input: { userId: string; name: string }): Promise<IdempotentCommand<string, WorkspaceDetail>> {
  assertPrincipalMayEnterWorkspace(input.userId, null);
  return {
    resolveWorkspaceId: async () => null,
    prepare: async () => {
      const baseSlug = slugify(input.name);
      let slug = baseSlug;
      let suffix = 1;
      while (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } })) {
        suffix += 1;
        slug = `${baseSlug}-${suffix}`;
      }
      return slug;
    },
    mutate: async (tx, slug) => {
      const created = await tx.workspace.create({ data: { name: input.name, slug } });
      await tx.workspaceMember.create({
        data: { workspaceId: created.id, userId: input.userId, role: 'owner', joinedAt: new Date() },
      });
      const detail = await loadWorkspaceDetail(created.id, input.userId, tx);
      await appendToTarget(tx, userTarget(input.userId), 'workspace:joined', detail, input.userId);
      return {
        status: 201,
        body: detail,
        afterCommit: async () => { invalidateTenancyCache(input.userId); },
      };
    },
  };
}

export async function createWorkspaceRoute(input: { userId: string; name: string }): Promise<WorkspaceDetail> {
  return runCommand(await authorizeCreateWorkspace(input));
}

export const WORKSPACE_STRUCTURE_VIEWS = ['full', 'summary'] as const;
export type WorkspaceStructureView = (typeof WORKSPACE_STRUCTURE_VIEWS)[number];

/**
 * `view=summary` (perf1): the workspace → projects → teams tree with counts
 * instead of member lists. Every team's members (with user rows) and the
 * workspace member list dominate the full payload (743 KB of 761 KB on the
 * 50k-task bench); the summary carries `_count.members` on the workspace and
 * on each team, and the caller's own membership as `currentMember`. Member
 * lists stay available, paginated, from GET /api/workspaces/:id/members.
 */
const workspaceStructureSummaryInclude = {
  _count: { select: { members: true, projects: true } },
  projects: {
    select: {
      id: true,
      workspaceId: true,
      key: true,
      name: true,
      status: true,
      color: true,
      icon: true,
      updatedAt: true,
      teams: {
        select: {
          id: true,
          name: true,
          key: true,
          color: true,
          projectId: true,
          _count: { select: { members: true, tasks: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      _count: { select: { tasks: true } },
    },
    orderBy: { updatedAt: 'desc' },
  },
} satisfies Prisma.WorkspaceInclude;

async function getWorkspaceStructureSummary(input: { workspaceId: string; userId: string }, role: WorkspaceRole) {
  const [workspace, currentMember] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      include: workspaceStructureSummaryInclude,
    }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
      include: memberInclude,
    }),
  ]);
  if (!workspace) throw new OwnershipError('workspace', input.workspaceId, 'not_found');
  return { ...workspace, view: 'summary' as const, role, currentMember };
}

export async function getWorkspaceStructure(input: {
  workspaceId: string;
  userId: string;
  view?: WorkspaceStructureView;
}) {
  const currentMember = await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin', 'member', 'viewer']);
  if (input.view === 'summary') {
    return getWorkspaceStructureSummary(input, currentMember.role);
  }
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

/**
 * POST /api/workspaces/:id/members as a command (W04b). 201 for a new
 * member (membership + `workspace:joined` + `workspace:member-added` commit
 * together), 200 with the existing row and no event otherwise.
 */
export async function authorizeAddWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  username: string;
  role: 'admin' | 'member' | 'viewer';
}): Promise<IdempotentCommand<{ id: string }, WorkspaceMemberWithUser>> {
  await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner', 'admin']);
  return {
    resolveWorkspaceId: async () => input.workspaceId,
    prepare: async () => {
      const user = await prisma.user.findUnique({ where: { username: input.username }, select: { id: true } });
      if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found', { username: input.username });
      return user;
    },
    mutate: async (tx, user) => {
      const existing = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
        include: memberInclude,
      });
      if (existing) return { status: 200, body: existing };
      const member = await tx.workspaceMember.create({
        data: { workspaceId: input.workspaceId, userId: user.id, role: input.role, joinedAt: new Date() },
        include: memberInclude,
      });
      await appendMemberJoined(tx, input.workspaceId, member, input.actorUserId);
      return {
        status: 201,
        body: member,
        afterCommit: async () => { invalidateTenancyCache(user.id); },
      };
    },
  };
}

export async function addWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  username: string;
  role: 'admin' | 'member' | 'viewer';
}): Promise<{ member: WorkspaceMemberWithUser; isNew: boolean }> {
  const result = await runCommandWithStatus(await authorizeAddWorkspaceMember(input));
  return { member: result.body, isNew: result.status === 201 };
}

interface BulkWorkspaceMembersResult {
  added: WorkspaceMemberWithUser[];
  skipped: Array<{ username: string; reason: string }>;
}

/** POST /api/workspaces/:id/members/bulk as a command (W04b). */
export async function authorizeBulkAddWorkspaceMembers(input: {
  workspaceId: string;
  actorUserId: string;
  invites: Array<{ username: string; role: WorkspaceRole }>;
}): Promise<IdempotentCommand<Map<string, { id: string }>, BulkWorkspaceMembersResult>> {
  const caller = await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner', 'admin']);
  if (caller.role !== 'owner' && input.invites.some((i) => i.role === 'owner')) {
    throw new OwnershipError('workspace', input.workspaceId, 'role_required', ['owner']);
  }
  return {
    resolveWorkspaceId: async () => input.workspaceId,
    prepare: async () => {
      const usernames = [...new Set(input.invites.map((i) => i.username))];
      const users = await prisma.user.findMany({ where: { username: { in: usernames } }, select: { id: true, username: true } });
      return new Map(users.map((u) => [u.username, { id: u.id }]));
    },
    mutate: async (tx, usersByUsername) => {
      const added: WorkspaceMemberWithUser[] = [];
      const skipped: Array<{ username: string; reason: string }> = [];
      for (const invite of input.invites) {
        const user = usersByUsername.get(invite.username);
        if (!user) { skipped.push({ username: invite.username, reason: 'USER_NOT_FOUND' }); continue; }
        const existing = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
          select: { id: true },
        });
        if (existing) { skipped.push({ username: invite.username, reason: 'ALREADY_MEMBER' }); continue; }
        const member = await tx.workspaceMember.create({
          data: { workspaceId: input.workspaceId, userId: user.id, role: invite.role, joinedAt: new Date() },
          include: memberInclude,
        });
        added.push(member);
      }
      for (const member of added) {
        await appendMemberJoined(tx, input.workspaceId, member, input.actorUserId);
      }
      return {
        status: 201,
        body: { added, skipped },
        afterCommit: async () => {
          for (const member of added) invalidateTenancyCache(member.userId);
        },
      };
    },
  };
}

export async function bulkAddWorkspaceMembers(input: {
  workspaceId: string;
  actorUserId: string;
  invites: Array<{ username: string; role: WorkspaceRole }>;
}): Promise<BulkWorkspaceMembersResult> {
  return runCommand(await authorizeBulkAddWorkspaceMembers(input));
}

export async function updateWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceRole;
}) {
  await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner']);
  await ensureNotLastOwner(input.workspaceId, input.targetUserId, input.role);

  const member = await transactionWithEvents(async (tx) => {
    const updated = await tx.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
      data: { role: input.role },
      include: memberInclude,
    });
    await appendToTarget(tx, workspaceTarget(input.workspaceId), 'workspace:member-updated', updated, input.actorUserId);
    return updated;
  });
  invalidateTenancyCache(input.targetUserId);
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

  await transactionWithEvents(async (tx) => {
    await tx.projectAccess.deleteMany({
      where: { userId: input.targetUserId, project: { workspaceId: input.workspaceId } },
    });
    await tx.teamMember.deleteMany({
      where: {
        userId: input.targetUserId,
        team: { project: { workspaceId: input.workspaceId } },
      },
    });
    await tx.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
    });
    await appendToTarget(tx, userTarget(input.targetUserId), 'workspace:left', { workspaceId: input.workspaceId }, input.actorUserId);
    await appendToTarget(tx, workspaceTarget(input.workspaceId), 'workspace:member-removed', { userId: input.targetUserId }, input.actorUserId);
  });
  // Synchronously after commit, before the flush can deliver anything.
  invalidateTenancyCache(input.targetUserId);
}

export async function deleteWorkspaceRoute(input: { workspaceId: string; userId: string }): Promise<void> {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner']);
  const projectCount = await prisma.project.count({ where: { workspaceId: input.workspaceId } });
  if (projectCount > 0) {
    throw new HttpError(409, 'WORKSPACE_HAS_PROJECTS', 'Cannot delete workspace with projects', { projectCount });
  }

  const memberUserIds = await transactionWithEvents(async (tx) => {
    const members = await tx.workspaceMember.findMany({ where: { workspaceId: input.workspaceId }, select: { userId: true } });
    // `PersonalAccessToken.workspace` is `onDelete: SetNull`, and a null
    // workspace means account-wide. Revoke bound tokens first so deleting a
    // workspace can never widen a token into an unrestricted one.
    await tx.personalAccessToken.updateMany({
      where: { workspaceId: input.workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.workspaceMember.deleteMany({ where: { workspaceId: input.workspaceId } });
    await tx.workspace.delete({ where: { id: input.workspaceId } });
    await appendToTarget(tx, workspaceTarget(input.workspaceId), 'workspace:deleted', { id: input.workspaceId }, input.userId);
    return members.map((member) => member.userId);
  });
  for (const uid of memberUserIds) invalidateTenancyCache(uid);
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

  // W04b: `workspace:updated` commits with the update.
  return transactionWithEvents(async (tx) => {
    await tx.workspace.update({ where: { id: input.workspaceId }, data: input.data });
    const detail = await loadWorkspaceDetail(input.workspaceId, input.userId, tx);
    await appendToTarget(tx, workspaceTarget(input.workspaceId), 'workspace:updated', detail, input.userId);
    return detail;
  });
}
