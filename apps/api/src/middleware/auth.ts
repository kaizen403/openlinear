import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { buildErrorEnvelope } from '../lib/http';
import {
  isPersonalAccessToken,
  lookupPersonalAccessToken,
  recordPersonalAccessTokenUse,
  type PatClaims,
} from '../services/pats';
import { getSessionState, hashToken, touchSession } from '../services/sessions';
import { getJwtSecret } from '../lib/secrets';
import { enterTenancy, resolveTenancyContext, type TenancyContext } from '../tenancy';
import { hasRequiredScopes, JWT_AUDIENCE, JWT_ISSUER } from '@openlinear/api-core';
import { isPatCallable, resolveRequestDeclaration } from '../registry';

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

/**
 * Verify a bearer access JWT (signature, expiry, `typ`, and `iss`/`aud` when
 * required). Does not check session revocation. Shared with the SSE route so
 * both apply the same claim rules.
 */
export function verifyAccessToken(token: string): { userId: string; username: string } | null {
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

    if (typeof verified.userId !== 'string' || !verified.userId) return null;
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
  /** Workspace the PAT is bound to; `null` for account-wide PATs and sessions. */
  patWorkspaceId?: string | null;
  /** `Session.id` behind a session JWT; `null` for PATs and sessionless tokens. */
  sessionId?: string | null;
  /** The request principal (W02a PrincipalContext), built once per request. */
  tenancy?: TenancyContext;
}

interface AuthOptions {
  optional: boolean;
  /** Extra scopes a route passes to `requireAuth([...])`; added to the registry's. */
  requiredScopes?: string[];
  sessionOnly?: boolean;
}

type PatDecision =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

/**
 * PAT authorization (W02b). The route registry is the single source of truth:
 * the matched route's declaration decides whether a PAT may call it at all,
 * which scopes it needs and whether a workspace-bound PAT may reach it.
 * Routes without a declaration refuse PATs (default deny), so a new route is
 * unreachable by API keys until someone declares its PAT behaviour.
 */
function authorizePat(req: Request, claims: PatClaims, inlineScopes: string[] | undefined): PatDecision {
  const declaration = resolveRequestDeclaration(req);
  if (!declaration) {
    return {
      ok: false,
      status: 403,
      code: 'PAT_ROUTE_UNDECLARED',
      message: 'This route does not accept personal access tokens.',
    };
  }
  if (!isPatCallable(declaration)) {
    return {
      ok: false,
      status: 403,
      code: 'SESSION_REQUIRED',
      message: 'This action requires an interactive session and cannot be performed with a personal access token.',
    };
  }
  const required = [...new Set([...declaration.patScopes, ...(inlineScopes ?? [])])];
  if (!hasRequiredScopes(claims.scopes, required)) {
    return {
      ok: false,
      status: 403,
      code: 'INSUFFICIENT_SCOPE',
      message: 'Personal access token lacks required scope',
      details: { requiredScopes: required },
    };
  }
  if (claims.workspaceId && declaration.workspaceBinding === 'refused') {
    return {
      ok: false,
      status: 403,
      code: 'PAT_WORKSPACE_RESTRICTED',
      message: 'This account-level resource is not available to a workspace-bound personal access token.',
    };
  }
  return { ok: true };
}

async function authenticateBearer(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  options: AuthOptions,
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

      const claims = await lookupPersonalAccessToken(token);
      if (!claims) {
        res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Invalid token'));
        return;
      }

      const decision = authorizePat(req, claims, options.requiredScopes);
      if (!decision.ok) {
        res.status(decision.status).json(
          buildErrorEnvelope(decision.code, decision.message, decision.details ? { details: decision.details } : {}),
        );
        return;
      }

      recordPersonalAccessTokenUse(claims.tokenId);
      req.userId = claims.userId;
      req.authSource = 'pat';
      req.patId = claims.tokenId;
      req.patScopes = claims.scopes;
      req.patWorkspaceId = claims.workspaceId;
      req.sessionId = null;
      await bindTenancy(req, next);
      return;
    }

    const claims = verifyAccessToken(token);
    if (!claims) {
      res.status(401).json(buildErrorEnvelope('UNAUTHORIZED', 'Invalid token'));
      return;
    }

    const tokenH = hashToken(token);
    const session = await getSessionState(tokenH);
    if (session.revoked) {
      res.status(401).json(buildErrorEnvelope('SESSION_REVOKED', 'Session has been revoked'));
      return;
    }

    void touchSession(tokenH);

    req.userId = claims.userId;
    req.username = claims.username;
    req.authSource = 'jwt';
    req.sessionId = session.sessionId;
    await bindTenancy(req, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Build the request principal once and bind it to the async context. Every
 * downstream policy helper (`assert*Access`, scoped where-builders, chat
 * tools, sidecar ownership checks) reads PAT scopes and workspace binding
 * from here rather than re-deriving an unrestricted context from `userId`.
 */
async function bindTenancy(req: AuthRequest, next: NextFunction): Promise<void> {
  if (!req.userId) {
    next();
    return;
  }
  try {
    const isPat = req.authSource === 'pat';
    const ctx = await resolveTenancyContext({
      userId: req.userId,
      authSource: req.authSource ?? 'jwt',
      scopes: req.patScopes ?? [],
      credentialId: isPat ? req.patId ?? null : null,
      workspaceRestriction: isPat ? req.patWorkspaceId ?? null : null,
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
