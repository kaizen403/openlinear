import type { FetchLike } from './openlinear/client';
import { isRecord } from './openlinear/errors';
import { USER_AGENT } from './version';

/** `ol_pat_` followed by 32 lowercase hex characters (apps/api/src/services/pats.ts). */
export const PAT_PATTERN = /^ol_pat_[a-f0-9]{32}$/;

const REALM = 'OpenLinear MCP';

export interface PatPrincipal {
  /**
   * The token owner, from `GET /api/users/me`. `null` for a valid token whose
   * scopes do not cover that account-level route (narrow family scopes such
   * as `tasks:write` + `projects:write`): tools then pass `me` to the API or
   * ask for an explicit user id.
   */
  userId: string | null;
  username: string | null;
}

export type VerifyOutcome =
  | { ok: true; principal: PatPrincipal; cacheKey: string }
  | { ok: false; reason: 'invalid' | 'insufficient_scope' | 'unavailable' };

interface CacheEntry {
  principal: PatPrincipal;
  expiresAt: number;
  /** Cleared after `POST /api/mcp/log` answers 403 (read-only token). */
  usageLogging: boolean;
}

export interface PatVerifierOptions {
  apiUrl: string;
  fetch?: FetchLike;
  /** How long a successful verification is reused (per isolate). */
  ttlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  now?: () => number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies personal access tokens against the OpenLinear API
 * (`GET /api/users/me`) and caches successes for a short TTL, keyed by the
 * token's SHA-256 so raw tokens are never kept as map keys. A revoked token
 * therefore stops working at the MCP edge within `ttlMs`, and immediately
 * once any tool call sees a 401 from the API (`invalidate`).
 *
 * `GET /api/users/me` needs `account:read`, which only the generic `read`,
 * `write` and `admin` scopes satisfy (W02b). The API checks the token before
 * its scopes, so `403 INSUFFICIENT_SCOPE` there proves a valid token with
 * narrow family scopes (`tasks:*`, `projects:*`, `labels:write`, …): it is
 * accepted without a known owner, and every tool call is still scope-checked
 * by the API.
 */
export class PatVerifier {
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: PatVerifierOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  async verify(token: string): Promise<VerifyOutcome> {
    const cacheKey = await sha256Hex(token);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return { ok: true, principal: cached.principal, cacheKey };
    if (cached) this.cache.delete(cacheKey);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.status === 401) return { ok: false, reason: 'invalid' };
    if (response.status === 403) {
      if ((await errorCode(response)) !== 'INSUFFICIENT_SCOPE') return { ok: false, reason: 'insufficient_scope' };
      const principal: PatPrincipal = { userId: null, username: null };
      this.remember(cacheKey, principal);
      return { ok: true, principal, cacheKey };
    }
    if (!response.ok) return { ok: false, reason: 'unavailable' };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (!isRecord(body) || typeof body.id !== 'string') return { ok: false, reason: 'unavailable' };
    const principal: PatPrincipal = {
      userId: body.id,
      username: typeof body.username === 'string' ? body.username : null,
    };
    this.remember(cacheKey, principal);
    return { ok: true, principal, cacheKey };
  }

  invalidate(cacheKey: string): void {
    this.cache.delete(cacheKey);
  }

  usageLoggingEnabled(cacheKey: string): boolean {
    return this.cache.get(cacheKey)?.usageLogging ?? true;
  }

  disableUsageLogging(cacheKey: string): void {
    const entry = this.cache.get(cacheKey);
    if (entry) entry.usageLogging = false;
  }

  private remember(cacheKey: string, principal: PatPrincipal): void {
    this.cache.set(cacheKey, { principal, expiresAt: this.now() + this.ttlMs, usageLogging: true });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

/** `code` of an API error envelope (`{ code }` or `{ error: { code } }`), if any. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return undefined;
    if (typeof body.code === 'string') return body.code;
    return isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

function quoted(value: string): string {
  return `"${value.replaceAll(/[\\"]/g, '\\$&').replaceAll(/[^\u0020-\u007E]/g, ' ')}"`;
}

export interface ChallengeOptions {
  resourceMetadataUrl: string;
  docsUrl: string;
}

/**
 * RFC 6750 challenge. A request without credentials gets no `error`
 * attribute (section 3.1); every challenge points at the RFC 9728
 * protected-resource metadata so spec-following clients can discover how to
 * authenticate.
 */
export function challengeResponse(
  kind: 'missing' | 'invalid_token' | 'insufficient_scope',
  description: string,
  options: ChallengeOptions,
): Response {
  const parts = [`Bearer realm=${quoted(REALM)}`];
  if (kind !== 'missing') {
    parts.push(`error=${quoted(kind)}`, `error_description=${quoted(description)}`);
  }
  if (kind === 'insufficient_scope') parts.push(`scope=${quoted('read')}`);
  parts.push(`resource_metadata=${quoted(options.resourceMetadataUrl)}`);
  const status = kind === 'insufficient_scope' ? 403 : 401;
  return Response.json(
    {
      error: kind === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token',
      error_description: description,
      error_uri: options.docsUrl,
    },
    { status, headers: { 'WWW-Authenticate': parts.join(', '), 'Cache-Control': 'no-store' } },
  );
}

export type AuthenticateResult =
  | { ok: true; token: string; principal: PatPrincipal; cacheKey: string }
  | { ok: false; response: Response };

/** Extract and verify the bearer PAT, or build the HTTP answer that refuses the request. */
export async function authenticate(
  request: Request,
  verifier: PatVerifier,
  options: ChallengeOptions,
): Promise<AuthenticateResult> {
  const header = request.headers.get('authorization');
  if (!header || header.trim().length === 0) {
    return {
      ok: false,
      response: challengeResponse(
        'missing',
        'Missing bearer token. Send "Authorization: Bearer ol_pat_…" with a personal access token from OpenLinear → Settings → Personal Access Tokens.',
        options,
      ),
    };
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match?.[1];
  if (!token || !PAT_PATTERN.test(token)) {
    return {
      ok: false,
      response: challengeResponse(
        'invalid_token',
        'Malformed credentials: expected "Authorization: Bearer ol_pat_" followed by 32 lowercase hex characters.',
        options,
      ),
    };
  }

  const outcome = await verifier.verify(token);
  if (outcome.ok) return { ok: true, token, principal: outcome.principal, cacheKey: outcome.cacheKey };
  if (outcome.reason === 'invalid') {
    return {
      ok: false,
      response: challengeResponse(
        'invalid_token',
        'The personal access token is invalid, expired or revoked. Create a new one in OpenLinear → Settings → Personal Access Tokens.',
        options,
      ),
    };
  }
  if (outcome.reason === 'insufficient_scope') {
    return {
      ok: false,
      response: challengeResponse(
        'insufficient_scope',
        'The personal access token may not use the OpenLinear API. Create a token with the "read" or "write" scope (or the narrow scopes the tools need).',
        options,
      ),
    };
  }
  return {
    ok: false,
    response: Response.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Could not verify the token with the OpenLinear API. Retry shortly.',
      },
      { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } },
    ),
  };
}
