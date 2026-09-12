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

    res.json({
      tasks: result.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        identifier: t.identifier,
        type: 'task' as const,
      })),
      projects: result.projects.map((p) => ({
        id: p.id,
        name: p.name,
        type: 'project' as const,
      })),
      teams: result.teams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        type: 'team' as const,
      })),
    });
  },
);

export default router;
