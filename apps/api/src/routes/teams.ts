import { Router, Response } from 'express';
import { Prisma, prisma } from '@openlinear/db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { makeEtag } from '../lib/etag';
import {
  getIdempotencyRecord,
  parseFields,
  parsePagination,
  pickFields,
  replayIdempotencyRecord,
  storeIdempotencyRecord,
} from '../lib/http';
import { buildSelect } from '../lib/field-select';
import {
  addTeamMemberRoute,
  changeTeamMemberRole,
  createTeam,
  deleteTeamRoute,
  getTeam,
  joinTeamRoute,
  listTeamMembers,
  removeTeamMemberRoute,
  updateTeam,
  teamFullInclude,
  teamMemberInclude,
} from '../services/teams';
import {
  createTeamBodySchema,
  updateTeamBodySchema,
  joinTeamBodySchema,
  addMemberBodySchema,
  updateTeamMemberBodySchema,
  CreateTeamBody,
  UpdateTeamBody,
  JoinTeamBody,
  AddMemberBody,
  UpdateTeamMemberBody,
} from '../schemas/teams';

const router: Router = Router();

const teamListFields = [
  'id', 'name', 'key', 'description', 'color', 'icon', 'private', 'inviteCode',
  'nextIssueNumber', 'projectId', 'createdAt', 'updatedAt', 'members', 'project', '_count',
] as const;

const teamMemberFields = ['id', 'teamId', 'userId', 'role', 'sortOrder', 'createdAt', 'user'] as const;

const teamScalarFields = new Set<string>([
  'id', 'name', 'key', 'description', 'color', 'icon', 'private', 'inviteCode',
  'nextIssueNumber', 'projectId', 'createdAt', 'updatedAt',
]);

const teamRelationMap = {
  members: { include: teamMemberInclude },
  project: { select: { id: true, name: true, status: true, color: true, icon: true } },
  _count: { select: { members: true } },
} as const;

function buildTeamSelect(fields: string[]): Prisma.TeamSelect {
  return buildSelect(fields, teamScalarFields, teamRelationMap) as Prisma.TeamSelect;
}

function memberToRecord(member: Record<string, unknown>): Record<string, unknown> {
  return { id: member.id, teamId: member.teamId, userId: member.userId, role: member.role, sortOrder: member.sortOrder, createdAt: member.createdAt, user: member.user };
}

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (!req.userId) { res.json([]); return; }
  const fields = parseFields(req.query.fields, teamListFields);
  const projectId = req.query.projectId as string | undefined;
  const workspaceId = req.query.workspaceId as string | undefined;
  const where: Prisma.TeamWhereInput = {
    members: { some: { userId: req.userId } },
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { project: { workspaceId } } : {}),
  };
  const teams = fields
    ? await prisma.team.findMany({ where, select: buildTeamSelect(fields), orderBy: { createdAt: 'asc' } })
    : await prisma.team.findMany({ where, include: teamFullInclude, orderBy: { createdAt: 'asc' } });
  res.json(fields ? teams : teams.map((t) => pickFields({ ...t }, fields)));
});

router.post('/', requireAuth, validateBody(createTeamBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateTeamBody>, res: Response) => {
    const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/teams');
    if (replay) { replayIdempotencyRecord(res, replay); return; }
    const team = await createTeam({ userId: req.userId!, ...req.validBody! });
    storeIdempotencyRecord(req, req.userId!, 'POST /api/teams', 201, team);
    res.status(201).json(team);
  },
);

router.post('/join', requireAuth, validateBody(joinTeamBodySchema),
  async (req: AuthRequest & ValidatedRequest<JoinTeamBody>, res: Response) => {
    const replay = getIdempotencyRecord(req, req.userId!, 'POST /api/teams/join');
    if (replay) { replayIdempotencyRecord(res, replay); return; }
    const result = await joinTeamRoute({ userId: req.userId!, inviteCode: req.validBody!.inviteCode });
    storeIdempotencyRecord(req, req.userId!, 'POST /api/teams/join', 200, result);
    res.json(result);
  },
);

router.patch('/:id', requireAuth, validateBody(updateTeamBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateTeamBody>, res: Response) => {
    const team = await updateTeam({ userId: req.userId!, teamId: req.params.id as string, ...req.validBody! });
    res.json(team);
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteTeamRoute({ teamId: req.params.id as string, userId: req.userId! });
  res.status(204).send();
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const team = await getTeam({ teamId: req.params.id as string, userId: req.userId! });
  const etag = makeEtag([team.updatedAt, team._count.members]);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (req.header('If-None-Match') === etag) { res.status(304).send(); return; }
  res.json(team);
});

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  const fields = parseFields(req.query.fields, teamMemberFields);
  const { limit, cursor } = parsePagination(req.query);
  const result = await listTeamMembers({ teamId: id, userId: req.userId!, limit, cursor });
  res.json({
    data: result.data.map((m) => pickFields(memberToRecord(m as unknown as Record<string, unknown>), fields)),
    nextCursor: result.nextCursor,
  });
});

router.post('/:id/members', requireAuth, validateBody(addMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<AddMemberBody>, res: Response) => {
    const id = req.params.id as string;
    const replay = getIdempotencyRecord(req, req.userId!, `POST /api/teams/${id}/members`);
    if (replay) { replayIdempotencyRecord(res, replay); return; }
    const { email, userId, role } = req.validBody!;
    const member = await addTeamMemberRoute({ teamId: id, actorUserId: req.userId!, email, userId, role });
    storeIdempotencyRecord(req, req.userId!, `POST /api/teams/${id}/members`, 201, member);
    res.status(201).json(member);
  },
);

router.patch('/:id/members/:userId', requireAuth, validateBody(updateTeamMemberBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateTeamMemberBody>, res: Response) => {
    const member = await changeTeamMemberRole({
      teamId: req.params.id as string, actorUserId: req.userId!,
      targetUserId: req.params.userId as string, role: req.validBody!.role,
    });
    res.json(member);
  },
);

router.delete('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  await removeTeamMemberRoute({
    teamId: req.params.id as string, actorUserId: req.userId!,
    targetUserId: req.params.userId as string,
  });
  res.status(204).send();
});

export default router;
