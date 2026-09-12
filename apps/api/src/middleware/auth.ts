import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { buildErrorEnvelope } from '../lib/http';
import {
  isPersonalAccessToken,
  validatePersonalAccessToken,
} from '../services/pats';
import { hashToken, isSessionRevoked, touchSession } from '../services/sessions';
import { getJwtSecret } from '../lib/secrets';
import { enterTenancy, resolveTenancyContext, type TenancyContext } from '../tenancy';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  defaultPatScopesForMethod,
} from '@openlinear/api-core';

interface JwtClaims {
  userId: string;
  username: string;
  iss?: string;
  aud?: string | string[];
  typ?: string;
  jti?: string;
  /**
   * Legacy 2FA-pending JWTs. New challenges are opaque DB rows; this claim is
   * still rejected so old pending tokens cannot authenticate.
   */
  twoFactorPending?: boolean;
}

function audienceMatches(aud: string | string[] | undefined): boolean {
  if (aud === undefined) return false;
  if (typeof aud === 'string') return aud === JWT_AUDIENCE;
  return aud.includes(JWT_AUDIENCE);
}

function decodeToken(token: string): { userId: string; username: string } | null {
  try {
    const verified = jwt.verify(token, getJwtSecret()) as JwtClaims;

    if (verified.twoFactorPending) {
      return null;
    }

    if (verified.typ && verified.typ !== 'access') {
      return null;
    }

    const requireClaims =
      process.env.NODE_ENV === 'production' || process.env.OPENLINEAR_REQUIRE_JWT_CLAIMS === '1';
    if (requireClaims) {
      if (verified.iss !== JWT_ISSUER || !audienceMatches(verified.aud)) {
        return null;
      }
    } else if (verified.iss || verified.aud) {
      if (verified.iss && verified.iss !== JWT_ISSUER) return null;
      if (verified.aud && !audienceMatches(verified.aud)) return null;
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
  tenancy?: TenancyContext;
}

async function authenticateBearer(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  options: { optional: boolean; requiredScopes?: string[]; sessionOnly?: boolean },
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
      if (options.sessionOnly) {
        res.status(403).json(
          buildErrorEnvelope(
            'SESSION_REQUIRED',
            'This action requires an interactive session and cannot be performed with a personal access token.',
          ),
        );
        return;
      }
      const requiredScopes =
        options.requiredScopes && options.requiredScopes.length > 0
          ? options.requiredScopes
          : defaultPatScopesForMethod(req.method);
      const result = await validatePersonalAccessToken(token, requiredScopes);

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
      await bindTenancy(req, next);
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
    await bindTenancy(req, next);
  } catch (error) {
    next(error);
  }
}

async function bindTenancy(req: AuthRequest, next: NextFunction): Promise<void> {
  if (!req.userId) {
    next();
    return;
  }
  try {
    const ctx = await resolveTenancyContext({
      userId: req.userId,
      authSource: req.authSource ?? 'jwt',
      scopes: req.patScopes ?? [],
    });
    req.tenancy = ctx;
    enterTenancy(ctx);
    next();
  } catch (err) {
    next(err);
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

/**
 * Session cookie / JWT only. A PAT is rejected with SESSION_REQUIRED *before*
 * scope checks, so a leaked read-only key cannot look like a missing write
 * scope on credential-management routes.
 */
export function requireInteractiveSession(req: AuthRequest, res: Response, next: NextFunction): void {
  void authenticateBearer(req, res, next, { optional: false, sessionOnly: true });
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
