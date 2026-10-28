/**
 * Request rate limits (W14).
 *
 * Authenticated traffic is limited per principal, unauthenticated traffic per
 * client IP:
 *
 *   - session JWT  → bucket `user:<userId>` (all of a user's sessions share it)
 *   - PAT          → bucket `pat:<tokenId>` (each token its own budget)
 *   - anything else (no credential, malformed or unknown credential, a PAT
 *     this process has not yet seen succeed) → bucket per IP (`ip` limit)
 *
 * Before, every request was limited per IP. All MCP users reach the API from
 * the Cloudflare worker's egress addresses, so they shared one 100/min
 * bucket; users behind one NAT did too.
 *
 * The limiter runs before body parsing and before route authentication, so
 * it must classify cheaply and must not trust what it cannot verify:
 *   - a JWT is verified (signature, expiry, claims; no database read). A
 *     revoked-but-unexpired session still lands in its user's bucket and is
 *     then refused by `requireAuth`;
 *   - a PAT is never looked up here. Its SHA-256 is mapped to the token id
 *     only after `requireAuth` accepted it on an earlier request
 *     (`res.on('finish')` reads `req.patId`). Random or revoked-unknown tokens
 *     therefore count against the caller's IP bucket, so guessing tokens
 *     cannot mint fresh buckets. The first request of a token per process
 *     (and per `PAT_PRINCIPAL_TTL_MS`) is counted against the IP bucket.
 *
 * Buckets live in process memory (express-rate-limit MemoryStore): each
 * replica limits independently. Limits are configurable (see
 * `readRateLimitConfig`).
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import { buildErrorEnvelope } from '../lib/http';
import { isPersonalAccessToken } from '../services/pats';
import { verifyAccessToken, type AuthRequest } from './auth';

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  /** Per authenticated principal (session user or PAT) per window. */
  principalMax: number;
  /** Per client IP per window, for requests without a recognised principal. */
  ipMax: number;
  /** `/api/auth/*` (except GitHub OAuth), per IP. */
  authMax: number;
  /** `/api/auth/github/*`, per IP. */
  githubOAuthMax: number;
  /** `/api/repos/url`, per IP. */
  reposUrlMax: number;
}

const DEFAULTS = {
  windowMs: 60_000,
  principalMax: 300,
  ipMax: 100,
  authMax: 60,
  githubOAuthMax: 120,
  reposUrlMax: 10,
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Environment:
 *   RATE_LIMIT_ENABLED                 `1`/`0`; default on, off under NODE_ENV=test
 *   RATE_LIMIT_WINDOW_MS               default 60000
 *   RATE_LIMIT_PRINCIPAL_PER_WINDOW    default 300 (per user session / per PAT)
 *   RATE_LIMIT_IP_PER_WINDOW           default 100 (unauthenticated, per IP)
 *   RATE_LIMIT_AUTH_PER_WINDOW         default 60
 *   RATE_LIMIT_GITHUB_OAUTH_PER_WINDOW default 120
 *   RATE_LIMIT_REPOS_URL_PER_WINDOW    default 10
 * Invalid numbers fall back to the default.
 */
export function readRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const flag = env.RATE_LIMIT_ENABLED?.trim().toLowerCase();
  const enabled = flag === undefined || flag === ''
    ? env.NODE_ENV !== 'test'
    : !['0', 'false', 'off', 'no'].includes(flag);
  return {
    enabled,
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULTS.windowMs),
    principalMax: positiveInt(env.RATE_LIMIT_PRINCIPAL_PER_WINDOW, DEFAULTS.principalMax),
    ipMax: positiveInt(env.RATE_LIMIT_IP_PER_WINDOW, DEFAULTS.ipMax),
    authMax: positiveInt(env.RATE_LIMIT_AUTH_PER_WINDOW, DEFAULTS.authMax),
    githubOAuthMax: positiveInt(env.RATE_LIMIT_GITHUB_OAUTH_PER_WINDOW, DEFAULTS.githubOAuthMax),
    reposUrlMax: positiveInt(env.RATE_LIMIT_REPOS_URL_PER_WINDOW, DEFAULTS.reposUrlMax),
  };
}

// ─── PAT principals learned from successful authentication ──────────────────

const PAT_PRINCIPAL_TTL_MS = 10 * 60_000;
const MAX_LEARNED_PATS = 10_000;
const learnedPats = new Map<string, { tokenId: string; expiresAt: number }>();

function patHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function learnedPatId(hash: string, now: number): string | null {
  const entry = learnedPats.get(hash);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    learnedPats.delete(hash);
    return null;
  }
  return entry.tokenId;
}

function learnPat(hash: string, tokenId: string, now: number): void {
  if (learnedPats.size >= MAX_LEARNED_PATS && !learnedPats.has(hash)) {
    // Drop the oldest entry (Map keeps insertion order).
    const oldest = learnedPats.keys().next();
    if (!oldest.done) learnedPats.delete(oldest.value);
  }
  learnedPats.delete(hash);
  learnedPats.set(hash, { tokenId, expiresAt: now + PAT_PRINCIPAL_TTL_MS });
}

/** Test seam. */
export function resetRateLimitPrincipals(): void {
  learnedPats.clear();
}

// ─── Classification ──────────────────────────────────────────────────────────

export type RateLimitPrincipal =
  | { kind: 'user'; key: string }
  | { kind: 'pat'; key: string }
  | { kind: 'ip'; key: string; pendingPatHash?: string };

function ipKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

export function classifyRequest(req: Request, now: number = Date.now()): RateLimitPrincipal {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token && isPersonalAccessToken(token)) {
      const hash = patHash(token);
      const tokenId = learnedPatId(hash, now);
      if (tokenId) return { kind: 'pat', key: `pat:${tokenId}` };
      return { kind: 'ip', key: ipKey(req), pendingPatHash: hash };
    }
    if (token) {
      const claims = verifyAccessToken(token);
      if (claims) return { kind: 'user', key: `user:${claims.userId}` };
    }
  }
  return { kind: 'ip', key: ipKey(req) };
}

/** Classified once per request (the dispatcher and the key generator both need it). */
const principals = new WeakMap<Request, RateLimitPrincipal>();

function principalOf(req: Request): RateLimitPrincipal {
  const stored = principals.get(req);
  if (stored) return stored;
  const principal = classifyRequest(req);
  principals.set(req, principal);
  return principal;
}

// ─── Limiters ────────────────────────────────────────────────────────────────

type Scope = 'principal' | 'default' | 'auth' | 'github-oauth' | 'repos-url';

function limitedResponse(scope: Scope) {
  return (req: Request, res: Response): void => {
    const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
    const resetMs = info?.resetTime ? info.resetTime.getTime() - Date.now() : 0;
    const retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));
    res.status(429).json(buildErrorEnvelope('RATE_LIMITED', 'Too many requests', {
      details: { scope, retryAfterSeconds },
      extras: { scope, retryAfterSeconds },
    }));
  };
}

/** An IP-keyed limiter (unauthenticated routes: auth, OAuth, repo URL checks). */
export function ipRateLimiter(config: RateLimitConfig, max: number, scope: Exclude<Scope, 'principal'>): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !config.enabled,
    keyGenerator: (req) => ipKey(req),
    handler: limitedResponse(scope),
  });
}

/**
 * The app-wide limiter: per principal when the request carries a verified
 * session JWT or a known PAT, else per IP. Mount before body parsing.
 */
export function principalRateLimiter(config: RateLimitConfig): RequestHandler {
  const perPrincipal = rateLimit({
    windowMs: config.windowMs,
    limit: config.principalMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => principalOf(req).key,
    handler: limitedResponse('principal'),
  });
  // Scope name `default` kept for the IP bucket (what clients saw before).
  const perIp = rateLimit({
    windowMs: config.windowMs,
    limit: config.ipMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => principalOf(req).key,
    handler: limitedResponse('default'),
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.enabled) {
      next();
      return;
    }
    const principal = principalOf(req);
    if (principal.kind === 'ip' && principal.pendingPatHash) {
      const hash = principal.pendingPatHash;
      // `requireAuth` sets `patId` only after the token was found valid and
      // allowed on the route, whatever the handler answered afterwards.
      res.on('finish', () => {
        const tokenId = (req as AuthRequest).patId;
        if (tokenId) learnPat(hash, tokenId, Date.now());
      });
    }
    if (principal.kind === 'ip') {
      void perIp(req, res, next);
      return;
    }
    void perPrincipal(req, res, next);
  };
}
