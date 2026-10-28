import { Router, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '@openlinear/db';
import {
  applyClientPrincipal,
  beginReplayHold,
  closeStreamsForSessions,
  endReplayHold,
  formatCursorFrame,
  formatSseMessage,
  registerClient,
  revalidateClientPrincipal,
  SESSION_REVOKED_EVENT,
  unregisterClient,
  type SSEClient,
} from '../events/hub';
import { liveStreamPosition, parseLastEventId } from '../events/outbox';
import { replayVisibleSince } from '../events/replay';
import { executionSseId, parseExecutionSseId } from '@openlinear/execution-core';
import { buildErrorEnvelope } from '../lib/http';
import { resolveTenancyContext } from '../tenancy/context';
import { canReceiveEvent } from '../tenancy/visibility';
import {
  getSessionState,
  hashToken,
  isSessionLive,
  onSessionsRevoked,
  sessionlessJwtAllowed,
} from '../services/sessions';
import { isPersonalAccessToken } from '../services/pats';
import { requireInteractiveSession, verifyAccessToken, type AuthRequest } from '../middleware/auth';
import { assertTaskAccess } from '../services/ownership';
import { HttpError } from '../errors';
import { broadcastToUser } from '../sse';

const router: Router = Router();
const TICKET_TTL_MS = 60_000;
/** Expired tickets are deleted (per user, when a new one is minted) after this. */
const TICKET_RETENTION_MS = 60 * 60 * 1000;
const SSE_TICKET_PREFIX = 'ol_sse_';
const HEARTBEAT_MS = 30_000;

interface SseIdentity {
  userId: string;
  /** Session the stream is bound to; `null` only for sessionless test tokens. */
  sessionId: string | null;
}

/**
 * Consume an SSE ticket (W02b).
 *
 * Single use under concurrency: the ticket is claimed with one conditional
 * UPDATE, so of N parallel connections presenting it exactly one proceeds
 * (previously read-then-write: all of them could). The ticket is then only
 * honoured while the session that minted it is live; revoking the session
 * also marks its outstanding tickets consumed (`afterSessionsRevoked`).
 */
export async function consumeSseTicket(ticket: string): Promise<SseIdentity | null> {
  if (!ticket.startsWith(SSE_TICKET_PREFIX)) return null;
  const tokenHash = hashToken(ticket);
  const now = new Date();
  const claimed = await prisma.sseTicket.updateMany({
    where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return null;
  const row = await prisma.sseTicket.findUnique({
    where: { tokenHash },
    select: { userId: true, sessionId: true },
  });
  if (!row) return null;
  if (row.sessionId) {
    if (!(await isSessionLive(row.sessionId))) return null;
  } else if (!sessionlessJwtAllowed()) {
    // Tickets minted before session binding (or without a session) are refused.
    return null;
  }
  return { userId: row.userId, sessionId: row.sessionId };
}

async function identityFromBearer(token: string): Promise<SseIdentity | null> {
  if (token.startsWith(SSE_TICKET_PREFIX)) {
    return consumeSseTicket(token);
  }
  if (isPersonalAccessToken(token)) return null;
  const claims = verifyAccessToken(token);
  if (!claims) return null;
  const session = await getSessionState(hashToken(token));
  if (session.revoked) return null;
  return { userId: claims.userId, sessionId: session.sessionId };
}

// Session revocation closes the streams that session opened: here at once,
// and on other replicas when they deliver the `session:revoked` signal.
onSessionsRevoked(({ userId, sessionIds, reason }) => {
  closeStreamsForSessions(sessionIds, userId);
  broadcastToUser(userId, SESSION_REVOKED_EVENT, { sessionIds, reason });
});

router.post('/ticket', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  const sessionId = req.sessionId ?? null;
  if (!sessionId && !sessionlessJwtAllowed()) {
    res.status(401).json(buildErrorEnvelope('SESSION_REQUIRED', 'An active session is required'));
    return;
  }
  const ticket = `${SSE_TICKET_PREFIX}${randomBytes(24).toString('base64url')}`;
  await prisma.sseTicket.create({
    data: {
      userId: req.userId!,
      tokenHash: hashToken(ticket),
      expiresAt: new Date(Date.now() + TICKET_TTL_MS),
      sessionId,
    },
  });
  void prisma.sseTicket
    .deleteMany({ where: { userId: req.userId!, expiresAt: { lt: new Date(Date.now() - TICKET_RETENTION_MS) } } })
    .catch(() => undefined);
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
  if (!identity) {
    res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid token'));
    return;
  }
  const { userId, sessionId } = identity;

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

  // The stream's principal (W02a): resolved fresh, uncached, before any byte
  // is sent. Every live and replayed event is authorized against it, and it
  // is refreshed on membership/access events and on every heartbeat. If it
  // cannot be resolved the stream is refused (fail closed).
  const principal = await resolveTenancyContext(
    { userId, authSource: 'jwt', scopes: [] },
    { bypassCache: true },
  );

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
    teamIds: [],
    workspaceIds: [],
    connectedAt: Date.now(),
    sessionId,
  };
  applyClientPrincipal(client, principal);
  const lastEventId = lastRun ? null : parseLastEventId(lastRaw);
  // Live events wait until the replay below has been written (ordering, dedupe).
  if (lastEventId !== null) beginReplayHold(client);
  registerClient(client);
  // W04b: events up to this position were delivered live before the stream
  // registered (replay them); later ones arrive live. Read synchronously
  // with registration.
  const liveBoundary = liveStreamPosition();

  let cleaned = false;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    unregisterClient(clientId);
    req.log?.info({ clientId, userId }, '[SSE] client disconnected');
  }
  function close() {
    unregisterClient(clientId);
    client.held = null;
    if (!res.writableEnded) res.end();
    cleanup();
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  // A revocation that committed after the ticket/token check but before the
  // stream was registered did not see this stream: re-check once registered.
  if (sessionId && !(await isSessionLive(sessionId))) {
    req.log?.info({ clientId, userId }, '[SSE] session revoked while connecting; closing stream');
    close();
    return;
  }

  req.log?.info(
    { clientId, userId, teamCount: client.teamIds.length },
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
  } else if (lastEventId !== null) {
    let cursor: bigint | null = null;
    let truncated = false;
    try {
      const replay = await replayVisibleSince(lastEventId, principal, { upTo: liveBoundary });
      let lastWritten: bigint | null = null;
      for (const event of replay.events) {
        if (cleaned) break;
        // Re-check against the current snapshot: a revocation may have
        // refreshed this stream's principal while the replay was read.
        if (!canReceiveEvent(client.principal ?? principal, event)) continue;
        res.write(formatSseMessage(event.type, event.payload, event.id.toString()));
        lastWritten = event.id;
      }
      cursor = replay.cursor;
      truncated = replay.truncated;
      if (cursor !== null && (lastWritten === null || cursor > lastWritten) && !cleaned) {
        res.write(formatCursorFrame(cursor));
      }
    } catch (err) {
      req.log?.warn({ err, clientId, lastEventId: lastEventId.toString() }, '[SSE] replay failed');
    }
    if (truncated) {
      // Not caught up. Held live events must not be delivered: their ids
      // would move the client past the rows not yet scanned. The client
      // reconnects from `cursor` and the next replay continues from there.
      req.log?.info({ clientId, userId, cursor: cursor?.toString() }, '[SSE] replay budget reached; handing cursor to client');
      close();
      return;
    }
    endReplayHold(client, cursor);
  }

  let revalidating = false;
  async function revalidate(): Promise<void> {
    if (revalidating) return;
    revalidating = true;
    try {
      // A stream dies with the session that opened it (bearer JWT or ticket).
      if (sessionId && !(await isSessionLive(sessionId))) {
        req.log?.info({ clientId, userId }, '[SSE] session revoked; closing stream');
        close();
        return;
      }
      await revalidateClientPrincipal(clientId);
    } catch (err) {
      req.log?.warn({ err, clientId }, '[SSE] revalidation failed; closing stream');
      close();
    } finally {
      revalidating = false;
    }
  }

  if (cleaned) return;
  heartbeatInterval = setInterval(() => {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    try {
      res.write(`: heartbeat\n\n`);
    } catch (err) {
      req.log?.debug({ err, clientId }, '[SSE] heartbeat write failed');
      cleanup();
      return;
    }
    void revalidate();
  }, HEARTBEAT_MS);
});

export default router;
