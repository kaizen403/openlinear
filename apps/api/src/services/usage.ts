import { Prisma, prisma } from '@openlinear/db';
import type { TenancyContext } from '../tenancy/types';
import { taskVisibleSql } from './scoped-sql';

/**
 * Agent-run usage reports (GET /api/usage/summary, /api/usage/by-task),
 * aggregated in SQL (P95 Phase 1, perf1).
 *
 * Scope is unchanged: runs the caller started, or runs on tasks of the
 * caller's teams, AND the run's task must be readable by the principal now
 * (`taskVisibleSql`, the SQL mirror of `scopedTaskWhere`). Team ids are the
 * principal snapshot's (`ctx.teams`) — the same set the visibility filter
 * already used — instead of a second live `team_members` read.
 *
 * Unknown cost stays unknown: `costUsd` sums only runs with a recorded (positive) cost — a stored 0 is not a price —
 * and every bucket/row carries how many runs have none (`unknownCostRuns`),
 * so a 0 is never mistaken for "free".
 */

export const USAGE_WINDOW_DAYS = 30;

export type UsageSort = 'cost' | 'runs' | 'recent';

function scopeSql(ctx: TenancyContext): Prisma.Sql {
  const teamIds = [...ctx.teams];
  const ownership = teamIds.length > 0
    ? Prisma.sql`(r."userId" = ${ctx.userId} OR t."teamId" = ANY(${teamIds}::text[]))`
    : Prisma.sql`r."userId" = ${ctx.userId}`;
  return Prisma.sql`${ownership} AND ${taskVisibleSql(ctx, 't')}`;
}

function toNumber(value: Prisma.Decimal | bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
}

const fixed6 = (value: number) => Number(value.toFixed(6));

interface SummaryRow {
  day: string | null;
  runs: bigint | number;
  runs_with_cost: bigint | number;
  cost: Prisma.Decimal | null;
  input_tokens: bigint | number | null;
  output_tokens: bigint | number | null;
  cached_input_tokens: bigint | number | null;
  cache_write_tokens: bigint | number | null;
  reasoning_tokens: bigint | number | null;
}

export interface UsageDailyBucket {
  date: string;
  costUsd: number;
  runs: number;
  unknownCostRuns: number;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  avgCostPerRun: number;
  daily: UsageDailyBucket[];
  costCoverage: {
    runsWithKnownCost: number;
    unknownCostRuns: number;
    coverage: 'none' | 'partial' | 'complete';
  };
}

/** Midnight UTC `USAGE_WINDOW_DAYS` days before `now`. */
export function usageWindowStart(now: Date = new Date()): Date {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - USAGE_WINDOW_DAYS);
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

/**
 * One statement: per-UTC-day sums plus the grand total (ROLLUP). Totals cover
 * every run since the window start (today included); `daily` lists the 30
 * days from the window start, as before.
 *
 * `startedAt` is a `timestamp(3)` holding UTC (Prisma's convention), so the
 * bound is passed as a UTC literal cast to `timestamp` and the day is read
 * with `to_char`, independent of the session TimeZone.
 */
export async function usageSummary(ctx: TenancyContext, now: Date = new Date()): Promise<UsageSummary> {
  const since = usageWindowStart(now);
  const rows = await prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
    SELECT to_char(date_trunc('day', r."startedAt"), 'YYYY-MM-DD') AS day,
           COUNT(*) AS runs,
           COUNT(*) FILTER (WHERE r."costUsd" > 0) AS runs_with_cost,
           SUM(r."costUsd") FILTER (WHERE r."costUsd" > 0) AS cost,
           SUM(r."inputTokens") AS input_tokens,
           SUM(r."outputTokens") AS output_tokens,
           SUM(r."cachedInputTokens") AS cached_input_tokens,
           SUM(r."cacheWriteTokens") AS cache_write_tokens,
           SUM(r."reasoningTokens") AS reasoning_tokens
      FROM "agent_runs" r
      JOIN "tasks" t ON t."id" = r."taskId"
     WHERE r."startedAt" >= ${since.toISOString()}::timestamp(3)
       AND ${scopeSql(ctx)}
     GROUP BY ROLLUP (date_trunc('day', r."startedAt"))
  `);

  const total = rows.find((row) => row.day === null);
  const byDay = new Map(rows.filter((row) => row.day !== null).map((row) => [row.day as string, row]));

  const daily: UsageDailyBucket[] = [];
  for (let i = 0; i < USAGE_WINDOW_DAYS; i += 1) {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const row = byDay.get(date);
    const runs = row ? toNumber(row.runs) : 0;
    daily.push({
      date,
      costUsd: row ? fixed6(toNumber(row.cost)) : 0,
      runs,
      unknownCostRuns: row ? runs - toNumber(row.runs_with_cost) : 0,
    });
  }

  const totalRuns = total ? toNumber(total.runs) : 0;
  const runsWithKnownCost = total ? toNumber(total.runs_with_cost) : 0;
  const totalCostUsd = total ? toNumber(total.cost) : 0;
  const unknownCostRuns = totalRuns - runsWithKnownCost;
  return {
    totalCostUsd: fixed6(totalCostUsd),
    totalRuns,
    totalInputTokens: total ? toNumber(total.input_tokens) : 0,
    totalOutputTokens: total ? toNumber(total.output_tokens) : 0,
    totalCachedInputTokens: total ? toNumber(total.cached_input_tokens) : 0,
    totalCacheWriteTokens: total ? toNumber(total.cache_write_tokens) : 0,
    totalReasoningTokens: total ? toNumber(total.reasoning_tokens) : 0,
    avgCostPerRun: fixed6(totalRuns > 0 ? totalCostUsd / totalRuns : 0),
    daily,
    costCoverage: {
      runsWithKnownCost,
      unknownCostRuns,
      coverage: totalRuns === 0 || runsWithKnownCost === 0 ? 'none' : unknownCostRuns === 0 ? 'complete' : 'partial',
    },
  };
}

interface ByTaskRow {
  task_id: string;
  title: string | null;
  identifier: string | null;
  runs: bigint | number;
  runs_with_cost: bigint | number;
  cost: Prisma.Decimal | null;
  input_tokens: bigint | number | null;
  output_tokens: bigint | number | null;
  cached_input_tokens: bigint | number | null;
  cache_write_tokens: bigint | number | null;
  reasoning_tokens: bigint | number | null;
  last_run_at: Date | null;
  total_groups: bigint | number;
}

export interface UsageByTaskItem {
  taskId: string;
  taskTitle: string;
  taskIdentifier: string | null;
  runs: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  unknownCostRuns: number;
  lastRunAt: Date | null;
}

/**
 * ORDER BY matches what Prisma's `groupBy` generated before (Postgres puts
 * NULL first in DESC order, so tasks whose runs all lack a cost lead the
 * `cost` sort, as before); `taskId` is an added tiebreaker so pages are stable.
 */
const ORDER_BY: Record<UsageSort, Prisma.Sql> = {
  cost: Prisma.sql`SUM(r."costUsd") FILTER (WHERE r."costUsd" > 0) DESC, r."taskId" ASC`,
  runs: Prisma.sql`COUNT(r."taskId") DESC, r."taskId" ASC`,
  recent: Prisma.sql`MAX(r."startedAt") DESC, r."taskId" ASC`,
};

/** The same order over the paged subquery's columns. */
const PAGE_ORDER_BY: Record<UsageSort, Prisma.Sql> = {
  cost: Prisma.sql`p.cost DESC, p.task_id ASC`,
  runs: Prisma.sql`p.runs DESC, p.task_id ASC`,
  recent: Prisma.sql`p.last_run_at DESC, p.task_id ASC`,
};

/**
 * One statement for the page and the number of tasks (window count over the
 * grouped rows), joined to the task title it already reads for visibility.
 */
export async function usageByTask(
  ctx: TenancyContext,
  input: { page: number; pageSize: number; sort: UsageSort },
): Promise<{ items: UsageByTaskItem[]; total: number }> {
  const offset = (input.page - 1) * input.pageSize;
  const groupedFrom = Prisma.sql`
      FROM "agent_runs" r
      JOIN "tasks" t ON t."id" = r."taskId"
     WHERE ${scopeSql(ctx)}`;
  // Aggregate and page on narrow rows first; titles are joined for the page
  // only (carrying them through the GROUP BY spilled the sort to disk).
  const rows = await prisma.$queryRaw<ByTaskRow[]>(Prisma.sql`
    SELECT p.*, pt."title" AS title, pt."identifier" AS identifier
      FROM (
        SELECT r."taskId" AS task_id,
               COUNT(*) AS runs,
               COUNT(*) FILTER (WHERE r."costUsd" > 0) AS runs_with_cost,
               SUM(r."costUsd") FILTER (WHERE r."costUsd" > 0) AS cost,
               SUM(r."inputTokens") AS input_tokens,
               SUM(r."outputTokens") AS output_tokens,
               SUM(r."cachedInputTokens") AS cached_input_tokens,
               SUM(r."cacheWriteTokens") AS cache_write_tokens,
               SUM(r."reasoningTokens") AS reasoning_tokens,
               MAX(r."startedAt") AS last_run_at,
               COUNT(*) OVER () AS total_groups
        ${groupedFrom}
         GROUP BY r."taskId"
         ORDER BY ${ORDER_BY[input.sort]}
         LIMIT ${input.pageSize} OFFSET ${offset}
      ) p
      LEFT JOIN "tasks" pt ON pt."id" = p.task_id
     ORDER BY ${PAGE_ORDER_BY[input.sort]}
  `);

  let total = rows.length > 0 ? toNumber(rows[0].total_groups) : 0;
  if (rows.length === 0 && offset > 0) {
    // Past the last page the window count has no row to ride on.
    const [counted] = await prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT r."taskId") AS total ${groupedFrom}
    `);
    total = counted ? toNumber(counted.total) : 0;
  }

  const items = rows.map((row) => {
    const runs = toNumber(row.runs);
    return {
      taskId: row.task_id,
      taskTitle: row.title ?? '(deleted task)',
      taskIdentifier: row.identifier ?? null,
      runs,
      totalCostUsd: fixed6(toNumber(row.cost)),
      totalInputTokens: toNumber(row.input_tokens),
      totalOutputTokens: toNumber(row.output_tokens),
      totalCachedInputTokens: toNumber(row.cached_input_tokens),
      totalCacheWriteTokens: toNumber(row.cache_write_tokens),
      totalReasoningTokens: toNumber(row.reasoning_tokens),
      unknownCostRuns: runs - toNumber(row.runs_with_cost),
      lastRunAt: row.last_run_at,
    };
  });
  return { items, total };
}
