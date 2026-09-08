import crypto from 'crypto';
import { Request } from 'express';
import { prisma } from '@openlinear/db';

/**
 * Session tracking backs both "sign out" and "revoke this device".
 *
 * Two properties matter and neither held before Phase 0:
 *
 *  1. **Fail closed.** `isSessionRevoked` used to return `false` when no session
 *     row existed, so a token whose row was deleted — or that was minted by a
 *     login path that never created one — authenticated forever. Every issuance
 *     path now goes through `issueSessionToken`, so a missing row means the token
 *     is not live and must be rejected.
 *
 *  2. **Bounded write amplification.** `touchSession` issued an UPDATE on every
 *     authenticated request. It is now throttled per token.
 *
 * `OPENLINEAR_ALLOW_SESSIONLESS_JWT=1` restores the old fail-open behaviour for a
 * single deploy window, so tokens issued before this change keep working while
 * users roll over. Remove it after one token lifetime (7 days).
 */

const REVOCATION_CACHE_TTL_MS = 30_000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

type RevocationState = { revoked: boolean; checkedAt: number };

const revocationCache = new Map<string, RevocationState>();
const lastTouchedAt = new Map<string, number>();

/** Bounded so a token-flood cannot grow these maps without limit. */
const MAX_CACHE_ENTRIES = 10_000;

function rememberRevocation(tokenHash: string, revoked: boolean): void {
  if (revocationCache.size >= MAX_CACHE_ENTRIES) revocationCache.clear();
  revocationCache.set(tokenHash, { revoked, checkedAt: Date.now() });
}

/** Drop cached state for a token so a revocation takes effect immediately. */
export function forgetSessionCache(tokenHash: string): void {
  revocationCache.delete(tokenHash);
  lastTouchedAt.delete(tokenHash);
}

export function clearSessionCaches(): void {
  revocationCache.clear();
  lastTouchedAt.clear();
}

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

  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });

  forgetSessionCache(session.tokenHash);
  return updated;
}

export async function revokeAllOtherSessions(userId: string, currentSessionId: string) {
  const doomed = await prisma.session.findMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
    select: { tokenHash: true },
  });

  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
    data: { revokedAt: new Date() },
  });

  for (const { tokenHash } of doomed) forgetSessionCache(tokenHash);
  return result;
}

/** Revoke the session behind a specific bearer token. Backs `POST /api/auth/logout`. */
export async function revokeSessionByTokenHash(tokenHash: string) {
  const result = await prisma.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  forgetSessionCache(tokenHash);
  return result.count > 0;
}

/**
 * Record liveness, at most once per `TOUCH_INTERVAL_MS` per token.
 * Previously this wrote to `sessions` on every authenticated request.
 */
export async function touchSession(tokenHash: string): Promise<void> {
  const now = Date.now();
  const last = lastTouchedAt.get(tokenHash);
  if (last && now - last < TOUCH_INTERVAL_MS) return;

  lastTouchedAt.set(tokenHash, now);
  if (lastTouchedAt.size > MAX_CACHE_ENTRIES) lastTouchedAt.clear();

  try {
    await prisma.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { lastActiveAt: new Date() },
    });
  } catch {
    // Telemetry only — never fail a request because liveness could not be recorded.
  }
}

export function sessionlessJwtAllowed(): boolean {
  return process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT === '1';
}

/**
 * True when the bearer token must be rejected.
 * Fails **closed**: an unknown token hash is not a live session.
 */
export async function isSessionRevoked(tokenHash: string): Promise<boolean> {
  const cached = revocationCache.get(tokenHash);
  if (cached && Date.now() - cached.checkedAt < REVOCATION_CACHE_TTL_MS) {
    return cached.revoked;
  }

  let session: { revokedAt: Date | null } | null;
  try {
    session = await prisma.session.findUnique({
      where: { tokenHash },
      select: { revokedAt: true },
    });
  } catch {
    // A database blip must not silently authenticate everyone.
    return true;
  }

  if (!session) {
    const revoked = !sessionlessJwtAllowed();
    // Not cached: the row may appear moments later during login races.
    return revoked;
  }

  const revoked = session.revokedAt !== null;
  rememberRevocation(tokenHash, revoked);
  return revoked;
}
