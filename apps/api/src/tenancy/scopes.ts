import type { Prisma } from '@openlinear/db';
import { workspaceRestrictionFor } from './context';
import type { TenancyContext } from './types';

export type ProjectAccessPermission = 'view' | 'full';

function restrictionOf(ctx: TenancyContext): string | null {
  return ctx.workspaceRestriction ?? workspaceRestrictionFor(ctx.userId);
}

/**
 * Correlated project visibility. Same rules as the previous
 * `buildProjectAccessWhere` / `buildProjectFullAccessWhere`, kept in one place
 * so list routes cannot drift.
 *
 * A project is visible when the caller is not explicitly denied AND one of:
 *   - workspace membership
 *   - an explicit view/full grant (workspace-less projects)
 *   - legacy team membership on a project team
 *
 * `full` additionally requires a write-tier workspace role (or an explicit
 * `full` grant) and treats an explicit `view` grant as read-only.
 *
 * A workspace-bound principal (PAT) additionally only sees projects in its
 * workspace. When the caller does not pass the restriction explicitly it is
 * read from the request-bound principal, so every list built from this
 * function inherits the PAT binding.
 */
export function projectAccessWhere(
  userId: string,
  teamIds: readonly string[] = [],
  permission: ProjectAccessPermission = 'view',
  workspaceRestriction: string | null = workspaceRestrictionFor(userId),
): Prisma.ProjectWhereInput {
  const base = unrestrictedProjectAccessWhere(userId, teamIds, permission);
  if (!workspaceRestriction) return base;
  return { AND: [base, { workspaceId: workspaceRestriction }] };
}

function unrestrictedProjectAccessWhere(
  userId: string,
  teamIds: readonly string[],
  permission: ProjectAccessPermission,
): Prisma.ProjectWhereInput {
  if (permission === 'full') {
    const legacyTeamAccessWhere: Prisma.ProjectWhereInput[] = teamIds.length > 0
      ? [
          {
            teams: { some: { id: { in: [...teamIds] } } },
            NOT: { workspace: { members: { some: { userId } } } },
            OR: [
              { workspaceId: { not: null } },
              { NOT: { access: { some: { userId, permission: 'view' } } } },
            ],
          },
        ]
      : [];

    return {
      NOT: { access: { some: { userId, permission: 'deny' } } },
      OR: [
        {
          workspaceId: { not: null },
          workspace: { members: { some: { userId } } },
          access: { some: { userId, permission: 'full' } },
        },
        {
          workspaceId: { not: null },
          workspace: {
            members: {
              some: {
                userId,
                role: { in: ['owner', 'admin'] },
              },
            },
          },
          NOT: { access: { some: { userId, permission: 'view' } } },
        },
        {
          workspaceId: null,
          access: { some: { userId, permission: 'full' } },
        },
        ...legacyTeamAccessWhere,
      ],
    };
  }

  return {
    NOT: { access: { some: { userId, permission: 'deny' } } },
    OR: [
      { workspace: { members: { some: { userId } } } },
      {
        workspaceId: null,
        access: { some: { userId, permission: { in: ['full', 'view'] } } },
      },
      ...(teamIds.length > 0
        ? [{ teams: { some: { id: { in: [...teamIds] } } } }]
        : []),
    ],
  };
}

/**
 * Extra project predicate for services that build their own project filter
 * (for example "projects of workspace X"): narrows to the bound PAT's
 * workspace, or matches everything for unrestricted principals.
 */
export function principalProjectScope(userId: string): Prisma.ProjectWhereInput {
  const restriction = workspaceRestrictionFor(userId);
  return restriction ? { workspaceId: restriction } : {};
}

export function scopedProjectWhere(
  ctx: TenancyContext,
  permission: ProjectAccessPermission = 'view',
): Prisma.ProjectWhereInput {
  return projectAccessWhere(ctx.userId, [...ctx.teams], permission, restrictionOf(ctx));
}

/**
 * Team rows reachable through a team-only task/activity: the team's project
 * must not deny the caller, and must sit in the principal's workspace when
 * the principal is workspace-bound.
 */
function teamProjectWhere(userId: string, restriction: string | null): Prisma.TeamWhereInput {
  return {
    project: {
      NOT: { access: { some: { userId, permission: 'deny' } } },
      ...(restriction ? { workspaceId: restriction } : {}),
    },
  };
}

/**
 * Task visibility via correlated EXISTS on `project`, not an `id IN (...)`
 * list of every accessible project (C1 F-060).
 *
 * A task is visible when:
 *   - it belongs to an accessible project, or
 *   - it has no project, is on a team the user belongs to, and that team's
 *     project does not deny the user, or
 *   - it is an orphan (no project, no team) created by the caller. Orphans
 *     belong to no workspace, so workspace-bound principals never see them.
 */
export function scopedTaskWhere(
  ctx: TenancyContext,
  filters: Prisma.TaskWhereInput = {},
  permission: ProjectAccessPermission = 'view',
): Prisma.TaskWhereInput {
  const teamIds = [...ctx.teams];
  const restriction = restrictionOf(ctx);
  const visibility: Prisma.TaskWhereInput[] = [
    {
      projectId: { not: null },
      project: projectAccessWhere(ctx.userId, teamIds, permission, restriction),
    },
  ];
  if (!restriction) {
    visibility.push({
      projectId: null,
      teamId: null,
      creatorId: ctx.userId,
    });
  }
  if (teamIds.length > 0) {
    visibility.push({
      projectId: null,
      teamId: { in: teamIds },
      team: teamProjectWhere(ctx.userId, restriction),
    });
  }

  const and: Prisma.TaskWhereInput[] = [{ OR: visibility }];
  if (Object.keys(filters).length > 0) {
    and.push(filters);
  }
  return { AND: and };
}

export function scopedTeamWhere(ctx: TenancyContext): Prisma.TeamWhereInput {
  const restriction = restrictionOf(ctx);
  return {
    members: { some: { userId: ctx.userId } },
    NOT: {
      project: {
        access: { some: { userId: ctx.userId, permission: 'deny' } },
      },
    },
    ...(restriction ? { project: { workspaceId: restriction } } : {}),
  };
}

/**
 * Activity rows for projects the caller can see (workspace-derived included)
 * plus team-only and self-authored orphan rows. Denied projects are excluded
 * even when the caller is still a team member.
 */
export function scopedActivityWhere(ctx: TenancyContext): Prisma.ActivityLogWhereInput {
  const teamIds = [...ctx.teams];
  const restriction = restrictionOf(ctx);
  const or: Prisma.ActivityLogWhereInput[] = [
    { project: projectAccessWhere(ctx.userId, teamIds, 'view', restriction) },
  ];
  if (!restriction) {
    or.push({ projectId: null, teamId: null, userId: ctx.userId });
  }
  if (teamIds.length > 0) {
    or.push({
      projectId: null,
      teamId: { in: teamIds },
      team: teamProjectWhere(ctx.userId, restriction),
    });
  }
  return { OR: or };
}
