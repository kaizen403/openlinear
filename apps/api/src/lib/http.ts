import { Request, Response } from 'express';
import { prisma, Prisma } from '@openlinear/db';
import { HttpError } from '../errors';

export { parseFields, pickFields, buildSelect } from './field-select';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
  [key: string]: unknown;
}

export function buildErrorEnvelope(
  code: string,
  message: string,
  options: { details?: unknown; requestId?: string; extras?: Record<string, unknown> } = {},
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
    code,
    message,
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.extras ?? {}),
  };
}

export function parsePagination(
  query: Request['query'],
  defaultLimit = 50,
  maxLimit = 200,
): { limit: number; cursor: string | undefined } {
  const rawLimit = query.limit;
  const parsedLimit =
    typeof rawLimit === 'string' && rawLimit.trim()
      ? Number.parseInt(rawLimit, 10)
      : defaultLimit;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new HttpError(400, 'INVALID_LIMIT', 'limit must be a positive integer');
  }
  const rawCursor = query.cursor;
  if (rawCursor !== undefined && typeof rawCursor !== 'string') {
    throw new HttpError(400, 'INVALID_CURSOR', 'cursor must be a string');
  }
  return {
    limit: Math.min(parsedLimit, maxLimit),
    cursor: rawCursor,
  };
}

const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

export async function getIdempotencyRecord(
  req: Request,
  userId: string,
  routeKey: string,
): Promise<{ status: number; body: unknown } | null> {
  const header = req.header('Idempotency-Key');
  if (!header) return null;
  const row = await prisma.idempotencyKey.findUnique({
    where: { userId_routeKey_key: { userId, routeKey, key: header } },
  });
  if (!row || row.expiresAt <= new Date()) return null;
  return { status: row.status, body: row.body };
}

export async function storeIdempotencyRecord(
  req: Request,
  userId: string,
  routeKey: string,
  status: number,
  body: unknown,
): Promise<void> {
  const header = req.header('Idempotency-Key');
  if (!header) return;
  await prisma.idempotencyKey.upsert({
    where: { userId_routeKey_key: { userId, routeKey, key: header } },
    create: {
      userId,
      routeKey,
      key: header,
      status,
      body: body as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
    update: {
      status,
      body: body as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
  });
}

export function replayIdempotencyRecord(res: Response, record: { status: number; body: unknown }): void {
  res.setHeader('Idempotency-Replayed', 'true');
  res.status(record.status).json(record.body);
}
