import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';

/**
 * Typed HTTP error for sidecar routes and services. Mapped by
 * `createErrorHandler` to the error envelope `{ error, code, message,
 * details? }` (`error` and `message` carry the same human-readable text, so
 * both the AGENTS.md `{ error, code }` contract and the desktop UI's
 * `message || error` reader work).
 */
export class HttpError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export interface ErrorBody {
  error: string;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export function errorBody(code: string, message: string, details?: unknown, requestId?: string): ErrorBody {
  return {
    error: message,
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function sendError(res: Response, error: HttpError): void {
  res.status(error.statusCode).json(errorBody(error.code, error.message, error.details));
}

function statusOf(err: unknown): number {
  if (err && typeof err === 'object') {
    const candidate = err as { statusCode?: unknown; status?: unknown };
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
    if (typeof candidate.status === 'number') return candidate.status;
  }
  return 500;
}

/** Final error middleware: never leaks stack traces or provider errors. */
export function createErrorHandler(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = randomUUID();
    logger.error({ err, requestId, path: req.path, method: req.method }, '[Sidecar] request failed');
    if (res.headersSent) return;
    if (isHttpError(err)) {
      res.status(err.statusCode).json(errorBody(err.code, err.message, err.details, requestId));
      return;
    }
    const status = statusOf(err);
    if (status >= 400 && status < 500) {
      res.status(status).json(errorBody('REQUEST_FAILED', 'Request failed', undefined, requestId));
      return;
    }
    res.status(500).json(errorBody('INTERNAL_ERROR', 'Internal server error', undefined, requestId));
  };
}
