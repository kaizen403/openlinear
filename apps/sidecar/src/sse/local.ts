import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { parseExecutionSseId, executionSseId } from '@openlinear/execution-core';

export interface LocalSseClient {
  id: string;
  res: Response;
  userId: string;
}

const clients = new Map<string, LocalSseClient>();

export function formatSseMessage(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function deliverLocalExecutionEvent(input: {
  userId?: string;
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
}): void {
  const sseId = executionSseId(input.runId, input.seq);
  const body = formatSseMessage('execution:progress', {
    runId: input.runId,
    seq: input.seq,
    type: input.type,
    payload: input.payload,
  }, sseId);
  for (const client of clients.values()) {
    if (input.userId && client.userId !== input.userId) continue;
    if (client.res.writableEnded) continue;
    try {
      client.res.write(body);
    } catch {
      clients.delete(client.id);
    }
  }
}

function identityFromBearer(token: string): { userId: string } | null {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const claims = jwt.verify(token, secret) as { userId?: string; twoFactorPending?: boolean; typ?: string };
    if (!claims.userId || claims.twoFactorPending || claims.typ === 'refresh') return null;
    return { userId: claims.userId };
  } catch {
    return null;
  }
}

export function createLocalEventsRouter(): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const headerToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.substring(7)
      : '';
    if (!headerToken) {
      res.status(401).json({ error: 'Authentication required', code: 'SSE_TOKEN_REQUIRED' });
      return;
    }
    const identity = identityFromBearer(headerToken);
    if (!identity) {
      res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = randomBytes(16).toString('hex');
    const client: LocalSseClient = { id: clientId, res, userId: identity.userId };
    clients.set(clientId, client);
    res.write(formatSseMessage('connected', { type: 'connected', clientId }));

    const lastRaw = req.headers['last-event-id'];
    if (typeof lastRaw === 'string' && parseExecutionSseId(lastRaw)) {
      // Replay is mirrored on the cloud API (`agent_run_events`). Local journal
      // consumers attach after subscribe; Last-Event-ID on the API EventSource
      // is the durable path after sidecar split.
    }

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': heartbeat\n\n');
      } catch {
        cleanup();
      }
    }, 30_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(clientId);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  return router;
}
