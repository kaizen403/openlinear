import { Router, Response } from 'express';
import type { Prisma } from '@openlinear/db';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  assertTaskAccess,
  assertProjectAccess,
  assertTeamRole,
} from '../services/ownership';
import { ACTIVITY_COUNT_MODES, decodeActivityCursor, listActivityPage } from '../services/activity-feed';
import { ValidationError } from '../errors';
import { resolvePrincipalForUser } from '../tenancy/context';
import { scopedActivityWhere } from '../tenancy/scopes';

const router: Router = Router();

const querySchema = z.object({
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque keyset cursor from a previous page's `nextCursor`; overrides `page`. */
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return null;
      const decoded = decodeActivityCursor(raw);
      if (!decoded) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid cursor' });
        return z.NEVER;
      }
      return decoded;
    }),
  /** `exact` computes the exact total (a full count of visible activity). */
  count: z.enum(ACTIVITY_COUNT_MODES).default('none'),
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error);
  }
  const { taskId, projectId, teamId, page, pageSize, cursor, count } = parsed.data;

  if (taskId) await assertTaskAccess(taskId, req.userId!, 'view');
  if (projectId) await assertProjectAccess(projectId, req.userId!, 'view');
  if (teamId) await assertTeamRole(teamId, req.userId!, ['owner', 'admin', 'member']);

  let where: Prisma.ActivityLogWhereInput = {};

  if (taskId || projectId || teamId) {
    where = {
      ...(taskId ? { taskId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(teamId ? { teamId } : {}),
    };
  } else {
    const ctx = req.tenancy ?? await resolvePrincipalForUser(req.userId!);
    where = scopedActivityWhere(ctx);
  }

  // Same `{ items, total, page, pageSize, hasMore }` envelope as before, plus
  // `nextCursor` and `totalExact` (see services/activity-feed.ts).
  res.json(await listActivityPage({ where, page, pageSize, cursor, count }));
});

export default router;
