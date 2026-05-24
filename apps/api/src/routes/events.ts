import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { clients, SSEClient } from '../sse';
import { buildErrorEnvelope } from '../lib/http';
import { getUserTeamIds } from '../services/team-scope';

const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  const tokenRaw = req.query.token;
  const token = typeof tokenRaw === 'string' ? tokenRaw : '';
  if (!token) {
    res.status(401).json(buildErrorEnvelope('SSE_TOKEN_REQUIRED', 'SSE token is required'));
    return;
  }

  const secret =
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV === 'production'
      ? null
      : 'openlinear-dev-secret-change-in-production');
  if (!secret) {
    res.status(500).json(buildErrorEnvelope('SERVER_MISCONFIGURED', 'Server is misconfigured'));
    return;
  }

  let userId: string;
  try {
    const claims = jwt.verify(token, secret) as { userId?: string };
    if (!claims?.userId) {
      res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
      return;
    }
    userId = claims.userId;
  } catch {
    res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
    return;
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

  const clientId = randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client: SSEClient = { id: clientId, res, userId, teamIds, workspaceIds };
  clients.set(clientId, client);

  req.log?.info(
    { clientId, userId, teamCount: teamIds.length, total: clients.size },
    '[SSE] client connected',
  );

  try {
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
  } catch (err) {
    req.log?.warn({ err, clientId }, '[SSE] initial write failed');
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
    clients.delete(clientId);
    req.log?.info(
      { clientId, userId, total: clients.size },
      '[SSE] client disconnected',
    );
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

export default router;
