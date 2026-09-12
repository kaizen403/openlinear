import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import {
  ACCESS_TOKEN_TTL,
  JWT_AUDIENCE,
  JWT_ISSUER,
  REFRESH_TOKEN_TTL_MS,
} from '@openlinear/api-core';
import { getJwtSecret } from './secrets';
import { createSession, hashToken } from '../services/sessions';

/**
 * The only places a bearer token may be minted.
 *
 * Access tokens are 1h JWTs (`iss`, `aud`, `jti`, `typ=access`). Refresh
 * tokens are opaque random values stored as SHA-256 hashes on `Session`.
 */

const TWO_FACTOR_PENDING_TTL_MS = 5 * 60 * 1000;

export interface TokenSubject {
  id: string;
  username: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
}

export async function issueSession(
  user: TokenSubject,
  req: Request,
): Promise<IssuedSession> {
  const jti = randomBytes(16).toString('hex');
  const accessToken = jwt.sign(
    { userId: user.id, username: user.username, typ: 'access' },
    getJwtSecret(),
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: jti,
    },
  );

  const refreshToken = randomBytes(32).toString('base64url');
  const familyId = randomBytes(16).toString('hex');
  await createSession(user.id, hashToken(accessToken), req, {
    refreshTokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return { accessToken, refreshToken };
}

export async function issueSessionToken(user: TokenSubject, req: Request): Promise<string> {
  const issued = await issueSession(user, req);
  return issued.accessToken;
}

export async function issueTwoFactorPendingToken(user: TokenSubject): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma.twoFactorChallenge.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TWO_FACTOR_PENDING_TTL_MS),
    },
  });
  return token;
}

export async function verifyTwoFactorPendingToken(token: string): Promise<TokenSubject | null> {
  const tokenHash = hashToken(token);
  const challenge = await prisma.twoFactorChallenge.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, username: true } } },
  });
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) {
    return null;
  }
  await prisma.twoFactorChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });
  return { id: challenge.user.id, username: challenge.user.username };
}

export async function rotateRefreshToken(
  refreshToken: string,
  req: Request,
): Promise<IssuedSession | null> {
  const refreshTokenHash = hashToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash },
    include: { user: { select: { id: true, username: true } } },
  });
  if (!session || session.revokedAt) return null;
  if (session.expiresAt && session.expiresAt <= new Date()) return null;

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  return issueSession(
    { id: session.user.id, username: session.user.username },
    req,
  );
}
