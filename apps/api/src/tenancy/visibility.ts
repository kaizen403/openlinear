import type { TenancyContext } from './types';

/**
 * Resource binding carried by realtime domain events (W02a).
 *
 * - `user`: private to the explicitly addressed users.
 * - `workspace`: workspace members (plus explicitly addressed users).
 * - `team`: current team members, minus users denied on the team's project.
 * - `project`: users who can currently view the project (audience arrays
 *   only route; they never authorize).
 *
 * Rows persisted before bindings existed have no type. They are delivered
 * only to explicitly addressed users (fail closed).
 */
export const EVENT_RESOURCE_TYPES = ['user', 'workspace', 'team', 'project'] as const;
export type EventResourceType = (typeof EVENT_RESOURCE_TYPES)[number];

export function isEventResourceType(value: unknown): value is EventResourceType {
  return typeof value === 'string' && (EVENT_RESOURCE_TYPES as readonly string[]).includes(value);
}

export interface ProjectSnapshotRef {
  projectId: string;
  workspaceId: string | null;
  /** Teams of the project known to the caller. A subset only narrows access. */
  teamIds: readonly string[];
}

/**
 * Snapshot mirror of `resolveProjectAccess` (services/workspaces.ts):
 * explicit deny wins; then workspace membership; then an explicit view/full
 * grant on a workspace-less project; then legacy team membership. A
 * workspace-bound principal never sees another workspace's project.
 */
export function canViewProjectInSnapshot(ctx: TenancyContext, ref: ProjectSnapshotRef): boolean {
  if (ctx.workspaceRestriction && ref.workspaceId !== ctx.workspaceRestriction) return false;
  const grant = ctx.projectGrants.get(ref.projectId);
  if (grant === 'deny') return false;
  if (ref.workspaceId && ctx.workspaces.has(ref.workspaceId)) return true;
  if (!ref.workspaceId && (grant === 'view' || grant === 'full')) return true;
  return ref.teamIds.some((teamId) => ctx.teams.has(teamId));
}

export interface EventAudienceRef {
  resourceType: string | null;
  projectId: string | null;
  workspaceId: string | null;
  userIds: readonly string[];
  teamIds: readonly string[];
  workspaceIds: readonly string[];
}

/**
 * Whether the principal may receive a realtime event. Audience arrays are a
 * routing hint; the resource binding is the authorization decision.
 */
export function canReceiveEvent(ctx: TenancyContext, event: EventAudienceRef): boolean {
  const direct = event.userIds.includes(ctx.userId);
  const viaTeam = event.teamIds.some((teamId) => ctx.teams.has(teamId));
  const viaWorkspace = event.workspaceIds.some((workspaceId) => ctx.workspaces.has(workspaceId));

  switch (event.resourceType) {
    case 'user':
      return direct;
    case 'workspace':
      return direct || viaWorkspace;
    case 'team': {
      // Current team membership only: direct addressing (for example a task
      // creator who has since left the team) does not authorize team data.
      if (event.projectId && ctx.projectGrants.get(event.projectId) === 'deny') return false;
      if (ctx.workspaceRestriction && event.workspaceId !== ctx.workspaceRestriction) return false;
      return viaTeam;
    }
    case 'project': {
      if (!event.projectId) return false;
      if (!direct && !viaTeam && !viaWorkspace) return false;
      return canViewProjectInSnapshot(ctx, {
        projectId: event.projectId,
        workspaceId: event.workspaceId,
        teamIds: event.teamIds,
      });
    }
    default:
      return direct;
  }
}

/** Project ids the principal is explicitly denied (cheap SQL pre-filter). */
export function deniedProjectIds(ctx: TenancyContext): string[] {
  const denied: string[] = [];
  for (const [projectId, grant] of ctx.projectGrants) {
    if (grant === 'deny') denied.push(projectId);
  }
  return denied;
}
