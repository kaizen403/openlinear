import { Router, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { HttpError } from '../errors';
import { buildErrorEnvelope } from '../lib/http';
import { assertProjectAccess, OwnershipError } from '../services/ownership';
import { assertWorkspaceRole } from '../services/workspaces';
import { runChatTurn, type ChatChunk } from '../services/chat';
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
  return session;
}

router.get(
  '/sessions',
  requireAuth,
  validateQuery(chatSessionListQuerySchema),
  async (req: AuthValidated<unknown, ChatSessionListQuery>, res: Response, next: NextFunction) => {

    const { workspaceId, cursor, limit } = req.validQuery!;
    await assertWorkspaceRole(workspaceId, req.userId!, ['owner', 'admin', 'member', 'viewer']);
    const sessions = await prisma.chatSession.findMany({
      where: { userId: req.userId!, workspaceId, archivedAt: null },
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
    res.json({ session, messages: page.reverse(), nextCursor: messages.length > limit ? page.at(-1)?.id ?? null : null });
    
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
    try {
      const id = req.params.id as string;
      await loadOwnedSession(id, req.userId!);

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
        abortSignal: abortController.signal,
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
    }
  },
);

export default router;
