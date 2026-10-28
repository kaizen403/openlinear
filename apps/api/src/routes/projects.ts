import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Prisma } from '@openlinear/db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { HttpError } from '../errors';
import { makeEtag } from '../lib/etag';
import { buildErrorEnvelope, parseFields } from '../lib/http';
import { buildSelect } from '../lib/field-select';
import { respondIdempotently } from '../services/idempotency';
import {
  authorizeCreateProjectFull,
  authorizeGrantProjectAccess,
  authorizeGrantProjectAccessBulk,
  buildAccessibleProjectsWhere,
  deleteProject,
  getProject,
  listProjectAccess,
  projectInclude,
  revokeProjectAccess,
  updateProjectFull,
  type ProjectWithInclude,
} from '../services/projects';
import {
  bulkProjectAccessBodySchema,
  createProjectBodySchema,
  updateProjectBodySchema,
  listProjectsQuerySchema,
  projectAccessBodySchema,
  projectVerificationSettingsBodySchema,
  BulkProjectAccessBody,
  CreateProjectBody,
  UpdateProjectBody,
  ListProjectsQuery,
  ProjectAccessBody,
  ProjectVerificationSettingsBody,
} from '../schemas/projects';
import { prisma } from '@openlinear/db';
import { getProjectVerificationSettings, updateProjectVerificationSettings } from '../services/execution-verification';
import { exportFileName, exportProject } from '../services/project-export';

const router: Router = Router();

/**
 * May this request set or change `localPath` (a directory on the caller's
 * machine the local sidecar runs agents in)?
 *
 * Only an interactive session may (W02b). The `x-openlinear-client: desktop`
 * header used to be the whole decision, but any HTTP client can send it, so a
 * personal access token (MCP, scripts, a leaked key) could point execution at
 * an arbitrary local directory. The header is kept as a client hint (the web
 * UI does not send it); it no longer authorizes anything on its own.
 */
function isDesktopClient(req: AuthRequest): boolean {
  if (req.authSource !== 'jwt') return false;
  const header = req.header('x-openlinear-client');
  return typeof header === 'string' && header.toLowerCase() === 'desktop';
}

const projectListFields = [
  'id', 'workspaceId', 'key', 'name', 'description', 'status', 'color', 'icon',
  'startDate', 'targetDate', 'leadId', 'repositoryId', 'localPath', 'repoUrl',
  'createdAt', 'updatedAt', 'teams', 'repository', 'workspace', '_count',
] as const;

const projectScalarFields = new Set<string>([
  'id', 'workspaceId', 'key', 'name', 'description', 'status', 'color', 'icon',
  'startDate', 'targetDate', 'leadId', 'repositoryId', 'localPath', 'repoUrl',
  'createdAt', 'updatedAt',
]);

const projectRelationMap = {
  teams: true,
  repository: { select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true } },
  workspace: { select: { id: true, name: true, slug: true, plan: true } },
  _count: { select: { tasks: true } },
} as const;

function buildProjectSelect(fields: string[]) {
  return buildSelect(fields, projectScalarFields, projectRelationMap) as Prisma.ProjectSelect;
}

function matchesEtag(req: Request, etag: string): boolean {
  return req.header('if-none-match')?.split(',').map((v) => v.trim()).includes(etag) ?? false;
}

// ─── GET / ───────────────────────────────────────────────────────────────────

router.get('/', optionalAuth, validateQuery(listProjectsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListProjectsQuery>, res: Response) => {
    const { teamId, workspaceId } = req.validQuery ?? {};
    const fields = parseFields(req.query.fields, projectListFields);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (!req.userId) { res.json([]); return; }

    const where = await buildAccessibleProjectsWhere(req.userId, { teamId, workspaceId });
    const projects = fields
      ? await prisma.project.findMany({ where, select: buildProjectSelect(fields), orderBy: { createdAt: 'desc' } })
      : await prisma.project.findMany({ where, include: projectInclude, orderBy: { createdAt: 'desc' } });

    res.json(fields ? projects : projects.map((p) => p));
  },
);

// ─── POST / ──────────────────────────────────────────────────────────────────

// The three creates below honour an optional `Idempotency-Key` (W04b, same
// contract as POST /api/tasks): equal retries replay, a different request
// with the same key gets 409 IDEMPOTENCY_CONFLICT.
router.post('/', requireAuth, validateBody(createProjectBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateProjectBody>, res: Response) => {
    const body = req.validBody!;
    const desktop = isDesktopClient(req);
    const { workspaceId, key, teamIds, startDate, targetDate, repoUrl, repositoryId, defaultBranch, localPath, ...rest } = body;
    await respondIdempotently(req, res, {
      operation: 'projects.create',
      // The desktop flag changes what the request may do (localPath).
      args: { body, params: { client: desktop ? 'desktop' : 'web' } },
      authorize: () => authorizeCreateProjectFull({
        userId: req.userId!, isDesktopClient: desktop,
        workspaceId, key, teamIds, startDate, targetDate, repoUrl, repositoryId, defaultBranch, localPath, ...rest,
      }),
    });
  },
);

// ─── GET /:id ────────────────────────────────────────────────────────────────

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  if (!req.userId) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  const project = await getProject({ projectId: req.params.id as string, userId: req.userId }) as ProjectWithInclude;
  const etag = makeEtag([project.updatedAt, project._count.tasks, project.teams.length]);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (matchesEtag(req, etag)) { res.status(304).send(); return; }
  res.json(project);
});

// ─── PATCH /:id ──────────────────────────────────────────────────────────────

router.patch('/:id', requireAuth, validateBody(updateProjectBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateProjectBody>, res: Response) => {
    const { teamIds, startDate, targetDate, repoUrl, localPath, workspaceId, key, ...updateData } = req.validBody!;
    const project = await updateProjectFull({
      userId: req.userId!, projectId: req.params.id as string, isDesktopClient: isDesktopClient(req),
      bodyFields: Object.keys(req.validBody!), teamIds, startDate, targetDate, repoUrl, localPath, workspaceId, key, ...updateData,
    });
    res.json(project);
  },
);

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteProject({ projectId: req.params.id as string, userId: req.userId! });
  res.status(204).send();
});

// ─── GET/PUT /:id/verification-settings (W11a) ───────────────────────────────

router.get('/:id/verification-settings', requireAuth, async (req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getProjectVerificationSettings({ projectId: req.params.id as string, userId: req.userId! }));
});

router.put('/:id/verification-settings', requireAuth, validateBody(projectVerificationSettingsBodySchema),
  async (req: AuthRequest & ValidatedRequest<ProjectVerificationSettingsBody>, res: Response) => {
    res.json(await updateProjectVerificationSettings({ projectId: req.params.id as string, userId: req.userId!, body: req.validBody! }));
  },
);

// ─── GET /:id/export (FE-16) ────────────────────────────────────────────────

/** The export is built in memory (bounded, services/project-export.ts): a few per minute per person. */
const exportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 2,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => (req as AuthRequest).userId ?? ipKeyGenerator(req.ip ?? '', 56),
  handler: (_req, res) => {
    res.status(429).json(buildErrorEnvelope('RATE_LIMITED', 'Too many exports; try again in a minute', {
      details: { scope: 'project-export', retryAfterSeconds: 60 },
      extras: { scope: 'project-export', retryAfterSeconds: 60 },
    }));
  },
});

router.get('/:id/export', requireAuth, exportLimiter, async (req: AuthRequest, res: Response) => {
  const bundle = await exportProject({ projectId: req.params.id as string, userId: req.userId! });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(bundle.project.key, bundle.project.name, new Date(bundle.exportedAt))}"`);
  res.json(bundle);
});

// ─── GET /:id/access ─────────────────────────────────────────────────────────

router.get('/:id/access', requireAuth, async (req: AuthRequest, res: Response) => {
  const access = await listProjectAccess({ projectId: req.params.id as string, userId: req.userId! });
  res.json(access);
});

// ─── POST /:id/access ────────────────────────────────────────────────────────

router.post('/:id/access', requireAuth, validateBody(projectAccessBodySchema),
  async (req: AuthRequest & ValidatedRequest<ProjectAccessBody>, res: Response) => {
    const id = req.params.id as string;
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'projects.access.grant',
      args: { body, params: { id } },
      authorize: () => authorizeGrantProjectAccess({
        projectId: id, actorUserId: req.userId!, userId: body.userId, permission: body.permission,
      }),
    });
  },
);

// ─── POST /:id/access/bulk ───────────────────────────────────────────────────

router.post('/:id/access/bulk', requireAuth, validateBody(bulkProjectAccessBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkProjectAccessBody>, res: Response) => {
    const id = req.params.id as string;
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'projects.access.bulk_grant',
      args: { body, params: { id } },
      authorize: () => authorizeGrantProjectAccessBulk({ projectId: id, actorUserId: req.userId!, grants: body.grants }),
    });
  },
);

// ─── DELETE /:id/access/:userId ──────────────────────────────────────────────

router.delete('/:id/access/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  await revokeProjectAccess({ projectId: req.params.id as string, actorUserId: req.userId!, targetUserId: req.params.userId as string });
  res.status(204).send();
});

export default router;
