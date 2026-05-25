import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { buildErrorEnvelope } from '../lib/http';
import {
  isPersonalAccessToken,
  validatePersonalAccessToken,
} from '../services/pats';
import { hashToken, isSessionRevoked, touchSession } from '../services/sessions';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Auth] JWT_SECRET is required in production');
    }
    return 'openlinear-dev-secret-change-in-production';
  }
  return secret;
}

function decodeToken(token: string): { userId: string; username: string } | null {
  try {
    const verified = jwt.verify(token, getJwtSecret()) as {
      userId: string;
      username: string;
    };
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
