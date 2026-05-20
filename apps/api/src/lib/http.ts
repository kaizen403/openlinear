import { Request, Response } from 'express';
import { HttpError } from '../errors';

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

export function parseFields(
  value: unknown,
  allowedFields: ReadonlyArray<string>,
): string[] | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_FIELDS', 'fields must be a comma-separated string');
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_FIELDS', 'fields must be a comma-separated string');
  }

  const allowed = new Set(allowedFields);
  const fields = value
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  const invalid = fields.filter((field) => !allowed.has(field));
  if (invalid.length > 0) {
    throw new HttpError(400, 'INVALID_FIELDS', 'Unsupported fields requested', {
      invalid,
      allowed: allowedFields,
    });
  }
  return [...new Set(fields)];
}

export function pickFields(
  value: Record<string, unknown>,
  fields: ReadonlyArray<string> | null,
): Record<string, unknown> {
  if (!fields) return value;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    selected[field] = value[field];
  }
  return selected;
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

interface IdempotencyRecord {
  expiresAt: number;
  status: number;
  body: unknown;
}

const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 200;
const idempotencyCache = new Map<string, IdempotencyRecord>();

export function getIdempotencyRecord(
  req: Request,
  userId: string,
  routeKey: string,
): IdempotencyRecord | null {
  const header = req.header('Idempotency-Key');
  if (!header) return null;
  const key = `${userId}:${routeKey}:${header}`;
  const record = idempotencyCache.get(key);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    idempotencyCache.delete(key);
    return null;
  }
  return record;
}

export function storeIdempotencyRecord(
  req: Request,
  userId: string,
  routeKey: string,
  status: number,
  body: unknown,
): void {
  const header = req.header('Idempotency-Key');
  if (!header) return;
  const key = `${userId}:${routeKey}:${header}`;
  idempotencyCache.set(key, {
    status,
    body,
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });
  pruneIdempotencyCache();
}

export function replayIdempotencyRecord(res: Response, record: IdempotencyRecord): void {
  res.setHeader('Idempotency-Replayed', 'true');
  res.status(record.status).json(record.body);
}

function pruneIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, record] of idempotencyCache) {
    if (record.expiresAt <= now) {
      idempotencyCache.delete(key);
    }
  }
  while (idempotencyCache.size > IDEMPOTENCY_MAX_ENTRIES) {
    const oldest = idempotencyCache.keys().next();
    if (oldest.done) break;
    idempotencyCache.delete(oldest.value);
  }
}
