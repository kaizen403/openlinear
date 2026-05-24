import { Router, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getUserTeamIds } from '../services/team-scope';
import { SearchQuerySchema } from '../schemas/search';
import { ValidationError } from '../errors';
import { buildErrorEnvelope } from '../lib/http';

const router: Router = Router();

// Per-user rate limit: 30 req/min, keyed off authenticated userId.
// Falls back to the express-rate-limit ipKeyGenerator helper, which
// normalizes IPv6 addresses to a /64 subnet so individual IPv6 clients
// can't bypass the limit by rotating addresses.
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

interface TaskHit {
  id: string;
  title: string;
  identifier: string | null;
  type: 'task';
}

interface ProjectHit {
  id: string;
  name: string;
  type: 'project';
}

interface TeamHit {
  id: string;
  name: string;
  key: string;
  type: 'team';
}

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
    const userTeamIds = await getUserTeamIds(req.userId!);

    // Distribute the limit across requested types (e.g. 20 / 3 ≈ 7,7,6)
    const perType = Math.max(1, Math.floor(limit / types.length));
    const wantTasks = types.includes('tasks');
    const wantProjects = types.includes('projects');
    const wantTeams = types.includes('teams');

    // Short-circuit when user has no team memberships:
    // tasks + projects scoped via teams will be empty, but team search
    // (scoped via TeamMember) is also vacuously empty.
    const hasTeams = userTeamIds.length > 0;

    const [taskRows, projectRows, teamRows] = await Promise.all([
      wantTasks && hasTeams
        ? prisma.task.findMany({
            where: {
              archived: false,
              teamId: { in: userTeamIds },
              OR: [
                { title: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
                { identifier: { contains: q, mode: 'insensitive' } },
              ],
            },
            select: {
              id: true,
              title: true,
              identifier: true,
            },
            orderBy: { updatedAt: 'desc' },
            take: perType,
          })
        : Promise.resolve([]),
      wantProjects && hasTeams
        ? prisma.project.findMany({
            where: {
              teams: {
                some: { id: { in: userTeamIds } },
              },
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            },
            select: {
              id: true,
              name: true,
            },
            orderBy: { updatedAt: 'desc' },
            take: perType,
          })
        : Promise.resolve([]),
      wantTeams
        ? prisma.team.findMany({
            where: {
              members: { some: { userId: req.userId! } },
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { key: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            },
            select: {
              id: true,
              name: true,
              key: true,
            },
            orderBy: { name: 'asc' },
            take: perType,
          })
        : Promise.resolve([]),
    ]);

    const tasks: TaskHit[] = taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      identifier: t.identifier,
      type: 'task',
    }));
    const projects: ProjectHit[] = projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      type: 'project',
    }));
    const teams: TeamHit[] = teamRows.map((t) => ({
      id: t.id,
      name: t.name,
      key: t.key,
      type: 'team',
    }));

    res.json({ tasks, projects, teams });
    
  },
);

export default router;
