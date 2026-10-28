import * as z from 'zod';
import type { ApiPlan } from '../../openlinear/api';
import { deriveIdempotencyKey } from '../idempotency';
import { id, IdempotencyKeyArg, IssuePriority } from '../inputs';
import { IdempotencyShape } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

/**
 * W17b reviewable plans: an agent proposes a plan (tasks with acceptance
 * checks, estimates and blockers by key), the API checks it, people review
 * revisions in OpenLinear, and approving the latest revision creates the
 * issues. Unlike openlinear_bulk_create_plan, nothing is created up front.
 */

const PlanTaskKey = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,40}$/, 'letters, digits, dot, dash or underscore (1-40)')
  .describe('Your handle for the task, unique in the plan and stable across revisions');

const PlanTaskInput = z.strictObject({
  key: PlanTaskKey,
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).optional().describe('Markdown'),
  priority: IssuePriority.optional(),
  acceptance: z
    .array(z.string().trim().min(1).max(500))
    .max(20)
    .optional()
    .describe('How to tell it is done; becomes a checklist on the issue (tasks without any are flagged as untestable)'),
  estimate: z.enum(['xs', 's', 'm', 'l', 'xl']).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional().describe('How likely it is to go wrong or need a human; shown to reviewers'),
  blockedBy: z.array(PlanTaskKey).max(20).optional().describe('Keys of plan tasks that must be done first'),
});

const PlanTasks = z.array(PlanTaskInput).min(1).max(100).describe('The whole task list (1-100), blockers by key');

const IssueShape = z.object({ code: z.string(), message: z.string(), keys: z.array(z.string()) });

const PlanShape = z.object({
  id: z.string().describe('Plan UUID'),
  projectId: z.string(),
  title: z.string(),
  status: z.string().describe('draft | approved | archived'),
  latestRevision: z.number().int(),
  approvedRevision: z.number().int().nullable(),
  revision: z.object({
    number: z.number().int(),
    approved: z.boolean(),
    summary: z.string().nullable(),
    tasks: z.array(z.object({
      key: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      priority: z.string().nullable(),
      acceptance: z.array(z.string()),
      estimate: z.string().nullable(),
      risk: z.string().nullable(),
      blockedBy: z.array(z.string()),
    })),
    order: z.array(z.string()).describe('Task keys, blockers first'),
    errors: z.array(IssueShape).describe('Problems that block approval'),
    warnings: z.array(IssueShape).describe('Review hints: untestable or unestimated tasks'),
    diff: z
      .object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.object({ key: z.string(), fields: z.array(z.string()) })) })
      .nullable()
      .describe('Changes against the previous revision'),
  }),
  createdIssues: z
    .array(z.object({ key: z.string(), id: z.string(), identifier: z.string().nullable(), title: z.string(), status: z.string() }))
    .describe('Issues approvals created, by plan key'),
});

function toPlan(plan: ApiPlan): z.infer<typeof PlanShape> {
  return {
    id: plan.id,
    projectId: plan.projectId,
    title: plan.title,
    status: plan.status,
    latestRevision: plan.latestRevision,
    approvedRevision: plan.approvedRevision,
    revision: {
      number: plan.revision.number,
      approved: Boolean(plan.revision.approvedAt),
      summary: plan.revision.spec.summary ?? null,
      tasks: plan.revision.spec.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        description: task.description ?? null,
        priority: task.priority ?? null,
        acceptance: task.acceptance ?? [],
        estimate: task.estimate ?? null,
        risk: task.risk ?? null,
        blockedBy: task.blockedBy ?? [],
      })),
      order: plan.revision.order,
      errors: plan.revision.errors.map(({ code, message, keys }) => ({ code, message, keys })),
      warnings: plan.revision.warnings.map(({ code, message, keys }) => ({ code, message, keys })),
      diff: plan.revision.diff
        ? {
            added: plan.revision.diff.added,
            removed: plan.revision.diff.removed,
            changed: plan.revision.diff.changed.map(({ key, fields }) => ({ key, fields })),
          }
        : null,
    },
    createdIssues: plan.tasks.map((task) => ({ key: task.key, id: task.id, identifier: task.identifier ?? null, title: task.title, status: task.status })),
  };
}

export const proposePlan = defineTool({
  name: 'openlinear_propose_plan',
  title: 'Propose a plan for review',
  description:
    'Propose a plan for a project as a draft people review in OpenLinear: tasks with acceptance checks, estimates and blockers (by key). It is checked first (duplicate keys, unknown blockers and loops are refused; tasks without acceptance checks or estimates are flagged). Nothing is created until the plan is approved. Revise it with openlinear_revise_plan. Safe to retry.',
  input: z.strictObject({
    projectId: id('Project'),
    title: z.string().trim().min(1).max(200).describe('Plan title'),
    summary: z.string().max(5000).optional().describe('What the plan achieves (markdown)'),
    tasks: PlanTasks,
    note: z.string().trim().max(1000).optional().describe('Why this revision (shown in its history)'),
    idempotencyKey: IdempotencyKeyArg.optional(),
  }),
  output: z.object({ plan: PlanShape, idempotency: IdempotencyShape }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run(args, { api, signal, toolName }) {
    const key = await deriveIdempotencyKey(toolName, 'plan', args);
    const created = await api.createPlan(
      args.projectId,
      { title: args.title, spec: { ...(args.summary ? { summary: args.summary } : {}), tasks: args.tasks }, ...(args.note ? { note: args.note } : {}) },
      key,
      signal,
    );
    return { plan: toPlan(created.value), idempotency: { key, replayed: created.replayed } };
  },
});

export const listPlans = defineTool({
  name: 'openlinear_list_plans',
  title: 'List plans',
  description: "List a project's reviewable plans with their status and progress (newest activity first). Check here before proposing a plan that may already exist.",
  input: z.strictObject({ projectId: id('Project') }),
  output: z.object({
    plans: z.array(z.object({
      id: z.string(),
      title: z.string(),
      status: z.string().describe('draft | approved | archived'),
      latestRevision: z.number().int(),
      approvedRevision: z.number().int().nullable(),
      awaitingReview: z.boolean().describe('A newer revision than the approved one waits for review'),
      taskCount: z.number().int().describe('Tasks in the latest revision'),
      createdIssues: z.number().int(),
      doneIssues: z.number().int(),
      updatedAt: z.string(),
    })),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run({ projectId }, { api, signal }) {
    const items = await api.listPlans(projectId, signal);
    return {
      plans: items.map((plan) => ({
        id: plan.id,
        title: plan.title,
        status: plan.status,
        latestRevision: plan.latestRevision,
        approvedRevision: plan.approvedRevision,
        awaitingReview: plan.approvedRevision === null ? plan.status === 'draft' : plan.latestRevision > plan.approvedRevision,
        taskCount: plan.taskCount,
        createdIssues: plan.createdTaskCount,
        doneIssues: plan.doneTaskCount,
        updatedAt: plan.updatedAt,
      })),
    };
  },
});

export const getPlan = defineTool({
  name: 'openlinear_get_plan',
  title: 'Get plan',
  description: 'Get a plan with one revision (the latest by default): its tasks, checks, changes against the previous revision, and the issues approvals created.',
  input: z.strictObject({
    planId: id('Plan'),
    revision: z.number().int().min(1).optional().describe('Revision number; defaults to the latest'),
  }),
  output: z.object({ plan: PlanShape }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run({ planId, revision }, { api, signal }) {
    return { plan: toPlan(await api.getPlan(planId, revision, signal)) };
  },
});

export const revisePlan = defineTool({
  name: 'openlinear_revise_plan',
  title: 'Revise a plan',
  description:
    'Store a new revision of a plan (the full task list; keep keys stable so approved issues are updated, not duplicated). baseRevision must be the latest revision (else PLAN_REVISION_CONFLICT: read the plan again). An identical task list adds no revision.',
  input: z.strictObject({
    planId: id('Plan'),
    baseRevision: z.number().int().min(1).describe('The latest revision you read'),
    title: z.string().trim().min(1).max(200).optional().describe('New plan title'),
    summary: z.string().max(5000).optional().describe('What the plan achieves (markdown)'),
    tasks: PlanTasks,
    note: z.string().trim().max(1000).optional().describe('What changed and why'),
  }),
  output: z.object({ plan: PlanShape, unchanged: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run(args, { api, signal }) {
    const result = await api.revisePlan(
      args.planId,
      {
        baseRevision: args.baseRevision,
        spec: { ...(args.summary ? { summary: args.summary } : {}), tasks: args.tasks },
        ...(args.title ? { title: args.title } : {}),
        ...(args.note ? { note: args.note } : {}),
      },
      signal,
    );
    return { plan: toPlan(result.plan), unchanged: result.unchanged };
  },
});

export const approvePlan = defineTool({
  name: 'openlinear_approve_plan',
  title: 'Approve a plan',
  description:
    'Approve the latest revision of a plan — only when the user asked for it. Creates the issues for new keys, applies what the plan changed since the last approval (edits made on the issues are kept), and syncs blockers between plan issues. Approving the same revision again changes nothing. Nothing is executed.',
  input: z.strictObject({
    planId: id('Plan'),
    revision: z.number().int().min(1).describe('The latest revision (as reviewed)'),
  }),
  output: z.object({
    plan: PlanShape,
    alreadyApproved: z.boolean(),
    created: z.array(z.object({ key: z.string(), issueId: z.string(), identifier: z.string().nullable() })),
    updated: z.array(z.object({ key: z.string(), issueId: z.string(), fields: z.array(z.string()) })),
    removedFromPlan: z.array(z.object({ key: z.string(), issueId: z.string() })).describe('Keys dropped since the last approval; their issues are kept'),
    skipped: z.array(z.object({ key: z.string(), reason: z.string() })).describe('Issues deleted or moved since; not recreated'),
    blockers: z.object({ added: z.number().int(), removed: z.number().int() }),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ planId, revision }, { api, signal }) {
    const { approval, plan } = await api.approvePlan(planId, revision, signal);
    return {
      plan: toPlan(plan),
      alreadyApproved: approval.alreadyApproved,
      created: approval.created.map((row) => ({ key: row.key, issueId: row.taskId, identifier: row.identifier ?? null })),
      updated: approval.updated.map((row) => ({ key: row.key, issueId: row.taskId, fields: row.fields })),
      removedFromPlan: approval.removed.map((row) => ({ key: row.key, issueId: row.taskId })),
      skipped: approval.skipped.map((row) => ({ key: row.key, reason: row.reason })),
      blockers: { added: approval.dependencies.added, removed: approval.dependencies.removed },
    };
  },
});
