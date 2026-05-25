import { type Request, type Response, type NextFunction } from 'express';
import { prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import {
  type AppAbility,
  type AppAction,
  type AppSubject,
  buildAbilityFromPermissions,
  collectEffectivePermissions,
} from '../services/ability-builder';

declare global {
  namespace Express {
    interface Request {
      ability?: AppAbility;
    }
  }
}

/**
 * Query the database for a user's memberships (workspace, team, and project)
 * and build a CASL Ability from the union of all effective permissions.
 *
 * - Custom roles (`roleRef`) take precedence.
 * - When `roleId` is null, the base enum role (WorkspaceRole / TeamRole)
 *   supplies sensible default permissions.
 */
export async function defineAbilityFor(userId: string): Promise<AppAbility> {
  const [workspaceMembers, teamMembers, projectAccess] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      select: {
        role: true,
        roleRef: { select: { permissions: true } },
      },
    }),
    prisma.teamMember.findMany({
      where: { userId },
      select: {
        role: true,
        roleRef: { select: { permissions: true } },
      },
    }),
    prisma.projectAccess.findMany({
      where: { userId },
      select: {
        roleRef: { select: { permissions: true } },
      },
    }),
  ]);

  const permissions = collectEffectivePermissions(
    workspaceMembers,
    teamMembers,
    projectAccess,
  );

  return buildAbilityFromPermissions(permissions);
}

/**
 * Express middleware factory that checks whether the authenticated user
 * has the requested CASL action on the given subject.
 *
 * Usage:
 *   router.post('/tasks', requirePermission('create', 'Task'), handler);
 *
 * The middleware expects `req.userId` to be set by upstream auth
 * (e.g. `requireAuth`). It attaches `req.ability` so downstream
 * handlers can perform fine-grained checks if needed.
 */
export function requirePermission(
  action: AppAction,
  subject: AppSubject,
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const userId = (req as Request & { userId?: string }).userId;
      if (!userId) {
        next(new HttpError(401, 'UNAUTHORIZED', 'Authentication required'));
        return;
      }

      const ability = await defineAbilityFor(userId);
      req.ability = ability;

      if (!ability.can(action, subject)) {
        next(
          new HttpError(
            403,
            'FORBIDDEN',
            `Permission denied: ${action} ${subject}`,
          ),
        );
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
