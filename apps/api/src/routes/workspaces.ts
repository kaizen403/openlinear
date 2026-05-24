import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import {
  getIdempotencyRecord,
  parseFields,
  parsePagination,
  pickFields,
  replayIdempotencyRecord,
  storeIdempotencyRecord,
} from '../lib/http';
import { makeEtag } from '../lib/etag';
import { ensureDefaultWorkspaceForUser } from '../services/workspaces';
import {
  addWorkspaceMember,
  bulkAddWorkspaceMembers,
  createWorkspaceRoute,
  deleteWorkspaceRoute,
  getWorkspaceStructure,
  listWorkspaceMembers,
  listWorkspacesForUser,
  removeWorkspaceMember,
  updateWorkspaceMember,
  updateWorkspaceRoute,
} from '../services/workspaces';
import {
  addWorkspaceMemberBodySchema,
  bulkWorkspaceMembersBodySchema,
  createWorkspaceBodySchema,
  updateWorkspaceBodySchema,
  updateWorkspaceMemberBodySchema,
  AddWorkspaceMemberBody,
  BulkWorkspaceMembersBody,
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceMemberBody,
} from '../schemas/workspaces';

const router: Router = Router();

const workspaceListFields = [
  'id', 'name', 'slug', 'plan', 'createdAt', 'updatedAt', 'role', 'invitedAt', 'joinedAt', '_count',
] as const;

const workspaceMemberFields = [
  'id', 'workspaceId', 'userId', 'role', 'invitedAt', 'joinedAt', 'user',
] as const;

function memberToRecord(member: Record<string, unknown>): Record<string, unknown> {
  return {
    id: member.id, workspaceId: member.workspaceId, userId: member.userId,
    role: member.role, invitedAt: member.invitedAt, joinedAt: member.joinedAt, user: member.user,
  };
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  await ensureDefaultWorkspaceForUser(req.userId!);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  const fields = parseFields(req.query.fields, workspaceListFields);
  const workspaces = await listWorkspacesForUser(req.userId!);
  res.json(workspaces.map((w) => pickFields(w as unknown as Record<string, unknown>, fields)));
});

router.post('/', requireAuth, validateBody(createWorkspaceBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateWorkspaceBody>, res: Response) => {
    const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/workspaces');
    if (replay) { replayIdempotencyRecord(res, replay); return; }
    const detail = await createWorkspaceRoute({ userId: req.userId!, name: req.validBody!.name });
    storeIdempotencyRecord(req, req.userId!, 'POST /api/workspaces', 201, detail);
    res.status(201).json(detail);
  },
);

router.get('/:id/structure', requireAuth, async (req: AuthRequest, res: Response) => {
  const result = await getWorkspaceStructure({ workspaceId: req.params.id as string, userId: req.userId! });
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.json(result);
});

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  const fields = parseFields(req.query.fields, workspaceMemberFields);
  const { limit, cursor } = parsePagination(req.query);
  const result = await listWorkspaceMembers({ workspaceId: id, userId: req.userId!, limit, cursor });
  res.json({
    data: result.data.map((m) => pickFields(memberToRecord(m as unknown as Record<string, unknown>), fields)),
    nextCursor: result.nextCursor,
  });
});

router.post('/:id/members', requireAuth, validateBody(addWorkspaceMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<AddWorkspaceMemberBody>, res: Response) => {
    const id = req.params.id as string;
    const replay = getIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members`);
    if (replay) { replayIdempotencyRecord(res, replay); return; }
    const { username, role } = req.validBody!;
    const { member, isNew } = await addWorkspaceMember({ workspaceId: id, actorUserId: req.userId!, username, role });
    const status = isNew ? 201 : 200;
    storeIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members`, status, member);
    res.status(status).json(member);
  },
);

router.post('/:id/members/bulk', requireAuth, validateBody(bulkWorkspaceMembersBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkWorkspaceMembersBody>, res: Response) => {
    const id = req.params.id as string;
    const replay = getIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members/bulk`);
    if (replay) { replayIdempotencyRecord(res, replay); return; }
    const result = await bulkAddWorkspaceMembers({ workspaceId: id, actorUserId: req.userId!, invites: req.validBody!.invites });
    storeIdempotencyRecord(req, req.userId!, `POST /api/workspaces/${id}/members/bulk`, 201, result);
    res.status(201).json(result);
  },
);

router.patch('/:id/members/:userId', requireAuth, validateBody(updateWorkspaceMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateWorkspaceMemberBody>, res: Response) => {
    const member = await updateWorkspaceMember({
      workspaceId: req.params.id as string, actorUserId: req.userId!,
      targetUserId: req.params.userId as string, role: req.validBody!.role,
    });
    res.json(member);
  },
);

router.delete('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  await removeWorkspaceMember({
    workspaceId: req.params.id as string, actorUserId: req.userId!,
    targetUserId: req.params.userId as string,
  });
  res.status(204).send();
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const detail = await listWorkspacesForUser(req.userId!);
  const workspace = detail.find((w) => w.id === req.params.id);
  if (!workspace) {
    const { getWorkspaceForUser } = await import('../services/workspaces');
    const ws = await getWorkspaceForUser(req.params.id as string, req.userId!);
    const etag = makeEtag([ws.updatedAt, ws._count.members, ws._count.projects]);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.header('If-None-Match') === etag) { res.status(304).send(); return; }
    res.json(ws);
    return;
  }
  const { getWorkspaceForUser } = await import('../services/workspaces');
  const ws = await getWorkspaceForUser(req.params.id as string, req.userId!);
  const etag = makeEtag([ws.updatedAt, ws._count.members, ws._count.projects]);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (req.header('If-None-Match') === etag) { res.status(304).send(); return; }
  res.json(ws);
});

router.patch('/:id', requireAuth, validateBody(updateWorkspaceBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateWorkspaceBody>, res: Response) => {
    const detail = await updateWorkspaceRoute({ workspaceId: req.params.id as string, userId: req.userId!, data: req.validBody! });
    res.json(detail);
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteWorkspaceRoute({ workspaceId: req.params.id as string, userId: req.userId! });
  res.status(204).send();
});

export default router;
