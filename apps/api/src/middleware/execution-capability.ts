import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';

/**
 * W03a run-scoped execution capability.
 *
 * An opaque random token minted by `POST /api/executions/attempts`, bound to
 * exactly one attempt (and through it one task and one user). Only its
 * SHA-256 digest is stored. It authorizes nothing but that attempt's
 * callbacks, it is never accepted by `requireAuth` (no `ol_pat_` prefix, not a
 * JWT), and session JWTs / PATs are refused here. It expires after a bounded
 * TTL and is revoked when the attempt closes.
 */
export const EXECUTION_CAPABILITY_PREFIX = 'olx_';
const CAPABILITY_TOKEN_PATTERN = /^olx_[A-Za-z0-9_-]{43}$/;

export const EXECUTION_CAPABILITY_SCOPES = [
  'execution:status',
  'execution:progress',
  'execution:logs',
  'execution:terminal',
  'execution:git-credential',
  /** W11a: record verification evidence for the attempt's commit. */
  'execution:verification',
] as const;
export type ExecutionCapabilityScope = (typeof EXECUTION_CAPABILITY_SCOPES)[number];

export interface ExecutionCapabilityContext {
  capabilityId: string;
  attemptId: string;
  taskId: string;
  userId: string;
  scopes: readonly string[];
  expiresAt: Date;
}

export interface CapabilityRequest extends Request {
  executionCapability?: ExecutionCapabilityContext;
}

export function hashExecutionCapability(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isExecutionCapabilityToken(value: string): boolean {
  return CAPABILITY_TOKEN_PATTERN.test(value);
}

function deny(res: Response, status: number, code: string, message: string): void {
  res.status(status).json(buildErrorEnvelope(code, message));
}

/**
 * Authenticate an attempt callback. Rejects (in order): missing or
 * non-capability credentials (401), unknown, revoked or expired capabilities
 * (401), a capability presented for a different attempt (403), and a missing
 * scope (403). Attempt state is enforced by each handler inside its own
 * transaction, so a stale or terminal attempt is still refused after this.
 */
export function requireExecutionCapability(scope: ExecutionCapabilityScope) {
  return (req: CapabilityRequest, res: Response, next: NextFunction): void => {
    void (async () => {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.substring(7).trim() : '';
      if (!token || !isExecutionCapabilityToken(token)) {
        deny(res, 401, 'CAPABILITY_REQUIRED', 'An execution capability is required for attempt callbacks');
        return;
      }

      const capability = await prisma.executionCapability.findUnique({
        where: { tokenHash: hashExecutionCapability(token) },
        select: {
          id: true,
          attemptId: true,
          taskId: true,
          userId: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          attempt: { select: { taskId: true, userId: true } },
        },
      });
      if (!capability) {
        deny(res, 401, 'CAPABILITY_INVALID', 'Unknown execution capability');
        return;
      }
      if (capability.revokedAt) {
        deny(res, 401, 'CAPABILITY_REVOKED', 'This execution capability has been revoked');
        return;
      }
      if (capability.expiresAt.getTime() <= Date.now()) {
        deny(res, 401, 'CAPABILITY_EXPIRED', 'This execution capability has expired');
        return;
      }
      // Binding integrity: the capability names the same task and user as
      // its attempt. A mismatch means the row was tampered with.
      if (capability.attempt.taskId !== capability.taskId || capability.attempt.userId !== capability.userId) {
        deny(res, 401, 'CAPABILITY_INVALID', 'Execution capability binding is inconsistent');
        return;
      }
      if (req.params.attemptId !== capability.attemptId) {
        deny(res, 403, 'CAPABILITY_ATTEMPT_MISMATCH', 'This capability does not belong to the requested attempt');
        return;
      }
      if (!capability.scopes.includes(scope)) {
        deny(res, 403, 'CAPABILITY_SCOPE_DENIED', `This capability lacks the ${scope} scope`);
        return;
      }

      req.executionCapability = {
        capabilityId: capability.id,
        attemptId: capability.attemptId,
        taskId: capability.taskId,
        userId: capability.userId,
        scopes: capability.scopes,
        expiresAt: capability.expiresAt,
      };
      next();
    })().catch(next);
  };
}
