import { createHash } from 'node:crypto';
import { prisma, type Prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget, taskTarget } from '../events/targets';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { planSpecSchema, type PlanSpec, type PlanTaskSpec } from '../schemas/plans';
import { logActivity } from './activity';
import { canonicalJson, type IdempotentCommand } from './idempotency';
import { isHeldByExecution } from './execution-control';
import { assertProjectAccess, assertTeamRole } from './ownership';
import { lockProjectDependencies, wouldCreateCycle } from './task-dependencies';
import { flattenTaskLabels, insertProjectTasks, resolveProjectTeamId, resolveProjectWorkspaceId, taskInclude } from './tasks';

/**
 * W17b: reviewable plans (FE-09). See docs/reports/revamp-2026-10-26/plans.md.
 *
 * A plan belongs to one project. Every change is a new immutable revision
 * (spec + hash); a revision is checked before it is stored (unique keys, known
 * blockers, no self-blocks, no loops) and warnings (no acceptance checks, no
 * estimate) are shown with it. Nothing is created until someone approves the
 * latest revision: approval creates the missing tasks, applies only the
 * fields the plan changed since the last approval (edits made on the tasks
 * themselves are kept), and syncs the dependencies between plan tasks — all
 * in one transaction under the project's dependency lock. Approving the same
 * revision again changes nothing. Plans never run anything.
 */

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
  status: string;
  latestRevision: number;
  approvedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  revisions: Array<{ number: number; specHash: string; note: string | null; createdAt: string; createdById: string | null; approvedAt: string | null }>;
  revision: {
    number: number;
    spec: PlanSpec;
    specHash: string;
    note: string | null;
    createdAt: string;
    approvedAt: string | null;
    /** Keys with blockers first. */
    order: string[];
    errors: PlanIssue[];
    warnings: PlanIssue[];
    /** Against the previous revision (null for the first). */
    diff: PlanDiff | null;
  };
  /** The tasks approvals created, by plan key (`running`: an execution holds it now). */
  tasks: Array<{ key: string; id: string; identifier: string | null; title: string; status: string; archived: boolean; running: boolean }>;
}

export function planSpecHash(spec: PlanSpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

function list(keys: readonly string[]): string {
  return keys.length > 5 ? `${keys.slice(0, 5).join(', ')} and ${keys.length - 5} more` : keys.join(', ');
}

/** Blocking problems (`errors`) and review hints (`warnings`) of a spec. */
export function validatePlanSpec(spec: PlanSpec): { errors: PlanIssue[]; warnings: PlanIssue[] } {
  const errors: PlanIssue[] = [];
  const keys = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of spec.tasks) {
    if (keys.has(task.key)) duplicates.add(task.key);
    keys.add(task.key);
  }
  if (duplicates.size > 0) errors.push({ code: 'DUPLICATE_KEY', message: `Task keys must be unique: ${list([...duplicates])}`, keys: [...duplicates] });
  const selfBlocked = spec.tasks.filter((task) => task.blockedBy?.includes(task.key)).map((task) => task.key);
  if (selfBlocked.length > 0) errors.push({ code: 'SELF_BLOCK', message: `A task cannot block itself: ${list(selfBlocked)}`, keys: selfBlocked });
  const unknown = spec.tasks.flatMap((task) => (task.blockedBy ?? []).filter((key) => !keys.has(key)).map((key) => `${task.key} → ${key}`));
  if (unknown.length > 0) {
    errors.push({ code: 'UNKNOWN_BLOCKER', message: `Blocked by tasks that are not in the plan: ${list(unknown)}`, keys: [...new Set(unknown.map((edge) => edge.split(' → ')[0] ?? ''))] });
  }
  if (errors.length === 0) {
    const order = topologicalOrder(spec);
    if (order.length < spec.tasks.length) {
      const looped = spec.tasks.map((task) => task.key).filter((key) => !order.includes(key));
      errors.push({ code: 'CYCLE', message: `These tasks block each other in a loop: ${list(looped)}`, keys: looped });
    }
  }
  const warnings: PlanIssue[] = [];
  const untestable = spec.tasks.filter((task) => !task.acceptance?.length).map((task) => task.key);
  if (untestable.length > 0) {
    warnings.push({ code: 'NO_ACCEPTANCE', message: `No acceptance checks, so "done" can't be verified: ${list(untestable)}`, keys: untestable });
  }
  const unestimated = spec.tasks.filter((task) => !task.estimate).map((task) => task.key);
  if (unestimated.length > 0) warnings.push({ code: 'NO_ESTIMATE', message: `No estimate: ${list(unestimated)}`, keys: unestimated });
  return { errors, warnings };
}

/** Keys in an order where blockers come first (stable); a loop leaves its keys out. */
export function topologicalOrder(spec: PlanSpec): string[] {
  const placed = new Set<string>();
  const order: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const task of spec.tasks) {
      if (placed.has(task.key) || !(task.blockedBy ?? []).every((key) => placed.has(key))) continue;
      placed.add(task.key);
      order.push(task.key);
      progressed = true;
    }
  }
  return order;
}

/** The description a plan task gives its issue: its text plus the acceptance checklist. */
export function taskDescriptionFor(task: PlanTaskSpec): string | null {
  const parts: string[] = [];
  if (task.description?.trim()) parts.push(task.description.trim());
  if (task.acceptance?.length) parts.push(['## Acceptance criteria', ...task.acceptance.map((check) => `- [ ] ${check}`)].join('\n'));
  return parts.length > 0 ? parts.join('\n\n') : null;
}

const DIFF_FIELDS = ['title', 'description', 'priority', 'acceptance', 'estimate', 'risk', 'blockedBy'] as const;

function fieldValue(task: PlanTaskSpec, field: (typeof DIFF_FIELDS)[number]): string {
  if (field === 'blockedBy') return JSON.stringify([...(task.blockedBy ?? [])].sort());
  if (field === 'acceptance') return JSON.stringify(task.acceptance ?? []);
  if (field === 'priority') return task.priority ?? 'medium';
  return task[field] ?? '';
}

export function diffPlanSpecs(previous: PlanSpec | null, next: PlanSpec): PlanDiff {
  const before = new Map((previous?.tasks ?? []).map((task) => [task.key, task]));
  const after = new Map(next.tasks.map((task) => [task.key, task]));
  const changed: PlanDiff['changed'] = [];
  for (const task of next.tasks) {
    const old = before.get(task.key);
    if (!old) continue;
    const fields = DIFF_FIELDS.filter((field) => fieldValue(old, field) !== fieldValue(task, field));
    if (fields.length > 0) changed.push({ key: task.key, fields: [...fields] });
  }
  return {
    added: next.tasks.filter((task) => !before.has(task.key)).map((task) => task.key),
    removed: (previous?.tasks ?? []).filter((task) => !after.has(task.key)).map((task) => task.key),
    changed,
  };
}

function parseStoredSpec(value: Prisma.JsonValue): PlanSpec {
  const parsed = planSpecSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(500, 'PLAN_CORRUPT', 'A stored plan revision is not a valid plan');
  return parsed.data;
}

/** Every caller (REST, Home Chat, MCP via REST) gets the same title rule as the DB check. */
function assertTitle(title: string): void {
  const length = title.trim().length;
  if (length < 1 || length > 200) throw new HttpError(400, 'VALIDATION_ERROR', 'A plan title needs 1-200 characters', { field: 'title' });
}

function assertValid(spec: PlanSpec): void {
  const { errors } = validatePlanSpec(spec);
  if (errors.length > 0) {
    throw new HttpError(400, 'PLAN_INVALID', `The plan has ${errors.length === 1 ? 'a problem' : 'problems'}: ${errors.map((issue) => issue.message).join('; ')}`, { issues: errors });
  }
}

async function loadPlan(planId: string) {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  return plan;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPlans(input: { projectId: string; userId: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const plans = await prisma.plan.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: 100,
    include: {
      revisions: { orderBy: { number: 'desc' }, take: 1, select: { spec: true } },
      tasks: { select: { task: { select: { status: true, projectId: true } } } },
    },
  });
  return {
    items: plans.map((plan) => {
      const latest = plan.revisions[0];
      // Tasks moved to another project since are not this plan's to report.
      const linked = plan.tasks.filter((link) => link.task.projectId === plan.projectId);
      return {
        id: plan.id,
        title: plan.title,
        status: plan.status,
        latestRevision: plan.latestRevision,
        approvedRevision: plan.approvedRevision,
        taskCount: latest ? parseStoredSpec(latest.spec).tasks.length : 0,
        createdTaskCount: linked.length,
        doneTaskCount: linked.filter((link) => link.task.status === 'done').length,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
      };
    }),
  };
}

/** One plan with a revision (latest by default), its checks, its diff and the tasks it created. */
export async function getPlan(input: { planId: string; userId: string; revision?: number }): Promise<PlanView> {
  const plan = await loadPlan(input.planId);
  await assertProjectAccess(plan.projectId, input.userId, 'view');
  const number = input.revision ?? plan.latestRevision;
  const revisions = await prisma.planRevision.findMany({
    where: { planId: plan.id },
    orderBy: { number: 'asc' },
    select: { number: true, specHash: true, note: true, createdAt: true, createdById: true, approvedAt: true, approvedById: true, spec: true },
  });
  const current = revisions.find((revision) => revision.number === number);
  if (!current) throw new HttpError(404, 'PLAN_REVISION_NOT_FOUND', `Revision ${number} does not exist`);
  const previous = revisions.find((revision) => revision.number === number - 1);
  const spec = parseStoredSpec(current.spec);
  // Only tasks still in the plan's project (a moved task belongs to its new project now).
  const links = await prisma.planTask.findMany({
    where: { planId: plan.id, task: { projectId: plan.projectId } },
    orderBy: { createdAt: 'asc' },
    select: { key: true, task: { select: { id: true, identifier: true, title: true, status: true, archived: true, sessionId: true } } },
  });
  const { errors, warnings } = validatePlanSpec(spec);
  return {
    id: plan.id,
    projectId: plan.projectId,
    title: plan.title,
    status: plan.status,
    latestRevision: plan.latestRevision,
    approvedRevision: plan.approvedRevision,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    revisions: revisions.map((revision) => ({
      number: revision.number,
      specHash: revision.specHash,
      note: revision.note,
      createdAt: revision.createdAt.toISOString(),
      createdById: revision.createdById,
      approvedAt: revision.approvedAt?.toISOString() ?? null,
    })),
    revision: {
      number: current.number,
      spec,
      specHash: current.specHash,
      note: current.note,
      createdAt: current.createdAt.toISOString(),
      approvedAt: current.approvedAt?.toISOString() ?? null,
      order: topologicalOrder(spec),
      errors,
      warnings,
      diff: previous ? diffPlanSpecs(parseStoredSpec(previous.spec), spec) : null,
    },
    tasks: links.map((link) => ({
      key: link.key, id: link.task.id, identifier: link.task.identifier, title: link.task.title, status: link.task.status, archived: link.task.archived,
      running: isHeldByExecution(link.task),
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** `POST /api/projects/:id/plans` as an idempotent command (W04a keys). */
export async function authorizeCreatePlan(input: { projectId: string; userId: string; title: string; spec: PlanSpec; note?: string }): Promise<IdempotentCommand<null, PlanView>> {
  await assertProjectAccess(input.projectId, input.userId, 'full');
  assertTitle(input.title);
  assertValid(input.spec);
  return {
    resolveWorkspaceId: () => resolveProjectWorkspaceId(input.projectId),
    prepare: async () => null,
    mutate: async (tx) => {
      const plan = await tx.plan.create({
        data: {
          projectId: input.projectId,
          title: input.title.trim(),
          createdById: input.userId,
          revisions: {
            create: {
              number: 1,
              spec: input.spec as Prisma.InputJsonObject,
              specHash: planSpecHash(input.spec),
              note: input.note ?? null,
              createdById: input.userId,
            },
          },
        },
      });
      await appendToTarget(tx, await projectTarget(tx, input.projectId), 'plan:created', { planId: plan.id, projectId: input.projectId, revision: 1 }, input.userId);
      return { status: 201, body: await planViewIn(tx, plan.id) };
    },
  };
}

/** The plan view read inside a transaction (the create response). */
async function planViewIn(tx: Prisma.TransactionClient, planId: string): Promise<PlanView> {
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
  const revision = await tx.planRevision.findUniqueOrThrow({ where: { planId_number: { planId, number: plan.latestRevision } } });
  const spec = parseStoredSpec(revision.spec);
  const { errors, warnings } = validatePlanSpec(spec);
  return {
    id: plan.id,
    projectId: plan.projectId,
    title: plan.title,
    status: plan.status,
    latestRevision: plan.latestRevision,
    approvedRevision: plan.approvedRevision,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    revisions: [{ number: revision.number, specHash: revision.specHash, note: revision.note, createdAt: revision.createdAt.toISOString(), createdById: revision.createdById, approvedAt: null }],
    revision: {
      number: revision.number,
      spec,
      specHash: revision.specHash,
      note: revision.note,
      createdAt: revision.createdAt.toISOString(),
      approvedAt: null,
      order: topologicalOrder(spec),
      errors,
      warnings,
      diff: null,
    },
    tasks: [],
  };
}

async function lockPlan(tx: Prisma.TransactionClient, planId: string) {
  await tx.$queryRaw`SELECT id FROM "plans" WHERE id = ${planId} FOR UPDATE`;
  const plan = await tx.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  return plan;
}

/**
 * Store a new revision based on the latest one (409 PLAN_REVISION_CONFLICT
 * otherwise). An identical spec adds no revision (`unchanged: true`).
 */
export async function revisePlan(input: { planId: string; userId: string; baseRevision: number; spec: PlanSpec; title?: string; note?: string }) {
  const existing = await loadPlan(input.planId);
  await assertProjectAccess(existing.projectId, input.userId, 'full');
  if (input.title !== undefined) assertTitle(input.title);
  assertValid(input.spec);
  const specHash = planSpecHash(input.spec);
  const outcome = await transactionWithEvents(async (tx) => {
    const plan = await lockPlan(tx, input.planId);
    if (plan.status === 'archived') throw new HttpError(409, 'PLAN_ARCHIVED', 'This plan is archived');
    if (input.baseRevision !== plan.latestRevision) {
      throw new HttpError(409, 'PLAN_REVISION_CONFLICT', `Revision ${plan.latestRevision} is the latest; revise from it`, { latestRevision: plan.latestRevision });
    }
    const latest = await tx.planRevision.findUniqueOrThrow({ where: { planId_number: { planId: plan.id, number: plan.latestRevision } } });
    const titleChanged = input.title !== undefined && input.title !== plan.title;
    if (latest.specHash === specHash) {
      if (titleChanged) await tx.plan.update({ where: { id: plan.id }, data: { title: input.title } });
      return { unchanged: true, number: plan.latestRevision };
    }
    const number = plan.latestRevision + 1;
    await tx.planRevision.create({
      data: { planId: plan.id, number, spec: input.spec as Prisma.InputJsonObject, specHash, note: input.note ?? null, createdById: input.userId },
    });
    await tx.plan.update({ where: { id: plan.id }, data: { latestRevision: number, ...(titleChanged ? { title: input.title } : {}) } });
    await appendToTarget(tx, await projectTarget(tx, plan.projectId), 'plan:revised', { planId: plan.id, projectId: plan.projectId, revision: number }, input.userId);
    return { unchanged: false, number };
  }, PRISMA_TX_OPTIONS);
  return { unchanged: outcome.unchanged, plan: await getPlan({ planId: input.planId, userId: input.userId, revision: outcome.number }) };
}

export async function archivePlan(input: { planId: string; userId: string }) {
  const plan = await loadPlan(input.planId);
  await assertProjectAccess(plan.projectId, input.userId, 'full');
  if (plan.status !== 'archived') {
    await transactionWithEvents(async (tx) => {
      await tx.plan.update({ where: { id: plan.id }, data: { status: 'archived' } });
      await appendToTarget(tx, await projectTarget(tx, plan.projectId), 'plan:archived', { planId: plan.id, projectId: plan.projectId }, input.userId);
    }, PRISMA_TX_OPTIONS);
  }
  return getPlan({ planId: plan.id, userId: input.userId });
}

export interface ApprovalReport {
  alreadyApproved: boolean;
  created: Array<{ key: string; taskId: string; identifier: string | null }>;
  updated: Array<{ key: string; taskId: string; fields: string[] }>;
  /** Keys the plan dropped since the last approval; their tasks are kept. */
  removed: Array<{ key: string; taskId: string }>;
  /** Keys whose task was deleted or moved out of the project; not recreated. */
  skipped: Array<{ key: string; reason: 'deleted' | 'moved' }>;
  dependencies: { added: number; removed: number };
}

/**
 * Approve the latest revision: create what is new, apply what the plan
 * changed, sync plan dependencies. 409 PLAN_REVISION_STALE when it is not the
 * latest, PLAN_CONFLICT when a plan dependency would close a loop with
 * dependencies added outside the plan (nothing is written then).
 */
export async function approvePlan(input: { planId: string; userId: string; revision: number }) {
  const existing = await loadPlan(input.planId);
  await assertProjectAccess(existing.projectId, input.userId, 'full');
  const teamId = await resolveProjectTeamId(existing.projectId);
  await assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member']);

  const report = await transactionWithEvents(async (tx): Promise<ApprovalReport & { createdTaskIds: string[] }> => {
    await lockProjectDependencies(tx, existing.projectId);
    const plan = await lockPlan(tx, input.planId);
    const empty: ApprovalReport & { createdTaskIds: string[] } = { alreadyApproved: true, created: [], updated: [], removed: [], skipped: [], dependencies: { added: 0, removed: 0 }, createdTaskIds: [] };
    if (plan.status === 'archived') throw new HttpError(409, 'PLAN_ARCHIVED', 'This plan is archived');
    if (input.revision !== plan.latestRevision) {
      throw new HttpError(409, 'PLAN_REVISION_STALE', `Revision ${plan.latestRevision} is the latest; review it before approving`, { latestRevision: plan.latestRevision });
    }
    if (plan.approvedRevision === input.revision) return empty;

    const revision = await tx.planRevision.findUniqueOrThrow({ where: { planId_number: { planId: plan.id, number: input.revision } } });
    const spec = parseStoredSpec(revision.spec);
    assertValid(spec);
    const previous = plan.approvedRevision
      ? parseStoredSpec((await tx.planRevision.findUniqueOrThrow({ where: { planId_number: { planId: plan.id, number: plan.approvedRevision } } })).spec)
      : null;
    const before = new Map((previous?.tasks ?? []).map((task) => [task.key, task]));
    const links = await tx.planTask.findMany({ where: { planId: plan.id }, select: { key: true, task: { select: { id: true, projectId: true } } } });
    const linkByKey = new Map(links.map((link) => [link.key, link.task]));

    const toCreate: PlanTaskSpec[] = [];
    const updates: Array<{ key: string; taskId: string; data: Prisma.TaskUpdateInput; fields: string[] }> = [];
    const skipped: ApprovalReport['skipped'] = [];
    const idByKey = new Map<string, string>();
    for (const task of spec.tasks) {
      const linked = linkByKey.get(task.key);
      const old = before.get(task.key);
      if (!linked) {
        // Approved before and gone now: the user deleted it; don't bring it back.
        if (old) skipped.push({ key: task.key, reason: 'deleted' });
        else toCreate.push(task);
        continue;
      }
      if (linked.projectId !== plan.projectId) {
        skipped.push({ key: task.key, reason: 'moved' });
        continue;
      }
      idByKey.set(task.key, linked.id);
      // Three-way: only what the plan changed since the approved revision.
      const data: Prisma.TaskUpdateInput = {};
      const fields: string[] = [];
      if (!old || old.title !== task.title) { data.title = task.title; fields.push('title'); }
      if (!old || taskDescriptionFor(old) !== taskDescriptionFor(task)) { data.description = taskDescriptionFor(task); fields.push('description'); }
      if (!old || (old.priority ?? 'medium') !== (task.priority ?? 'medium')) { data.priority = task.priority ?? 'medium'; fields.push('priority'); }
      if (fields.length > 0) updates.push({ key: task.key, taskId: linked.id, data, fields });
    }
    const inSpec = new Set(spec.tasks.map((task) => task.key));
    const removed = (previous?.tasks ?? [])
      .filter((task) => !inSpec.has(task.key))
      .flatMap((task) => {
        const linked = linkByKey.get(task.key);
        return linked ? [{ key: task.key, taskId: linked.id }] : [];
      });

    const created = await insertProjectTasks(tx, {
      projectId: plan.projectId,
      teamId,
      userId: input.userId,
      items: toCreate.map((task) => ({ title: task.title, description: taskDescriptionFor(task) ?? undefined, priority: task.priority ?? 'medium', status: 'todo' })),
    });
    if (created.length > 0) {
      await tx.planTask.createMany({ data: created.map((row, index) => ({ planId: plan.id, key: toCreate[index]?.key ?? '', taskId: row.id })) });
    }
    created.forEach((row, index) => { const key = toCreate[index]?.key; if (key) idByKey.set(key, row.id); });
    for (const update of updates) await tx.task.update({ where: { id: update.taskId }, data: update.data });

    // Dependencies between plan tasks: add what the spec wants, drop what the
    // previous approval added and this one no longer wants. Edges added by
    // hand are left alone.
    const edgeKey = (taskId: string, dependsOnTaskId: string) => `${taskId}>${dependsOnTaskId}`;
    const wanted = new Map<string, { taskId: string; dependsOnTaskId: string }>();
    for (const task of spec.tasks) {
      const taskId = idByKey.get(task.key);
      for (const blocker of task.blockedBy ?? []) {
        const dependsOnTaskId = idByKey.get(blocker);
        if (taskId && dependsOnTaskId) wanted.set(edgeKey(taskId, dependsOnTaskId), { taskId, dependsOnTaskId });
      }
    }
    const touched = new Set<string>();
    const stale: Array<{ taskId: string; dependsOnTaskId: string }> = [];
    for (const task of previous?.tasks ?? []) {
      const taskId = linkByKey.get(task.key)?.id;
      for (const blocker of task.blockedBy ?? []) {
        const dependsOnTaskId = linkByKey.get(blocker)?.id;
        if (taskId && dependsOnTaskId && !wanted.has(edgeKey(taskId, dependsOnTaskId))) stale.push({ taskId, dependsOnTaskId });
      }
    }
    let removedEdges = 0;
    if (stale.length > 0) {
      removedEdges = (await tx.taskDependency.deleteMany({ where: { OR: stale } })).count;
      for (const edge of stale) touched.add(edge.taskId);
    }
    // Plan edges alone are acyclic (checked with the spec), so a loop needs an
    // edge the plan doesn't define touching its tasks: only then is each new
    // edge checked one by one. Otherwise they go in with one statement.
    const planTaskIds = [...new Set(idByKey.values())];
    const edgesNow = planTaskIds.length === 0 ? [] : await tx.taskDependency.findMany({
      where: { OR: [{ taskId: { in: planTaskIds } }, { dependsOnTaskId: { in: planTaskIds } }] },
      select: { taskId: true, dependsOnTaskId: true },
    });
    const present = new Set(edgesNow.map((edge) => edgeKey(edge.taskId, edge.dependsOnTaskId)));
    const missing = [...wanted.values()].filter((edge) => !present.has(edgeKey(edge.taskId, edge.dependsOnTaskId)));
    const foreign = edgesNow.some((edge) => !wanted.has(edgeKey(edge.taskId, edge.dependsOnTaskId)));
    if (foreign) {
      for (const edge of missing) {
        if (await wouldCreateCycle(tx, edge.taskId, edge.dependsOnTaskId)) {
          throw new HttpError(409, 'PLAN_CONFLICT', 'Approving would make tasks block each other in a loop with dependencies added outside the plan; remove one of them first', edge);
        }
        await tx.taskDependency.create({ data: { ...edge, createdById: input.userId } });
      }
    } else if (missing.length > 0) {
      await tx.taskDependency.createMany({ data: missing.map((edge) => ({ ...edge, createdById: input.userId })), skipDuplicates: true });
    }
    const addedEdges = missing.length;
    for (const edge of missing) touched.add(edge.taskId);

    const approvedAt = new Date();
    await tx.planRevision.update({ where: { id: revision.id }, data: { approvedAt, approvedById: input.userId } });
    await tx.plan.update({ where: { id: plan.id }, data: { approvedRevision: input.revision, status: 'approved' } });

    // Events: the new tasks as one bulk event (lists refetch), then every
    // existing task whose fields or blockers changed, read after all writes.
    const createdIds = created.map((row) => row.id);
    if (createdIds.length > 0) {
      await appendToTarget(tx, await projectTarget(tx, plan.projectId), 'tasks:bulk-created', {
        type: 'tasks:bulk-created', projectId: plan.projectId, count: createdIds.length, taskIds: createdIds,
      }, input.userId);
    }
    const changedIds = [...new Set([...updates.map((update) => update.taskId), ...touched])].filter((id) => !createdIds.includes(id));
    if (changedIds.length > 0) {
      const rows = await tx.task.findMany({ where: { id: { in: changedIds } }, include: taskInclude });
      for (const row of rows) {
        const dto = flattenTaskLabels(row);
        await appendToTarget(tx, await taskTarget(tx, dto), 'task:updated', dto, input.userId);
      }
    }
    await appendToTarget(tx, await projectTarget(tx, plan.projectId), 'plan:approved', { planId: plan.id, projectId: plan.projectId, revision: input.revision }, input.userId);

    return {
      alreadyApproved: false,
      created: created.map((row, index) => ({ key: toCreate[index]?.key ?? '', taskId: row.id, identifier: row.identifier })),
      updated: updates.map(({ key, taskId, fields }) => ({ key, taskId, fields })),
      removed,
      skipped,
      dependencies: { added: addedEdges, removed: removedEdges },
      createdTaskIds: createdIds,
    };
  }, PRISMA_TX_OPTIONS);

  if (report.createdTaskIds.length > 0) {
    const rows = await prisma.task.findMany({ where: { id: { in: report.createdTaskIds } }, select: { id: true, projectId: true, teamId: true, title: true, identifier: true } });
    await Promise.all(rows.map((row) => logActivity({
      taskId: row.id, projectId: row.projectId, teamId: row.teamId, userId: input.userId,
      action: 'task_created', payload: { title: row.title, identifier: row.identifier, source: 'plan', planId: input.planId },
    })));
  }
  const { createdTaskIds: _createdTaskIds, ...approval } = report;
  return { approval, plan: await getPlan({ planId: input.planId, userId: input.userId }) };
}
