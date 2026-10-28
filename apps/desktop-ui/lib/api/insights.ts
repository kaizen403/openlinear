import { apiFetch } from './fetch';

/**
 * W15b insights (apps/api `GET /api/projects/:id/insights`,
 * `GET /api/workspaces/:id/insights`): one read-only document with agent run
 * outcomes, verification, publication, duration, cost (unknown prices
 * counted, never guessed), runner/model groups and delivery (created vs
 * completed, cycle time, blocked now, plan approvals). Daily series are UTC
 * days, today last.
 */

export type InsightsRange = '7d' | '30d' | '90d';
export const INSIGHTS_RANGES: readonly InsightsRange[] = ['7d', '30d', '90d'];

export type InsightsScope = { kind: 'project'; id: string } | { kind: 'workspace'; id: string };

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

export interface InsightsPercentiles {
  medianMs: number | null;
  p90Ms: number | null;
  samples: number;
}

export interface Insights {
  scope: { kind: 'project' | 'workspace'; id: string; projects: number };
  range: { key: InsightsRange; days: number; since: string; until: string };
  runs: {
    total: number;
    outcomes: { succeeded: number; failed: number; cancelled: number; recoveryRequired: number; inProgress: number };
    finished: number;
    successRate: number | null;
    verification: { passed: number; failed: number; skipped: number; unverified: number; passRate: number | null };
    publication: { published: number; rate: number | null };
    duration: InsightsPercentiles;
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
    cycleTime: InsightsPercentiles;
    openNow: number;
    blockedNow: number;
    plans: { approvals: number; plansApproved: number; awaitingReview: number };
    daily: Array<{ date: string; created: number; completed: number }>;
  };
  /** How the ambiguous numbers are counted, keyed by metric. */
  notes: Record<string, string>;
}

/**
 * Query keys, under the project / workspace scope so scope-wide
 * invalidation reaches them. (Kept here; not in `lib/query/keys.ts`.)
 */
export const insightsKeys = {
  project: (projectId: string, range: InsightsRange) => ['ol', 'project', projectId, 'insights', range] as const,
  workspace: (workspaceId: string, range: InsightsRange) => ['ol', 'ws', workspaceId, 'insights', range] as const,
  forScope: (scope: InsightsScope, range: InsightsRange) =>
    scope.kind === 'project' ? insightsKeys.project(scope.id, range) : insightsKeys.workspace(scope.id, range),
};

export function fetchProjectInsights(projectId: string, range: InsightsRange): Promise<Insights> {
  return apiFetch<Insights>(`/api/projects/${encodeURIComponent(projectId)}/insights?range=${range}`);
}

export function fetchWorkspaceInsights(workspaceId: string, range: InsightsRange): Promise<Insights> {
  return apiFetch<Insights>(`/api/workspaces/${encodeURIComponent(workspaceId)}/insights?range=${range}`);
}

export function fetchInsights(scope: InsightsScope, range: InsightsRange): Promise<Insights> {
  return scope.kind === 'project' ? fetchProjectInsights(scope.id, range) : fetchWorkspaceInsights(scope.id, range);
}

// ─── Formatting (shared by the view and its tests) ───────────────────────────

/** `0.2` → `20%`, `0.3333` → `33%`; null (nothing to divide by) → `—`. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** Known spend only; callers show unknown-cost runs next to it. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Known spend of a row (a runner, model or day): `null` means none of its
 * `runs` recorded a price, shown as `unknown` — never `$0.00`; `—` when the
 * row has no runs at all.
 */
export function formatKnownCost(costUsd: number | null, runs: number): string {
  if (costUsd !== null) return formatUsd(costUsd);
  return runs > 0 ? 'unknown' : '—';
}

/** 1,284 / 12.9K / 4.2M. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString('en-US');
}

/** 45 s, 12 min, 3.5 h, 2.1 d; null → `—`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Number(hours.toFixed(1))} h`;
  return `${Number((hours / 24).toFixed(1))} d`;
}

/** `2026-10-21` → `Oct 21` (the date is a UTC day; never shifted to local time). */
export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}
