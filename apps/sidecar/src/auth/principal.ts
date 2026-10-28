import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { createPrincipalClient, toSidecarError } from '../config/cloud-api';
import { HttpError, sendError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * W03a sidecar authentication.
 *
 * The desktop client keeps sending `Authorization: Bearer <cloud access
 * token>` (or a PAT). The sidecar cannot verify either itself — it holds no
 * JWT signing secret and no database — so it asks the control plane
 * (`GET /api/executions/principal`) who the bearer is.
 *
 * - Positive results are cached in memory, keyed by the SHA-256 of the token,
 *   for at most `PRINCIPAL_CACHE_TTL_MS` (30 s, under the 60 s bound) and at
 *   most `PRINCIPAL_CACHE_MAX` entries. A revoked session therefore stops
 *   working here within 30 s.
 * - Negative results are never cached.
 * - Concurrent validations of one token share one request.
 * - When the API is unreachable and no fresh positive entry exists the
 *   request is refused with 503 CLOUD_API_UNREACHABLE (fail closed; 503 so
 *   the desktop client does not treat an outage as an expired session).
 */
export interface SidecarPrincipal {
  userId: string;
  authSource: 'session' | 'pat';
  scopes: readonly string[];
  workspaceRestriction: string | null;
  /** SHA-256 of the bearer token; for correlation, never the token itself. */
  tokenHash: string;
}

/** The request principal plus its bearer token, kept in memory only. */
export interface PrincipalCredential {
  principal: SidecarPrincipal;
  token: string;
}

export interface AuthedRequest extends Request {
  principal?: SidecarPrincipal;
  credential?: PrincipalCredential;
  /** Legacy field read by existing handlers. Equals `principal.userId`. */
  userId?: string;
}

export const PRINCIPAL_CACHE_TTL_MS = 30_000;
export const PRINCIPAL_CACHE_MAX = 500;
const PRINCIPAL_TIMEOUT_MS = 5_000;

interface CacheEntry {
  principal: SidecarPrincipal;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SidecarPrincipal>>();

export function hashBearer(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Tests and sign-out paths: drop every cached principal. */
export function clearPrincipalCache(): void {
  cache.clear();
  inFlight.clear();
}

export function principalCacheSize(): number {
  return cache.size;
}

function remember(tokenHash: string, principal: SidecarPrincipal): void {
  if (cache.size >= PRINCIPAL_CACHE_MAX && !cache.has(tokenHash)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(tokenHash, { principal, expiresAt: Date.now() + PRINCIPAL_CACHE_TTL_MS });
}

async function fetchPrincipal(token: string, tokenHash: string): Promise<SidecarPrincipal> {
  try {
    const body = await createPrincipalClient(token, PRINCIPAL_TIMEOUT_MS).getExecutionPrincipal();
    if (!body || typeof body.userId !== 'string' || !body.userId) {
      throw new HttpError(503, 'CLOUD_API_UNREACHABLE', 'OpenLinear API returned an invalid principal');
    }
    return {
      userId: body.userId,
      authSource: body.authSource === 'pat' ? 'pat' : 'session',
      scopes: Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
      workspaceRestriction: typeof body.workspaceId === 'string' ? body.workspaceId : null,
      tokenHash,
    };
  } catch (error) {
    throw toSidecarError(error, 'principal validation');
  }
}

/** Validate a bearer token against the control plane (cached, single-flight). */
export async function validateBearer(token: string): Promise<SidecarPrincipal> {
  const tokenHash = hashBearer(token);
  const hit = cache.get(tokenHash);
  if (hit && hit.expiresAt > Date.now()) return hit.principal;
  if (hit) cache.delete(tokenHash);

  const pending = inFlight.get(tokenHash);
  if (pending) return pending;
  const request = fetchPrincipal(token, tokenHash)
    .then((principal) => {
      remember(tokenHash, principal);
      return principal;
    })
    .finally(() => {
      inFlight.delete(tokenHash);
    });
  inFlight.set(tokenHash, request);
  return request;
}

/** Drop one token's cached principal (e.g. after the API answered 401 for it). */
export function forgetBearer(token: string): void {
  cache.delete(hashBearer(token));
}

export function bearerFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.substring(7).trim();
  return token.length > 0 ? token : null;
}

/** Express middleware: every sidecar route except /health requires it. */
export function requireSidecarAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = bearerFrom(req);
  if (!token) {
    sendError(res, new HttpError(401, 'UNAUTHORIZED', 'Authentication required'));
    return;
  }
  validateBearer(token)
    .then((principal) => {
      req.principal = principal;
      req.credential = { principal, token };
      req.userId = principal.userId;
      next();
    })
    .catch((error: unknown) => {
      const mapped = toSidecarError(error, 'principal validation');
      if (mapped.statusCode >= 500) {
        logger.warn({ code: mapped.code }, '[Auth] principal validation unavailable; request refused');
      }
      sendError(res, mapped);
    });
}

/** Narrow a request that passed `requireSidecarAuth`. */
export function credentialOf(req: AuthedRequest): PrincipalCredential {
  if (!req.credential) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return req.credential;
}
