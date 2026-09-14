import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma, type WorkspaceRole } from '@openlinear/db';
import type { AuthContext, ProjectGrant, TenancyContext } from './types';

const als = new AsyncLocalStorage<TenancyContext>();

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { ctx: TenancyContext; expiresAt: number }>();

function cacheEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.OPENLINEAR_TENANCY_CACHE !== '0';
}

function cacheKey(auth: AuthContext): string {
  return `${auth.authSource}:${auth.userId}:${auth.scopes.join(',')}`;
}

export function enterTenancy(ctx: TenancyContext): void {
  als.enterWith(ctx);
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

export function invalidateTenancyCache(userId: string): void {
  for (const key of [...cache.keys()]) {
    const parts = key.split(':');
    if (parts[1] === userId) {
      cache.delete(key);
    }
  }
}

export async function resolveTenancyContext(auth: AuthContext): Promise<TenancyContext> {
  if (cacheEnabled()) {
    const key = cacheKey(auth);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.ctx;
    }
  }

  const [workspaceMembers, teamMembers, projectAccess] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId: auth.userId },
      select: { workspaceId: true, role: true },
    }),
    prisma.teamMember.findMany({
      where: { userId: auth.userId },
      select: { teamId: true },
    }),
    prisma.projectAccess.findMany({
      where: { userId: auth.userId },
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
    workspaces,
    teams,
    projectGrants,
    resolvedAt: Date.now(),
  };

  if (cacheEnabled()) {
    cache.set(cacheKey(auth), { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  return ctx;
}
