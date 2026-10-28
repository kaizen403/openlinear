import * as z from 'zod';
import type { OpenLinearClient } from './client';
import { isRecord, OpenLinearApiError, OpenLinearResponseError } from './errors';

/*
 * Response schemas for the endpoints the MCP tools call. They are loose on
 * purpose: unknown fields are kept, optional data may be null or missing,
 * and enum-like fields stay strings so a new API value never breaks a tool.
 * Each one was checked against apps/api/src/routes and services.
 */

const str = z.string();
const optStr = z.string().nullish();
const optNum = z.number().nullish();

export const ApiUserRef = z.looseObject({ id: str, username: optStr });

/** One W11a evidence record (`GET /api/executions/tasks/:id/verifications`). */
export const ApiVerification = z.looseObject({
  commitSha: str,
  status: str,
  policy: str,
  publication: str,
  source: str,
  runner: optStr,
  checks: z.array(z.looseObject({ id: optStr, name: str, status: str, required: z.boolean().nullish(), exitCode: optNum, durationMs: optNum })).nullish(),
  warnings: z.array(z.string()).nullish(),
  detail: optStr,
  finishedAt: optStr,
  createdAt: optStr,
});
export type ApiVerification = z.infer<typeof ApiVerification>;
const VerificationPage = z.looseObject({ items: z.array(ApiVerification) });
export type ApiUserRef = z.infer<typeof ApiUserRef>;

export const ApiLabel = z.looseObject({
  id: str,
  name: str,
  color: optStr,
  priority: optNum,
  projectId: optStr,
});
export type ApiLabel = z.infer<typeof ApiLabel>;

/** `{ id, identifier, title, status }`: `parent` / `subtasks` of `GET /api/tasks/:id`. */
export const ApiTaskRef = z.looseObject({ id: str, identifier: optStr, title: str, status: str });
export type ApiTaskRef = z.infer<typeof ApiTaskRef>;

/** W17a: `blockedBy` / `blocking` of `GET /api/tasks/:id` (`resolved` = done). */
export const ApiDependencyRef = ApiTaskRef.extend({ resolved: z.boolean().nullish() });
export type ApiDependencyRef = z.infer<typeof ApiDependencyRef>;

export const ApiTask = z.looseObject({
  id: str,
  title: str,
  description: optStr,
  status: str,
  priority: str,
  identifier: optStr,
  projectId: optStr,
  teamId: optStr,
  parentId: optStr,
  assigneeId: optStr,
  creatorId: optStr,
  dueDate: optStr,
  prUrl: optStr,
  outcome: optStr,
  model: optStr,
  agent: optStr,
  archived: z.boolean().nullish(),
  createdAt: str,
  updatedAt: str,
  labels: z.array(ApiLabel).nullish(),
  team: z.looseObject({ id: str, name: optStr, key: optStr }).nullish(),
  project: z.looseObject({ id: str, name: optStr }).nullish(),
  assignee: ApiUserRef.nullish(),
  creator: ApiUserRef.nullish(),
  /** Only on `GET /api/tasks/:id`: the visible parent and up to 100 non-archived sub-issues. */
  parent: ApiTaskRef.nullish(),
  subtasks: z.array(ApiTaskRef).nullish(),
  /** W17a, only on `GET /api/tasks/:id`: what this issue waits on and what waits on it. */
  blockedBy: z.array(ApiDependencyRef).nullish(),
  blocking: z.array(ApiDependencyRef).nullish(),
  /** W17b, only on `GET /api/tasks/:id`: the plan this issue came from. */
  plan: z.looseObject({ id: str, key: str, title: str, status: str }).nullish(),
});
export type ApiTask = z.infer<typeof ApiTask>;

/** W17b: a plan task in a revision spec. */
const ApiPlanTaskSpec = z.looseObject({
  key: str,
  title: str,
  description: optStr,
  priority: optStr,
  acceptance: z.array(str).nullish(),
  estimate: optStr,
  risk: optStr,
  blockedBy: z.array(str).nullish(),
});
const ApiPlanIssue = z.looseObject({ code: str, message: str, keys: z.array(str) });

/** W17b: `GET /api/plans/:id` (and the create/revise/approve responses' `plan`). */
export const ApiPlan = z.looseObject({
  id: str,
  projectId: str,
  title: str,
  status: str,
  latestRevision: z.number(),
  approvedRevision: z.number().nullable(),
  revision: z.looseObject({
    number: z.number(),
    spec: z.looseObject({ summary: optStr, tasks: z.array(ApiPlanTaskSpec) }),
    order: z.array(str),
    errors: z.array(ApiPlanIssue),
    warnings: z.array(ApiPlanIssue),
    approvedAt: optStr,
    diff: z.looseObject({ added: z.array(str), removed: z.array(str), changed: z.array(z.looseObject({ key: str, fields: z.array(str) })) }).nullable(),
  }),
  tasks: z.array(z.looseObject({ key: str, id: str, identifier: optStr, title: str, status: str })),
});
export type ApiPlan = z.infer<typeof ApiPlan>;

const ApiPlanApproval = z.looseObject({
  approval: z.looseObject({
    alreadyApproved: z.boolean(),
    created: z.array(z.looseObject({ key: str, taskId: str, identifier: optStr })),
    updated: z.array(z.looseObject({ key: str, taskId: str, fields: z.array(str) })),
    removed: z.array(z.looseObject({ key: str, taskId: str })),
    skipped: z.array(z.looseObject({ key: str, reason: str })),
    dependencies: z.looseObject({ added: z.number(), removed: z.number() }),
  }),
  plan: ApiPlan,
});
export type ApiPlanApproval = z.infer<typeof ApiPlanApproval>;

/** W20 recurring issue (`GET /api/projects/:id/schedules` items, `POST` result). */
export const ApiSchedule = z.looseObject({
  id: str,
  projectId: str,
  title: str,
  description: optStr,
  priority: str,
  labelIds: z.array(str),
  assigneeId: optStr,
  cadence: str,
  weekday: z.number().nullable(),
  dayOfMonth: z.number().nullable(),
  hour: z.number(),
  minute: z.number(),
  timezone: str,
  cadenceText: str,
  nextRunAt: str,
  lastRunAt: optStr,
  pausedAt: optStr,
  pauseReason: optStr,
});
export type ApiSchedule = z.infer<typeof ApiSchedule>;

/** W19b project knowledge entry (services/knowledge.ts view). */
export const ApiKnowledgeEntry = z.looseObject({
  id: str,
  projectId: str,
  kind: str,
  title: str,
  body: str,
  status: str,
  source: str,
  version: z.number().int(),
  expired: z.boolean().optional(),
  updatedAt: str,
});
export type ApiKnowledgeEntry = z.infer<typeof ApiKnowledgeEntry>;

const num = z.number();
const nullNum = z.number().nullable();
const ApiInsightsPercentiles = z.looseObject({ medianMs: nullNum, p90Ms: nullNum, samples: num });
const ApiInsightsRunGroup = z.looseObject({
  key: str, runs: num, succeeded: num, failed: num, cancelled: num, recoveryRequired: num, inProgress: num,
  successRate: nullNum, medianMs: nullNum, p90Ms: nullNum, costUsd: nullNum, unknownCostRuns: num,
});

/** W15b insights document (apps/api services/insights.ts `InsightsDocument`). */
export const ApiInsights = z.looseObject({
  scope: z.looseObject({ kind: str, id: str, projects: num }),
  range: z.looseObject({ key: str, days: num, since: str, until: str }),
  runs: z.looseObject({
    total: num,
    outcomes: z.looseObject({ succeeded: num, failed: num, cancelled: num, recoveryRequired: num, inProgress: num }),
    finished: num,
    successRate: nullNum,
    verification: z.looseObject({ passed: num, failed: num, skipped: num, unverified: num, passRate: nullNum }),
    publication: z.looseObject({ published: num, rate: nullNum }),
    duration: ApiInsightsPercentiles,
    cost: z.looseObject({ knownUsd: num, runsWithCost: num, unknownCostRuns: num, coverage: str }),
    tokens: z.looseObject({ input: num, output: num, cachedInput: num, cacheWrite: num, reasoning: num, runsWithTokens: num }),
    byRunner: z.array(ApiInsightsRunGroup),
    byModel: z.array(ApiInsightsRunGroup),
    daily: z.array(z.looseObject({ date: str, runs: num, succeeded: num, failed: num, cancelled: num, recoveryRequired: num, costUsd: nullNum, unknownCostRuns: num })),
  }),
  delivery: z.looseObject({
    created: num,
    completed: num,
    completedUntracked: num,
    cycleTime: ApiInsightsPercentiles,
    openNow: num,
    blockedNow: num,
    plans: z.looseObject({ approvals: num, plansApproved: num, awaitingReview: num }),
    daily: z.array(z.looseObject({ date: str, created: num, completed: num })),
  }),
  notes: z.record(z.string(), z.string()),
});
export type ApiInsights = z.infer<typeof ApiInsights>;

export interface CreateScheduleBody {
  title: string;
  description?: string;
  priority?: string;
  labelIds?: string[];
  assigneeId?: string;
  cadence: string;
  weekday?: number;
  dayOfMonth?: number;
  hour: number;
  minute: number;
  timezone: string;
}

export interface PlanSpecBody {
  summary?: string;
  tasks: Array<{ key: string; title: string; description?: string; priority?: string; acceptance?: string[]; estimate?: string; risk?: string; blockedBy?: string[] }>;
}

const ApiDependencies = z.looseObject({ created: z.boolean().nullish(), blockedBy: z.array(ApiDependencyRef), blocking: z.array(ApiDependencyRef) });

export const ApiTeamMember = z.looseObject({
  userId: optStr,
  role: optStr,
  user: z.looseObject({ id: str, username: optStr }).nullish(),
});

export const ApiTeam = z.looseObject({
  id: str,
  name: str,
  key: str,
  description: optStr,
  color: optStr,
  private: z.boolean().nullish(),
  projectId: optStr,
  project: z.looseObject({ id: str, name: optStr }).nullish(),
  members: z.array(ApiTeamMember).nullish(),
  _count: z.looseObject({ members: optNum, tasks: optNum }).nullish(),
});
export type ApiTeam = z.infer<typeof ApiTeam>;

export const ApiProject = z.looseObject({
  id: str,
  name: str,
  key: optStr,
  description: optStr,
  status: optStr,
  workspaceId: optStr,
  createdAt: optStr,
  updatedAt: optStr,
  teams: z.array(z.looseObject({ id: str, name: optStr, key: optStr })).nullish(),
  repository: z
    .looseObject({ id: str, name: optStr, fullName: optStr, defaultBranch: optStr })
    .nullish(),
  workspace: z.looseObject({ id: str, name: optStr, slug: optStr }).nullish(),
  _count: z.looseObject({ tasks: optNum }).nullish(),
});
export type ApiProject = z.infer<typeof ApiProject>;

export const ApiWorkspace = z.looseObject({
  id: str,
  name: str,
  slug: optStr,
  plan: optStr,
  role: optStr,
  _count: z.looseObject({ members: optNum, projects: optNum }).nullish(),
});
export type ApiWorkspace = z.infer<typeof ApiWorkspace>;

export const ApiComment = z.looseObject({
  id: str,
  taskId: optStr,
  body: str,
  createdAt: str,
  updatedAt: optStr,
  user: ApiUserRef.nullish(),
});
export type ApiComment = z.infer<typeof ApiComment>;

export const ApiMe = z.looseObject({ id: str, username: optStr });

/**
 * `GET /api/tasks` in keyset mode (`pagination=cursor` / `cursor=`):
 * `{ items, pageSize, hasMore, nextCursor }`, plus `total` with
 * `includeTotal=true`. Offset mode answers the same fields plus `page` and an
 * exact `total`.
 */
const TaskPage = z.looseObject({
  items: z.array(ApiTask),
  pageSize: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullish(),
  total: z.number().optional(),
});
export type ApiTaskPage = z.infer<typeof TaskPage>;

const CommentPage = z.looseObject({
  comments: z.array(ApiComment),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ApiCommentPage = z.infer<typeof CommentPage>;

const BulkCreateResult = z.looseObject({
  created: z.array(ApiTask),
  failed: z.array(z.looseObject({ index: z.number(), error: str })),
});

const BulkStatusResult = z.looseObject({
  updated: z.array(ApiTask),
  already: z.array(z.looseObject({ id: str, identifier: optStr, title: optStr })),
  failed: z.array(z.looseObject({ id: str, error: str })),
  status: str,
});

const SearchResult = z.looseObject({
  tasks: z.array(
    z.looseObject({
      id: str,
      title: str,
      identifier: optStr,
      status: optStr,
      priority: optStr,
      projectId: optStr,
      teamId: optStr,
    }),
  ),
  projects: z.array(z.looseObject({ id: str, name: str, key: optStr, status: optStr, workspaceId: optStr })),
  teams: z.array(z.looseObject({ id: str, name: str, key: optStr, projectId: optStr })),
});
export type ApiSearchResult = z.infer<typeof SearchResult>;

export interface Replayable<T> {
  value: T;
  replayed: boolean;
}

function parse<T>(schema: z.ZodType<T>, body: unknown, method: string, path: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    throw new OpenLinearResponseError(method, path, `${first?.message ?? 'invalid shape'}${where}`);
  }
  return result.data;
}

export interface CreateTaskBody {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  projectId?: string;
  teamId?: string;
  labelIds?: string[];
  dueDate?: string | null;
  model?: string | null;
  /** FE-02: agent runner (`opencode` | `claude-code` | `codex`); the API refuses anything else. */
  agent?: string | null;
  /** Team members; the first becomes the primary assignee (`assigneeId`). */
  assigneeIds?: string[];
}

export interface BulkTaskBody {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  labelIds?: string[];
}

/**
 * `GET /api/tasks` filters (apps/api/src/schemas/tasks.ts). Every filter is
 * ANDed, except `assignee` + `creator`, which the API ORs. The MCP always
 * asks for keyset pages (`pagination=cursor`) and compact rows
 * (`view=compact`, no `executionLogs`).
 */
export interface ListTasksQuery {
  projectId?: string;
  teamId?: string;
  /** `me`, `none` or a user id. */
  assignee?: string;
  /** `me` or a user id. */
  creator?: string;
  status?: readonly string[];
  /** Any of these labels. */
  labelIds?: readonly string[];
  /** Case-insensitive literal substring of title, description or identifier. */
  q?: string;
  /**
   * Exact identifier such as `ENG-12`, case-insensitive (never `ENG-120`).
   * An API from before this filter ignores it, so callers re-check the match.
   */
  identifier?: string;
  /** A parent task id, or `none` for top-level issues. */
  parentId?: string;
  cursor?: string;
  includeTotal?: boolean;
  pageSize: number;
}

export interface BulkScope {
  /** Issues of this project. */
  projectId?: string;
  /** This team's issues without a project. */
  teamId?: string;
}

/** Typed wrappers for the OpenLinear REST endpoints (see apps/api/src/registry.ts). */
export class OpenLinearApi {
  constructor(private readonly client: OpenLinearClient) {}

  async me(signal?: AbortSignal) {
    const path = '/api/users/me';
    const { body } = await this.client.call('GET', path, { signal });
    return parse(ApiMe, body, 'GET', path);
  }

  async listWorkspaces(signal?: AbortSignal): Promise<ApiWorkspace[]> {
    const path = '/api/workspaces';
    const { body } = await this.client.call('GET', path, { signal });
    return parse(z.array(ApiWorkspace), body, 'GET', path);
  }

  async listProjects(query: { workspaceId?: string; teamId?: string }, signal?: AbortSignal): Promise<ApiProject[]> {
    const path = '/api/projects';
    const { body } = await this.client.call('GET', path, { query, signal });
    return parse(z.array(ApiProject), body, 'GET', path);
  }

  async getProject(projectId: string, signal?: AbortSignal): Promise<ApiProject> {
    const path = `/api/projects/${encodeURIComponent(projectId)}`;
    const { body } = await this.client.call('GET', path, { signal });
    return parse(ApiProject, body, 'GET', '/api/projects/:id');
  }

  /** Transactional `Idempotency-Key` (W04b, 24 h): safe to retry with the same key. */
  async createProject(
    payload: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Replayable<ApiProject>> {
    const path = '/api/projects';
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(ApiProject, result.body, 'POST', path), replayed: result.replayed };
  }

  async listTeams(query: { projectId?: string; workspaceId?: string }, signal?: AbortSignal): Promise<ApiTeam[]> {
    const path = '/api/teams';
    const { body } = await this.client.call('GET', path, { query, signal });
    return parse(z.array(ApiTeam), body, 'GET', path);
  }

  /** Transactional `Idempotency-Key` (W04b, 24 h): safe to retry with the same key. */
  async createTeam(
    payload: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Replayable<ApiTeam>> {
    const path = '/api/teams';
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(ApiTeam, result.body, 'POST', path), replayed: result.replayed };
  }

  async listLabels(projectId: string, signal?: AbortSignal): Promise<ApiLabel[]> {
    const path = '/api/labels';
    const { body } = await this.client.call('GET', path, { query: { projectId }, signal });
    return parse(z.array(ApiLabel), body, 'GET', path);
  }

  async createLabel(
    payload: { projectId: string; name: string; color: string; priority?: number },
    signal?: AbortSignal,
  ): Promise<ApiLabel> {
    const path = '/api/labels';
    const { body } = await this.client.call('POST', path, { body: payload, signal });
    return parse(ApiLabel, body, 'POST', path);
  }

  /** One keyset page of compact issue rows; follow `nextCursor` with the same filters. */
  async listTasks(query: ListTasksQuery, signal?: AbortSignal): Promise<ApiTaskPage> {
    const path = '/api/tasks';
    const { body } = await this.client.call('GET', path, {
      query: {
        projectId: query.projectId,
        teamId: query.teamId,
        assignee: query.assignee,
        creator: query.creator,
        // The API accepts repeated or comma-separated values; ids and statuses contain no commas.
        status: query.status?.length ? query.status.join(',') : undefined,
        labelId: query.labelIds?.length ? query.labelIds.join(',') : undefined,
        q: query.q,
        identifier: query.identifier,
        parentId: query.parentId,
        pagination: 'cursor',
        cursor: query.cursor,
        includeTotal: query.includeTotal ? 'true' : undefined,
        view: 'compact',
        pageSize: query.pageSize,
      },
      signal,
    });
    // An API from before the W14 contract ignores pagination=cursor and every
    // new filter, answering an unfiltered offset page (with `page`). Refuse it
    // rather than return wrong issues.
    if (isRecord(body) && 'page' in body) {
      throw new OpenLinearResponseError('GET', path, 'offset page instead of a keyset page; the API predates server-side filters');
    }
    return parse(TaskPage, body, 'GET', path);
  }

  /**
   * W11a: the task's newest verification evidence, or null when there is none
   * — or when the API predates the route (404 NOT_FOUND), so an older API
   * never breaks get_issue.
   */
  async latestVerification(taskId: string, signal?: AbortSignal): Promise<ApiVerification | null> {
    const path = `/api/executions/tasks/${encodeURIComponent(taskId)}/verifications`;
    let body: unknown;
    try {
      ({ body } = await this.client.call('GET', path, { signal }));
    } catch (error) {
      if (error instanceof OpenLinearApiError && error.status === 404 && error.code === 'NOT_FOUND') return null;
      throw error;
    }
    const page = parse(VerificationPage, body, 'GET', '/api/executions/tasks/:id/verifications');
    return page.items[0] ?? null;
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<ApiTask> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}`;
    const { body } = await this.client.call('GET', path, { signal });
    return parse(ApiTask, body, 'GET', '/api/tasks/:id');
  }

  /** Transactional `Idempotency-Key` (W04a): safe to retry with the same key. */
  async createTask(payload: CreateTaskBody, idempotencyKey: string, signal?: AbortSignal): Promise<Replayable<ApiTask>> {
    const path = '/api/tasks';
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(ApiTask, result.body, 'POST', path), replayed: result.replayed };
  }

  /** Transactional `Idempotency-Key` (W04a): safe to retry with the same key. */
  async bulkCreateTasks(
    payload: { projectId: string; tasks: BulkTaskBody[] },
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    const path = '/api/tasks/bulk';
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(BulkCreateResult, result.body, 'POST', path), replayed: result.replayed };
  }

  async updateTask(taskId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<ApiTask> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}`;
    const { body } = await this.client.call('PATCH', path, { body: payload, signal });
    return parse(ApiTask, body, 'PATCH', '/api/tasks/:id');
  }

  /**
   * Exactly one of `projectId` / `teamId` (400 `BULK_SCOPE_INVALID`) and 1–100
   * `taskIds` (400 `TASK_IDS_REQUIRED`; older APIs changed every issue of the
   * project when it was omitted, so an empty list is never sent).
   */
  async bulkUpdateStatus(payload: BulkScope & { status: string; taskIds: string[] }, signal?: AbortSignal) {
    if (payload.taskIds.length === 0) throw new Error('bulkUpdateStatus requires at least one task id');
    const path = '/api/tasks/bulk-status';
    const { body } = await this.client.call('PATCH', path, { body: payload, signal });
    return parse(BulkStatusResult, body, 'PATCH', path);
  }

  /**
   * Attach one label (`POST /api/labels/tasks/:id/labels`). The API checks that
   * the label belongs to the task's project (400 `LABEL_NOT_IN_TASK_PROJECT`);
   * an already attached label answers 409 `P2002`.
   */
  async attachLabel(taskId: string, labelId: string, signal?: AbortSignal): Promise<void> {
    const path = `/api/labels/tasks/${encodeURIComponent(taskId)}/labels`;
    await this.client.call('POST', path, { body: { labelId }, signal });
  }

  /**
   * W17a: `taskId` is blocked by `dependsOnTaskId` (idempotent: `created`
   * false when it already was). Same project only (400 DEPENDENCY_SCOPE);
   * a loop answers 409 DEPENDENCY_CYCLE.
   */
  async addBlocker(taskId: string, dependsOnTaskId: string, signal?: AbortSignal): Promise<{ created: boolean; blockedBy: ApiDependencyRef[] }> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/dependencies`;
    const { body } = await this.client.call('POST', path, { body: { dependsOnTaskId }, signal });
    const parsed = parse(ApiDependencies, body, 'POST', '/api/tasks/:id/dependencies');
    return { created: parsed.created === true, blockedBy: parsed.blockedBy };
  }

  /** W17b: a draft plan (nothing is created until it is approved). Keyed, retry-safe. */
  async createPlan(projectId: string, payload: { title: string; spec: PlanSpecBody; note?: string }, idempotencyKey: string, signal?: AbortSignal): Promise<Replayable<ApiPlan>> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/plans`;
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(ApiPlan, result.body, 'POST', '/api/projects/:id/plans'), replayed: result.replayed };
  }

  /** W17b: a project's plans, newest activity first (≤ 100). */
  async listPlans(projectId: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string; status: string; latestRevision: number; approvedRevision: number | null; taskCount: number; createdTaskCount: number; doneTaskCount: number; updatedAt: string }>> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/plans`;
    const { body } = await this.client.call('GET', path, { signal });
    const parsed = parse(z.looseObject({ items: z.array(z.looseObject({
      id: str, title: str, status: str, latestRevision: z.number(), approvedRevision: z.number().nullable(),
      taskCount: z.number(), createdTaskCount: z.number(), doneTaskCount: z.number(), updatedAt: str,
    })) }), body, 'GET', '/api/projects/:id/plans');
    return parsed.items;
  }

  async getPlan(planId: string, revision: number | undefined, signal?: AbortSignal): Promise<ApiPlan> {
    const path = `/api/plans/${encodeURIComponent(planId)}`;
    const { body } = await this.client.call('GET', path, { query: revision ? { revision: String(revision) } : {}, signal });
    return parse(ApiPlan, body, 'GET', '/api/plans/:id');
  }

  /** A new revision based on the latest (409 PLAN_REVISION_CONFLICT otherwise); identical specs add none. */
  async revisePlan(planId: string, payload: { baseRevision: number; spec: PlanSpecBody; title?: string; note?: string }, signal?: AbortSignal): Promise<{ unchanged: boolean; plan: ApiPlan }> {
    const path = `/api/plans/${encodeURIComponent(planId)}/revisions`;
    const { body } = await this.client.call('POST', path, { body: payload, signal });
    return parse(z.looseObject({ unchanged: z.boolean(), plan: ApiPlan }), body, 'POST', '/api/plans/:id/revisions');
  }

  /** Approve the latest revision: creates/updates its tasks and dependencies (idempotent per revision). */
  async approvePlan(planId: string, revision: number, signal?: AbortSignal): Promise<ApiPlanApproval> {
    const path = `/api/plans/${encodeURIComponent(planId)}/approve`;
    const { body } = await this.client.call('POST', path, { body: { revision }, retry: 'safe', signal });
    return parse(ApiPlanApproval, body, 'POST', '/api/plans/:id/approve');
  }

  /** W20: a project's recurring issues (≤ 50, oldest first). */
  async listSchedules(projectId: string, signal?: AbortSignal): Promise<ApiSchedule[]> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/schedules`;
    const { body } = await this.client.call('GET', path, { signal });
    return parse(z.looseObject({ items: z.array(ApiSchedule) }), body, 'GET', '/api/projects/:id/schedules').items;
  }

  /** W20: a recurring issue (creates issues on its cadence; never runs them). Keyed, retry-safe. */
  async createSchedule(projectId: string, payload: CreateScheduleBody, idempotencyKey: string, signal?: AbortSignal): Promise<Replayable<ApiSchedule>> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/schedules`;
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(ApiSchedule, result.body, 'POST', '/api/projects/:id/schedules'), replayed: result.replayed };
  }

  /** W19b: a project's knowledge entries (newest activity first). */
  async listKnowledge(projectId: string, signal?: AbortSignal): Promise<ApiKnowledgeEntry[]> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/knowledge`;
    const { body } = await this.client.call('GET', path, { signal });
    return parse(z.looseObject({ entries: z.array(ApiKnowledgeEntry) }), body, 'GET', '/api/projects/:id/knowledge').entries;
  }

  /** W19b: a knowledge proposal (a PAT can only propose; a person approves). Keyed, retry-safe. */
  async proposeKnowledge(projectId: string, payload: { kind: 'convention' | 'procedure' | 'note'; title: string; body: string }, idempotencyKey: string, signal?: AbortSignal): Promise<Replayable<ApiKnowledgeEntry>> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/knowledge`;
    const result = await this.client.call('POST', path, { body: payload, idempotencyKey, retry: 'safe', signal });
    return { value: parse(ApiKnowledgeEntry, result.body, 'POST', '/api/projects/:id/knowledge'), replayed: result.replayed };
  }

  /** W15b: insights for one project or one workspace over 7 / 30 / 90 days (read-only). */
  async getInsights(scope: { projectId: string } | { workspaceId: string }, range: '7d' | '30d' | '90d', signal?: AbortSignal): Promise<ApiInsights> {
    const [path, route] = 'projectId' in scope
      ? [`/api/projects/${encodeURIComponent(scope.projectId)}/insights`, '/api/projects/:id/insights']
      : [`/api/workspaces/${encodeURIComponent(scope.workspaceId)}/insights`, '/api/workspaces/:id/insights'];
    const { body } = await this.client.call('GET', path, { query: { range }, signal });
    return parse(ApiInsights, body, 'GET', route);
  }

  /** FE-11: open issues in a project with a similar title (pg_trgm), best first. */
  async similarTasks(query: { projectId: string; title: string; limit: number }, signal?: AbortSignal): Promise<Array<{ id: string; identifier?: string | null; title: string; status: string; score: number }>> {
    const path = '/api/tasks/similar';
    const { body } = await this.client.call('GET', path, { query: { projectId: query.projectId, title: query.title, limit: query.limit }, signal });
    const parsed = parse(z.looseObject({ items: z.array(z.looseObject({ id: str, identifier: optStr, title: str, status: str, score: z.number() })) }), body, 'GET', path);
    return parsed.items;
  }

  /** W17a: remove the edge (idempotent, 204 either way). */
  async removeBlocker(taskId: string, dependsOnTaskId: string, signal?: AbortSignal): Promise<void> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/dependencies/${encodeURIComponent(dependsOnTaskId)}`;
    await this.client.call('DELETE', path, { signal });
  }

  /** Detach one label; a label that is not attached answers 404 `P2025`. */
  async detachLabel(taskId: string, labelId: string, signal?: AbortSignal): Promise<void> {
    const path = `/api/labels/tasks/${encodeURIComponent(taskId)}/labels/${encodeURIComponent(labelId)}`;
    await this.client.call('DELETE', path, { signal });
  }

  async listComments(
    taskId: string,
    query: { page: number; pageSize: number },
    signal?: AbortSignal,
  ): Promise<ApiCommentPage> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/comments`;
    const { body } = await this.client.call('GET', path, { query, signal });
    return parse(CommentPage, body, 'GET', '/api/tasks/:taskId/comments');
  }

  async addComment(taskId: string, text: string, signal?: AbortSignal): Promise<ApiComment> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/comments`;
    const { body } = await this.client.call('POST', path, { body: { body: text }, signal });
    return parse(ApiComment, body, 'POST', '/api/tasks/:taskId/comments');
  }

  async search(
    query: { q: string; types: Array<'tasks' | 'projects' | 'teams'>; limit: number },
    signal?: AbortSignal,
  ): Promise<ApiSearchResult> {
    const path = '/api/search';
    const { body } = await this.client.call('GET', path, {
      query: { q: query.q, types: query.types.join(','), limit: query.limit },
      signal,
    });
    return parse(SearchResult, body, 'GET', path);
  }

  /** Usage telemetry (`POST /api/mcp/log`); needs a write-capable token. */
  async logToolCall(entry: { toolName: string; success: boolean; error?: string }): Promise<void> {
    await this.client.call('POST', '/api/mcp/log', { body: entry });
  }
}
