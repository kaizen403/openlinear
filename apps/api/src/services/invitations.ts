import { prisma, type WorkspaceRole } from '@openlinear/db';
import { assertWorkspaceRole } from './workspaces';
import { OwnershipError } from './ownership';
import { HttpError } from '../errors';

const INVITATION_EXPIRY_DAYS = 7;

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export async function createInvitation(input: {
  email: string;
  workspaceId: string;
  role: WorkspaceRole;
  invitedById: string;
}) {
  await assertWorkspaceRole(input.workspaceId, input.invitedById, ['owner', 'admin']);

  const normalizedEmail = input.email.toLowerCase().trim();

  const existing = await prisma.invitation.findFirst({
    where: {
      email: normalizedEmail,
      workspaceId: input.workspaceId,
      status: 'pending',
    },
  });

  if (existing) {
    throw new HttpError(409, 'INVITATION_EXISTS', 'A pending invitation already exists for this email in this workspace', {
      invitationId: existing.id,
    });
  }

  const invitation = await prisma.invitation.create({
    data: {
      email: normalizedEmail,
      workspaceId: input.workspaceId,
      role: input.role,
      invitedById: input.invitedById,
      expiresAt: addDays(new Date(), INVITATION_EXPIRY_DAYS),
    },
  });

  return invitation;
}

export async function listPendingInvitationsForWorkspace(input: {
  workspaceId: string;
  userId: string;
}) {
  await assertWorkspaceRole(input.workspaceId, input.userId, ['owner', 'admin']);

  const invitations = await prisma.invitation.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      invitedBy: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
    },
  });

  return invitations;
}

export async function acceptInvitation(input: {
  invitationId: string;
  token?: string;
  userId: string;
  userEmail: string;
}) {
  let invitation;

  if (input.token) {
    invitation = await prisma.invitation.findFirst({
      where: {
        token: input.token,
        status: 'pending',
      },
    });
  } else {
    invitation = await prisma.invitation.findFirst({
      where: {
        id: input.invitationId,
        status: 'pending',
        email: input.userEmail.toLowerCase().trim(),
      },
    });
  }

  if (!invitation) {
    throw new OwnershipError('workspace', input.invitationId, 'not_found');
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'expired' },
    });
    throw new HttpError(410, 'INVITATION_EXPIRED', 'This invitation has expired');
  }

  const existingMember = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: input.userId } },
  });

  if (existingMember) {
    throw new HttpError(409, 'ALREADY_MEMBER', 'You are already a member of this workspace');
  }

  await prisma.$transaction(async (tx) => {
    await tx.workspaceMember.create({
      data: {
        workspaceId: invitation.workspaceId,
        userId: input.userId,
        role: invitation.role,
        joinedAt: new Date(),
      },
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted' },
    });
  });

  return { invitationId: invitation.id, workspaceId: invitation.workspaceId };
}

export async function revokeInvitation(input: {
  invitationId: string;
  userId: string;
}) {
  const invitation = await prisma.invitation.findUnique({
    where: { id: input.invitationId },
  });

  if (!invitation) {
    throw new OwnershipError('workspace', input.invitationId, 'not_found');
  }

  if (invitation.status !== 'pending') {
    throw new HttpError(409, 'INVITATION_NOT_PENDING', 'Invitation is not pending', { status: invitation.status });
  }

  const isInviter = invitation.invitedById === input.userId;
  let canRevoke = isInviter;

  if (!canRevoke) {
    try {
      await assertWorkspaceRole(invitation.workspaceId, input.userId, ['owner', 'admin']);
      canRevoke = true;
    } catch {
      canRevoke = false;
    }
  }

  if (!canRevoke) {
    throw new OwnershipError('workspace', invitation.workspaceId, 'forbidden');
  }

  const updated = await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: 'revoked' },
  });

  return updated;
}

export async function listMyPendingInvitations(input: {
  userEmail: string;
}) {
  const normalizedEmail = input.userEmail.toLowerCase().trim();

  const invitations = await prisma.invitation.findMany({
    where: {
      email: normalizedEmail,
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true },
      },
      invitedBy: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
    },
  });

  return invitations;
}
