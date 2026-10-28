import * as z from 'zod';
import type { ApiInsights } from '../../openlinear/api';
import { ToolInputError } from '../errors';
import { id } from '../inputs';
import { defineTool, READ_ONLY } from '../tool';

/**
 * W15b insights: how agent work and delivery are going in one project or
 * workspace over 7 / 30 / 90 days. Cost is "known spend": runs without a
 * recorded price are counted in `unknownCostRuns`, never as $0, and a runner,
 * model or day where no run recorded one has `costUsd: null` (unknown). The
 * daily series (one point per UTC day) are left out unless asked for.
 */

const rate = z.number().nullable().describe('0-1; null when there is nothing to divide by');
const rowCost = z.number().nullable().describe('Known cost (USD) of finished runs; null = unknown (no run here recorded a price), never $0');
const ms = z.number().nullable().describe('Milliseconds; null without samples');
const Percentiles = z.object({ medianMs: ms, p90Ms: ms, samples: z.number() });

const RunGroup = z.object({
  key: z.string().describe('Runner or model; "(other)" folds everything past the top ten'),
  runs: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  recoveryRequired: z.number(),
  inProgress: z.number(),
  successRate: rate,
  medianMs: ms,
  p90Ms: ms,
  costUsd: rowCost,
  unknownCostRuns: z.number(),
});

const InsightsShape = z.object({
  scope: z.object({ kind: z.string().describe('project | workspace'), id: z.string(), projects: z.number().describe('Projects counted') }),
  range: z.object({ key: z.string(), days: z.number(), since: z.string().describe('UTC midnight, first day'), until: z.string() }),
  runs: z.object({
    total: z.number().describe('Agent runs started in the range'),
    outcomes: z.object({ succeeded: z.number(), failed: z.number(), cancelled: z.number(), recoveryRequired: z.number(), inProgress: z.number() }),
    finished: z.number(),
    successRate: rate,
    verification: z.object({ passed: z.number(), failed: z.number(), skipped: z.number(), unverified: z.number(), passRate: rate }),
    publication: z.object({ published: z.number().describe('Finished runs with a pull request'), rate }),
    duration: Percentiles,
    cost: z.object({
      knownUsd: z.number().describe('Sum of recorded costs of finished runs only (0 when runsWithCost is 0: unknown, not free)'),
      runsWithCost: z.number(),
      unknownCostRuns: z.number().describe('Finished runs with no recorded price (never counted as $0)'),
      coverage: z.string().describe('none | partial | complete'),
    }),
    tokens: z.object({ input: z.number(), output: z.number(), cachedInput: z.number(), cacheWrite: z.number(), reasoning: z.number(), runsWithTokens: z.number() }),
    byRunner: z.array(RunGroup),
    byModel: z.array(RunGroup),
    daily: z
      .array(z.object({ date: z.string(), runs: z.number(), succeeded: z.number(), failed: z.number(), cancelled: z.number(), recoveryRequired: z.number(), costUsd: rowCost, unknownCostRuns: z.number() }))
      .optional()
      .describe('Only with includeDaily'),
  }),
  delivery: z.object({
    created: z.number(),
    completed: z.number().describe('Issues done now whose last move to done is in the range'),
    completedUntracked: z.number().describe('Done issues changed in the range with no recorded move to done (not in completed)'),
    cycleTime: Percentiles,
    openNow: z.number(),
    blockedNow: z.number().describe('Open issues with a blocker that is not done (now, not range-bound)'),
    plans: z.object({ approvals: z.number(), plansApproved: z.number(), awaitingReview: z.number() }),
    daily: z.array(z.object({ date: z.string(), created: z.number(), completed: z.number() })).optional().describe('Only with includeDaily'),
  }),
  notes: z.record(z.string(), z.string()).describe('How the ambiguous numbers are counted'),
});

function group(row: ApiInsights['runs']['byRunner'][number]): z.infer<typeof RunGroup> {
  return {
    key: row.key,
    runs: row.runs,
    succeeded: row.succeeded,
    failed: row.failed,
    cancelled: row.cancelled,
    recoveryRequired: row.recoveryRequired,
    inProgress: row.inProgress,
    successRate: row.successRate,
    medianMs: row.medianMs,
    p90Ms: row.p90Ms,
    costUsd: row.costUsd,
    unknownCostRuns: row.unknownCostRuns,
  };
}

function toInsights(doc: ApiInsights, includeDaily: boolean): z.infer<typeof InsightsShape> {
  const { runs, delivery } = doc;
  const percentiles = (value: ApiInsights['runs']['duration']) => ({ medianMs: value.medianMs, p90Ms: value.p90Ms, samples: value.samples });
  return {
    scope: { kind: doc.scope.kind, id: doc.scope.id, projects: doc.scope.projects },
    range: { key: doc.range.key, days: doc.range.days, since: doc.range.since, until: doc.range.until },
    runs: {
      total: runs.total,
      outcomes: {
        succeeded: runs.outcomes.succeeded,
        failed: runs.outcomes.failed,
        cancelled: runs.outcomes.cancelled,
        recoveryRequired: runs.outcomes.recoveryRequired,
        inProgress: runs.outcomes.inProgress,
      },
      finished: runs.finished,
      successRate: runs.successRate,
      verification: {
        passed: runs.verification.passed,
        failed: runs.verification.failed,
        skipped: runs.verification.skipped,
        unverified: runs.verification.unverified,
        passRate: runs.verification.passRate,
      },
      publication: { published: runs.publication.published, rate: runs.publication.rate },
      duration: percentiles(runs.duration),
      cost: { knownUsd: runs.cost.knownUsd, runsWithCost: runs.cost.runsWithCost, unknownCostRuns: runs.cost.unknownCostRuns, coverage: runs.cost.coverage },
      tokens: {
        input: runs.tokens.input,
        output: runs.tokens.output,
        cachedInput: runs.tokens.cachedInput,
        cacheWrite: runs.tokens.cacheWrite,
        reasoning: runs.tokens.reasoning,
        runsWithTokens: runs.tokens.runsWithTokens,
      },
      byRunner: runs.byRunner.map(group),
      byModel: runs.byModel.map(group),
      ...(includeDaily
        ? {
            daily: runs.daily.map((day) => ({
              date: day.date,
              runs: day.runs,
              succeeded: day.succeeded,
              failed: day.failed,
              cancelled: day.cancelled,
              recoveryRequired: day.recoveryRequired,
              costUsd: day.costUsd,
              unknownCostRuns: day.unknownCostRuns,
            })),
          }
        : {}),
    },
    delivery: {
      created: delivery.created,
      completed: delivery.completed,
      completedUntracked: delivery.completedUntracked,
      cycleTime: percentiles(delivery.cycleTime),
      openNow: delivery.openNow,
      blockedNow: delivery.blockedNow,
      plans: { approvals: delivery.plans.approvals, plansApproved: delivery.plans.plansApproved, awaitingReview: delivery.plans.awaitingReview },
      ...(includeDaily ? { daily: delivery.daily.map((day) => ({ date: day.date, created: day.created, completed: day.completed })) } : {}),
    },
    notes: doc.notes,
  };
}

const getInsightsInput = z
  .strictObject({
    projectId: id('Project').optional().describe('Insights for this project; pass projectId or workspaceId'),
    workspaceId: id('Workspace').optional().describe('Insights for the projects of this workspace you can read; pass projectId or workspaceId'),
    range: z.enum(['7d', '30d', '90d']).optional().describe('Window ending now (default 30d); days are UTC'),
    includeDaily: z.boolean().optional().describe('Also return one point per day (default false)'),
  })
  .refine((value) => Boolean(value.projectId) !== Boolean(value.workspaceId), {
    message: 'Pass exactly one of projectId or workspaceId.',
    path: ['projectId'],
  });

export const getInsights = defineTool({
  name: 'openlinear_get_insights',
  title: 'Get insights',
  description:
    'How agent work and delivery are going in a project or workspace over the last 7, 30 or 90 days: agent runs (succeeded / failed / cancelled / needs recovery / in progress), success, verification and pull request rates, median and p90 duration, known cost and tokens (runs without a price are counted in unknownCostRuns, never as $0), by runner and model; issues created vs completed, cycle time, blocked now, plan approvals. Read-only.',
  input: getInsightsInput,
  output: InsightsShape,
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run({ projectId, workspaceId, range, includeDaily }, { api, signal }) {
    const scope = projectId ? { projectId } : workspaceId ? { workspaceId } : null;
    if (!scope) throw new ToolInputError('Pass exactly one of projectId or workspaceId.');
    const doc = await api.getInsights(scope, range ?? '30d', signal);
    return toInsights(doc, includeDaily === true);
  },
});
