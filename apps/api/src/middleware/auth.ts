import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

/** Lazy read to avoid ESM module-load-time race with dotenv */
function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'openlinear-dev-secret-change-in-production';
}

export interface AuthRequest extends Request {
  userId?: string;
  username?: string;
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, getJwtSecret()) as { userId: string; username: string };
      req.userId = decoded.userId;
      req.username = decoded.username;
    } catch {
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

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, getJwtSecret()) as { userId: string; username: string };
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
