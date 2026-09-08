import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './secrets';
import { createSession, hashToken } from '../services/sessions';

/**
 * The only places a bearer token may be minted.
 *
 * Previously four call sites signed their own JWTs and only one of them created
 * the matching `Session` row, so "sign out everywhere" could not reach tokens
 * from the SSO and 2FA paths. Session revocation now fails closed, which makes
 * pairing issuance with a session row mandatory rather than merely tidy.
 */

const SESSION_TTL = '7d';
const TWO_FACTOR_PENDING_TTL = '5m';

export interface TokenSubject {
  id: string;
  username: string;
}

/**
 * Mint a full-privilege session token and record the session that backs it.
 * Throws if the session row cannot be written — minting a token that
 * `isSessionRevoked` will immediately reject is worse than a failed login.
 */
export async function issueSessionToken(user: TokenSubject, req: Request): Promise<string> {
  const token = jwt.sign(
    { userId: user.id, username: user.username },
    getJwtSecret(),
    { expiresIn: SESSION_TTL },
  );

  await createSession(user.id, hashToken(token), req);
  return token;
}

/**
 * Mint the short-lived token that carries a user between primary auth and TOTP
 * verification. It is deliberately NOT a credential: `decodeToken` in the auth
 * middleware rejects any token carrying `twoFactorPending`, and no session row
 * is created for it. Only the 2FA verification endpoint may consume it, via
 * `verifyTwoFactorPendingToken`.
 */
export function issueTwoFactorPendingToken(user: TokenSubject): string {
  return jwt.sign(
    { userId: user.id, username: user.username, twoFactorPending: true },
    getJwtSecret(),
    { expiresIn: TWO_FACTOR_PENDING_TTL },
  );
}

/**
 * Verify a 2FA-pending token. Returns null unless the token is valid AND
 * actually carries `twoFactorPending`, so a full session token cannot be
 * replayed at the 2FA endpoint to skip a step.
 */
export function verifyTwoFactorPendingToken(token: string): TokenSubject | null {
  try {
    const claims = jwt.verify(token, getJwtSecret()) as {
      userId?: string;
      username?: string;
      twoFactorPending?: boolean;
    };

    if (!claims.twoFactorPending || !claims.userId || !claims.username) return null;
    return { id: claims.userId, username: claims.username };
  } catch {
    return null;
  }
}
