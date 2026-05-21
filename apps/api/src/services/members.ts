import { prisma, type Prisma, type WorkspaceRole } from '@openlinear/db';
import { HttpError } from '../errors';
import { broadcastToUser, broadcastToWorkspace } from '../sse';
import { OwnershipError } from './ownership';
import { assertWorkspaceRole } from './workspaces';

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;
const workspaceMemberInclude = { user: { select: userSelect } } as const;

type WorkspaceMemberWithUser = Prisma.WorkspaceMemberGetPayload<{ include: typeof workspaceMemberInclude }>;

export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, '');
}

export async function resolveUserByHandle(handle: string) {
  const normalized = normalizeHandle(handle);
  if (!normalized) {
    throw new HttpError(400, 'USER_HANDLE_REQUIRED', 'A username, @handle, email, or user id is required');
  }

  const user = normalized.includes('@')
    ? await prisma.user.findFirst({ where: { email: normalized }, select: userSelect })
    : await prisma.user.findFirst({
        where: {
          OR: [
            { id: normalized },
            { username: normalized },
          ],
        },
        select: userSelect,
      });

  if (!user) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found', { handle });
  }
  return user;
}

export async function listWorkspaceMembers(input: {
  workspaceId: string;
  userId: string;
  limit?: number;
  cursor?: string;
}) {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin', 'member', 'viewer']);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId: input.workspaceId },
    include: workspaceMemberInclude,
    orderBy: [{ id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    data: page,
    nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
  };
}

async function loadWorkspaceForUser(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  });
  if (!membership) return null;
  return prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
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
    },
  });
}

async function ensureNotLastWorkspaceOwner(
  workspaceId: string,
  userId: string,
  nextRole?: WorkspaceRole,
): Promise<void> {
  const current = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!current) {
    throw new OwnershipError('workspace', workspaceId, 'not_found');
  }
  if (current.role !== 'owner') return;
  if (nextRole === 'owner') return;

  const ownerCount = await prisma.workspaceMember.count({ where: { workspaceId, role: 'owner' } });
  if (ownerCount <= 1) {
    throw new HttpError(409, 'LAST_OWNER', 'Cannot demote the last workspace owner', {
      workspaceId,
      userId,
    });
  }
}

export async function inviteWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  handle: string;
  role: WorkspaceRole;
}) {
  const caller = await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner', 'admin']);
  if (input.role === 'owner' && caller.role !== 'owner') {
    throw new OwnershipError('workspace', input.workspaceId, 'role_required', ['owner']);
  }

  const user = await resolveUserByHandle(input.handle);
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
    include: workspaceMemberInclude,
  });
  if (existing) return existing;

  const member = await prisma.workspaceMember.create({
    data: {
      workspaceId: input.workspaceId,
      userId: user.id,
      role: input.role,
      joinedAt: new Date(),
    },
    include: workspaceMemberInclude,
  });

  const workspace = await loadWorkspaceForUser(input.workspaceId, user.id);
  if (workspace) broadcastToUser(user.id, 'workspace:joined', workspace);
  broadcastToWorkspace(input.workspaceId, 'workspace:member-added', member);
  return member;
}

export async function changeWorkspaceMemberRole(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceRole;
}) {
  await assertWorkspaceRole(input.workspaceId, input.actorUserId, ['owner']);
  await ensureNotLastWorkspaceOwner(input.workspaceId, input.targetUserId, input.role);

  const member = await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
    data: { role: input.role },
    include: workspaceMemberInclude,
  });

  broadcastToWorkspace(input.workspaceId, 'workspace:member-updated', member);
  return member;
}
