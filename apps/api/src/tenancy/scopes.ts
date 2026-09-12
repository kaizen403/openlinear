import type { Prisma } from '@openlinear/db';
import type { TenancyContext } from './types';

export type ProjectAccessPermission = 'view' | 'full';

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
 */
export function projectAccessWhere(
  userId: string,
  teamIds: readonly string[] = [],
  permission: ProjectAccessPermission = 'view',
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

export function scopedProjectWhere(
  ctx: TenancyContext,
  permission: ProjectAccessPermission = 'view',
): Prisma.ProjectWhereInput {
  return projectAccessWhere(ctx.userId, [...ctx.teams], permission);
}

/**
 * Task visibility via correlated EXISTS on `project`, not an `id IN (...)`
 * list of every accessible project (C1 F-060).
 *
 * A task is visible when:
 *   - it belongs to an accessible project, or
 *   - it has no project, is on a team the user belongs to, or
 *   - it is an orphan (no project, no team) created by the caller.
 */
export function scopedTaskWhere(
  ctx: TenancyContext,
  filters: Prisma.TaskWhereInput = {},
  permission: ProjectAccessPermission = 'view',
): Prisma.TaskWhereInput {
  const teamIds = [...ctx.teams];
  const visibility: Prisma.TaskWhereInput[] = [
    {
      projectId: { not: null },
      project: projectAccessWhere(ctx.userId, teamIds, permission),
    },
    {
      projectId: null,
      teamId: null,
      creatorId: ctx.userId,
    },
  ];
  if (teamIds.length > 0) {
    visibility.push({
      projectId: null,
      teamId: { in: teamIds },
    });
  }

  const and: Prisma.TaskWhereInput[] = [{ OR: visibility }];
  if (Object.keys(filters).length > 0) {
    and.push(filters);
  }
  return { AND: and };
}

export function scopedTeamWhere(ctx: TenancyContext): Prisma.TeamWhereInput {
  return {
    members: { some: { userId: ctx.userId } },
    NOT: {
      project: {
        access: { some: { userId: ctx.userId, permission: 'deny' } },
      },
    },
  };
}

/**
 * Activity rows for projects the caller can see (workspace-derived included)
 * plus team-only and self-authored orphan rows. Denied projects are excluded
 * even when the caller is still a team member.
 */
export function scopedActivityWhere(ctx: TenancyContext): Prisma.ActivityLogWhereInput {
  const teamIds = [...ctx.teams];
  const or: Prisma.ActivityLogWhereInput[] = [
    { project: projectAccessWhere(ctx.userId, teamIds, 'view') },
    { projectId: null, teamId: null, userId: ctx.userId },
  ];
  if (teamIds.length > 0) {
    or.push({ projectId: null, teamId: { in: teamIds } });
  }
  return { OR: or };
}
