import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@openlinear/db';

const TOKEN_PREFIX = 'ol_pat_';
const TOKEN_RANDOM_BYTES = 16;
const TOKEN_DISPLAY_HEX_CHARS = 8;

export interface PatClaims {
  userId: string;
  tokenId: string;
  scopes: string[];
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

export function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true;
  if (scopes.includes('*')) return true;

  return requiredScopes.every((scope) => {
    if (scopes.includes(scope)) return true;
    const [resource] = scope.split(':');
    return Boolean(resource && scopes.includes(`${resource}:*`));
  });
}

export async function validatePersonalAccessToken(
  token: string,
  requiredScopes: string[] = [],
): Promise<PatClaims | 'invalid' | 'insufficient_scope'> {
  if (!isPersonalAccessToken(token)) return 'invalid';

  const tokenHash = hashPersonalAccessToken(token);
  const pat = await prisma.personalAccessToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!pat || pat.revokedAt) return 'invalid';
  if (pat.expiresAt && pat.expiresAt <= new Date()) return 'invalid';
  if (!hasRequiredScopes(pat.scopes, requiredScopes)) return 'insufficient_scope';

  void prisma.personalAccessToken
    .update({
      where: { id: pat.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      // Authentication succeeded; a best-effort telemetry write must not break the request.
    });

  return {
    userId: pat.userId,
    tokenId: pat.id,
    scopes: pat.scopes,
  };
}
