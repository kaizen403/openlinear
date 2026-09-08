import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { buildErrorEnvelope } from '../lib/http';
import {
  isPersonalAccessToken,
  validatePersonalAccessToken,
} from '../services/pats';
import { hashToken, isSessionRevoked, touchSession } from '../services/sessions';
import { getJwtSecret } from '../lib/secrets';

interface JwtClaims {
  userId: string;
  username: string;
  /**
   * Set on the short-lived token issued between password/OAuth success and TOTP
   * verification. Such a token is NOT a credential: it may only be exchanged at
   * the 2FA verification endpoint, which reads it directly rather than through
   * this middleware.
   */
  twoFactorPending?: boolean;
}

function decodeToken(token: string): { userId: string; username: string } | null {
  try {
    const verified = jwt.verify(token, getJwtSecret()) as JwtClaims;

    // A 2FA-pending token previously authenticated every route, so enabling 2FA
    // made an account strictly easier to access, not harder.
    if (verified.twoFactorPending) {
      return null;
    }

    return { userId: verified.userId, username: verified.username };
  } catch {
    return null;
  }
}

export interface AuthRequest extends Request {
  userId?: string;
  username?: string;
  authSource?: 'jwt' | 'pat';
  patId?: string;
  patScopes?: string[];
}

async function authenticateBearer(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  options: { optional: boolean; requiredScopes?: string[] },
) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      if (options.optional) {
        next();
        return;
      }
      res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const token = authHeader.substring(7);

    if (isPersonalAccessToken(token)) {
      const result = await validatePersonalAccessToken(token, options.requiredScopes);

      if (result === 'insufficient_scope') {
        res.status(403).json(buildErrorEnvelope('INSUFFICIENT_SCOPE', 'Personal access token lacks required scope'));
        return;
      }

      if (result === 'invalid') {
        res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Invalid token'));
        return;
      }

      req.userId = result.userId;
      req.authSource = 'pat';
      req.patId = result.tokenId;
      req.patScopes = result.scopes;
      next();
      return;
    }

    const claims = decodeToken(token);
    if (!claims) {
      res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Invalid token'));
      return;
    }

    const tokenH = hashToken(token);
    const revoked = await isSessionRevoked(tokenH);
    if (revoked) {
      res.status(401).json(buildErrorEnvelope('SESSION_REVOKED', 'Session has been revoked'));
      return;
    }

    void touchSession(tokenH);

    req.userId = claims.userId;
    req.username = claims.username;
    req.authSource = 'jwt';
    next();
  } catch (error) {
    next(error);
  }
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  void authenticateBearer(req, res, next, { optional: true });
}

/**
 * Reject personal access tokens on credential-management routes.
 *
 * A PAT is a long-lived, non-interactive credential. Without this, a leaked PAT
 * could mint further PATs, read or reset the TOTP secret, list and revoke
 * sessions, or change the account email — i.e. escalate a scoped API key into
 * full, persistent account takeover. Those actions require a real user session.
 *
 * Mount AFTER an authentication middleware.
 */
export function denyPersonalAccessTokens(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  if (req.authSource === 'pat') {
    res.status(403).json(
      buildErrorEnvelope(
        'SESSION_REQUIRED',
        'This action requires an interactive session and cannot be performed with a personal access token.',
      ),
    );
    return;
  }
  next();
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void;
export function requireAuth(requiredScopes: string[]): (req: AuthRequest, res: Response, next: NextFunction) => void;
export function requireAuth(
  reqOrScopes: AuthRequest | string[],
  res?: Response,
  next?: NextFunction,
): void | ((req: AuthRequest, res: Response, next: NextFunction) => void) {
  if (Array.isArray(reqOrScopes)) {
    const requiredScopes = reqOrScopes;
    return (req: AuthRequest, res: Response, next: NextFunction) => {
      void authenticateBearer(req, res, next, { optional: false, requiredScopes });
    };
  }

  void authenticateBearer(reqOrScopes, res!, next!, { optional: false });
}
