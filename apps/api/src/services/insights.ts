import { Prisma, prisma } from '@openlinear/db';
import { INSIGHTS_RANGE_DAYS, type InsightsRange } from '../schemas/insights';
import { assertProjectAccess } from './ownership';
import { assertWorkspaceRole } from './workspaces';

/**
 * W15b insights: how agent work and delivery are going in one project, or in
 * the projects of a workspace the caller can see. See
 * docs/reports/revamp-2026-10-26/insights.md.
 *
 * Three aggregate statements, run in parallel. Every table is reached through
 * an index from the scope — per project, then per issue — never by scanning
 * it, so the cost follows the size of the scope, not of other tenants' data:
 *   1. runs: the scope's issues (`tasks (projectId)`) → their runs in the
 *      window (`agent_runs (taskId, startedAt)`) → the attempt (`agentRunId`
 *      unique) → its latest verification evidence (`attemptId` prefix); one
 *      GROUPING SETS pass for totals, runner, model and day;
 *   2. delivery: created per day (`tasks (projectId, archived, createdAt)`
 *      with both `archived` values as index keys, an index-only scan) and
 *      completed per day with cycle-time percentiles;
 *   3. snapshot: open and blocked issues now, plan approvals in the window,
 *      plans awaiting review, visible project count.
 * Lookups are LATERAL subqueries with `OFFSET 0`: the fence keeps each one a
 * parameterized index probe. Without it Postgres may pull the subquery up and
 * hash-join a sequential scan of the whole table when most of a small test
 * table falls in the window (measured: docs/reports/revamp-2026-10-26/insights.md §4).
 *
 * Runs and issues are attributed to the issue's current project. Cost stays
 * unknown when nothing was recorded (never $0): only a positive `costUsd` of a
 * finished run is a price — the same runs `runsWithCost` counts — and a group
 * or day with none has `costUsd: null`. Labels (runner, model) are capped so a
 * free-text model name cannot grow the response.
 */

const LABEL_LIMIT = 10;
const OTHER_LABEL = '(other)';
const RUNNER_LABEL_CHARS = 64;
const MODEL_LABEL_CHARS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_READ_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

/** Only where a number could be read two ways. */
export const INSIGHTS_NOTES = {
  runs: 'Agent runs started (claimed) in the range on issues currently in scope.',
  recoveryRequired: 'Runs whose attempt ended needing recovery (the sidecar was lost, or the agent state was unknown after a restart; work may remain on the device). Counted here, not as failed.',
  successRate: 'succeeded / finished runs; finished = succeeded + failed + cancelled + needs recovery.',
  verification: 'Latest evidence per finished run. passRate = passed / (passed + failed); failed includes check errors; skipped (no checks) and runs without evidence are not in the rate.',
  publication: 'Finished runs that recorded a pull request / finished runs.',
  duration: 'Claim to end of finished runs; preparation before the claim (clone, setup) is not included.',
  unknownCostRuns: 'Finished runs with no recorded cost (the runner reported no price, the model price is unknown, or the model is free/local; a stored 0 counts as not recorded). Never counted as $0: knownUsd sums the recorded (positive) costs of finished runs only, and a runner, model or day whose runs recorded none has costUsd null.',
  tokens: 'Sums of reported counts; runsWithTokens says how many runs reported any.',
  completed: 'Issues currently done whose last move to done (a status change, or an agent run finishing as done) is in the range, by that UTC day.',
  completedUntracked: 'Done issues last changed in the range whose move to done was never recorded (created as done, or done before it was logged). Not in the series or cycle time.',
  cycleTime: 'Created to last move to done, for the completed issues.',
  blockedNow: 'Open (todo or in progress), unarchived issues with at least one blocker that is not done (cancelled blockers still block). Current, not range-bound.',
} as const;

export type InsightsScopeKind = 'project' | 'workspace';

export interface InsightsRunGroup {
  key: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  recoveryRequired: number;
  inProgress: number;
  successRate: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  /** Known spend of the group's finished runs; null when none recorded a price (unknown, never $0). */
  costUsd: number | null;
  unknownCostRuns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface InsightsRunDay {
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  recoveryRequired: number;
  /** Known spend of the day's finished runs; null when none recorded a price (or nothing ran). */
  costUsd: number | null;
  unknownCostRuns: number;
}

export interface InsightsDeliveryDay {
  date: string;
  created: number;
  completed: number;
}

export interface Percentiles {
  medianMs: number | null;
  p90Ms: number | null;
  samples: number;
}

export interface InsightsDocument {
  scope: { kind: InsightsScopeKind; id: string; projects: number };
  range: { key: InsightsRange; days: number; since: string; until: string };
  runs: {
    total: number;
    outcomes: { succeeded: number; failed: number; cancelled: number; recoveryRequired: number; inProgress: number };
    finished: number;
    successRate: number | null;
    verification: { passed: number; failed: number; skipped: number; unverified: number; passRate: number | null };
    publication: { published: number; rate: number | null };
    duration: Percentiles;
    cost: { knownUsd: number; runsWithCost: number; unknownCostRuns: number; coverage: 'none' | 'partial' | 'complete' };
    tokens: { input: number; output: number; cachedInput: number; cacheWrite: number; reasoning: number; runsWithTokens: number };
    byRunner: InsightsRunGroup[];
    byModel: InsightsRunGroup[];
    daily: InsightsRunDay[];
  };
  delivery: {
    created: number;
    completed: number;
    completedUntracked: number;
    cycleTime: Percentiles;
    openNow: number;
    blockedNow: number;
    plans: { approvals: number; plansApproved: number; awaitingReview: number };
    daily: InsightsDeliveryDay[];
  };
  notes: typeof INSIGHTS_NOTES;
}

type Count = bigint | number | null;

const n = (value: Count | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const fixed6 = (value: number) => Number(value.toFixed(6));
const ms = (value: number | null | undefined): number | null => (value === null || value === undefined ? null : Math.round(value));

function money(value: Prisma.Decimal | null | undefined): number {
  return value === null || value === undefined ? 0 : fixed6(value.toNumber());
}

/** A row's known spend, or null when no finished run in it recorded a price. */
function knownMoney(row: RunRow | undefined): number | null {
  return row && n(row.runs_with_cost) > 0 ? money(row.cost) : null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

interface Window {
  key: InsightsRange;
  days: number;
  since: Date;
  until: Date;
}

/** UTC midnight `days - 1` days before `now`, up to `now`: `days` daily points, today last. */
export function insightsWindow(key: InsightsRange, now: Date = new Date()): Window {
  const days = INSIGHTS_RANGE_DAYS[key];
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { key, days, since, until: now };
}

function dayKeys(window: Window): string[] {
  return Array.from({ length: window.days }, (_, i) => new Date(window.since.getTime() + i * DAY_MS).toISOString().slice(0, 10));
}

/**
 * `timestamp(3)` columns hold UTC (Prisma's convention): bounds are bound as
 * UTC literals cast to `timestamp`, and days are read with `to_char`, so the
 * session TimeZone never matters.
 */
const ts = (date: Date) => Prisma.sql`${date.toISOString()}::timestamp(3)`;

/**
 * A workspace means its projects minus those that explicitly deny the caller —
 * exactly what a workspace member may read (`visibleProjectIdsSql` for
 * members; a bound PAT was already confined to its workspace by
 * `assertWorkspaceRole`).
 */
interface Scope {
  kind: InsightsScopeKind;
  id: string;
  userId: string;
}

function workspaceProjectsSql(scope: Scope): Prisma.Sql {
  return Prisma.sql`SELECT wp."id" FROM "linear_projects" wp
     WHERE wp."workspaceId" = ${scope.id}
       AND NOT EXISTS (SELECT 1 FROM "project_access" wd WHERE wd."projectId" = wp."id" AND wd."userId" = ${scope.userId} AND wd."permission" = 'deny')`;
}

/**
 * Rows of `table` (aliased `t`) in the scope, as a derived table: `select`
 * and `where` are written against `t`. A workspace is walked project by
 * project, so `(projectId, …)` indexes drive the read.
 */
function scoped(scope: Scope, table: 'tasks' | 'plans', select: Prisma.Sql, where: Prisma.Sql = Prisma.sql`true`): Prisma.Sql {
  const source = table === 'tasks' ? Prisma.sql`"tasks" t` : Prisma.sql`"plans" t`;
  if (scope.kind === 'project') {
    return Prisma.sql`(SELECT ${select} FROM ${source} WHERE t."projectId" = ${scope.id} AND ${where})`;
  }
  return Prisma.sql`(SELECT sr.* FROM (${workspaceProjectsSql(scope)}) sp
    CROSS JOIN LATERAL (SELECT ${select} FROM ${source} WHERE t."projectId" = sp."id" AND ${where} OFFSET 0) sr)`;
}

// ─── 1. Runs ──────────────────────────────────────────────────────────────────

interface RunRow {
  g_runner: number;
  g_model: number;
  g_day: number;
  runner_label: string | null;
  model_label: string | null;
  day: string | null;
  runs: Count;
  succeeded: Count;
  failed: Count;
  cancelled: Count;
  recovery_required: Count;
  in_progress: Count;
  runs_with_cost: Count;
  unknown_cost_runs: Count;
  cost: Prisma.Decimal | null;
  input_tokens: Count;
  output_tokens: Count;
  cached_input_tokens: Count;
  cache_write_tokens: Count;
  reasoning_tokens: Count;
  runs_with_tokens: Count;
  published: Count;
  v_passed: Count;
  v_failed: Count;
  v_skipped: Count;
  p50: number | null;
  p90: number | null;
  duration_samples: Count;
}

function runStatement(scope: Scope, window: Window): Prisma.Sql {
  return Prisma.sql`
    WITH runs AS (
      SELECT r."status"::text AS status,
             r."startedAt", r."endedAt", r."costUsd", r."prUrl",
             r."inputTokens", r."outputTokens", r."cachedInputTokens", r."cacheWriteTokens", r."reasoningTokens",
             left(lower(coalesce(nullif(btrim(r."runner"), ''), r."agent")), ${RUNNER_LABEL_CHARS}) AS runner,
             left(r."model", ${MODEL_LABEL_CHARS}) AS model,
             coalesce(a."recoveryState" = 'recovery_required' OR a."closeReason" = 'recovery_required', false) AS recovery,
             v."status" AS verification
        FROM ${scoped(scope, 'tasks', Prisma.sql`t."id"`)} st
        CROSS JOIN LATERAL (
          SELECT r."id", r."status", r."startedAt", r."endedAt", r."costUsd", r."prUrl", r."runner", r."agent", r."model",
                 r."inputTokens", r."outputTokens", r."cachedInputTokens", r."cacheWriteTokens", r."reasoningTokens"
            FROM "agent_runs" r
           WHERE r."taskId" = st."id" AND r."startedAt" >= ${ts(window.since)} AND r."startedAt" < ${ts(window.until)}
          OFFSET 0
        ) r
        LEFT JOIN LATERAL (
          SELECT a."id", a."recoveryState", a."closeReason" FROM "execution_attempts" a WHERE a."agentRunId" = r."id" OFFSET 0
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT ev."status" FROM "execution_verifications" ev
           WHERE ev."attemptId" = a."id"
           ORDER BY ev."finishedAt" DESC, ev."createdAt" DESC, ev."id" DESC
           LIMIT 1
        ) v ON true
    ), classified AS (
      SELECT runs.*,
             CASE WHEN status IN ('pending', 'running') THEN 'in_progress'
                  WHEN recovery THEN 'recovery_required'
                  ELSE status END AS outcome,
             CASE WHEN status NOT IN ('pending', 'running') AND "endedAt" IS NOT NULL
                  THEN GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) * 1000)::double precision END AS duration_ms,
             to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day
        FROM runs
    ), runner_rank AS (
      SELECT runner, row_number() OVER (ORDER BY COUNT(*) DESC, runner) AS rn FROM classified GROUP BY runner
    ), model_rank AS (
      SELECT model, row_number() OVER (ORDER BY COUNT(*) DESC, model) AS rn FROM classified GROUP BY model
    ), labelled AS (
      SELECT c.*,
             CASE WHEN rr.rn <= ${LABEL_LIMIT} THEN c.runner ELSE ${OTHER_LABEL} END AS runner_label,
             CASE WHEN mr.rn <= ${LABEL_LIMIT} THEN c.model ELSE ${OTHER_LABEL} END AS model_label
        FROM classified c
        JOIN runner_rank rr ON rr.runner = c.runner
        JOIN model_rank mr ON mr.model = c.model
    )
    SELECT GROUPING(runner_label)::int AS g_runner, GROUPING(model_label)::int AS g_model, GROUPING(day)::int AS g_day,
           runner_label, model_label, day,
           COUNT(*) AS runs,
           COUNT(*) FILTER (WHERE outcome = 'succeeded') AS succeeded,
           COUNT(*) FILTER (WHERE outcome = 'failed') AS failed,
           COUNT(*) FILTER (WHERE outcome = 'cancelled') AS cancelled,
           COUNT(*) FILTER (WHERE outcome = 'recovery_required') AS recovery_required,
           COUNT(*) FILTER (WHERE outcome = 'in_progress') AS in_progress,
           COUNT(*) FILTER (WHERE outcome <> 'in_progress' AND "costUsd" > 0) AS runs_with_cost,
           COUNT(*) FILTER (WHERE outcome <> 'in_progress' AND NOT coalesce("costUsd" > 0, false)) AS unknown_cost_runs,
           SUM("costUsd") FILTER (WHERE outcome <> 'in_progress' AND "costUsd" > 0) AS cost,
           SUM("inputTokens") AS input_tokens,
           SUM("outputTokens") AS output_tokens,
           SUM("cachedInputTokens") AS cached_input_tokens,
           SUM("cacheWriteTokens") AS cache_write_tokens,
           SUM("reasoningTokens") AS reasoning_tokens,
           COUNT(*) FILTER (WHERE "inputTokens" IS NOT NULL OR "outputTokens" IS NOT NULL) AS runs_with_tokens,
           COUNT(*) FILTER (WHERE outcome <> 'in_progress' AND "prUrl" IS NOT NULL) AS published,
           COUNT(*) FILTER (WHERE outcome <> 'in_progress' AND verification = 'passed') AS v_passed,
           COUNT(*) FILTER (WHERE outcome <> 'in_progress' AND verification IN ('failed', 'error')) AS v_failed,
           COUNT(*) FILTER (WHERE outcome <> 'in_progress' AND verification = 'skipped') AS v_skipped,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS p90,
           COUNT(duration_ms) AS duration_samples
      FROM labelled
     GROUP BY GROUPING SETS ((), (runner_label), (model_label), (day))
  `;
}

function finishedOf(row: RunRow | undefined): number {
  return row ? n(row.succeeded) + n(row.failed) + n(row.cancelled) + n(row.recovery_required) : 0;
}

function runGroup(key: string, row: RunRow): InsightsRunGroup {
  return {
    key,
    runs: n(row.runs),
    succeeded: n(row.succeeded),
    failed: n(row.failed),
    cancelled: n(row.cancelled),
    recoveryRequired: n(row.recovery_required),
    inProgress: n(row.in_progress),
    successRate: rate(n(row.succeeded), finishedOf(row)),
    medianMs: ms(row.p50),
    p90Ms: ms(row.p90),
    costUsd: knownMoney(row),
    unknownCostRuns: n(row.unknown_cost_runs),
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
  };
}

/** Most runs first; the folded `(other)` bucket always last. */
function sortGroups(groups: InsightsRunGroup[]): InsightsRunGroup[] {
  return groups.sort((a, b) => {
    if ((a.key === OTHER_LABEL) !== (b.key === OTHER_LABEL)) return a.key === OTHER_LABEL ? 1 : -1;
    return b.runs - a.runs || a.key.localeCompare(b.key);
  });
}

function summarizeRuns(rows: RunRow[], window: Window): InsightsDocument['runs'] {
  const total = rows.find((row) => row.g_runner === 1 && row.g_model === 1 && row.g_day === 1);
  const byRunner = rows.filter((row) => row.g_runner === 0).map((row) => runGroup(row.runner_label ?? '', row));
  const byModel = rows.filter((row) => row.g_model === 0).map((row) => runGroup(row.model_label ?? '', row));
  const byDay = new Map(rows.filter((row) => row.g_day === 0 && row.day !== null).map((row) => [row.day as string, row]));

  const finished = finishedOf(total);
  const runsWithCost = n(total?.runs_with_cost);
  const unknownCostRuns = n(total?.unknown_cost_runs);
  const passed = n(total?.v_passed);
  const failedChecks = n(total?.v_failed);
  const skipped = n(total?.v_skipped);
  const published = n(total?.published);

  return {
    total: n(total?.runs),
    outcomes: {
      succeeded: n(total?.succeeded),
      failed: n(total?.failed),
      cancelled: n(total?.cancelled),
      recoveryRequired: n(total?.recovery_required),
      inProgress: n(total?.in_progress),
    },
    finished,
    successRate: rate(n(total?.succeeded), finished),
    verification: {
      passed,
      failed: failedChecks,
      skipped,
      unverified: Math.max(0, finished - passed - failedChecks - skipped),
      passRate: rate(passed, passed + failedChecks),
    },
    publication: { published, rate: rate(published, finished) },
    duration: { medianMs: ms(total?.p50), p90Ms: ms(total?.p90), samples: n(total?.duration_samples) },
    cost: {
      knownUsd: money(total?.cost),
      runsWithCost,
      unknownCostRuns,
      coverage: runsWithCost === 0 ? 'none' : unknownCostRuns === 0 ? 'complete' : 'partial',
    },
    tokens: {
      input: n(total?.input_tokens),
      output: n(total?.output_tokens),
      cachedInput: n(total?.cached_input_tokens),
      cacheWrite: n(total?.cache_write_tokens),
      reasoning: n(total?.reasoning_tokens),
      runsWithTokens: n(total?.runs_with_tokens),
    },
    byRunner: sortGroups(byRunner),
    byModel: sortGroups(byModel),
    daily: dayKeys(window).map((date) => {
      const row = byDay.get(date);
      return {
        date,
        runs: n(row?.runs),
        succeeded: n(row?.succeeded),
        failed: n(row?.failed),
        cancelled: n(row?.cancelled),
        recoveryRequired: n(row?.recovery_required),
        costUsd: knownMoney(row),
        unknownCostRuns: n(row?.unknown_cost_runs),
      };
    }),
  };
}

// ─── 2. Delivery series ─────────────────────────────────────────────────────

interface DeliveryRow {
  kind: 'created' | 'completed' | 'untracked';
  day: string | null;
  count: Count;
  p50: number | null;
  p90: number | null;
}

/**
 * Completion time = the latest recorded move to done: a `task_status_changed`
 * activity to `done`, or an execution attempt whose terminal projection was
 * `done` (agent runs do not write status activity). Only issues done now
 * count. Every move to done bumps `updatedAt` (Prisma `@updatedAt`, also on
 * `updateMany`), so `updatedAt >= since - 1 day` is a safe pre-filter that
 * keeps the per-issue lookups (`activity_logs (taskId, createdAt)`,
 * `execution_attempts (taskId, createdAt)`) to recently changed done issues;
 * the day of slack covers the activity row being written just after the
 * update.
 */
function deliveryStatement(scope: Scope, window: Window): Prisma.Sql {
  const prefilter = new Date(window.since.getTime() - DAY_MS);
  return Prisma.sql`
    WITH candidates AS (
      SELECT st.created_at, st.updated_at,
             GREATEST(
               (SELECT MAX(al."createdAt") FROM "activity_logs" al
                 WHERE al."taskId" = st."id" AND al."action" = 'task_status_changed' AND al."payload"->>'to' = 'done'),
               (SELECT MAX(a."finishedAt") FROM "execution_attempts" a
                 WHERE a."taskId" = st."id" AND a."terminalStatus" = 'done')
             ) AS done_at
        FROM ${scoped(scope, 'tasks', Prisma.sql`t."id", t."createdAt" AS created_at, t."updatedAt" AS updated_at`,
          Prisma.sql`t."status" = 'done' AND t."updatedAt" >= ${ts(prefilter)}`)} st
    ), completed AS (
      SELECT done_at, GREATEST(0, EXTRACT(EPOCH FROM (done_at - created_at)) * 1000)::double precision AS cycle_ms
        FROM candidates
       WHERE done_at >= ${ts(window.since)} AND done_at < ${ts(window.until)}
    )
    SELECT 'completed' AS kind, to_char(date_trunc('day', done_at), 'YYYY-MM-DD') AS day, COUNT(*) AS count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_ms) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY cycle_ms) AS p90
      FROM completed
     GROUP BY ROLLUP (date_trunc('day', done_at))
    UNION ALL
    SELECT 'untracked', NULL, COUNT(*), NULL, NULL
      FROM candidates
     WHERE done_at IS NULL AND updated_at >= ${ts(window.since)} AND updated_at < ${ts(window.until)}
    UNION ALL
    SELECT 'created', to_char(date_trunc('day', st.created_at), 'YYYY-MM-DD'), COUNT(*), NULL, NULL
      FROM ${scoped(scope, 'tasks', Prisma.sql`t."createdAt" AS created_at`,
        Prisma.sql`t."archived" IN (false, true) AND t."createdAt" >= ${ts(window.since)} AND t."createdAt" < ${ts(window.until)}`)} st
     GROUP BY ROLLUP (date_trunc('day', st.created_at))
  `;
}

// ─── 3. Snapshot ─────────────────────────────────────────────────────────────

interface SnapshotRow {
  open_now: Count;
  blocked_now: Count;
  approvals: Count;
  plans_approved: Count;
  awaiting_review: Count;
  projects: Count;
}

function snapshotStatement(scope: Scope, window: Window): Prisma.Sql {
  const projects = scope.kind === 'project'
    ? Prisma.sql`SELECT 1 AS projects`
    : Prisma.sql`SELECT COUNT(*) AS projects FROM (${workspaceProjectsSql(scope)}) vp`;
  return Prisma.sql`
    SELECT o.open_now, o.blocked_now, pl.approvals, pl.plans_approved, pa.awaiting_review, pc.projects
      FROM (
        SELECT COUNT(*) AS open_now,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "task_dependencies" d JOIN "tasks" b ON b."id" = d."dependsOnTaskId"
                  WHERE d."taskId" = st."id" AND b."status" <> 'done'
               )) AS blocked_now
          FROM ${scoped(scope, 'tasks', Prisma.sql`t."id"`, Prisma.sql`t."archived" = false AND t."status" IN ('todo', 'in_progress')`)} st
      ) o,
      (
        SELECT COUNT(*) AS approvals, COUNT(DISTINCT pr."planId") AS plans_approved
          FROM ${scoped(scope, 'plans', Prisma.sql`t."id"`)} sp
          CROSS JOIN LATERAL (
            SELECT r."planId" FROM "plan_revisions" r
             WHERE r."planId" = sp."id" AND r."approvedAt" >= ${ts(window.since)} AND r."approvedAt" < ${ts(window.until)}
            OFFSET 0
          ) pr
      ) pl,
      (
        SELECT COUNT(*) AS awaiting_review
          FROM ${scoped(scope, 'plans', Prisma.sql`t."id"`, Prisma.sql`t."status" <> 'archived'
            AND CASE WHEN t."approvedRevision" IS NULL THEN t."status" = 'draft' ELSE t."latestRevision" > t."approvedRevision" END`)} sw
      ) pa,
      (${projects}) pc
  `;
}

// ─── Document ────────────────────────────────────────────────────────────────

async function buildInsights(scope: Scope, window: Window): Promise<InsightsDocument> {
  const [runRows, deliveryRows, snapshotRows] = await Promise.all([
    prisma.$queryRaw<RunRow[]>(runStatement(scope, window)),
    prisma.$queryRaw<DeliveryRow[]>(deliveryStatement(scope, window)),
    prisma.$queryRaw<SnapshotRow[]>(snapshotStatement(scope, window)),
  ]);

  const created = new Map<string, number>();
  const completed = new Map<string, number>();
  let createdTotal = 0;
  let completedTotal: DeliveryRow | undefined;
  let untracked = 0;
  for (const row of deliveryRows) {
    if (row.kind === 'untracked') untracked = n(row.count);
    else if (row.kind === 'created') {
      if (row.day === null) createdTotal = n(row.count);
      else created.set(row.day, n(row.count));
    } else if (row.day === null) completedTotal = row;
    else completed.set(row.day, n(row.count));
  }
  const snapshot = snapshotRows[0];

  return {
    scope: { kind: scope.kind, id: scope.id, projects: n(snapshot?.projects) },
    range: { key: window.key, days: window.days, since: window.since.toISOString(), until: window.until.toISOString() },
    runs: summarizeRuns(runRows, window),
    delivery: {
      created: createdTotal,
      completed: n(completedTotal?.count),
      completedUntracked: untracked,
      cycleTime: { medianMs: ms(completedTotal?.p50), p90Ms: ms(completedTotal?.p90), samples: n(completedTotal?.count) },
      openNow: n(snapshot?.open_now),
      blockedNow: n(snapshot?.blocked_now),
      plans: { approvals: n(snapshot?.approvals), plansApproved: n(snapshot?.plans_approved), awaitingReview: n(snapshot?.awaiting_review) },
      daily: dayKeys(window).map((date) => ({ date, created: created.get(date) ?? 0, completed: completed.get(date) ?? 0 })),
    },
    notes: INSIGHTS_NOTES,
  };
}

/** One project (view access). */
export async function projectInsights(input: { projectId: string; userId: string; range: InsightsRange; now?: Date }): Promise<InsightsDocument> {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  return buildInsights({ kind: 'project', id: input.projectId, userId: input.userId }, insightsWindow(input.range, input.now));
}

/** The workspace's projects the caller may read (any member role; denied projects left out). */
export async function workspaceInsights(input: { workspaceId: string; userId: string; range: InsightsRange; now?: Date }): Promise<InsightsDocument> {
  await assertWorkspaceRole(input.workspaceId, input.userId, WORKSPACE_READ_ROLES);
  return buildInsights({ kind: 'workspace', id: input.workspaceId, userId: input.userId }, insightsWindow(input.range, input.now));
}
