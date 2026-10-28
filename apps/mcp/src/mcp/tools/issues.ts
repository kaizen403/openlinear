import * as z from 'zod';
import type { PatPrincipal } from '../../auth';
import type { ApiComment, ApiTask, OpenLinearApi } from '../../openlinear/api';
import { OpenLinearApiError } from '../../openlinear/errors';
import { ToolInputError } from '../errors';
import { deriveIdempotencyKey } from '../idempotency';
import { AgentRunner, DueDate, id, IdempotencyKeyArg, IssuePriority, IssueStatus } from '../inputs';
import {
  CommentShape,
  DependencyRefShape,
  IdempotencyShape,
  IssueDetailShape,
  IssueRefShape,
  IssueSummaryShape,
  toComment,
  toDependencyRef,
  toIssueDetail,
  toIssueRef,
  toIssueSummary,
  toVerification,
  VerificationShape,
} from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

/** Keyset pages read per call when the creator filter has to be applied here (see listIssues). */
export const MAX_LOCAL_FILTER_PAGES = 5;
/** Identifier lookup reads at most this many `GET /api/tasks` pages of this size. */
export const IDENTIFIER_PAGE_SIZE = 100;
export const MAX_IDENTIFIER_PAGES = 3;
/** `GET /api/tasks/:id` returns at most this many sub-issues. */
export const SUBTASK_CAP = 100;

/** The API's `identifier` filter (schemas/tasks.ts): team keys have at most 10 characters. */
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;

const Me = z.literal('me');

/** Resolve `"me"` to the token owner; narrow-scope tokens have no known owner (see auth.ts). */
function resolveMe(value: string, principal: PatPrincipal, field: string): string {
  if (value !== 'me') return value;
  if (principal.userId) return principal.userId;
  throw new ToolInputError(
    `"me" cannot be used in ${field} with this token: its scopes do not include reading the token owner (GET /api/users/me needs the read or write scope). Pass your user UUID instead (openlinear_list_teams lists members).`,
  );
}

export const listIssues = defineTool({
  name: 'openlinear_list_issues',
  title: 'List issues',
  description:
    'List issues newest first. Every filter runs on the server and they combine with AND: project, team, assignee ("me", "none" or a UUID), creator, status, labels, parent (sub-issues, or "none" for top-level only) and text. To page, call again with the same filters and cursor = nextCursor. For search across projects and teams use openlinear_search.',
  input: z.strictObject({
    projectId: id('Project').optional(),
    teamId: id('Team').optional().describe("Team UUID: the team's issues, with or without a project"),
    assignee: z
      .union([Me, z.literal('none'), z.guid()])
      .optional()
      .describe('"me", "none" (unassigned) or a user UUID (primary assignee)'),
    creator: z.union([Me, z.guid()]).optional().describe('"me" or a user UUID'),
    status: z.array(IssueStatus).min(1).max(4).optional().describe('Match any of these statuses'),
    labelId: z
      .union([z.guid(), z.array(z.guid()).min(1).max(20)])
      .optional()
      .describe('Label (or phase label) UUID, or up to 20 of them: an issue matches if it has any'),
    parentId: z
      .union([z.guid(), z.literal('none')])
      .optional()
      .describe('Parent issue UUID (its sub-issues), or "none" for top-level issues only'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive literal text in the title, description or identifier'),
    limit: z.number().int().min(1).max(100).default(25).describe('Issues per page'),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('nextCursor from the previous page (opaque); keep every other argument unchanged'),
    includeTotal: z
      .boolean()
      .default(false)
      .describe('Also count every matching issue (one more query on the server)'),
  }),
  output: z.object({
    issues: z.array(IssueSummaryShape),
    limit: z.number().int(),
    hasMore: z.boolean().describe('More issues match: call again with cursor = nextCursor'),
    nextCursor: z.string().nullable().describe('Opaque cursor for the next page; null on the last page'),
    total: z
      .number()
      .int()
      .nullable()
      .describe(
        'Every matching issue (not just this page) when includeTotal is true; null otherwise, and when assignee and creator are combined',
      ),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run(args, { api, principal, signal }) {
    const { projectId, teamId, assignee, creator, status, labelId, parentId, query, limit, cursor, includeTotal } = args;
    const labelIds = labelId === undefined ? undefined : Array.isArray(labelId) ? labelId : [labelId];
    // The API ORs assignee with creator ("assigned to or created by"). Agents
    // expect AND, so with both the API filters by assignee and the creator is
    // checked here.
    const localCreator = assignee && creator ? resolveMe(creator, principal, 'creator') : undefined;
    const filters = {
      projectId,
      teamId,
      assignee,
      creator: localCreator ? undefined : creator,
      status,
      labelIds,
      q: query,
      parentId,
    };

    if (!localCreator) {
      const page = await api.listTasks({ ...filters, cursor, includeTotal, pageSize: limit }, signal);
      const nextCursor = page.hasMore ? (page.nextCursor ?? null) : null;
      return {
        issues: page.items.map(toIssueSummary),
        limit,
        hasMore: nextCursor !== null,
        nextCursor,
        total: includeTotal ? (page.total ?? null) : null,
      };
    }

    // Ask only for as many rows as are still missing: every fetched row is
    // then either returned or skipped, so the API's own nextCursor stays exact.
    // A page can therefore hold fewer than `limit` issues while hasMore is true.
    const matches: ApiTask[] = [];
    let next = cursor;
    let more = true;
    for (let pages = 0; pages < MAX_LOCAL_FILTER_PAGES && more && matches.length < limit; pages += 1) {
      const page = await api.listTasks({ ...filters, cursor: next, pageSize: limit - matches.length }, signal);
      matches.push(...page.items.filter((task) => (task.creatorId ?? task.creator?.id) === localCreator));
      more = page.hasMore && Boolean(page.nextCursor);
      next = page.nextCursor ?? undefined;
    }
    const nextCursor = more ? (next ?? null) : null;
    return { issues: matches.map(toIssueSummary), limit, hasMore: nextCursor !== null, nextCursor, total: null };
  },
});

/**
 * Resolve `taskId`, or an identifier such as `ENG-12` through
 * `GET /api/tasks?identifier=` (exact, case-insensitive). Teams in different
 * workspaces can share a key, so an identifier can match several issues.
 *
 * `q` is sent as well: an API from before the `identifier` filter ignores it
 * and runs a substring search instead (`ENG-1` also finds `ENG-12` and text
 * that mentions it), so only exact identifier matches count here. Unless every
 * page was read, another issue with the same identifier may be on a later
 * page, so a single match is refused too: picking it could make the caller act
 * on the wrong issue.
 */
async function resolveIssue(
  api: OpenLinearApi,
  args: { taskId?: string; identifier?: string },
  signal: AbortSignal,
): Promise<ApiTask> {
  if (args.taskId) return api.getTask(args.taskId, signal);
  const identifier = args.identifier;
  if (!identifier) throw new ToolInputError('Pass taskId (UUID) or identifier (e.g. ENG-12).');
  const wanted = identifier.toLowerCase();
  const matches: ApiTask[] = [];
  let cursor: string | undefined;
  let exhausted = false;
  let read = 0;
  for (let page = 0; page < MAX_IDENTIFIER_PAGES; page += 1) {
    const result = await api.listTasks({ q: identifier, identifier, cursor, pageSize: IDENTIFIER_PAGE_SIZE }, signal);
    read += result.items.length;
    matches.push(...result.items.filter((task) => task.identifier?.toLowerCase() === wanted));
    if (!result.hasMore) {
      exhausted = true;
      break;
    }
    // hasMore without a cursor: the rest cannot be read, so it is not exhausted.
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const candidates = matches.map((task) => `${task.id} (${task.title})`).join('; ');
  const [only, ...others] = matches;
  if (others.length > 0) {
    throw new ToolInputError(`Identifier ${identifier} matches several issues; call again with taskId: ${candidates}`);
  }
  if (!exhausted) {
    const stopped = `the lookup stopped after ${read} issues mentioning it, before reading them all`;
    const findIt = 'Find the issue with openlinear_list_issues (projectId) or openlinear_search and pass its taskId';
    throw new ToolInputError(
      only
        ? `Identifier ${identifier} cannot be resolved safely: ${stopped}, and teams in different workspaces can share a key, so another ${identifier} may exist. Call again with taskId. Found so far: ${candidates}. ${findIt}.`
        : `No issue with identifier ${identifier} found, but ${stopped}. ${findIt}.`,
    );
  }
  if (!only) {
    throw new ToolInputError(
      `No visible issue has identifier ${identifier}. Check it with openlinear_search or openlinear_list_issues.`,
    );
  }
  return api.getTask(only.id, signal);
}

/** The newest `limit` comments, oldest first. The API pages comments oldest first. */
async function latestComments(
  api: OpenLinearApi,
  taskId: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ items: ApiComment[]; total: number }> {
  const first = await api.listComments(taskId, { page: 1, pageSize: limit }, signal);
  if (first.total <= limit) return { items: first.comments, total: first.total };
  const lastPage = Math.ceil(first.total / limit);
  const last = await api.listComments(taskId, { page: lastPage, pageSize: limit }, signal);
  let items = last.comments;
  if (items.length < limit) {
    const previous =
      lastPage - 1 === 1 ? first : await api.listComments(taskId, { page: lastPage - 1, pageSize: limit }, signal);
    items = [...previous.comments.slice(items.length - limit), ...items];
  }
  return { items, total: first.total };
}

export const getIssue = defineTool({
  name: 'openlinear_get_issue',
  title: 'Get issue',
  description:
    'Get one issue by taskId or identifier (e.g. ENG-12) with its description, parent issue, latest comments, sub-issues and latest verification evidence.',
  input: z.strictObject({
    taskId: id('Issue (task)').optional(),
    identifier: z
      .string()
      .trim()
      .regex(IDENTIFIER_PATTERN)
      .optional()
      .describe(
        'Issue identifier such as ENG-12; used when taskId is omitted. Refused, with the candidate taskIds, when it may match more than one issue (teams in different workspaces can share a key)',
      ),
    includeComments: z.boolean().default(true).describe('Include the newest comments'),
    commentLimit: z.number().int().min(1).max(100).default(30).describe('Newest comments to return'),
    includeSubtasks: z.boolean().default(true).describe(`Include direct sub-issues (up to ${SUBTASK_CAP})`),
    includeVerification: z.boolean().default(true).describe("Include the latest verification evidence (checks run against the agent's commit)"),
  }),
  output: z.object({
    issue: IssueDetailShape,
    parent: IssueRefShape.nullable().describe('The parent issue when this is a sub-issue (null if none or not visible)'),
    comments: z
      .object({
        items: z.array(CommentShape).describe('Oldest first'),
        total: z.number().int(),
        truncated: z.boolean().describe('true when older comments were omitted'),
      })
      .nullable(),
    subtasks: z
      .object({
        items: z.array(IssueRefShape).describe('Direct, non-archived sub-issues by issue number'),
        complete: z
          .boolean()
          .describe(
            `false when the ${SUBTASK_CAP}-item cap was reached; list every sub-issue with openlinear_list_issues parentId`,
          ),
      })
      .nullable()
      .describe('null when includeSubtasks is false'),
    verification: VerificationShape.nullable().describe('Latest verification evidence; null when none was recorded or includeVerification is false'),
    blockedBy: z
      .array(DependencyRefShape)
      .describe('Issues this one waits on; agent runs of it are refused until each is done (unless run anyway)'),
    blocking: z.array(DependencyRefShape).describe('Issues waiting on this one'),
    plan: z
      .object({ id: z.string(), key: z.string(), title: z.string(), status: z.string() })
      .nullable()
      .describe('The reviewed plan this issue came from (openlinear_get_plan), with its key there; null if none'),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run(args, { api, signal }) {
    const task = await resolveIssue(api, args, signal);
    const comments = args.includeComments ? await latestComments(api, task.id, args.commentLimit, signal) : null;
    const subtasks = args.includeSubtasks ? (task.subtasks ?? null) : null;
    const verification = args.includeVerification ? await api.latestVerification(task.id, signal) : null;
    return {
      verification: verification ? toVerification(verification) : null,
      issue: toIssueDetail(task),
      parent: task.parent ? toIssueRef(task.parent) : null,
      comments: comments
        ? {
            items: comments.items.map(toComment),
            total: comments.total,
            truncated: comments.total > comments.items.length,
          }
        : null,
      subtasks: subtasks ? { items: subtasks.map(toIssueRef), complete: subtasks.length < SUBTASK_CAP } : null,
      blockedBy: (task.blockedBy ?? []).map(toDependencyRef),
      blocking: (task.blocking ?? []).map(toDependencyRef),
      plan: task.plan ? { id: task.plan.id, key: task.plan.key, title: task.plan.title, status: task.plan.status } : null,
    };
  },
});

const createIssueInput = z
  .strictObject({
    title: z.string().trim().min(1).max(500).describe('Issue title'),
    description: z.string().max(10000).optional().describe('Markdown'),
    priority: IssuePriority.optional().describe('Defaults to medium'),
    status: IssueStatus.optional().describe('Defaults to todo'),
    projectId: id('Project')
      .optional()
      .describe('Project (its default team numbers the issue). projectId or teamId is required'),
    teamId: id('Team')
      .optional()
      .describe('Team, for an issue without a project (such issues take no labels); ignored when projectId is given'),
    labelIds: z
      .array(z.guid())
      .max(20)
      .optional()
      .describe('Label UUIDs from the same project, including phase labels'),
    assigneeIds: z
      .array(z.union([Me, z.guid()]))
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Assignees: "me" or user UUIDs of members of the issue team (openlinear_list_teams); the first is the primary assignee shown on the board',
      ),
    dueDate: DueDate.nullable().optional().describe('ISO 8601 UTC due date, e.g. 2026-11-01T00:00:00Z'),
    model: z.string().min(1).max(200).nullable().optional().describe('Model override for execution, "provider/model"'),
    agent: AgentRunner.nullable().optional().describe("Agent runner that executes the issue; omit or null for the project's default"),
    idempotencyKey: IdempotencyKeyArg.optional(),
  })
  .refine((value) => Boolean(value.projectId || value.teamId), {
    message: 'Either projectId or teamId is required.',
    path: ['projectId'],
  });

export const createIssue = defineTool({
  name: 'openlinear_create_issue',
  title: 'Create issue',
  description:
    'Create one issue in a project (or in a team, without a project), optionally with labels and assignees. Safe to retry: identical calls within 24 hours return the original issue (idempotency.replayed: true) instead of a duplicate. For many issues use openlinear_bulk_create_plan.',
  input: createIssueInput,
  output: z.object({ issue: IssueDetailShape, idempotency: IdempotencyShape }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run(args, { api, principal, signal, toolName }) {
    const { idempotencyKey: _clientKey, assigneeIds, ...body } = args;
    const assignees = assigneeIds
      ? [...new Set(assigneeIds.map((value) => resolveMe(value, principal, 'assigneeIds')))]
      : undefined;
    const key = await deriveIdempotencyKey(toolName, 'issue', args);
    const created = await api.createTask({ ...body, ...(assignees ? { assigneeIds: assignees } : {}) }, key, signal);
    return { issue: toIssueDetail(created.value), idempotency: { key, replayed: created.replayed } };
  },
});

export const updateIssue = defineTool({
  name: 'openlinear_update_issue',
  title: 'Update issue',
  description:
    "Change fields of one issue; omitted fields are left as they are. labelIds REPLACES the whole label set (use openlinear_label_issue to add or remove). projectId moves the issue to that project's default team; null detaches it.",
  input: z.strictObject({
    taskId: id('Issue (task)'),
    title: z.string().trim().min(1).max(500).optional().describe('New title'),
    description: z.string().max(10000).nullable().optional().describe('New markdown description; null clears it'),
    priority: IssuePriority.optional().describe('New priority'),
    status: IssueStatus.optional().describe('Moving to todo, done or cancelled resets execution state'),
    labelIds: z.array(z.guid()).max(20).optional().describe('Replaces all labels'),
    teamId: id('Team').optional(),
    projectId: id('Project').nullable().optional().describe('Move to this project (its default team); null detaches'),
    dueDate: DueDate.nullable().optional().describe('ISO 8601 UTC due date; null clears it'),
    assigneeId: id('User').nullable().optional().describe('Must be a member of the issue team; null unassigns'),
    model: z.string().min(1).max(200).nullable().optional().describe('Model override "provider/model"; null clears it'),
    agent: AgentRunner.nullable().optional().describe("Agent runner; null falls back to the project's default"),
  }),
  output: z.object({ issue: IssueDetailShape }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ taskId, ...changes }, { api, signal }) {
    const fields = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    if (Object.keys(fields).length === 0) throw new ToolInputError('Nothing to update: pass at least one field besides taskId.');
    return { issue: toIssueDetail(await api.updateTask(taskId, fields, signal)) };
  },
});

export const assignIssue = defineTool({
  name: 'openlinear_assign_issue',
  title: 'Assign issue',
  description:
    'Assign an issue to "me" (the token owner) or a user UUID, or pass null to unassign. The user must be a member of the issue team (see openlinear_list_teams).',
  input: z.strictObject({
    taskId: id('Issue (task)'),
    assignee: z.union([Me, z.guid()]).nullable().describe('"me", a user UUID, or null to unassign'),
  }),
  output: z.object({ issue: IssueDetailShape }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ taskId, assignee }, { api, principal, signal }) {
    const assigneeId = assignee === null ? null : resolveMe(assignee, principal, 'assignee');
    return { issue: toIssueDetail(await api.updateTask(taskId, { assigneeId }, signal)) };
  },
});

/** 409 `P2002` on attach = the label is already on the issue. */
function alreadyAttached(error: unknown): boolean {
  return error instanceof OpenLinearApiError && error.status === 409 && error.code === 'P2002';
}

/** 404 `P2025` on detach = the label was not on the issue (a missing issue answers OWNERSHIP_REQUIRED). */
function notAttached(error: unknown): boolean {
  return error instanceof OpenLinearApiError && error.status === 404 && error.code === 'P2025';
}

export const labelIssue = defineTool({
  name: 'openlinear_label_issue',
  title: 'Add or remove issue labels',
  description:
    "Add and/or remove labels (including phase labels) on one issue without touching its other labels. Each label is attached or detached on its own (no overwrite race); labels must belong to the issue's project.",
  input: z.strictObject({
    taskId: id('Issue (task)'),
    add: z.array(z.guid()).max(20).optional().describe('Label UUIDs to add'),
    remove: z.array(z.guid()).max(20).optional().describe('Label UUIDs to remove'),
  }),
  output: z.object({
    issue: IssueDetailShape,
    added: z.array(z.string()).describe('Labels attached by this call'),
    removed: z.array(z.string()).describe('Labels detached by this call'),
    changed: z.boolean(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ taskId, add = [], remove = [] }, { api, signal }) {
    if (add.length === 0 && remove.length === 0) throw new ToolInputError('Pass at least one label id in add or remove.');
    const overlap = add.filter((labelId) => remove.includes(labelId));
    if (overlap.length > 0) throw new ToolInputError(`Labels in both add and remove: ${overlap.join(', ')}`);

    // POST/DELETE /api/labels/tasks/:id/labels change one link each, so a
    // concurrent edit of other labels is never overwritten. The API checks
    // that each label belongs to the issue's project. Adds run first: when a
    // label is refused, a "replace phase N with phase M" call has removed
    // nothing yet.
    const added: string[] = [];
    const removed: string[] = [];
    for (const labelId of new Set(add)) {
      try {
        await api.attachLabel(taskId, labelId, signal);
        added.push(labelId);
      } catch (error) {
        if (!alreadyAttached(error)) throw error;
      }
    }
    for (const labelId of new Set(remove)) {
      try {
        await api.detachLabel(taskId, labelId, signal);
        removed.push(labelId);
      } catch (error) {
        if (!notAttached(error)) throw error;
      }
    }
    const task = await api.getTask(taskId, signal);
    return { issue: toIssueDetail(task), added, removed, changed: added.length + removed.length > 0 };
  },
});

export const findSimilarIssues = defineTool({
  name: 'openlinear_find_similar_issues',
  title: 'Find similar issues',
  description:
    'Before creating an issue, find open issues in the project whose title is similar (likely duplicates), best match first. Read-only.',
  input: z.strictObject({
    projectId: id('Project'),
    title: z.string().trim().min(4).max(500).describe('The title you are about to create'),
    limit: z.number().int().min(1).max(10).default(5).describe('Most matches to return'),
  }),
  output: z.object({
    matches: z.array(IssueRefShape.extend({ score: z.number().describe('Title similarity 0-1') })),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run({ projectId, title, limit }, { api, signal }) {
    const items = await api.similarTasks({ projectId, title, limit }, signal);
    return { matches: items.map((item) => ({ id: item.id, identifier: item.identifier ?? null, title: item.title, status: item.status, score: item.score })) };
  },
});

export const setBlockers = defineTool({
  name: 'openlinear_set_blockers',
  title: 'Add or remove issue blockers',
  description:
    'Mark an issue as blocked by other issues of the same project, or remove such blockers. A blocked issue waits: agent runs of it are refused until every blocker is done, and batches run blockers first. Loops are refused (DEPENDENCY_CYCLE). Each blocker is added or removed on its own; re-adding one is a no-op.',
  input: z.strictObject({
    taskId: id('Issue (task) that waits'),
    add: z.array(z.guid()).max(20).optional().describe('Issue UUIDs that must be done first'),
    remove: z.array(z.guid()).max(20).optional().describe('Issue UUIDs that no longer block it'),
  }),
  output: z.object({
    blockedBy: z.array(DependencyRefShape).describe('Every issue it waits on after this call'),
    added: z.array(z.string()).describe('Blockers added by this call'),
    removed: z.array(z.string()).describe('Blockers removed by this call'),
    changed: z.boolean(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ taskId, add = [], remove = [] }, { api, signal }) {
    if (add.length === 0 && remove.length === 0) throw new ToolInputError('Pass at least one issue id in add or remove.');
    const overlap = add.filter((blockerId) => remove.includes(blockerId));
    if (overlap.length > 0) throw new ToolInputError(`Issues in both add and remove: ${overlap.join(', ')}`);
    if (add.includes(taskId)) throw new ToolInputError('An issue cannot block itself.');

    const before = new Set((await api.getTask(taskId, signal)).blockedBy?.map((ref) => ref.id) ?? []);
    const added: string[] = [];
    for (const blockerId of new Set(add)) {
      const result = await api.addBlocker(taskId, blockerId, signal);
      if (result.created) added.push(blockerId);
    }
    const removed: string[] = [];
    for (const blockerId of new Set(remove)) {
      await api.removeBlocker(taskId, blockerId, signal);
      if (before.has(blockerId)) removed.push(blockerId);
    }
    const task = await api.getTask(taskId, signal);
    return { blockedBy: (task.blockedBy ?? []).map(toDependencyRef), added, removed, changed: added.length + removed.length > 0 };
  },
});

const IssueStatusRef = z.object({ id: z.string(), identifier: z.string().nullable(), title: z.string().nullable() });

const bulkStatusInput = z
  .strictObject({
    projectId: id('Project').optional().describe('Change issues of this project; pass projectId or teamId'),
    teamId: id('Team')
      .optional()
      .describe("Change this team's issues that have no project (created with only a teamId); pass projectId or teamId"),
    taskIds: z.array(z.guid()).min(1).max(100).describe('Issue UUIDs, all in the chosen project or team scope'),
    status: IssueStatus.describe('todo, done and cancelled reset execution state'),
  })
  .refine((value) => Boolean(value.projectId) !== Boolean(value.teamId), {
    message: 'Pass exactly one of projectId or teamId.',
    path: ['projectId'],
  });

export const bulkUpdateStatus = defineTool({
  name: 'openlinear_bulk_update_status',
  title: 'Move issues to a status',
  description:
    'Set the status of up to 100 listed issues in one call (e.g. move a phase to done), scoped to one project or to one team\'s issues without a project. Only the listed taskIds change; issues already in that status are reported as unchanged.',
  input: bulkStatusInput,
  output: z.object({
    status: z.string(),
    updated: z.array(IssueStatusRef),
    unchanged: z.array(IssueStatusRef),
    failed: z
      .array(z.object({ taskId: z.string(), error: z.string() }))
      .describe('Listed issues outside the scope (or not visible); nothing changed for them'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ projectId, teamId, taskIds, status }, { api, signal }) {
    const scope = projectId ? { projectId } : { teamId };
    const result = await api.bulkUpdateStatus({ ...scope, status, taskIds: [...new Set(taskIds)] }, signal);
    return {
      status: result.status,
      updated: result.updated.map((task) => ({ id: task.id, identifier: task.identifier ?? null, title: task.title })),
      unchanged: result.already.map((task) => ({
        id: task.id,
        identifier: task.identifier ?? null,
        title: task.title ?? null,
      })),
      failed: result.failed.map((failure) => ({ taskId: failure.id, error: failure.error })),
    };
  },
});

export const addComment = defineTool({
  name: 'openlinear_add_comment',
  title: 'Add comment',
  description:
    'Add a markdown comment to an issue. @username mentions notify users who can see the issue. Not idempotent: each call adds a comment.',
  input: z.strictObject({
    taskId: id('Issue (task)'),
    body: z.string().min(1).max(10000).describe('Markdown comment text'),
  }),
  output: z.object({ comment: CommentShape.extend({ taskId: z.string() }) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run({ taskId, body }, { api, signal }) {
    const comment = await api.addComment(taskId, body, signal);
    return { comment: { ...toComment(comment), taskId: comment.taskId ?? taskId } };
  },
});
