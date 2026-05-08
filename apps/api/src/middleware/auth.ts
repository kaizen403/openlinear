import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const claims = decodeToken(authHeader.substring(7));
    if (claims) {
      req.userId = claims.userId;
      req.username = claims.username;
    }
  }

  next();
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const claims = decodeToken(authHeader.substring(7));
  if (!claims) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  req.userId = claims.userId;
  req.username = claims.username;
  next();
}
