import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma, Prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { assertTaskAccess } from '../services/ownership';
import { getUserTeamIds } from '../services/team-scope';
import { paginated, paginationSkipTake } from '../schemas/pagination';
import { HttpError, ValidationError } from '../errors';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { persistAndDeliver } from '../events/outbox';
import { deliverToLocalClients } from '../events/hub';
import { executionSseId } from '@openlinear/execution-core';
import { validateBody, ValidatedRequest } from '../middleware/validate';

const router: Router = Router();

const agentRunSelect = {
  id: true,
  taskId: true,
  userId: true,
  agent: true,
  runner: true,
  externalSessionId: true,
  model: true,
  startedAt: true,
  endedAt: true,
  costUsd: true,
  costBasis: true,
  inputTokens: true,
  outputTokens: true,
  cachedInputTokens: true,
  cacheWriteTokens: true,
  reasoningTokens: true,
  status: true,
  prUrl: true,
  errorMessage: true,
} as const;

const listQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  userId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const createRunSchema = z.object({
  taskId: z.string().uuid(),
  agent: z.string().min(1),
  model: z.string().min(1),
  runner: z.string().min(1).optional(),
  externalSessionId: z.string().min(1).optional(),
});

const updateRunSchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  endedAt: z.string().datetime().optional(),
  costUsd: z.number().optional(),
  costBasis: z.string().nullable().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  cachedInputTokens: z.number().int().optional(),
  cacheWriteTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  prUrl: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  externalSessionId: z.string().nullable().optional(),
  runner: z.string().nullable().optional(),
});

const progressEventSchema = z.object({
  seq: z.number().int().min(0),
  type: z.string().min(1),
  at: z.string().datetime().optional(),
  payload: z.unknown().optional(),
});

const progressBodySchema = z.object({
  runId: z.string().uuid(),
  events: z.array(progressEventSchema).min(1).max(50),
});

router.get(
  '/',
  requireAuth,
  async (req: AuthRequest, res: Response) => {

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw ValidationError.fromZod(parsed.error);
    }
    const { taskId, userId, page, pageSize } = parsed.data;

    if (!taskId && !userId) {
      throw new HttpError(400, 'TASK_OR_USER_REQUIRED', 'taskId or userId is required');
    }

    const where: { taskId?: string; userId?: string; task?: { teamId: { in: string[] } } } = {};

    if (taskId) {
      await assertTaskAccess(taskId, req.userId!, 'view');
      where.taskId = taskId;
    } else if (userId) {
      const resolvedUserId = userId === 'me' ? req.userId! : userId;
      if (resolvedUserId !== req.userId!) {
        throw new HttpError(403, 'FORBIDDEN', 'Forbidden');
      }
      where.userId = resolvedUserId;
      const teamIds = await getUserTeamIds(req.userId!);
      if (teamIds.length === 0) {
        res.json(paginated([], 0, page, pageSize));
        return;
      }
      where.task = { teamId: { in: teamIds } };
    }

    const [runs, total] = await prisma.$transaction(
      async (tx) => {
        const items = await tx.agentRun.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          ...paginationSkipTake(page, pageSize),
          select: agentRunSelect,
        });
        const count = await tx.agentRun.count({ where });
        return [items, count] as const;
      },
      PRISMA_TX_OPTIONS,
    );

    res.json(paginated(runs, total, page, pageSize));
    
  },
);

router.post(
  '/',
  requireAuth(['tasks:write']),
  validateBody(createRunSchema),
  async (req: AuthRequest & ValidatedRequest<z.infer<typeof createRunSchema>>, res: Response) => {
    const body = req.validBody!;
    await assertTaskAccess(body.taskId, req.userId!, 'full');
    const created = await prisma.agentRun.create({
      data: {
        taskId: body.taskId,
        userId: req.userId!,
        agent: body.agent,
        model: body.model,
        runner: body.runner ?? body.agent,
        externalSessionId: body.externalSessionId ?? null,
        status: 'running',
      },
      select: agentRunSelect,
    });
    res.status(201).json(created);
  },
);

router.patch(
  '/:id',
  requireAuth(['tasks:write']),
  validateBody(updateRunSchema),
  async (req: AuthRequest & ValidatedRequest<z.infer<typeof updateRunSchema>>, res: Response) => {
    const id = req.params.id as string;
    const existing = await prisma.agentRun.findUnique({ where: { id }, select: { id: true, taskId: true } });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Agent run not found');
    await assertTaskAccess(existing.taskId, req.userId!, 'full');
    const body = req.validBody!;
    const data: Prisma.AgentRunUpdateInput = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.endedAt !== undefined) data.endedAt = new Date(body.endedAt);
    if (body.costUsd !== undefined) data.costUsd = body.costUsd;
    if (body.costBasis !== undefined) data.costBasis = body.costBasis;
    if (body.inputTokens !== undefined) data.inputTokens = body.inputTokens;
    if (body.outputTokens !== undefined) data.outputTokens = body.outputTokens;
    if (body.cachedInputTokens !== undefined) data.cachedInputTokens = body.cachedInputTokens;
    if (body.cacheWriteTokens !== undefined) data.cacheWriteTokens = body.cacheWriteTokens;
    if (body.reasoningTokens !== undefined) data.reasoningTokens = body.reasoningTokens;
    if (body.prUrl !== undefined) data.prUrl = body.prUrl;
    if (body.errorMessage !== undefined) data.errorMessage = body.errorMessage;
    if (body.externalSessionId !== undefined) data.externalSessionId = body.externalSessionId;
    if (body.runner !== undefined) data.runner = body.runner;
    const updated = await prisma.agentRun.update({ where: { id }, data, select: agentRunSelect });
    res.json(updated);
  },
);

router.post(
  '/progress',
  requireAuth(['tasks:write']),
  validateBody(progressBodySchema),
  async (req: AuthRequest & ValidatedRequest<z.infer<typeof progressBodySchema>>, res: Response) => {
    const { runId, events } = req.validBody!;
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        taskId: true,
        userId: true,
        task: { select: { teamId: true, workspaceId: true, creatorId: true } },
      },
    });
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Agent run not found');
    await assertTaskAccess(run.taskId, req.userId!, 'full');

    const userIds = [req.userId!, run.userId, run.task.creatorId].filter((id): id is string => Boolean(id));
    const teamIds = run.task.teamId ? [run.task.teamId] : [];
    const workspaceIds = run.task.workspaceId ? [run.task.workspaceId] : [];

    const stored: Array<{ seq: number; sseId: string }> = [];
    for (const event of events) {
      await prisma.agentRunEvent.upsert({
        where: { runId_seq: { runId, seq: event.seq } },
        create: {
          runId,
          seq: event.seq,
          type: event.type,
          at: event.at ? new Date(event.at) : new Date(),
          payload: (event.payload ?? {}) as Prisma.InputJsonValue,
        },
        update: {
          type: event.type,
          payload: (event.payload ?? {}) as Prisma.InputJsonValue,
        },
      });
      const sseId = executionSseId(runId, event.seq);
      const payload = {
        runId,
        taskId: run.taskId,
        seq: event.seq,
        type: event.type,
        payload: event.payload ?? {},
      };
      deliverToLocalClients({
        id: sseId,
        type: 'execution:progress',
        occurredAt: new Date().toISOString(),
        actorId: req.userId!,
        workspaceId: run.task.workspaceId,
        payload,
        userIds,
        teamIds,
        workspaceIds,
      });
      stored.push({ seq: event.seq, sseId });
    }

    const last = events[events.length - 1];
    if (last) {
      await persistAndDeliver({
        type: 'execution:progress',
        payload: { runId, taskId: run.taskId, seq: last.seq, type: last.type, payload: last.payload ?? {} },
        actorId: req.userId!,
        workspaceId: run.task.workspaceId,
        audience: { userIds, teamIds, workspaceIds },
      });
    }

    res.json({ ok: true, stored });
  },
);

export default router;
