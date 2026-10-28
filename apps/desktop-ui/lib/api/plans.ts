import type { Task } from '@/types/task';
import { apiFetch } from './fetch';
import { idempotencyHeaders } from './idempotency';

/**
 * W17b reviewable plans (apps/api `/api/projects/:id/plans`, `/api/plans/:id`).
 * Revisions are immutable; approving the latest one creates its issues.
 */

export type PlanStatus = 'draft' | 'approved' | 'archived';
export type PlanEstimate = 'xs' | 's' | 'm' | 'l' | 'xl';
export type PlanRisk = 'low' | 'medium' | 'high';

export interface PlanTaskSpec {
  key: string;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  acceptance?: string[];
  estimate?: PlanEstimate;
  risk?: PlanRisk;
  blockedBy?: string[];
}

export interface PlanIssue {
  code: string;
  message: string;
  keys: string[];
}

export interface PlanDiff {
  added: string[];
  removed: string[];
  changed: Array<{ key: string; fields: string[] }>;
}

export interface PlanView {
  id: string;
  projectId: string;
  title: string;
  status: PlanStatus;
  latestRevision: number;
  approvedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  revisions: Array<{ number: number; specHash: string; note: string | null; createdAt: string; createdById: string | null; approvedAt: string | null }>;
  revision: {
    number: number;
    spec: { summary?: string; tasks: PlanTaskSpec[] };
    specHash: string;
    note: string | null;
    createdAt: string;
    approvedAt: string | null;
    order: string[];
    errors: PlanIssue[];
    warnings: PlanIssue[];
    diff: PlanDiff | null;
  };
  tasks: Array<{ key: string; id: string; identifier: string | null; title: string; status: Task['status']; archived: boolean; running?: boolean }>;
}

export interface PlanSummary {
  id: string;
  title: string;
  status: PlanStatus;
  latestRevision: number;
  approvedRevision: number | null;
  taskCount: number;
  createdTaskCount: number;
  doneTaskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanApproval {
  alreadyApproved: boolean;
  created: Array<{ key: string; taskId: string; identifier: string | null }>;
  updated: Array<{ key: string; taskId: string; fields: string[] }>;
  removed: Array<{ key: string; taskId: string }>;
  skipped: Array<{ key: string; reason: 'deleted' | 'moved' }>;
  dependencies: { added: number; removed: number };
}

/** Plans a reviewer should look at: never approved drafts, or a newer revision than the approved one. */
export function plansAwaitingReview(plans: readonly PlanSummary[]): number {
  return plans.filter((plan) => plan.status !== 'archived' && (plan.approvedRevision === null ? plan.status === 'draft' : plan.latestRevision > plan.approvedRevision)).length;
}

export async function fetchProjectPlans(projectId: string): Promise<PlanSummary[]> {
  const data = await apiFetch<{ items: PlanSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/plans`);
  return data.items;
}

export function fetchPlan(planId: string, revision?: number): Promise<PlanView> {
  const query = revision ? `?revision=${revision}` : '';
  return apiFetch<PlanView>(`/api/plans/${encodeURIComponent(planId)}${query}`);
}

export function approvePlan(planId: string, revision: number): Promise<{ approval: PlanApproval; plan: PlanView }> {
  return apiFetch<{ approval: PlanApproval; plan: PlanView }>(`/api/plans/${encodeURIComponent(planId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ revision }),
  });
}

/** A draft plan (revision 1); nothing is created until it is approved. Keyed: a retry returns the same plan. */
export function createPlan(projectId: string, body: { title: string; spec: PlanView['revision']['spec']; note?: string }, idempotencyKey: string): Promise<PlanView> {
  return apiFetch<PlanView>(`/api/projects/${encodeURIComponent(projectId)}/plans`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: idempotencyHeaders(idempotencyKey),
  });
}

/** A new revision based on `baseRevision` (409 PLAN_REVISION_CONFLICT when it is no longer the latest). */
export function revisePlan(planId: string, body: { baseRevision: number; spec: PlanView['revision']['spec']; title?: string; note?: string }): Promise<{ unchanged: boolean; plan: PlanView }> {
  return apiFetch<{ unchanged: boolean; plan: PlanView }>(`/api/plans/${encodeURIComponent(planId)}/revisions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Problems the server listed for a refused plan (400 PLAN_INVALID `details.issues`). */
export function planIssuesFromError(error: unknown): PlanIssue[] {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'PLAN_INVALID' || !('details' in error)) return [];
  const details = error.details;
  if (!details || typeof details !== 'object' || !('issues' in details) || !Array.isArray(details.issues)) return [];
  return details.issues.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    return typeof record.code === 'string' && typeof record.message === 'string'
      ? [{ code: record.code, message: record.message, keys: Array.isArray(record.keys) ? record.keys.filter((key): key is string => typeof key === 'string') : [] }]
      : [];
  });
}

/** A key for a new task that no task in the plan uses yet. */
export function nextPlanTaskKey(tasks: readonly PlanTaskSpec[]): string {
  const used = new Set(tasks.map((task) => task.key));
  let index = tasks.length + 1;
  while (used.has(`task-${index}`)) index += 1;
  return `task-${index}`;
}

export function archivePlan(planId: string): Promise<PlanView> {
  return apiFetch<PlanView>(`/api/plans/${encodeURIComponent(planId)}/archive`, { method: 'POST' });
}

/** One line for the approval toast. */
export function describeApproval(approval: PlanApproval): string {
  if (approval.alreadyApproved) return 'This revision was already approved; nothing changed.';
  const parts: string[] = [];
  if (approval.created.length) parts.push(`created ${approval.created.length} ${approval.created.length === 1 ? 'issue' : 'issues'}`);
  if (approval.updated.length) parts.push(`updated ${approval.updated.length}`);
  const blockers = approval.dependencies.added + approval.dependencies.removed;
  if (blockers) parts.push(`${blockers} blocker ${blockers === 1 ? 'change' : 'changes'}`);
  if (approval.skipped.length) parts.push(`${approval.skipped.length} skipped (deleted or moved)`);
  if (parts.length === 0) return 'Approved; nothing needed to change.';
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * FE-10 "Run plan": the plan's unfinished issues (not done, archived or
 * running), blockers first. A prefix of that order is closed under "blocked
 * by", so when there are more than a batch holds (`maxBatchSize`, the
 * user's setting), the first ones still run correctly; `remaining` says how
 * many wait for the next run.
 */
export function planRunSelection(plan: PlanView, maxBatchSize: number): { taskIds: string[]; remaining: number } {
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  const runnable = orderedPlanTasks(plan)
    .flatMap((spec) => byKey.get(spec.key) ?? [])
    .filter((task) => task.status !== 'done' && !task.archived && !task.running);
  return { taskIds: runnable.slice(0, maxBatchSize).map((task) => task.id), remaining: Math.max(0, runnable.length - maxBatchSize) };
}

/** Start one parallel v2 batch on the local execution service (it orders by blockers). */
export async function runPlanTasks(taskIds: readonly string[]): Promise<{ id: string }> {
  return apiFetch<{ id: string }>('/api/batches', {
    method: 'POST',
    sidecar: true,
    body: JSON.stringify({ taskIds, mode: 'parallel' }),
  });
}

/**
 * Plan tasks grouped into waves: wave 1 has no blockers, wave N waits only on
 * earlier waves, so everything in one wave can run in parallel. Tasks in a
 * loop (the server refuses those) land in a last, unordered group.
 */
export function planWaves(tasks: readonly PlanTaskSpec[]): PlanTaskSpec[][] {
  const keys = new Set(tasks.map((task) => task.key));
  const level = new Map<string, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (level.has(task.key)) continue;
      const blockers = (task.blockedBy ?? []).filter((key) => keys.has(key) && key !== task.key);
      if (!blockers.every((key) => level.has(key))) continue;
      level.set(task.key, 1 + Math.max(0, ...blockers.map((key) => level.get(key) ?? 0)));
      changed = true;
    }
  }
  const waves: PlanTaskSpec[][] = [];
  for (const task of tasks) {
    const index = (level.get(task.key) ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(index)) continue;
    (waves[index - 1] ??= []).push(task);
  }
  const looped = tasks.filter((task) => !level.has(task.key));
  const dense = waves.filter((wave) => wave !== undefined && wave.length > 0);
  return looped.length > 0 ? [...dense, looped] : dense;
}

/** Plan tasks in blocker-first order (the server's `order`), then any it left out. */
export function orderedPlanTasks(plan: PlanView): PlanTaskSpec[] {
  const byKey = new Map(plan.revision.spec.tasks.map((task) => [task.key, task]));
  const ordered = plan.revision.order.flatMap((key) => byKey.get(key) ?? []);
  const seen = new Set(ordered.map((task) => task.key));
  return [...ordered, ...plan.revision.spec.tasks.filter((task) => !seen.has(task.key))];
}
