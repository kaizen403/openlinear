import crypto from 'node:crypto';
import { prisma, type Prisma, type TeamRole } from '@openlinear/db';
import { HttpError } from '../errors';
import { broadcastToTeam, broadcastToUser } from '../sse';
import { logActivity } from './activity';
import { assertProjectAccess, assertTeamRole, OwnershipError } from './ownership';
import { resolveUserByHandle } from './members';

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;
const memberInclude = { user: { select: userSelect } } as const;
const teamFullInclude = {
  members: { include: memberInclude },
  _count: { select: { members: true, tasks: true } },
  project: { select: { id: true, name: true, status: true, color: true, icon: true, workspaceId: true } },
} satisfies Prisma.TeamInclude;

type TeamMemberWithUser = Prisma.TeamMemberGetPayload<{ include: typeof memberInclude }>;

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
  const teams = await prisma.team.findMany({
    where: {
      members: { some: { userId: input.userId } },
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.workspaceId ? { project: { workspaceId: input.workspaceId } } : {}),
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

export async function createTeam(input: {
  userId: string;
  projectId: string;
  name: string;
  key: string;
  description?: string | null;
  color?: string;
  icon?: string | null;
  private?: boolean;
}) {
  await assertProjectAccess(input.projectId, input.userId, 'full');
  const existingKey = await prisma.team.findFirst({ where: { projectId: input.projectId, key: input.key }, select: { id: true } });
  if (existingKey) throw new HttpError(409, 'TEAM_KEY_TAKEN', `Team key "${input.key}" is already used in this project`);

  const team = await prisma.team.create({
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
  broadcastToTeam(team.id, 'team:created', team);
  broadcastToUser(input.userId, 'team:created', team);
  await logActivity({
    teamId: team.id,
    projectId: input.projectId,
    userId: input.userId,
    action: 'team_created',
    payload: { name: team.name, key: team.key, source: 'chat' },
  });
  return team;
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

  await prisma.team.update({ where: { id: input.teamId }, data });
  const team = await loadTeam(input.teamId);
  broadcastToTeam(team.id, 'team:updated', team);
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
  const member: TeamMemberWithUser = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: input.teamId, userId: user.id } },
    update: {},
    create: { teamId: input.teamId, userId: user.id, role: input.role },
    include: memberInclude,
  });
  await logActivity({
    teamId: input.teamId,
    userId: input.actorUserId,
    action: 'team_member_added',
    payload: { addedUserId: user.id, role: member.role, source: 'chat' },
  });
  broadcastToTeam(input.teamId, 'team:member-added', member);
  broadcastToUser(user.id, 'team:joined', { teamId: input.teamId });
  return member;
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
  const member = await prisma.teamMember.update({
    where: { teamId_userId: { teamId: input.teamId, userId: input.targetUserId } },
    data: { role: input.role },
    include: memberInclude,
  });
  broadcastToTeam(input.teamId, 'team:member-updated', member);
  return member;
}

export async function joinTeamRoute(input: { userId: string; inviteCode: string }) {
  const team = await prisma.team.findUnique({ where: { inviteCode: input.inviteCode } });
  if (!team) throw new OwnershipError('team', input.inviteCode, 'not_found');

  const existing = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: team.id, userId: input.userId } },
  });
  if (existing) throw new HttpError(409, 'ALREADY_MEMBER', 'You are already a member of this team');

  await prisma.teamMember.create({ data: { teamId: team.id, userId: input.userId, role: 'member' } });
  const result = await loadTeam(team.id);
  broadcastToTeam(team.id, 'team:updated', result);
  broadcastToUser(input.userId, 'team:updated', result);
  return result;
}

export async function deleteTeamRoute(input: { teamId: string; userId: string }): Promise<void> {
  await assertTeamRole(input.teamId, input.userId, ['owner']);
  const memberUserIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const team = await tx.team.findUnique({ where: { id: input.teamId } });
    if (!team) throw new OwnershipError('team', input.teamId, 'not_found');
    const members = await tx.teamMember.findMany({ where: { teamId: input.teamId }, select: { userId: true } });
    const taskCount = await tx.task.count({ where: { teamId: input.teamId } });
    if (taskCount > 0) throw new HttpError(409, 'TEAM_HAS_TASKS', 'Cannot delete a team that still has tasks');
    memberUserIds.push(...members.map((m) => m.userId));
    await tx.teamMember.deleteMany({ where: { teamId: input.teamId } });
    await tx.team.delete({ where: { id: input.teamId } });
  }, { timeout: 15000, maxWait: 5000 });
  for (const uid of memberUserIds) {
    broadcastToUser(uid, 'team:deleted', { id: input.teamId });
  }
}

export async function addTeamMemberRoute(input: {
  teamId: string;
  actorUserId: string;
  email?: string;
  userId?: string;
  role: TeamRole;
}) {
  const caller = await assertTeamRole(input.teamId, input.actorUserId, ['owner', 'admin']);
  if (input.role === 'owner' && caller.role !== 'owner') {
    throw new OwnershipError('team', input.teamId, 'role_required', ['owner']);
  }

  const user = input.userId
    ? await prisma.user.findUnique({ where: { id: input.userId }, select: userSelect })
    : input.email
      ? await prisma.user.findFirst({ where: { email: input.email }, select: userSelect })
      : null;
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');

  const member = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: input.teamId, userId: user.id } },
    update: {},
    create: { teamId: input.teamId, userId: user.id, role: input.role },
    include: memberInclude,
  });

  await logActivity({
    teamId: input.teamId, userId: input.actorUserId,
    action: 'team_member_added',
    payload: { addedUserId: user.id, role: member.role },
  });
  broadcastToTeam(input.teamId, 'team:member-added', member);
  broadcastToUser(user.id, 'team:joined', { teamId: input.teamId });
  return member;
}

export async function removeTeamMemberRoute(input: {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  if (input.targetUserId !== input.actorUserId) {
    await assertTeamRole(input.teamId, input.actorUserId, ['owner']);
  } else {
    await assertTeamRole(input.teamId, input.actorUserId, ['owner', 'admin', 'member']);
  }
  await ensureNotLastTeamOwner(input.teamId, input.targetUserId);

  await prisma.teamMember.delete({
    where: { teamId_userId: { teamId: input.teamId, userId: input.targetUserId } },
  });

  await logActivity({
    teamId: input.teamId, userId: input.actorUserId,
    action: 'team_member_removed',
    payload: { removedUserId: input.targetUserId },
  });
  broadcastToTeam(input.teamId, 'team:member-removed', { userId: input.targetUserId });
  broadcastToUser(input.targetUserId, 'team:left', { teamId: input.teamId });
}

export { teamFullInclude, memberInclude as teamMemberInclude };
