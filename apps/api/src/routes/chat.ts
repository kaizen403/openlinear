import { Router, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Prisma, prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { HttpError } from '../errors';
import { buildErrorEnvelope } from '../lib/http';
import { loadChatBudgetConfig } from '../lib/chat-budget-config';
import {
  memberBudgetBodySchema,
  revokeConfirmationBodySchema,
  workspaceBudgetBodySchema,
  type MemberBudgetBody,
  type RevokeConfirmationBody,
  type WorkspaceBudgetBody,
} from '../lib/chat-schemas';
import { logAudit } from '../services/audit';
import { assertProjectAccess, OwnershipError } from '../services/ownership';
import { assertWorkspaceRole } from '../services/workspaces';
import { prepareChatTurn, runChatTurn, type ChatChunk } from '../services/chat';
import { chatBudgetStatus } from '../services/chat-budget';
import { sessionHistoryExtras, withToolCallStates } from '../services/chat-history';
import { revokeConfirmation } from '../services/chat-tools/confirmations';
import { resolvePrincipalForUser } from '../tenancy/context';
import { scopedProjectWhere } from '../tenancy/scopes';
import {
  chatMessagesQuerySchema,
  chatSessionListQuerySchema,
  createChatSessionBodySchema,
  sendChatMessageBodySchema,
  updateChatSessionBodySchema,
  type ChatMessagesQuery,
  type ChatSessionListQuery,
  type CreateChatSessionBody,
  type SendChatMessageBody,
  type UpdateChatSessionBody,
} from '../schemas/chat';

const router: Router = Router();

const chatMessageLimiter = rateLimit({
  windowMs: 60_000,
  limit: () => {
    const raw = process.env.CHAT_RATE_LIMIT_PER_MIN;
    const parsed = raw ? Number.parseInt(raw, 10) : 60;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => {
    const userId = (req as AuthRequest).userId;
    return userId ?? ipKeyGenerator(req.ip ?? '', 56);
  },
  handler: (_req, res) => {
    res.status(429).json(buildErrorEnvelope(
      'RATE_LIMITED',
      'Too many chat messages',
      {
        details: { scope: 'chat', retryAfterSeconds: 60 },
        extras: { scope: 'chat', retryAfterSeconds: 60 },
      },
    ));
  },
});

type AuthValidated<TBody = unknown, TQuery = unknown> = AuthRequest & ValidatedRequest<TBody, TQuery>;

async function assertProjectInWorkspace(projectId: string, workspaceId: string, userId: string): Promise<void> {
  await assertProjectAccess(projectId, userId, 'view');
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!project) throw new OwnershipError('project', projectId, 'not_found');
  if (project.workspaceId !== workspaceId) {
    throw new HttpError(400, 'PROJECT_SCOPE_MISMATCH', 'Project does not belong to the selected workspace');
  }
}

async function loadOwnedSession(sessionId: string, userId: string) {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, archivedAt: null },
  });
  if (!session) throw new OwnershipError('workspace', sessionId, 'not_found');
  await assertWorkspaceRole(session.workspaceId, userId, ['owner', 'admin', 'member', 'viewer']);
  // A project-scoped session quotes project data in its transcript and tool
  // results; losing project access (explicit deny, removal) hides it, as it
  // already did for sending new messages.
  if (session.projectId) await assertProjectAccess(session.projectId, userId, 'view');
  return session;
}

router.get(
  '/sessions',
  requireAuth,
  validateQuery(chatSessionListQuerySchema),
  async (req: AuthValidated<unknown, ChatSessionListQuery>, res: Response, next: NextFunction) => {

    const { workspaceId, cursor, limit } = req.validQuery!;
    await assertWorkspaceRole(workspaceId, req.userId!, ['owner', 'admin', 'member', 'viewer']);
    const principal = req.tenancy ?? await resolvePrincipalForUser(req.userId!);
    const sessions = await prisma.chatSession.findMany({
      where: {
        userId: req.userId!,
        workspaceId,
        archivedAt: null,
        OR: [{ projectId: null }, { project: scopedProjectWhere(principal) }],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = sessions.slice(0, limit);
    res.json({ data: page, nextCursor: sessions.length > limit ? page.at(-1)?.id ?? null : null });
    
  },
);

router.post(
  '/sessions',
  requireAuth,
  validateBody(createChatSessionBodySchema),
  async (req: AuthValidated<CreateChatSessionBody>, res: Response, next: NextFunction) => {

    const { workspaceId, projectId, title } = req.validBody!;
    await assertWorkspaceRole(workspaceId, req.userId!, ['owner', 'admin', 'member', 'viewer']);
    if (projectId) await assertProjectInWorkspace(projectId, workspaceId, req.userId!);
    const session = await prisma.chatSession.create({
      data: {
        userId: req.userId!,
        workspaceId,
        projectId,
        title: title ?? 'New chat',
      },
    });
    res.status(201).json(session);
    
  },
);

router.get(
  '/sessions/:id',
  requireAuth,
  validateQuery(chatMessagesQuerySchema),
  async (req: AuthValidated<unknown, ChatMessagesQuery>, res: Response, next: NextFunction) => {

    const id = req.params.id as string;
    const { before, limit } = req.validQuery!;
    const session = await loadOwnedSession(id, req.userId!);
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    });
    const page = messages.slice(0, limit);
    const nextCursor = messages.length > limit ? page.at(-1)?.id ?? null : null;
    // W18a: journal outcomes per tool call, confirmation states, ledger usage
    // and a running turn, so a reloaded client renders the same truth.
    const [enriched, extras] = await Promise.all([
      withToolCallStates(id, page.reverse()),
      sessionHistoryExtras(session),
    ]);
    res.json({ session, messages: enriched, nextCursor, ...extras });
  },
);

router.patch(
  '/sessions/:id',
  requireAuth,
  validateBody(updateChatSessionBodySchema),
  async (req: AuthValidated<UpdateChatSessionBody>, res: Response, next: NextFunction) => {

    const id = req.params.id as string;
    const session = await loadOwnedSession(id, req.userId!);
    const { title, projectId } = req.validBody!;
    if (projectId) await assertProjectInWorkspace(projectId, session.workspaceId, req.userId!);
    const updated = await prisma.chatSession.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      },
    });
    res.json(updated);
    
  },
);

router.delete('/sessions/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {

  const id = req.params.id as string;
  await loadOwnedSession(id, req.userId!);
  await prisma.chatSession.update({ where: { id }, data: { archivedAt: new Date() } });
  res.status(204).send();
  
});

function writeChunk(res: Response, chunk: ChatChunk): void {
  res.write(`event: ${chunk.type}\n`);
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
    (res as unknown as { flush: () => void }).flush();
  }
}

router.post(
  '/sessions/:id/messages',
  requireAuth(['chat:write']),
  chatMessageLimiter,
  validateBody(sendChatMessageBodySchema),
  async (req: AuthValidated<SendChatMessageBody>, res: Response, next: NextFunction) => {
    let prepared: Awaited<ReturnType<typeof prepareChatTurn>> | null = null;
    try {
      const id = req.params.id as string;
      const session = await loadOwnedSession(id, req.userId!);

      // Single writer + budget admission before any byte is streamed: a
      // refused turn is a plain JSON error and stores nothing.
      prepared = await prepareChatTurn({ sessionId: id, userId: req.userId!, workspaceId: session.workspaceId });
      if (!prepared.ok) {
        const details = prepared.details;
        const retryAfter = prepared.code === 'TURN_IN_PROGRESS' && details && typeof details === 'object'
          ? (details as { retryAfterSeconds?: unknown }).retryAfterSeconds
          : undefined;
        if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
        throw new HttpError(prepared.status, prepared.code, prepared.message, details);
      }
      const { lease, budget } = prepared;

      const abortController = new AbortController();
      let finished = false;
      const abort = () => {
        if (!finished) abortController.abort();
      };
      req.on('aborted', abort);
      req.on('error', abort);
      res.on('close', abort);
      res.on('error', abort);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let wroteDone = false;
      for await (const chunk of runChatTurn({
        sessionId: id,
        userId: req.userId!,
        userMessage: req.validBody!.content,
        attachmentIds: req.validBody!.attachmentIds,
        confirmationTokens: req.validBody!.confirmationTokens,
        abortSignal: abortController.signal,
        lease,
        budget,
      })) {
        if (res.writableEnded) break;
        if (chunk.type === 'done') wroteDone = true;
        writeChunk(res, chunk);
      }

      finished = true;
      if (!wroteDone) {
        res.write('event: done\ndata: {"type":"done"}\n\n');
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        writeChunk(res, {
          type: 'error',
          code: 'CHAT_STREAM_FAILED',
          message: error instanceof Error ? error.message : 'Chat stream failed',
        });
        res.end();
        return;
      }
      next(error);
    } finally {
      // The turn releases both; this covers a turn that never started.
      if (prepared?.ok) {
        await prepared.budget.settle('CHAT_STREAM_FAILED');
        await prepared.lease.release();
      }
    }
  },
);

/**
 * Dismiss a confirmation preview: revoke its code server-side so it can never
 * be redeemed later (W18a). Idempotent; 409 when the change already ran.
 */
router.post(
  '/sessions/:id/confirmations/revoke',
  requireAuth(['chat:write']),
  validateBody(revokeConfirmationBodySchema),
  async (req: AuthValidated<RevokeConfirmationBody>, res: Response) => {
    const id = req.params.id as string;
    await loadOwnedSession(id, req.userId!);
    const outcome = await revokeConfirmation({ sessionId: id, userId: req.userId!, code: req.validBody!.code });
    if (!outcome.ok) {
      const status = outcome.code === 'CONFIRMATION_USED' ? 409 : 404;
      throw new HttpError(status, outcome.code, outcome.message, outcome.confirmation ? { confirmation: outcome.confirmation } : undefined);
    }
    res.json({ confirmation: outcome.confirmation });
  },
);

// ─── Budgets (W15) ────────────────────────────────────────────────────────────

function decimalToNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function usdDecimal(value: number | null | undefined): Prisma.Decimal | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Prisma.Decimal(value.toFixed(6));
}

function workspaceBudgetView(row: {
  monthlyUsdLimit: Prisma.Decimal | null;
  monthlyTokenLimit: number | null;
  perUserMonthlyUsdLimit: Prisma.Decimal | null;
  perUserMonthlyTokenLimit: number | null;
  unknownCostPolicy: string | null;
  updatedById: string | null;
  updatedAt: Date;
} | null) {
  if (!row) return null;
  return {
    monthlyUsdLimit: decimalToNumber(row.monthlyUsdLimit),
    monthlyTokenLimit: row.monthlyTokenLimit,
    perUserMonthlyUsdLimit: decimalToNumber(row.perUserMonthlyUsdLimit),
    perUserMonthlyTokenLimit: row.perUserMonthlyTokenLimit,
    unknownCostPolicy: row.unknownCostPolicy,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function budgetAdminView(workspaceId: string, userId: string) {
  const [settings, members, status] = await Promise.all([
    prisma.chatWorkspaceBudget.findUnique({ where: { workspaceId } }),
    prisma.chatMemberBudget.findMany({ where: { workspaceId }, orderBy: { userId: 'asc' }, take: 500 }),
    chatBudgetStatus(workspaceId, userId),
  ]);
  const config = loadChatBudgetConfig();
  return {
    workspaceId,
    settings: workspaceBudgetView(settings),
    members: members.map((member) => ({
      userId: member.userId,
      monthlyUsdLimit: decimalToNumber(member.monthlyUsdLimit),
      monthlyTokenLimit: member.monthlyTokenLimit,
      updatedById: member.updatedById,
      updatedAt: member.updatedAt.toISOString(),
    })),
    defaults: config.ok
      ? {
          workspaceMonthlyUsd: config.config.workspaceMonthlyUsd,
          workspaceMonthlyTokens: config.config.workspaceMonthlyTokens,
          userMonthlyUsd: config.config.userMonthlyUsd,
          userMonthlyTokens: config.config.userMonthlyTokens,
          unknownCostPolicy: config.config.unknownCostPolicy,
        }
      : null,
    configIssues: config.ok ? [] : config.issues,
    status,
  };
}

router.get(
  '/budgets/:workspaceId',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const workspaceId = req.params.workspaceId as string;
    await assertWorkspaceRole(workspaceId, req.userId!, ['owner', 'admin']);
    res.json(await budgetAdminView(workspaceId, req.userId!));
  },
);

router.put(
  '/budgets/:workspaceId',
  requireAuth,
  validateBody(workspaceBudgetBodySchema),
  async (req: AuthValidated<WorkspaceBudgetBody>, res: Response) => {
    const workspaceId = req.params.workspaceId as string;
    await assertWorkspaceRole(workspaceId, req.userId!, ['owner', 'admin']);
    const body = req.validBody!;
    const before = await prisma.chatWorkspaceBudget.findUnique({ where: { workspaceId } });
    const data = {
      ...(body.monthlyUsdLimit !== undefined ? { monthlyUsdLimit: usdDecimal(body.monthlyUsdLimit) } : {}),
      ...(body.monthlyTokenLimit !== undefined ? { monthlyTokenLimit: body.monthlyTokenLimit } : {}),
      ...(body.perUserMonthlyUsdLimit !== undefined ? { perUserMonthlyUsdLimit: usdDecimal(body.perUserMonthlyUsdLimit) } : {}),
      ...(body.perUserMonthlyTokenLimit !== undefined ? { perUserMonthlyTokenLimit: body.perUserMonthlyTokenLimit } : {}),
      ...(body.unknownCostPolicy !== undefined ? { unknownCostPolicy: body.unknownCostPolicy } : {}),
      updatedById: req.userId!,
    };
    const after = await prisma.chatWorkspaceBudget.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    await logAudit({
      workspaceId,
      actorId: req.userId!,
      action: 'chat.budget_updated',
      resourceType: 'chat_budget',
      resourceId: workspaceId,
      metadata: { before: workspaceBudgetView(before), after: workspaceBudgetView(after) },
      ...(req.ip ? { ipAddress: req.ip } : {}),
    });
    res.json(await budgetAdminView(workspaceId, req.userId!));
  },
);

router.put(
  '/budgets/:workspaceId/members/:userId',
  requireAuth,
  validateBody(memberBudgetBodySchema),
  async (req: AuthValidated<MemberBudgetBody>, res: Response) => {
    const workspaceId = req.params.workspaceId as string;
    const memberId = req.params.userId as string;
    await assertWorkspaceRole(workspaceId, req.userId!, ['owner', 'admin']);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: memberId } },
      select: { id: true },
    });
    if (!membership) throw new HttpError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this workspace');
    const body = req.validBody!;
    const before = await prisma.chatMemberBudget.findUnique({ where: { workspaceId_userId: { workspaceId, userId: memberId } } });
    const nextUsd = body.monthlyUsdLimit !== undefined ? body.monthlyUsdLimit : decimalToNumber(before?.monthlyUsdLimit);
    const nextTokens = body.monthlyTokenLimit !== undefined ? body.monthlyTokenLimit : before?.monthlyTokenLimit ?? null;
    if (nextUsd === null && nextTokens === null) {
      // Nothing left to override: back to the workspace's per-member default.
      await prisma.chatMemberBudget.deleteMany({ where: { workspaceId, userId: memberId } });
    } else {
      const data = { monthlyUsdLimit: usdDecimal(nextUsd), monthlyTokenLimit: nextTokens, updatedById: req.userId! };
      await prisma.chatMemberBudget.upsert({
        where: { workspaceId_userId: { workspaceId, userId: memberId } },
        create: { workspaceId, userId: memberId, ...data },
        update: data,
      });
    }
    await logAudit({
      workspaceId,
      actorId: req.userId!,
      action: 'chat.member_budget_updated',
      resourceType: 'chat_member_budget',
      resourceId: memberId,
      metadata: {
        before: before ? { monthlyUsdLimit: decimalToNumber(before.monthlyUsdLimit), monthlyTokenLimit: before.monthlyTokenLimit } : null,
        after: nextUsd === null && nextTokens === null ? null : { monthlyUsdLimit: nextUsd, monthlyTokenLimit: nextTokens },
      },
      ...(req.ip ? { ipAddress: req.ip } : {}),
    });
    res.json(await budgetAdminView(workspaceId, req.userId!));
  },
);

export default router;
