import crypto from 'crypto';
import { Request } from 'express';
import { prisma } from '@openlinear/db';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string, tokenHash: string, req: Request) {
  const deviceInfo = req.headers['user-agent'] || null;
  const ipAddress = req.ip || req.socket.remoteAddress || null;

  return prisma.session.create({
    data: {
      userId,
      tokenHash,
      deviceInfo,
      ipAddress,
    },
  });
}

export async function listActiveSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastActiveAt: 'desc' },
    select: {
      id: true,
      deviceInfo: true,
      ipAddress: true,
      lastActiveAt: true,
      createdAt: true,
    },
  });
}

export async function revokeSession(sessionId: string, userId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, revokedAt: null },
  });
  if (!session) return null;

  return prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllOtherSessions(userId: string, currentSessionId: string) {
  return prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
    data: { revokedAt: new Date() },
  });
}

export async function touchSession(tokenHash: string) {
  await prisma.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { lastActiveAt: new Date() },
  });
}

export async function isSessionRevoked(tokenHash: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { tokenHash } });
  if (!session) return false; // graceful: no session record means legacy token, allow through
  return session.revokedAt !== null;
}
