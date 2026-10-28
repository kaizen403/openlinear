import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { hasRequiredScopes } from '@openlinear/api-core';

const TOKEN_PREFIX = 'ol_pat_';
const TOKEN_RANDOM_BYTES = 16;
const TOKEN_DISPLAY_HEX_CHARS = 8;

/**
 * `lastUsedAt` is telemetry. It used to be written on every PAT request (one
 * extra UPDATE per API call). It is now written at most once per interval
 * per token: skipped in-process inside the interval, and the UPDATE itself is
 * conditional on the stored value being older than the interval, so other
 * replicas do not write either. Validity (revoked/expired) is still read from
 * the database on every request; only this write is throttled.
 */
export const PAT_LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MAX_TRACKED_TOKENS = 10_000;
const lastUsedWrites = new Map<string, number>();

export interface PatClaims {
  userId: string;
  tokenId: string;
  scopes: string[];
  /** Workspace the token is bound to; `null` means account-wide. */
  workspaceId: string | null;
}

export function isPersonalAccessToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

export function generatePersonalAccessToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('hex')}`;
}

export function hashPersonalAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function getPersonalAccessTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + TOKEN_DISPLAY_HEX_CHARS);
}

export { hasRequiredScopes };

/**
 * Resolve a PAT to its claims, or `null` when it is unknown, revoked or
 * expired. Always reads the database (no caching), so revocation is
 * immediate. No side effects.
 */
export async function lookupPersonalAccessToken(token: string): Promise<PatClaims | null> {
  if (!isPersonalAccessToken(token)) return null;

  const pat = await prisma.personalAccessToken.findUnique({
    where: { tokenHash: hashPersonalAccessToken(token) },
    select: {
      id: true,
      userId: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
      workspaceId: true,
    },
  });

  if (!pat || pat.revokedAt) return null;
  if (pat.expiresAt && pat.expiresAt <= new Date()) return null;

  return {
    userId: pat.userId,
    tokenId: pat.id,
    scopes: pat.scopes,
    workspaceId: pat.workspaceId,
  };
}

/** Throttled, best-effort `lastUsedAt` write. Never fails a request. */
export function recordPersonalAccessTokenUse(tokenId: string, now: number = Date.now()): void {
  const last = lastUsedWrites.get(tokenId);
  if (last !== undefined && now - last < PAT_LAST_USED_WRITE_INTERVAL_MS) return;
  if (lastUsedWrites.size >= MAX_TRACKED_TOKENS) lastUsedWrites.clear();
  lastUsedWrites.set(tokenId, now);

  void prisma.personalAccessToken
    .updateMany({
      where: {
        id: tokenId,
        OR: [
          { lastUsedAt: null },
          { lastUsedAt: { lt: new Date(now - PAT_LAST_USED_WRITE_INTERVAL_MS) } },
        ],
      },
      data: { lastUsedAt: new Date(now) },
    })
    .catch(() => {
      // Authentication succeeded; a best-effort telemetry write must not break the request.
    });
}

/** Test seam: forget in-process throttle state. */
export function resetPatUsageThrottle(): void {
  lastUsedWrites.clear();
}

/**
 * Validate a PAT and (optionally) a scope requirement. The HTTP middleware
 * does not use the scope argument: it takes the requirement from the route
 * registry (see middleware/auth.ts).
 */
export async function validatePersonalAccessToken(
  token: string,
  requiredScopes: string[] = [],
): Promise<PatClaims | 'invalid' | 'insufficient_scope'> {
  const claims = await lookupPersonalAccessToken(token);
  if (!claims) return 'invalid';
  if (!hasRequiredScopes(claims.scopes, requiredScopes)) return 'insufficient_scope';
  recordPersonalAccessTokenUse(claims.tokenId);
  return claims;
}
