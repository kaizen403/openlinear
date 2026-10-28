import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { parseFields, parsePagination, pickFields } from '../lib/http';
import { makeEtag } from '../lib/etag';
import { ValidationError } from '../errors';
import { respondIdempotently } from '../services/idempotency';
import {
  WORKSPACE_STRUCTURE_VIEWS,
  authorizeAddWorkspaceMember,
  authorizeBulkAddWorkspaceMembers,
  authorizeCreateWorkspace,
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
import { logAudit } from '../services/audit';

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
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  const fields = parseFields(req.query.fields, workspaceListFields);
  // Ensures the default workspace itself when the caller has none.
  const workspaces = await listWorkspacesForUser(req.userId!);
  res.json(workspaces.map((w) => pickFields(w as unknown as Record<string, unknown>, fields)));
});

router.post('/', requireAuth, validateBody(createWorkspaceBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateWorkspaceBody>, res: Response) => {
    // Optional `Idempotency-Key` (W04b; contract as POST /api/tasks).
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'workspaces.create',
      args: { body },
      authorize: () => authorizeCreateWorkspace({ userId: req.userId!, name: body.name }),
    });
  },
);

const structureQuerySchema = z.object({
  /** `full` (default, unchanged shape) or `summary` (counts instead of member lists). */
  view: z.enum(WORKSPACE_STRUCTURE_VIEWS).default('full'),
});

const workspaceStructureFields = [
  'id', 'name', 'slug', 'plan', 'createdAt', 'updatedAt', '_count', 'members', 'projects', 'role', 'currentMember', 'view',
] as const;

router.get('/:id/structure', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = structureQuerySchema.safeParse({ view: req.query.view });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const fields = parseFields(req.query.fields, workspaceStructureFields);
  const result = await getWorkspaceStructure({
    workspaceId: req.params.id as string,
    userId: req.userId!,
    view: parsed.data.view,
  });
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.json(pickFields(result as unknown as Record<string, unknown>, fields));
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
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'workspaces.members.add',
      args: { body, params: { id } },
      authorize: () => authorizeAddWorkspaceMember({
        workspaceId: id, actorUserId: req.userId!, username: body.username, role: body.role,
      }),
    });
  },
);

router.post('/:id/members/bulk', requireAuth, validateBody(bulkWorkspaceMembersBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkWorkspaceMembersBody>, res: Response) => {
    const id = req.params.id as string;
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'workspaces.members.bulk_add',
      args: { body, params: { id } },
      authorize: () => authorizeBulkAddWorkspaceMembers({ workspaceId: id, actorUserId: req.userId!, invites: body.invites }),
    });
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
  const workspaceId = req.params.id as string;
  const targetUserId = req.params.userId as string;
  await removeWorkspaceMember({
    workspaceId, actorUserId: req.userId!,
    targetUserId,
  });
  await logAudit({
    workspaceId,
    actorId: req.userId!,
    action: 'workspace.member_removed',
    resourceType: 'workspace_member',
    resourceId: targetUserId,
    ipAddress: req.ip,
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
