import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AuthedRequest,
  bearerFrom,
  type PrincipalCredential,
  requireSidecarAuth,
  validateBearer,
} from '../auth/principal';
import { toSidecarError } from '../config/cloud-api';
import { errorBody, HttpError, sendError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * The sidecar's local event stream (W03a).
 *
 * Authentication is the same control-plane principal validation as every
 * other sidecar route: `Authorization: Bearer <cloud access token>` (the
 * desktop UI's fetch-based stream). A native EventSource cannot set headers,
 * so a stream may instead present a one-time ticket minted by
 * `POST /api/events/ticket` (60 s, single use, memory only, hash-keyed).
 *
 * Each open stream re-validates its principal every heartbeat (30 s) and is
 * closed when the token is no longer valid or the control plane cannot be
 * reached (fail closed; the client reconnects).
 *
 * Delivery: task events go only to the run owner's streams (see
 * events/publisher.ts); user events only to that user; global events
 * (OpenCode status) to every authenticated stream.
 */
interface LocalSseClient {
  id: string;
  res: Response;
  credential: PrincipalCredential;
}

const clients = new Map<string, LocalSseClient>();
const tickets = new Map<string, { credential: PrincipalCredential; expiresAt: number }>();

export const SSE_TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 1_000;
const HEARTBEAT_MS = 30_000;

/**
 * Every event carries `id: <boot>:<seq>`. The last `REPLAY_BUFFER_SIZE`
 * events are kept in memory (with their audience) so a reconnecting stream
 * that sends `Last-Event-ID` gets what it missed — filtered by its own
 * principal. A cursor from another sidecar boot, or older than the buffer,
 * gets a `replay-gap` event instead (the client re-reads state).
 */
export const REPLAY_BUFFER_SIZE = 500;
const BOOT_ID = randomBytes(4).toString('hex');
let sequence = 0;

type Audience = { userId: string } | 'all';
interface BufferedEvent {
  seq: number;
  event: string;
  data: unknown;
  audience: Audience;
}
const replayBuffer: BufferedEvent[] = [];

export function formatSseMessage(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function eventId(seq: number): string {
  return `${BOOT_ID}:${seq}`;
}

function audienceAllows(audience: Audience, credential: PrincipalCredential): boolean {
  return audience === 'all' || audience.userId === credential.principal.userId;
}

export function deliverLocalEvent(event: string, data: unknown, audience: Audience): void {
  sequence += 1;
  replayBuffer.push({ seq: sequence, event, data, audience });
  if (replayBuffer.length > REPLAY_BUFFER_SIZE) replayBuffer.splice(0, replayBuffer.length - REPLAY_BUFFER_SIZE);
  if (clients.size === 0) return;
  const body = formatSseMessage(event, data, eventId(sequence));
  for (const client of clients.values()) {
    if (!audienceAllows(audience, client.credential)) continue;
    if (client.res.writableEnded) continue;
    try {
      client.res.write(body);
    } catch {
      clients.delete(client.id);
    }
  }
}

/** Parse `<boot>:<seq>`; null when the cursor is malformed. */
export function parseLocalEventId(raw: string): { boot: string; seq: number } | null {
  const match = /^([0-9a-f]{8}):(\d{1,15})$/.exec(raw.trim());
  if (!match) return null;
  return { boot: match[1]!, seq: Number(match[2]) };
}

/** Events after `lastEventId` this credential may receive, or a gap marker. */
export function replayFor(lastEventId: string, credential: PrincipalCredential):
  { events: BufferedEvent[]; gap: string | null } {
  const cursor = parseLocalEventId(lastEventId);
  if (!cursor) return { events: [], gap: 'invalid_cursor' };
  if (cursor.boot !== BOOT_ID) return { events: [], gap: 'sidecar_restarted' };
  if (cursor.seq > sequence) return { events: [], gap: 'invalid_cursor' };
  const oldest = replayBuffer[0]?.seq ?? sequence + 1;
  const gap = cursor.seq < oldest - 1 ? 'buffer_exceeded' : null;
  return {
    events: replayBuffer.filter((item) => item.seq > cursor.seq && audienceAllows(item.audience, credential)),
    gap,
  };
}

export function localClientCount(): number {
  return clients.size;
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function sweepTickets(now: number): void {
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(key);
  }
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
}

function consumeTicket(ticket: string): PrincipalCredential | null {
  const key = hashTicket(ticket);
  const entry = tickets.get(key);
  tickets.delete(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.credential;
}

/** Tests: forget all tickets, streams and buffered events. */
export function resetLocalEvents(): void {
  tickets.clear();
  replayBuffer.length = 0;
  for (const client of clients.values()) {
    try {
      client.res.end();
    } catch {
      // already closed
    }
  }
  clients.clear();
}

export function createLocalEventsRouter(): Router {
  const router = Router();

  router.post('/ticket', requireSidecarAuth, (req: AuthedRequest, res: Response) => {
    if (!req.credential) {
      sendError(res, new HttpError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }
    const now = Date.now();
    sweepTickets(now);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(hashTicket(ticket), { credential: req.credential, expiresAt: now + SSE_TICKET_TTL_MS });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket, expiresIn: SSE_TICKET_TTL_MS / 1000 });
  });

  router.get('/', (req: Request, res: Response) => {
    void (async () => {
      const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
      const bearer = bearerFrom(req);
      let credential: PrincipalCredential | null = null;
      if (ticket) {
        credential = consumeTicket(ticket);
        if (!credential) {
          res.status(401).json(errorBody('INVALID_TICKET', 'SSE ticket is invalid, expired or already used'));
          return;
        }
      } else if (bearer) {
        credential = { principal: await validateBearer(bearer), token: bearer };
      } else {
        res.status(401).json(errorBody('SSE_TOKEN_REQUIRED', 'Authentication required'));
        return;
      }
      // Fail closed if the ticket's principal was revoked since it was minted.
      const principal = await validateBearer(credential.token);
      credential = { principal, token: credential.token };

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const clientId = randomBytes(16).toString('hex');
      const client: LocalSseClient = { id: clientId, res, credential };
      // `connected` carries the current high-water id, so resuming from it
      // replays nothing older.
      res.write(formatSseMessage('connected', { type: 'connected', clientId }, eventId(sequence)));
      const lastHeader = req.headers['last-event-id'];
      const lastEventId = typeof lastHeader === 'string' && lastHeader
        ? lastHeader
        : typeof req.query.lastEventId === 'string' ? req.query.lastEventId : null;
      if (lastEventId) {
        const replay = replayFor(lastEventId, credential);
        if (replay.gap) {
          res.write(formatSseMessage('replay-gap', { type: 'replay-gap', reason: replay.gap, lastEventId }, eventId(sequence)));
        }
        for (const item of replay.events) res.write(formatSseMessage(item.event, item.data, eventId(item.seq)));
      }
      // Registered after the synchronous replay, so no live event interleaves.
      clients.set(clientId, client);

      const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(clientId);
      };
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        validateBearer(client.credential.token)
          .then(() => {
            try {
              res.write(': heartbeat\n\n');
            } catch {
              cleanup();
            }
          })
          .catch((error: unknown) => {
            logger.info({ code: toSidecarError(error, 'stream revalidation').code }, '[SSE] closing stream after failed revalidation');
            cleanup();
            res.end();
          });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      req.on('close', cleanup);
      res.on('close', cleanup);
    })().catch((error: unknown) => {
      const mapped = toSidecarError(error, 'stream authentication');
      if (!res.headersSent) sendError(res, mapped);
    });
  });

  return router;
}
