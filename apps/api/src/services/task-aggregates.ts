import { Prisma, prisma } from '@openlinear/db';
import type { TenancyContext } from '../tenancy/types';
import { taskVisibleSql } from './scoped-sql';

/**
 * Counters over the caller's visible tasks, one statement each (P95 Phase 1,
 * perf1). They replace several Prisma `count`/`groupBy` calls that each
 * re-evaluated the whole visibility predicate over every visible task:
 * dashboard 6 scans -> 1, inbox count 2 -> 1. Visibility is `taskVisibleSql`,
 * the SQL mirror of `scopedTaskWhere` (equivalence-tested).
 */

const n = (value: bigint | number | null | undefined) => (value === null || value === undefined ? 0 : Number(value));

interface DashboardRow {
  total: bigint;
  recent: bigint;
  overdue: bigint;
  unassigned: bigint;
  todo: bigint;
  in_progress: bigint;
  done: bigint;
  cancelled: bigint;
  low: bigint;
  medium: bigint;
  high: bigint;
}

export interface DashboardTaskStats {
  total: number;
  recent: number;
  overdue: number;
  unassigned: number;
  byStatus: { todo: number; in_progress: number; done: number; cancelled: number };
  byPriority: { low: number; medium: number; high: number };
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Non-archived visible tasks: total, created in the last 7 days, overdue
 * (not done, due before now), unassigned (not done, no assignee), and counts
 * by status and priority. Same predicates as the six queries it replaces.
 * `dueDate`/`createdAt` are `timestamp(3)` holding UTC, so bounds are bound
 * as UTC literals.
 */
export async function dashboardTaskStats(ctx: TenancyContext, now: Date = new Date()): Promise<DashboardTaskStats> {
  const nowUtc = now.toISOString();
  const recentSince = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
  const [row] = await prisma.$queryRaw<DashboardRow[]>(Prisma.sql`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE t."createdAt" >= ${recentSince}::timestamp(3)) AS recent,
           COUNT(*) FILTER (WHERE t."status" <> 'done' AND t."dueDate" < ${nowUtc}::timestamp(3)) AS overdue,
           COUNT(*) FILTER (WHERE t."status" <> 'done' AND t."assigneeId" IS NULL) AS unassigned,
           COUNT(*) FILTER (WHERE t."status" = 'todo') AS todo,
           COUNT(*) FILTER (WHERE t."status" = 'in_progress') AS in_progress,
           COUNT(*) FILTER (WHERE t."status" = 'done') AS done,
           COUNT(*) FILTER (WHERE t."status" = 'cancelled') AS cancelled,
           COUNT(*) FILTER (WHERE t."priority" = 'low') AS low,
           COUNT(*) FILTER (WHERE t."priority" = 'medium') AS medium,
           COUNT(*) FILTER (WHERE t."priority" = 'high') AS high
      FROM "tasks" t
     WHERE t."archived" = false
       AND ${taskVisibleSql(ctx, 't')}
  `);
  return {
    total: n(row?.total),
    recent: n(row?.recent),
    overdue: n(row?.overdue),
    unassigned: n(row?.unassigned),
    byStatus: { todo: n(row?.todo), in_progress: n(row?.in_progress), done: n(row?.done), cancelled: n(row?.cancelled) },
    byPriority: { low: n(row?.low), medium: n(row?.medium), high: n(row?.high) },
  };
}

/**
 * The caller's notifications that are not about a task they can no longer
 * read (same rule as `visibleNotificationWhere` in routes/notifications.ts):
 * `total` honours `unreadOnly`, `unread` never does. One statement for both
 * counts (they were two scans inside a transaction).
 */
export async function notificationCounts(
  ctx: TenancyContext,
  input: { unreadOnly: boolean },
): Promise<{ total: number; unread: number }> {
  const totalFilter = input.unreadOnly ? Prisma.sql`WHERE n."readAt" IS NULL` : Prisma.sql`WHERE true`;
  // A join, not `EXISTS`: Postgres turns that EXISTS into a hashed set of
  // every visible task (45k rows on the bench) even for a user with a few
  // hundred notifications; the join probes `tasks` by primary key per row.
  const [row] = await prisma.$queryRaw<Array<{ total: bigint; unread: bigint }>>(Prisma.sql`
    SELECT COUNT(*) FILTER (${totalFilter}) AS total,
           COUNT(*) FILTER (WHERE n."readAt" IS NULL) AS unread
      FROM "notifications" n
      LEFT JOIN "tasks" t ON t."id" = n."taskId"
     WHERE n."userId" = ${ctx.userId}
       AND (n."taskId" IS NULL OR (t."id" IS NOT NULL AND ${taskVisibleSql(ctx, 't')}))
  `);
  return { total: n(row?.total), unread: n(row?.unread) };
}

/** Inbox badge: visible, non-archived, done or cancelled tasks; and how many are unread. */
export async function inboxCounts(ctx: TenancyContext): Promise<{ total: number; unread: number }> {
  const [row] = await prisma.$queryRaw<Array<{ total: bigint; unread: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE t."inboxRead" = false) AS unread
      FROM "tasks" t
     WHERE t."archived" = false
       AND t."status" IN ('done', 'cancelled')
       AND ${taskVisibleSql(ctx, 't')}
  `);
  return { total: n(row?.total), unread: n(row?.unread) };
}
