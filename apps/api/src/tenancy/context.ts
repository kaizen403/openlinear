import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma, type WorkspaceRole } from '@openlinear/db';
import type { AuthContext, ProjectGrant, TenancyContext } from './types';

const als = new AsyncLocalStorage<TenancyContext>();

/**
 * Process-local principal cache (short TTL). Semantics unchanged by perf1:
 * list filters may use a principal up to `CACHE_TTL_MS` old, and every
 * membership/grant mutation calls `invalidateTenancyCache` after commit (and
 * replicas do the same on the membership domain events), so revocation still
 * applies to the next request and to open streams. Single-resource checks
 * never read this cache.
 *
 * perf1 adds hygiene only: entries are bounded (`maxCacheEntries()`, expired
 * entries first, then oldest), expired entries are dropped on read,
 * invalidation finds a user's entries through an index instead of scanning
 * every key, and a principal whose reads overlapped an invalidation of its
 * user is returned but not cached (before, such a pre-commit snapshot could be
 * cached after the invalidation and served for the rest of the TTL).
 */
const CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 10_000;

/** OPENLINEAR_TENANCY_CACHE_MAX (positive integer) overrides the default bound. */
function maxCacheEntries(): number {
  const configured = Number(process.env.OPENLINEAR_TENANCY_CACHE_MAX);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CACHE_ENTRIES;
}
const cache = new Map<string, { ctx: TenancyContext; expiresAt: number }>();
const cacheKeysByUser = new Map<string, Set<string>>();

/**
 * On outside NODE_ENV=test unless OPENLINEAR_TENANCY_CACHE=0;
 * OPENLINEAR_TENANCY_CACHE=1 forces it on (tests of the cached path).
 */
function cacheEnabled(): boolean {
  const toggle = process.env.OPENLINEAR_TENANCY_CACHE;
  if (toggle === '0') return false;
  if (toggle === '1') return true;
  return process.env.NODE_ENV !== 'test';
}

function forgetCacheKey(key: string, userId: string): void {
  cache.delete(key);
  const keys = cacheKeysByUser.get(userId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) cacheKeysByUser.delete(userId);
}

function rememberCacheEntry(key: string, ctx: TenancyContext): void {
  if (!cache.has(key) && cache.size >= maxCacheEntries()) {
    const now = Date.now();
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= now) forgetCacheKey(k, entry.ctx.userId);
    }
    // Still full: evict in insertion order (oldest first).
    for (const [k, entry] of cache) {
      if (cache.size < maxCacheEntries()) break;
      forgetCacheKey(k, entry.ctx.userId);
    }
  }
  cache.set(key, { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  let keys = cacheKeysByUser.get(ctx.userId);
  if (!keys) {
    keys = new Set();
    cacheKeysByUser.set(ctx.userId, keys);
  }
  keys.add(key);
}

/**
 * Invalidation sequence. A principal read is cached only if no invalidation
 * for its user happened while it was in flight (the reads may predate the
 * commit the invalidation announces). The per-user map is bounded like the
 * cache; clearing it makes every read in flight at that moment skip caching,
 * so the bound can only cost a cache fill, never serve stale data.
 */
let invalidationSeq = 0;
let invalidationsClearedAt = 0;
const lastInvalidation = new Map<string, number>();

function invalidatedSince(userId: string, stamp: number): boolean {
  return invalidationsClearedAt > stamp || (lastInvalidation.get(userId) ?? 0) > stamp;
}

function recordInvalidation(userId: string): void {
  invalidationSeq += 1;
  if (!lastInvalidation.has(userId) && lastInvalidation.size >= maxCacheEntries()) {
    lastInvalidation.clear();
    invalidationsClearedAt = invalidationSeq;
  }
  lastInvalidation.set(userId, invalidationSeq);
}

/** Test seam: entries currently cached (expired ones included until read or evicted). */
export function tenancyCacheSize(): number {
  return cache.size;
}

/** Test seam: drop every cached principal without notifying listeners. */
export function clearTenancyCache(): void {
  cache.clear();
  cacheKeysByUser.clear();
}

function cacheKey(auth: AuthContext): string {
  return [
    auth.authSource,
    auth.userId,
    auth.credentialId ?? '',
    auth.workspaceRestriction ?? '',
    auth.scopes.join(','),
  ].join(':');
}

export function enterTenancy(ctx: TenancyContext): void {
  als.enterWith(ctx);
}

/** Run `fn` with `ctx` bound as the current principal (tests, background work). */
export function runWithPrincipal<T>(ctx: TenancyContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getTenancyContext(): TenancyContext | undefined {
  return als.getStore();
}

export function requireTenancyContext(): TenancyContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error('TenancyContext is not bound to this request');
  }
  return ctx;
}

/**
 * The request principal, when it is `userId`.
 *
 * Policy helpers take a bare `userId` for historical reasons. Restrictions
 * carried by the principal (PAT workspace binding) apply only when the helper
 * is evaluating the caller's own access, never when it checks another user
 * (for example, a mention recipient).
 */
export function principalFor(userId: string): TenancyContext | undefined {
  const ctx = als.getStore();
  return ctx && ctx.userId === userId ? ctx : undefined;
}

/** Workspace a bound PAT principal is restricted to, or `null`. */
export function workspaceRestrictionFor(userId: string): string | null {
  return principalFor(userId)?.workspaceRestriction ?? null;
}

type InvalidationListener = (userId: string) => void;
const invalidationListeners = new Set<InvalidationListener>();

/**
 * Subscribe to membership/grant invalidations. The SSE hub uses this to pause
 * and re-authorize a user's open streams synchronously, before any event
 * emitted after the (already committed) change can be delivered.
 */
export function onTenancyInvalidated(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/**
 * Call after committing any change to `userId`'s memberships or grants.
 * Drops cached principals and notifies listeners (open streams).
 */
export function invalidateTenancyCache(userId: string): void {
  recordInvalidation(userId);
  for (const key of [...(cacheKeysByUser.get(userId) ?? [])]) {
    forgetCacheKey(key, userId);
  }
  for (const listener of invalidationListeners) {
    listener(userId);
  }
}

export interface ResolveTenancyOptions {
  /** Skip the process-local cache (long-lived SSE streams, revalidation). */
  bypassCache?: boolean;
}

export async function resolveTenancyContext(
  auth: AuthContext,
  options: ResolveTenancyOptions = {},
): Promise<TenancyContext> {
  const useCache = cacheEnabled() && !options.bypassCache;
  const key = cacheKey(auth);
  if (useCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.ctx;
    }
    if (hit) forgetCacheKey(key, auth.userId);
  }
  // An invalidation that lands while these reads are in flight may have
  // committed after they ran: such a result is returned but never cached.
  const stamp = invalidationSeq;

  const restriction = auth.workspaceRestriction ?? null;

  // A workspace-bound principal only ever sees memberships inside that
  // workspace. Deny grants are kept regardless of workspace: they can only
  // subtract access.
  const [workspaceMembers, teamMembers, projectAccess] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId: auth.userId, ...(restriction ? { workspaceId: restriction } : {}) },
      select: { workspaceId: true, role: true },
    }),
    prisma.teamMember.findMany({
      where: {
        userId: auth.userId,
        ...(restriction ? { team: { project: { workspaceId: restriction } } } : {}),
      },
      select: { teamId: true },
    }),
    prisma.projectAccess.findMany({
      where: {
        userId: auth.userId,
        ...(restriction
          ? { OR: [{ permission: 'deny' }, { project: { workspaceId: restriction } }] }
          : {}),
      },
      select: { projectId: true, permission: true },
    }),
  ]);

  const workspaces = new Map<string, WorkspaceRole>();
  for (const row of workspaceMembers) {
    workspaces.set(row.workspaceId, row.role);
  }

  const teams = new Set<string>();
  for (const row of teamMembers) {
    teams.add(row.teamId);
  }

  const projectGrants = new Map<string, ProjectGrant>();
  for (const row of projectAccess) {
    projectGrants.set(row.projectId, row.permission);
  }

  const ctx: TenancyContext = {
    userId: auth.userId,
    authSource: auth.authSource,
    scopes: auth.scopes,
    credentialId: auth.credentialId ?? null,
    workspaceRestriction: restriction,
    workspaces,
    teams,
    projectGrants,
    resolvedAt: Date.now(),
  };

  if (useCache && !invalidatedSince(auth.userId, stamp)) {
    rememberCacheEntry(key, ctx);
  }

  return ctx;
}

/**
 * Principal for service code that only receives a `userId`.
 *
 * Returns the request-bound principal when it belongs to `userId`, so PAT
 * scopes and workspace binding propagate into services and chat tools.
 * Otherwise resolves an unrestricted session-equivalent context (background
 * jobs, or checks about another user).
 */
export async function resolvePrincipalForUser(userId: string): Promise<TenancyContext> {
  const bound = principalFor(userId);
  if (bound) return bound;
  return resolveTenancyContext({ userId, authSource: 'jwt', scopes: [] });
}
