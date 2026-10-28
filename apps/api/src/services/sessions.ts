import crypto from 'crypto';
import { Request } from 'express';
import { prisma, type Prisma } from '@openlinear/db';
import { logger } from '../logger';

/** The global client, or the client of an enclosing `$transaction`. */
export type SessionDb = Prisma.TransactionClient | typeof prisma;

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
 * W02b adds a third: **revocation reaches realtime.** Every path that revokes
 * a session (logout, "revoke this device", "revoke all others", refresh-token
 * rotation and reuse detection) goes through `afterSessionsRevoked`, which
 * marks the session's outstanding SSE tickets consumed and notifies listeners
 * (the SSE route closes streams opened by those sessions, locally and on other
 * replicas).
 *
 * `OPENLINEAR_ALLOW_SESSIONLESS_JWT=1` restores the old fail-open behaviour for a
 * single deploy window, so tokens issued before this change keep working while
 * users roll over. Remove it after one token lifetime (7 days).
 */

const REVOCATION_CACHE_TTL_MS = 30_000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

type SessionStateEntry = { revoked: boolean; sessionId: string | null; checkedAt: number };

const revocationCache = new Map<string, SessionStateEntry>();
const lastTouchedAt = new Map<string, number>();

/** Bounded so a token-flood cannot grow these maps without limit. */
const MAX_CACHE_ENTRIES = 10_000;

function rememberSessionState(tokenHash: string, revoked: boolean, sessionId: string | null): void {
  if (revocationCache.size >= MAX_CACHE_ENTRIES) revocationCache.clear();
  revocationCache.set(tokenHash, { revoked, sessionId, checkedAt: Date.now() });
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

export async function createSession(
  userId: string,
  tokenHash: string,
  req: Request,
  extras: { refreshTokenHash?: string; familyId?: string; expiresAt?: Date } = {},
  db: SessionDb = prisma,
) {
  const deviceInfo = req.headers['user-agent'] || null;
  const ipAddress = req.ip || req.socket.remoteAddress || null;

  return db.session.create({
    data: {
      userId,
      tokenHash,
      deviceInfo,
      ipAddress,
      refreshTokenHash: extras.refreshTokenHash,
      familyId: extras.familyId,
      expiresAt: extras.expiresAt,
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

// ─── Revocation fan-out ─────────────────────────────────────────────────────

export type SessionRevocationReason =
  | 'logout'
  | 'revoked'
  | 'revoked-others'
  | 'rotated'
  | 'refresh-reuse';

export interface SessionsRevokedEvent {
  userId: string;
  sessionIds: string[];
  reason: SessionRevocationReason;
}

type SessionsRevokedListener = (event: SessionsRevokedEvent) => void | Promise<void>;

const revokedListeners = new Set<SessionsRevokedListener>();

/**
 * Subscribe to session revocations (after they committed). The SSE route uses
 * this to close streams opened by a revoked session on this replica and to
 * signal the other replicas.
 */
export function onSessionsRevoked(listener: SessionsRevokedListener): () => void {
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
}

/**
 * Called after a session revocation committed. Outstanding SSE tickets minted
 * by those sessions become unusable, then listeners close their streams.
 *
 * Best effort by design: the revocation itself is already durable, ticket
 * consumption re-checks the issuing session, and every open stream re-checks
 * its session on each heartbeat. A failure here only delays, never prevents,
 * the effect.
 */
export async function afterSessionsRevoked(
  userId: string,
  sessionIds: readonly string[],
  reason: SessionRevocationReason,
): Promise<void> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return;
  try {
    await prisma.sseTicket.updateMany({
      where: { userId, sessionId: { in: ids }, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  } catch (err) {
    logger.warn({ err, userId, reason }, '[sessions] failed to invalidate SSE tickets of revoked sessions');
  }
  for (const listener of revokedListeners) {
    try {
      await listener({ userId, sessionIds: ids, reason });
    } catch (err) {
      logger.warn({ err, userId, reason }, '[sessions] session revocation listener failed');
    }
  }
}

export async function revokeSession(sessionId: string, userId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, revokedAt: null },
  });
  if (!session) return null;

  const revokedAt = new Date();
  const claimed = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt },
  });
  if (claimed.count === 0) return null;

  forgetSessionCache(session.tokenHash);
  await afterSessionsRevoked(userId, [session.id], 'revoked');
  return { ...session, revokedAt };
}

/**
 * Revoke every live session of `userId` except `currentSessionId` (the
 * session the request was made with).
 *
 * The previous version compared `Session.id` against the *hash of the bearer
 * token*, which never matches, so "revoke other sessions" also signed out
 * the session that asked.
 */
export async function revokeAllOtherSessions(userId: string, currentSessionId: string) {
  const doomed = await prisma.session.findMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
    select: { id: true, tokenHash: true },
  });

  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { in: doomed.map((row) => row.id) } },
    data: { revokedAt: new Date() },
  });

  for (const { tokenHash } of doomed) forgetSessionCache(tokenHash);
  await afterSessionsRevoked(userId, doomed.map((row) => row.id), 'revoked-others');
  return result;
}

/** Revoke the session behind a specific bearer token. Backs `POST /api/auth/logout`. */
export async function revokeSessionByTokenHash(tokenHash: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, revokedAt: true },
  });
  const result = await prisma.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  forgetSessionCache(tokenHash);
  if (session && result.count > 0) {
    await afterSessionsRevoked(session.userId, [session.id], 'logout');
  }
  return result.count > 0;
}

/**
 * Revoke every live session of a refresh-token family (refresh-token reuse).
 * Returns the ids that were revoked by this call.
 */
export async function revokeSessionFamily(
  userId: string,
  familyId: string,
  reason: SessionRevocationReason,
): Promise<string[]> {
  const live = await prisma.session.findMany({
    where: { userId, familyId, revokedAt: null },
    select: { id: true, tokenHash: true },
  });
  if (live.length === 0) return [];
  await prisma.session.updateMany({
    where: { userId, id: { in: live.map((row) => row.id) }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  for (const { tokenHash } of live) forgetSessionCache(tokenHash);
  const ids = live.map((row) => row.id);
  await afterSessionsRevoked(userId, ids, reason);
  return ids;
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

export interface SessionState {
  /** True when the bearer token must be rejected. */
  revoked: boolean;
  /** `Session.id` behind the token; `null` for sessionless (test/legacy) tokens. */
  sessionId: string | null;
}

/**
 * Session state for a bearer token. Fails **closed**: an unknown token hash
 * is not a live session (unless sessionless JWTs are explicitly allowed).
 */
export async function getSessionState(tokenHash: string): Promise<SessionState> {
  const cached = revocationCache.get(tokenHash);
  if (cached && Date.now() - cached.checkedAt < REVOCATION_CACHE_TTL_MS) {
    return { revoked: cached.revoked, sessionId: cached.sessionId };
  }

  let session: { id: string; revokedAt: Date | null } | null;
  try {
    session = await prisma.session.findUnique({
      where: { tokenHash },
      select: { id: true, revokedAt: true },
    });
  } catch {
    // A database blip must not silently authenticate everyone.
    return { revoked: true, sessionId: null };
  }

  if (!session) {
    // Not cached: the row may appear moments later during login races.
    return { revoked: !sessionlessJwtAllowed(), sessionId: null };
  }

  const revoked = session.revokedAt !== null;
  rememberSessionState(tokenHash, revoked, session.id);
  return { revoked, sessionId: session.id };
}

/**
 * True when the bearer token must be rejected.
 * Fails **closed**: an unknown token hash is not a live session.
 */
export async function isSessionRevoked(tokenHash: string): Promise<boolean> {
  return (await getSessionState(tokenHash)).revoked;
}

/**
 * Uncached liveness of a session by id (SSE ticket consumption and stream
 * heartbeats). Fails closed on a database error.
 */
export async function isSessionLive(sessionId: string): Promise<boolean> {
  try {
    const row = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true },
    });
    return row !== null && row.revokedAt === null;
  } catch {
    return false;
  }
}
