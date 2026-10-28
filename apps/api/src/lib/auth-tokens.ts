import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma, type Prisma } from '@openlinear/db';
import {
  ACCESS_TOKEN_TTL,
  JWT_AUDIENCE,
  JWT_ISSUER,
  REFRESH_TOKEN_TTL_MS,
} from '@openlinear/api-core';
import { getJwtSecret } from './secrets';
import {
  afterSessionsRevoked,
  forgetSessionCache,
  hashToken,
  revokeSessionFamily,
  type SessionDb,
} from '../services/sessions';
import { logAccountAuditBestEffort } from '../services/account-audit';

/**
 * The only places a bearer token may be minted.
 *
 * Access tokens are 1h JWTs (`iss`, `aud`, `jti`, `typ=access`). Refresh
 * tokens are opaque random values stored as SHA-256 hashes on `Session`.
 *
 * Refresh tokens rotate (W02b): every successful refresh revokes the
 * presented session (`revokedAt` + `rotatedAt`) and mints a successor in the
 * same `familyId`, in one transaction. Presenting a rotated refresh token
 * again is reuse: the whole family is revoked, its realtime streams are
 * closed and an account audit entry is written. A concurrent duplicate of the
 * same refresh (two tabs refreshing at once) inside a short grace window is
 * refused without revoking the family.
 */

const TWO_FACTOR_PENDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_REUSE_GRACE_MS = 10_000;
const MAX_REFRESH_REUSE_GRACE_MS = 60_000;

type Db = Prisma.TransactionClient | typeof prisma;

export interface TokenSubject {
  id: string;
  username: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
}

/** Window in which a second presentation of a just-rotated token is treated as a benign race. */
export function refreshReuseGraceMs(): number {
  const raw = Number.parseInt(process.env.OPENLINEAR_REFRESH_REUSE_GRACE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_REFRESH_REUSE_GRACE_MS;
  return Math.min(raw, MAX_REFRESH_REUSE_GRACE_MS);
}

function signAccessToken(user: TokenSubject): string {
  return jwt.sign(
    { userId: user.id, username: user.username, typ: 'access' },
    getJwtSecret(),
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: randomBytes(16).toString('hex'),
    },
  );
}

async function createSessionRow(
  db: Db,
  user: TokenSubject,
  req: Request,
  tokens: IssuedSession,
  familyId: string,
): Promise<string> {
  const row = await db.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(tokens.accessToken),
      refreshTokenHash: hashToken(tokens.refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      deviceInfo: req.headers['user-agent'] || null,
      ipAddress: req.ip || req.socket.remoteAddress || null,
    },
    select: { id: true },
  });
  return row.id;
}

function newTokens(user: TokenSubject): IssuedSession {
  return {
    accessToken: signAccessToken(user),
    refreshToken: randomBytes(32).toString('base64url'),
  };
}

/**
 * `db` lets a caller mint the session inside its own transaction, so the
 * session row commits or rolls back together with whatever authorized it
 * (for example the one-time desktop sign-in code).
 */
export async function issueSession(
  user: TokenSubject,
  req: Request,
  db: Db = prisma,
): Promise<IssuedSession> {
  const tokens = newTokens(user);
  await createSessionRow(db, user, req, tokens, randomBytes(16).toString('hex'));
  return tokens;
}

export async function issueSessionToken(user: TokenSubject, req: Request): Promise<string> {
  const issued = await issueSession(user, req);
  return issued.accessToken;
}

export async function issueTwoFactorPendingToken(
  user: TokenSubject,
  db: SessionDb = prisma,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.twoFactorChallenge.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TWO_FACTOR_PENDING_TTL_MS),
    },
  });
  return token;
}

/**
 * Consume a 2FA challenge. Single use under concurrency: the challenge is
 * claimed with a conditional UPDATE, so of N parallel requests presenting the
 * same challenge exactly one proceeds (previously read-then-write: all could).
 */
export async function verifyTwoFactorPendingToken(token: string): Promise<TokenSubject | null> {
  const tokenHash = hashToken(token);
  const now = new Date();
  const claimed = await prisma.twoFactorChallenge.updateMany({
    where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return null;
  const challenge = await prisma.twoFactorChallenge.findUnique({
    where: { tokenHash },
    select: { user: { select: { id: true, username: true } } },
  });
  return challenge ? { id: challenge.user.id, username: challenge.user.username } : null;
}

export type RefreshFailure = 'unknown' | 'expired' | 'revoked' | 'reused' | 'race';

export type RefreshOutcome =
  | { ok: true; issued: IssuedSession }
  | { ok: false; reason: RefreshFailure };

interface PresentedSession {
  id: string;
  userId: string;
  familyId: string | null;
  rotatedAt: Date | null;
}

async function handleRotatedTokenPresented(
  session: PresentedSession,
  req: Request,
): Promise<RefreshOutcome> {
  const rotatedAt = session.rotatedAt;
  if (!rotatedAt) return { ok: false, reason: 'revoked' };
  if (Date.now() - rotatedAt.getTime() <= refreshReuseGraceMs()) {
    return { ok: false, reason: 'race' };
  }
  const familyId = session.familyId ?? session.id;
  const revokedSessionIds = await revokeSessionFamily(session.userId, familyId, 'refresh-reuse');
  await logAccountAuditBestEffort({
    userId: session.userId,
    actorId: null,
    action: 'session.refresh_reuse_detected',
    resourceType: 'session_family',
    resourceId: familyId,
    metadata: { presentedSessionId: session.id, revokedSessionIds },
    ipAddress: req.ip ?? null,
  });
  return { ok: false, reason: 'reused' };
}

export async function rotateRefreshTokenDetailed(
  refreshToken: string,
  req: Request,
): Promise<RefreshOutcome> {
  const refreshTokenHash = hashToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash },
    select: {
      id: true,
      userId: true,
      tokenHash: true,
      familyId: true,
      revokedAt: true,
      rotatedAt: true,
      expiresAt: true,
      user: { select: { id: true, username: true } },
    },
  });
  if (!session) return { ok: false, reason: 'unknown' };
  if (session.revokedAt) return handleRotatedTokenPresented(session, req);
  if (session.expiresAt && session.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

  // Legacy rows have no family: the presented session becomes the family root.
  const familyId = session.familyId ?? session.id;
  const subject: TokenSubject = { id: session.user.id, username: session.user.username };
  const tokens = newTokens(subject);
  const now = new Date();

  const successorId = await prisma.$transaction(async (tx) => {
    const claimed = await tx.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now, rotatedAt: now, familyId },
    });
    if (claimed.count !== 1) return null;
    return createSessionRow(tx, subject, req, tokens, familyId);
  });

  if (!successorId) {
    // Another request rotated (or revoked) this session between our read and
    // our claim. Classify with the committed state.
    const current = await prisma.session.findUnique({
      where: { id: session.id },
      select: { id: true, userId: true, familyId: true, rotatedAt: true },
    });
    return current ? handleRotatedTokenPresented(current, req) : { ok: false, reason: 'unknown' };
  }

  forgetSessionCache(session.tokenHash);
  await afterSessionsRevoked(session.userId, [session.id], 'rotated');
  return { ok: true, issued: tokens };
}

export async function rotateRefreshToken(
  refreshToken: string,
  req: Request,
): Promise<IssuedSession | null> {
  const outcome = await rotateRefreshTokenDetailed(refreshToken, req);
  return outcome.ok ? outcome.issued : null;
}
