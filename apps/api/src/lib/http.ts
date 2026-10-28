import { Request } from 'express';
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

// The legacy read-then-write `Idempotency-Key` cache (audit A09) was removed in
// W04b: every keyed route uses `respondIdempotently` (services/idempotency.ts).
