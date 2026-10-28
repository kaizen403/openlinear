import { Prisma } from '@openlinear/db';
import { workspaceRestrictionFor } from '../tenancy/context';
import type { TenancyContext } from '../tenancy/types';

/**
 * Raw-SQL mirror of `scopedTaskWhere(ctx, {}, 'view')` (tenancy/scopes.ts),
 * for aggregate reads that Prisma cannot express (GROUP BY a computed day,
 * several FILTERed aggregates in one statement). P95 Phase 1, perf1.
 *
 * It must stay equivalent to the Prisma builder:
 * `__tests__/perf1-scoped-aggregates.test.ts` checks both against the same
 * multi-tenant fixture (workspace members, explicit
 * view/full/deny grants, workspace-less projects, legacy team access,
 * team-only tasks, orphans, workspace-bound PATs). Change both together.
 *
 * A task is visible when:
 *   - its project is visible: not explicitly denied, AND (workspace member, OR
 *     an explicit view/full grant on a workspace-less project, OR legacy
 *     membership of one of the project's teams), AND inside the principal's
 *     bound workspace when there is one; or
 *   - it has no project and no team and the caller created it (unbound
 *     principals only); or
 *   - it has no project, is on one of the caller's teams, and that team's
 *     project neither denies the caller nor lies outside the bound workspace.
 *
 * The caller's team ids come from the principal snapshot (`ctx.teams`), exactly
 * as in `scopedTaskWhere`.
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(alias: string): Prisma.Sql {
  if (!IDENTIFIER.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  return Prisma.raw(alias);
}

function restrictionOf(ctx: TenancyContext): string | null {
  return ctx.workspaceRestriction ?? workspaceRestrictionFor(ctx.userId);
}

/**
 * Ids of the projects `projectAccessWhere(userId, teamIds, 'view',
 * restriction)` matches, as a subquery. Each way in is its own index-driven
 * arm (workspace membership by `workspace_members.userId`, explicit view/full
 * grants on workspace-less projects by `project_access.userId`, legacy team
 * membership by team id), so the cost follows the caller's memberships rather
 * than the size of `linear_projects`; denies and the PAT workspace binding then
 * filter the union.
 */
function visibleProjectIdsSql(userId: string, teamIds: readonly string[], restriction: string | null): Prisma.Sql {
  const arms: Prisma.Sql[] = [
    Prisma.sql`SELECT gp."id" FROM "linear_projects" gp
      JOIN "workspace_members" wm ON wm."workspaceId" = gp."workspaceId"
     WHERE wm."userId" = ${userId}`,
    Prisma.sql`SELECT ga."projectId" FROM "project_access" ga
      JOIN "linear_projects" gap ON gap."id" = ga."projectId"
     WHERE ga."userId" = ${userId} AND ga."permission" IN ('full', 'view') AND gap."workspaceId" IS NULL`,
  ];
  if (teamIds.length > 0) {
    arms.push(Prisma.sql`SELECT pt."project_id" FROM "teams" pt WHERE pt."id" = ANY(${[...teamIds]}::text[])`);
  }
  return Prisma.sql`SELECT vp."id" FROM "linear_projects" vp
     WHERE vp."id" IN (${Prisma.join(arms, ' UNION ALL ')})
       AND NOT EXISTS (SELECT 1 FROM "project_access" pd WHERE pd."projectId" = vp."id" AND pd."userId" = ${userId} AND pd."permission" = 'deny')
       ${restriction ? Prisma.sql`AND vp."workspaceId" = ${restriction}` : Prisma.empty}`;
}

/**
 * Boolean SQL expression: task row `taskAlias` is visible to `ctx` (view).
 *
 * The project and team branches are uncorrelated `IN (SELECT …)` sets, so
 * Postgres evaluates each once per statement and probes a hash per task row
 * ("hashed SubPlan"). That keeps the access rules in the database (no list of
 * every accessible project id is bound from the app, the F-060 concern); a
 * correlated `EXISTS` per task row measured 2-3x slower on the 50k-task bench.
 */
export function taskVisibleSql(ctx: TenancyContext, taskAlias: string): Prisma.Sql {
  const t = identifier(taskAlias);
  const teamIds = [...ctx.teams];
  const restriction = restrictionOf(ctx);

  const branches: Prisma.Sql[] = [
    Prisma.sql`${t}."projectId" IN (${visibleProjectIdsSql(ctx.userId, teamIds, restriction)})`,
  ];
  if (!restriction) {
    branches.push(Prisma.sql`(${t}."projectId" IS NULL AND ${t}."teamId" IS NULL AND ${t}."creatorId" = ${ctx.userId})`);
  }
  if (teamIds.length > 0) {
    branches.push(Prisma.sql`(${t}."projectId" IS NULL AND ${t}."teamId" IN (
      SELECT vt."id" FROM "teams" vt JOIN "linear_projects" vtp ON vtp."id" = vt."project_id"
      WHERE vt."id" = ANY(${teamIds}::text[])
        AND NOT EXISTS (SELECT 1 FROM "project_access" vtd WHERE vtd."projectId" = vtp."id" AND vtd."userId" = ${ctx.userId} AND vtd."permission" = 'deny')
        ${restriction ? Prisma.sql`AND vtp."workspaceId" = ${restriction}` : Prisma.empty}
    ))`);
  }
  return Prisma.sql`(${Prisma.join(branches, ' OR ')})`;
}
