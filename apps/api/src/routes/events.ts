import { Router, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { formatSseMessage, registerClient, unregisterClient, type SSEClient } from '../events/hub';
import { parseLastEventId, replaySince } from '../events/outbox';
import { executionSseId, parseExecutionSseId } from '@openlinear/execution-core';
import { buildErrorEnvelope } from '../lib/http';
import { getUserTeamIds } from '../services/team-scope';
import { getJwtSecret } from '../lib/secrets';
import { hashToken, isSessionRevoked } from '../services/sessions';
import { requireInteractiveSession, type AuthRequest } from '../middleware/auth';
import { assertTaskAccess } from '../services/ownership';
import { HttpError } from '../errors';

const router: Router = Router();
const TICKET_TTL_MS = 60_000;
const SSE_TICKET_PREFIX = 'ol_sse_';

interface SseIdentity {
  userId: string;
}

async function consumeTicket(ticket: string): Promise<SseIdentity | null> {
  if (!ticket.startsWith(SSE_TICKET_PREFIX)) return null;
  const row = await prisma.sseTicket.findUnique({
    where: { tokenHash: hashToken(ticket) },
  });
  if (!row || row.consumedAt || row.expiresAt <= new Date()) return null;
  await prisma.sseTicket.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
  return { userId: row.userId };
}

async function identityFromBearer(token: string): Promise<SseIdentity | 'pending' | null> {
  if (token.startsWith(SSE_TICKET_PREFIX)) {
    return consumeTicket(token);
  }
  try {
    const claims = jwt.verify(token, getJwtSecret()) as {
      userId?: string;
      twoFactorPending?: boolean;
      typ?: string;
    };
    if (!claims?.userId) return null;
    if (claims.twoFactorPending || claims.typ === 'refresh') return 'pending';
    if (await isSessionRevoked(hashToken(token))) return null;
    return { userId: claims.userId };
  } catch {
    return null;
  }
}

router.post('/ticket', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  const ticket = `${SSE_TICKET_PREFIX}${randomBytes(24).toString('base64url')}`;
  await prisma.sseTicket.create({
    data: {
      userId: req.userId!,
      tokenHash: hashToken(ticket),
      expiresAt: new Date(Date.now() + TICKET_TTL_MS),
    },
  });
  res.status(201).json({ ticket, expiresIn: TICKET_TTL_MS / 1000 });
});

router.get('/', async (req: Request, res: Response) => {
  if (typeof req.query.token === 'string' && req.query.token.length > 0) {
    res.status(400).json(
      buildErrorEnvelope(
        'SSE_TOKEN_QUERY_REMOVED',
        'Pass a short-lived ticket from POST /api/events/ticket as ?ticket=, or an Authorization header. JWT query tokens are no longer accepted.',
      ),
    );
    return;
  }

  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.substring(7)
    : '';
  const ticketRaw = req.query.ticket;
  const ticket = typeof ticketRaw === 'string' ? ticketRaw : '';
  const token = ticket || headerToken;
  if (!token) {
    res.status(401).json(buildErrorEnvelope('SSE_TOKEN_REQUIRED', 'SSE ticket is required'));
    return;
  }

  const identity = await identityFromBearer(token);
  if (identity === 'pending' || !identity) {
    res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
    return;
  }
  const { userId } = identity;

  const lastRaw = req.headers['last-event-id'] ?? req.query.lastEventId;
  const lastRun = typeof lastRaw === 'string' ? parseExecutionSseId(lastRaw) : null;
  if (lastRun) {
    const run = await prisma.agentRun.findUnique({
      where: { id: lastRun.runId },
      select: { taskId: true },
    });
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Agent run not found');
    // Check current resource permissions before opening the stream or reading
    // journal payloads. Knowing a run id must not grant access to its task.
    await assertTaskAccess(run.taskId, userId, 'view');
  }

  let teamIds: string[] = [];
  let workspaceIds: string[] = [];
  try {
    teamIds = await getUserTeamIds(userId);
    const workspaces = await prisma.workspaceMember.findMany({
      where: { userId },
      select: { workspaceId: true },
    });
    workspaceIds = workspaces.map((membership) => membership.workspaceId);
  } catch (err) {
    req.log?.warn({ err, userId }, '[SSE] failed to load team memberships');
  }

  const clientId = randomBytes(16).toString('hex');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client: SSEClient = {
    id: clientId,
    res,
    userId,
    teamIds,
    workspaceIds,
    connectedAt: Date.now(),
  };
  registerClient(client);

  req.log?.info(
    { clientId, userId, teamCount: teamIds.length },
    '[SSE] client connected',
  );

  try {
    res.write(formatSseMessage('connected', { type: 'connected', clientId }));
  } catch (err) {
    req.log?.warn({ err, clientId }, '[SSE] initial write failed');
  }

  if (lastRun) {
    try {
      const missed = await prisma.agentRunEvent.findMany({
        where: { runId: lastRun.runId, seq: { gt: lastRun.seq } },
        orderBy: { seq: 'asc' },
        take: 500,
      });
      for (const event of missed) {
        res.write(formatSseMessage('execution:progress', {
          runId: event.runId,
          seq: event.seq,
          type: event.type,
          payload: event.payload,
        }, executionSseId(event.runId, event.seq)));
      }
    } catch (err) {
      req.log?.warn({ err, clientId, lastEventId: lastRaw }, '[SSE] run journal replay failed');
    }
  } else {
    const lastEventId = parseLastEventId(lastRaw);
    if (lastEventId !== null) {
      try {
        const missed = await replaySince(lastEventId, { userId, teamIds, workspaceIds });
        for (const event of missed) {
          res.write(formatSseMessage(event.type, event.payload, event.id.toString()));
        }
      } catch (err) {
        req.log?.warn({ err, clientId, lastEventId: lastEventId.toString() }, '[SSE] replay failed');
      }
    }
  }

  const heartbeatInterval = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(`: heartbeat\n\n`);
    } catch (err) {
      req.log?.debug({ err, clientId }, '[SSE] heartbeat write failed');
      cleanup();
    }
  }, 30000);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeatInterval);
    unregisterClient(clientId);
    req.log?.info(
      { clientId, userId },
      '[SSE] client disconnected',
    );
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

export default router;
