import { HttpError } from '../errors';
import {
  assertProjectAccess,
  assertTaskAccess,
  assertTeamRole,
  isOwnershipError,
} from '../services/ownership';
import { assertWorkspaceRole } from '../services/workspaces';
import type { Action, Resource, TenancyContext } from './types';

function requiredProjectPermission(action: Action): 'view' | 'full' {
  return action === 'read' || action === 'view' ? 'view' : 'full';
}

/**
 * Authorisation for a concrete resource id. List queries must use the scoped
 * where-builders instead of calling this in a loop.
 *
 * Implemented via the existing ownership helpers so single-resource checks
 * stay consistent with Phase 0 while routes migrate onto TenancyContext.
 */
export async function assertCan(
  ctx: TenancyContext,
  action: Action,
  resource: Resource,
): Promise<void> {
  const permission = requiredProjectPermission(action);

  switch (resource.type) {
    case 'task':
      await assertTaskAccess(resource.id, ctx.userId, permission);
      return;
    case 'project':
      await assertProjectAccess(resource.id, ctx.userId, permission);
      return;
    case 'team': {
      const roles = permission === 'view'
        ? (['owner', 'admin', 'member'] as const)
        : (['owner', 'admin'] as const);
      await assertTeamRole(resource.id, ctx.userId, roles);
      return;
    }
    case 'workspace': {
      const roles = permission === 'view'
        ? (['owner', 'admin', 'member', 'viewer'] as const)
        : (['owner', 'admin'] as const);
      await assertWorkspaceRole(resource.id, ctx.userId, roles);
      return;
    }
    default: {
      const _exhaustive: never = resource;
      throw new HttpError(403, 'FORBIDDEN', `Unknown resource ${_exhaustive}`);
    }
  }
}

export async function can(
  ctx: TenancyContext,
  action: Action,
  resource: Resource,
): Promise<boolean> {
  try {
    await assertCan(ctx, action, resource);
    return true;
  } catch (err) {
    if (isOwnershipError(err) || (err instanceof HttpError && err.statusCode === 403)) {
      return false;
    }
    throw err;
  }
}
