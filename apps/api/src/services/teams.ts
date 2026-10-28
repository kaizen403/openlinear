import crypto from 'node:crypto';
import { prisma, type Prisma, type TeamRole } from '@openlinear/db';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, teamTarget, userTarget } from '../events/targets';
import { logActivity } from './activity';
import { runCommand, type IdempotentCommand } from './idempotency';
import {
  assertPrincipalMayEnterWorkspace,
  assertPrincipalWorkspace,
  assertProjectAccess,
  assertTeamRole,
  OwnershipError,
} from './ownership';
import { resolveUserByHandle } from './members';
import { invalidateTenancyCache, resolvePrincipalForUser } from '../tenancy/context';
import { scopedTeamWhere } from '../tenancy/scopes';

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;
const memberInclude = { user: { select: userSelect } } as const;
const teamFullInclude = {
  members: { include: memberInclude },
  _count: { select: { members: true, tasks: true } },
  project: { select: { id: true, name: true, status: true, color: true, icon: true, workspaceId: true } },
} satisfies Prisma.TeamInclude;

type TeamMemberWithUser = Prisma.TeamMemberGetPayload<{ include: typeof memberInclude }>;
type TeamFull = Prisma.TeamGetPayload<{ include: typeof teamFullInclude }>;
type Db = Prisma.TransactionClient;

async function loadTeamIn(tx: Db, teamId: string): Promise<TeamFull> {
  const team = await tx.team.findUnique({ where: { id: teamId }, include: teamFullInclude });
  if (!team) throw new OwnershipError('team', teamId, 'not_found');
  return team;
}

async function teamWorkspaceId(teamId: string): Promise<string | null> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { project: { select: { workspaceId: true } } },
  });
  return team?.project.workspaceId ?? null;
}

function generateInviteCode(key: string): string {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${key}-${random}`;
}

async function loadTeam(teamId: string) {
  const team = await prisma.team.findUnique({ where: { id: teamId }, include: teamFullInclude });
  if (!team) throw new OwnershipError('team', teamId, 'not_found');
  return team;
}

async function ensureNotLastTeamOwner(teamId: string, userId: string, nextRole?: TeamRole): Promise<void> {
  const current = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });
  if (!current) throw new OwnershipError('team', teamId, 'not_found');
  if (current.role !== 'owner') return;
  if (nextRole === 'owner') return;

  const ownerCount = await prisma.teamMember.count({ where: { teamId, role: 'owner' } });
  if (ownerCount <= 1) {
    throw new HttpError(409, 'LAST_OWNER', 'Cannot demote the last team owner', { teamId, userId });
  }
}

export async function listTeams(input: {
  userId: string;
  workspaceId?: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const principal = await resolvePrincipalForUser(input.userId);
  const teams = await prisma.team.findMany({
    where: {
      AND: [
        scopedTeamWhere(principal),
        input.projectId ? { projectId: input.projectId } : {},
        input.workspaceId ? { project: { workspaceId: input.workspaceId } } : {},
      ],
    },
    include: teamFullInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = teams.slice(0, limit);
  return { data: page, nextCursor: teams.length > limit ? page.at(-1)?.id ?? null : null };
}

export async function getTeam(input: { teamId: string; userId: string }) {
  await assertTeamRole(input.teamId, input.userId, ['owner', 'admin', 'member']);
  return loadTeam(input.teamId);
}

export async function listTeamMembers(input: { teamId: string; userId: string; limit?: number; cursor?: string }) {
  await assertTeamRole(input.teamId, input.userId, ['owner', 'admin', 'member']);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await prisma.teamMember.findMany({
    where: { teamId: input.teamId },
    include: memberInclude,
    orderBy: [{ id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return { data: page, nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null };
}

export interface CreateTeamInput {
  userId: string;
  projectId: string;
  name: string;
  key: string;
  description?: string | null;
  color?: string;
  icon?: string | null;
  private?: boolean;
}

/**
 * POST /api/teams as a command (W04b): the team, the creator's owner
 * membership and both `team:created` events commit together.
 */
export async function authorizeCreateTeam(input: CreateTeamInput): Promise<IdempotentCommand<void, TeamFull>> {
  await assertProjectAccess(input.projectId, input.userId, 'full');
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  return {
    resolveWorkspaceId: async () => project?.workspaceId ?? null,
    prepare: async () => {
      const existingKey = await prisma.team.findFirst({ where: { projectId: input.projectId, key: input.key }, select: { id: true } });
      if (existingKey) throw new HttpError(409, 'TEAM_KEY_TAKEN', `Team key "${input.key}" is already used in this project`);
    },
    mutate: async (tx) => {
      const team = await tx.team.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          key: input.key,
          description: input.description ?? undefined,
          color: input.color ?? undefined,
          icon: input.icon ?? undefined,
          private: input.private ?? undefined,
          inviteCode: generateInviteCode(input.key),
          members: { create: { userId: input.userId, role: 'owner' } },
        },
        include: teamFullInclude,
      });
      await appendToTarget(tx, await teamTarget(tx, team.id), 'team:created', team, input.userId);
      await appendToTarget(tx, userTarget(input.userId), 'team:created', team, input.userId);
      return {
        status: 201,
        body: team,
        afterCommit: async () => {
          // The creator is now a team owner.
          invalidateTenancyCache(input.userId);
          await logActivity({
            teamId: team.id,
            projectId: input.projectId,
            userId: input.userId,
            action: 'team_created',
            payload: { name: team.name, key: team.key, source: 'chat' },
          });
        },
      };
    },
  };
}

export async function createTeam(input: CreateTeamInput): Promise<TeamFull> {
  return runCommand(await authorizeCreateTeam(input));
}

export async function updateTeam(input: {
  userId: string;
  teamId: string;
  name?: string;
  key?: string;
  description?: string | null;
  color?: string;
  icon?: string | null;
  private?: boolean;
}) {
  await assertTeamRole(input.teamId, input.userId, ['owner', 'admin']);
  const existing = await prisma.team.findUnique({ where: { id: input.teamId }, select: { key: true } });
  if (!existing) throw new OwnershipError('team', input.teamId, 'not_found');

  const data: Prisma.TeamUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.key !== undefined) {
    data.key = input.key;
    if (input.key !== existing.key) data.inviteCode = generateInviteCode(input.key);
  }
  if (input.description !== undefined) data.description = input.description;
  if (input.color !== undefined) data.color = input.color;
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.private !== undefined) data.private = input.private;

  // W04b: `team:updated` commits with the update.
  const team = await transactionWithEvents(async (tx) => {
    await tx.team.update({ where: { id: input.teamId }, data });
    const updated = await loadTeamIn(tx, input.teamId);
    await appendToTarget(tx, await teamTarget(tx, updated.id), 'team:updated', updated, input.userId);
    return updated;
  });
  await logActivity({
    teamId: team.id,
    projectId: team.projectId,
    userId: input.userId,
    action: 'team_updated',
    payload: { source: 'chat' },
  });
  return team;
}

export async function inviteTeamMember(input: {
  teamId: string;
  actorUserId: string;
  handle: string;
  role: TeamRole;
}) {
  const caller = await assertTeamRole(input.teamId, input.actorUserId, ['owner', 'admin']);
  if (input.role === 'owner' && caller.role !== 'owner') {
    throw new OwnershipError('team', input.teamId, 'role_required', ['owner']);
  }
  const user = await resolveUserByHandle(input.handle);
  const member = await transactionWithEvents(async (tx) => {
    const added: TeamMemberWithUser = await tx.teamMember.upsert({
      where: { teamId_userId: { teamId: input.teamId, userId: user.id } },
      update: {},
      create: { teamId: input.teamId, userId: user.id, role: input.role },
      include: memberInclude,
    });
    await appendMemberAdded(tx, input.teamId, added, input.actorUserId);
    return added;
  });
  invalidateTenancyCache(user.id);
  await logActivity({
    teamId: input.teamId,
    userId: input.actorUserId,
    action: 'team_member_added',
    payload: { addedUserId: user.id, role: member.role, source: 'chat' },
  });
  return member;
}

async function appendMemberAdded(tx: Db, teamId: string, member: TeamMemberWithUser, actorUserId: string): Promise<void> {
  await appendToTarget(tx, await teamTarget(tx, teamId), 'team:member-added', member, actorUserId);
  await appendToTarget(tx, userTarget(member.userId), 'team:joined', { teamId }, actorUserId);
}

export async function changeTeamMemberRole(input: {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
  role: TeamRole;
}) {
  const caller = await assertTeamRole(input.teamId, input.actorUserId, ['owner', 'admin']);
  if (input.role === 'owner' && caller.role !== 'owner') {
    throw new OwnershipError('team', input.teamId, 'role_required', ['owner']);
  }
  await ensureNotLastTeamOwner(input.teamId, input.targetUserId, input.role);
  return transactionWithEvents(async (tx) => {
    const member = await tx.teamMember.update({
      where: { teamId_userId: { teamId: input.teamId, userId: input.targetUserId } },
      data: { role: input.role },
      include: memberInclude,
    });
    await appendToTarget(tx, await teamTarget(tx, input.teamId), 'team:member-updated', member, input.actorUserId);
    return member;
  });
}

/**
 * POST /api/teams/join as a command (W04b). The membership and both
 * `team:updated` events commit together; a replay of a successful join
 * returns the stored team instead of 409 ALREADY_MEMBER.
 */
export async function authorizeJoinTeam(input: { userId: string; inviteCode: string }): Promise<IdempotentCommand<void, TeamFull>> {
  const team = await prisma.team.findUnique({
    where: { inviteCode: input.inviteCode },
    include: { project: { select: { workspaceId: true } } },
  });
  if (!team) throw new OwnershipError('team', input.inviteCode, 'not_found');
  assertPrincipalMayEnterWorkspace(input.userId, team.project.workspaceId);

  return {
    resolveWorkspaceId: async () => team.project.workspaceId,
    prepare: async () => undefined,
    mutate: async (tx) => {
      const existing = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: input.userId } },
        select: { id: true },
      });
      if (existing) throw new HttpError(409, 'ALREADY_MEMBER', 'You are already a member of this team');
      await tx.teamMember.create({ data: { teamId: team.id, userId: input.userId, role: 'member' } });
      const result = await loadTeamIn(tx, team.id);
      await appendToTarget(tx, await teamTarget(tx, team.id), 'team:updated', result, input.userId);
      await appendToTarget(tx, userTarget(input.userId), 'team:updated', result, input.userId);
      return {
        status: 200,
        body: result,
        afterCommit: async () => { invalidateTenancyCache(input.userId); },
      };
    },
  };
}

export async function joinTeamRoute(input: { userId: string; inviteCode: string }): Promise<TeamFull> {
  return runCommand(await authorizeJoinTeam(input));
}

export async function deleteTeamRoute(input: { teamId: string; userId: string }): Promise<void> {
  await assertTeamRole(input.teamId, input.userId, ['owner']);
  const memberUserIds = await transactionWithEvents(async (tx) => {
    const team = await tx.team.findUnique({ where: { id: input.teamId } });
    if (!team) throw new OwnershipError('team', input.teamId, 'not_found');
    const members = await tx.teamMember.findMany({ where: { teamId: input.teamId }, select: { userId: true } });
    const taskCount = await tx.task.count({ where: { teamId: input.teamId } });
    if (taskCount > 0) throw new HttpError(409, 'TEAM_HAS_TASKS', 'Cannot delete a team that still has tasks');
    await tx.teamMember.deleteMany({ where: { teamId: input.teamId } });
    await tx.team.delete({ where: { id: input.teamId } });
    const userIds = members.map((m) => m.userId);
    for (const uid of userIds) {
      await appendToTarget(tx, userTarget(uid), 'team:deleted', { id: input.teamId }, input.userId);
    }
    return userIds;
  }, PRISMA_TX_OPTIONS);
  // Former members lost the team: refresh their principals and open streams.
  for (const uid of memberUserIds) invalidateTenancyCache(uid);
}

type TeamMemberUser = Prisma.UserGetPayload<{ select: typeof userSelect }>;

/**
 * POST /api/teams/:id/members as a command (W04b): the membership and the
 * `team:member-added` / `team:joined` events commit together; the new
 * member's principal is refreshed right after commit.
 */
export async function authorizeAddTeamMember(input: {
  teamId: string;
  actorUserId: string;
  email?: string;
  userId?: string;
  role: TeamRole;
}): Promise<IdempotentCommand<TeamMemberUser, TeamMemberWithUser>> {
  const caller = await assertTeamRole(input.teamId, input.actorUserId, ['owner', 'admin']);
  if (input.role === 'owner' && caller.role !== 'owner') {
    throw new OwnershipError('team', input.teamId, 'role_required', ['owner']);
  }
  return {
    resolveWorkspaceId: () => teamWorkspaceId(input.teamId),
    prepare: async () => {
      const user = input.userId
        ? await prisma.user.findUnique({ where: { id: input.userId }, select: userSelect })
        : input.email
          ? await prisma.user.findFirst({ where: { email: input.email }, select: userSelect })
          : null;
      if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      return user;
    },
    mutate: async (tx, user) => {
      const member = await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: input.teamId, userId: user.id } },
        update: {},
        create: { teamId: input.teamId, userId: user.id, role: input.role },
        include: memberInclude,
      });
      await appendMemberAdded(tx, input.teamId, member, input.actorUserId);
      return {
        status: 201,
        body: member,
        afterCommit: async () => {
          invalidateTenancyCache(user.id);
          await logActivity({
            teamId: input.teamId, userId: input.actorUserId,
            action: 'team_member_added',
            payload: { addedUserId: user.id, role: member.role },
          });
        },
      };
    },
  };
}

export async function addTeamMemberRoute(input: {
  teamId: string;
  actorUserId: string;
  email?: string;
  userId?: string;
  role: TeamRole;
}): Promise<TeamMemberWithUser> {
  return runCommand(await authorizeAddTeamMember(input));
}

export async function removeTeamMemberRoute(input: {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  if (input.targetUserId !== input.actorUserId) {
    await assertTeamRole(input.teamId, input.actorUserId, ['owner']);
  } else {
    // Leaving only reduces authority, so it stays possible after the team's
    // project denies the caller; a workspace-bound PAT still cannot act on
    // another workspace's team.
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: input.teamId, userId: input.actorUserId } },
      select: { team: { select: { project: { select: { workspaceId: true } } } } },
    });
    if (!membership) throw new OwnershipError('team', input.teamId, 'not_found');
    assertPrincipalWorkspace(input.actorUserId, membership.team.project.workspaceId, 'team', input.teamId);
  }
  await ensureNotLastTeamOwner(input.teamId, input.targetUserId);

  await transactionWithEvents(async (tx) => {
    await tx.teamMember.delete({
      where: { teamId_userId: { teamId: input.teamId, userId: input.targetUserId } },
    });
    await appendToTarget(tx, await teamTarget(tx, input.teamId), 'team:member-removed', { userId: input.targetUserId }, input.actorUserId);
    await appendToTarget(tx, userTarget(input.targetUserId), 'team:left', { teamId: input.teamId }, input.actorUserId);
  });
  // Synchronously after commit, before the flush can deliver anything.
  invalidateTenancyCache(input.targetUserId);

  await logActivity({
    teamId: input.teamId, userId: input.actorUserId,
    action: 'team_member_removed',
    payload: { removedUserId: input.targetUserId },
  });
}

export { teamFullInclude, memberInclude as teamMemberInclude };
