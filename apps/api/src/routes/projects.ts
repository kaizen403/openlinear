import { Router, Request, Response } from 'express';
import { Prisma } from '@openlinear/db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { HttpError } from '../errors';
import { makeEtag } from '../lib/etag';
import {
  getIdempotencyRecord,
  parseFields,
  pickFields,
  replayIdempotencyRecord,
  storeIdempotencyRecord,
} from '../lib/http';
import { buildSelect } from '../lib/field-select';
import {
  buildAccessibleProjectsWhere,
  createProjectFull,
  deleteProject,
  getProject,
  grantProjectAccess,
  grantProjectAccessBulk,
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
  BulkProjectAccessBody,
  CreateProjectBody,
  UpdateProjectBody,
  ListProjectsQuery,
  ProjectAccessBody,
} from '../schemas/projects';
import { prisma } from '@openlinear/db';

const router: Router = Router();

function isDesktopClient(req: Request): boolean {
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

router.post('/', requireAuth, validateBody(createProjectBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateProjectBody>, res: Response) => {
    const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/projects');
    if (replay) { replayIdempotencyRecord(res, replay); return; }

    const { workspaceId, key, teamIds, startDate, targetDate, repoUrl, repositoryId, defaultBranch, localPath, ...rest } = req.validBody!;
    const project = await createProjectFull({
      userId: req.userId!, isDesktopClient: isDesktopClient(req),
      workspaceId, key, teamIds, startDate, targetDate, repoUrl, repositoryId, defaultBranch, localPath, ...rest,
    });

    storeIdempotencyRecord(req, req.userId!, 'POST /api/projects', 201, project);
    res.status(201).json(project);
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

// ─── GET /:id/access ─────────────────────────────────────────────────────────

router.get('/:id/access', requireAuth, async (req: AuthRequest, res: Response) => {
  const access = await listProjectAccess({ projectId: req.params.id as string, userId: req.userId! });
  res.json(access);
});

// ─── POST /:id/access ────────────────────────────────────────────────────────

router.post('/:id/access', requireAuth, validateBody(projectAccessBodySchema),
  async (req: AuthRequest & ValidatedRequest<ProjectAccessBody>, res: Response) => {
    const id = req.params.id as string;
    const replay = getIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access`);
    if (replay) { replayIdempotencyRecord(res, replay); return; }

    const { userId, permission } = req.validBody!;
    const { access, isNew } = await grantProjectAccess({ projectId: id, actorUserId: req.userId!, userId, permission });
    const status = isNew ? 201 : 200;
    storeIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access`, status, access);
    res.status(status).json(access);
  },
);

// ─── POST /:id/access/bulk ───────────────────────────────────────────────────

router.post('/:id/access/bulk', requireAuth, validateBody(bulkProjectAccessBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkProjectAccessBody>, res: Response) => {
    const id = req.params.id as string;
    const replay = getIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access/bulk`);
    if (replay) { replayIdempotencyRecord(res, replay); return; }

    const result = await grantProjectAccessBulk({ projectId: id, actorUserId: req.userId!, grants: req.validBody!.grants });
    storeIdempotencyRecord(req, req.userId!, `POST /api/projects/${id}/access/bulk`, 200, result);
    res.json(result);
  },
);

// ─── DELETE /:id/access/:userId ──────────────────────────────────────────────

router.delete('/:id/access/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  await revokeProjectAccess({ projectId: req.params.id as string, actorUserId: req.userId!, targetUserId: req.params.userId as string });
  res.status(204).send();
});

export default router;
