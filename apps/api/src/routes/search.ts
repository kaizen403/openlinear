import { Router, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { SearchQuerySchema } from '../schemas/search';
import { ValidationError } from '../errors';
import { buildErrorEnvelope } from '../lib/http';
import { searchWorkspaceData } from '../services/search';

const router: Router = Router();

const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => {
    const userId = (req as AuthRequest).userId;
    if (userId) return userId;
    return ipKeyGenerator(req.ip ?? '', 56);
  },
  handler: (_req, res) => {
    res.status(429).json(buildErrorEnvelope(
      'RATE_LIMITED',
      'Too many requests',
      {
        details: { scope: 'search', retryAfterSeconds: 60 },
        extras: { scope: 'search', retryAfterSeconds: 60 },
      },
    ));
  },
});

router.get(
  '/',
  requireAuth,
  searchLimiter,
  async (req: AuthRequest, res: Response) => {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw ValidationError.fromZod(parsed.error);
    }

    const { q, types, limit } = parsed.data;
    const result = await searchWorkspaceData({
      userId: req.userId!,
      query: q,
      types: [...types],
      limit,
    });

    // W14: hits carry the fields agents need to act without a second lookup
    // (status, project/team ids); all additive.
    res.json({
      tasks: result.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        identifier: t.identifier,
        status: t.status,
        priority: t.priority,
        projectId: t.projectId,
        teamId: t.teamId,
        type: 'task' as const,
      })),
      projects: result.projects.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        status: p.status,
        workspaceId: p.workspaceId,
        type: 'project' as const,
      })),
      teams: result.teams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        projectId: t.projectId,
        type: 'team' as const,
      })),
    });
  },
);

export default router;
