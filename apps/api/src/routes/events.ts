import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { clients, SSEClient } from '../sse';
import { buildErrorEnvelope } from '../lib/http';
import { getUserTeamIds } from '../services/team-scope';
import { getJwtSecret } from '../lib/secrets';
import { hashToken, isSessionRevoked } from '../services/sessions';

const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  // Prefer the Authorization header; `?token=` is retained only because the
  // browser EventSource API cannot set headers. Query-string tokens land in
  // proxy and access logs, so the client should migrate to a fetch-based stream.
  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.substring(7)
    : '';
  const tokenRaw = req.query.token;
  const token = headerToken || (typeof tokenRaw === 'string' ? tokenRaw : '');
  if (!token) {
    res.status(401).json(buildErrorEnvelope('SSE_TOKEN_REQUIRED', 'SSE token is required'));
    return;
  }

  let userId: string;
  try {
    const claims = jwt.verify(token, getJwtSecret()) as {
      userId?: string;
      twoFactorPending?: boolean;
    };
    if (!claims?.userId) {
      res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
      return;
    }
    // This endpoint bypassed the auth middleware, so it accepted 2FA-pending
    // tokens and revoked sessions that every other route rejected.
    if (claims.twoFactorPending) {
      res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
      return;
    }
    userId = claims.userId;
  } catch {
    res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
    return;
  }

  if (await isSessionRevoked(hashToken(token))) {
    res.status(401).json(buildErrorEnvelope('SESSION_REVOKED', 'Session has been revoked'));
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
