import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * In-memory stand-in for the OpenLinear REST API (apps/api), served on
 * 127.0.0.1 with an ephemeral port. It mirrors the behaviour the MCP worker
 * depends on, checked against apps/api/src:
 * - the error envelope (lib/http.ts buildErrorEnvelope) and VALIDATION_ERROR
 *   details (zod flatten);
 * - PAT scope rules (packages/api-core/src/scopes.ts) with the W02b
 *   per-route family scopes of registry.ts (`account:read` for
 *   /api/users/me, `tasks:*`, `projects:*`, `labels:write`, …), the
 *   INSUFFICIENT_SCOPE `details.requiredScopes`, and W02a workspace binding
 *   (bound PATs refused on account-level writes such as /api/mcp/log);
 * - W04a/W04b transactional Idempotency-Key on task, bulk task, project and
 *   team creation (replay, 409 conflict, per-credential scope, 24 h);
 * - GET /api/tasks (schemas/tasks.ts + services/tasks.ts): status / labelId
 *   lists (repeated or comma-separated), q (literal, case-insensitive),
 *   identifier (exact, case-insensitive), parentId incl. `none`, assignee `none`, assignee+creator OR, view=compact,
 *   offset and keyset pagination (createdAt DESC, id DESC; opaque base64url
 *   cursor; INVALID_CURSOR, PAGINATION_CONFLICT; includeTotal);
 * - GET /api/tasks/:id with `parent` and `subtasks`;
 * - task label attach/detach (LABEL_NOT_IN_TASK_PROJECT, P2002, P2025);
 * - bulk-status scopes (exactly one of projectId | teamId, BULK_SCOPE_INVALID,
 *   TASK_IDS_REQUIRED, team scope = the team's project-less issues);
 * - POST /api/tasks `assigneeIds` and team-only (project-less) issues;
 * - POST /api/projects `teamIds` team moves with TEAM_PROJECT_CONFLICT
 *   `details.teams[].reason`;
 * - label-name uniqueness and the W14 search hit fields.
 */

type Json = Record<string, unknown>;

export interface FakeUser {
  id: string;
  username: string;
}

export interface FakePat {
  token: string;
  userId: string;
  scopes: string[];
  workspaceId: string | null;
  revoked: boolean;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  members: Map<string, string>;
  createdAt: string;
}

interface Project {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface Team {
  id: string;
  projectId: string;
  name: string;
  key: string;
  description: string | null;
  color: string;
  private: boolean;
  nextIssueNumber: number;
  members: Map<string, string>;
  createdAt: string;
}

interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
  priority: number;
}

interface FakePlanTask {
  key: string;
  title: string;
  description?: string;
  priority?: string;
  acceptance?: string[];
  estimate?: string;
  risk?: string;
  blockedBy?: string[];
}

export interface FakePlan {
  id: string;
  projectId: string;
  title: string;
  status: 'draft' | 'approved' | 'archived';
  revisions: Array<{ number: number; spec: { summary?: string; tasks: FakePlanTask[] }; approvedAt: string | null }>;
  approvedRevision: number | null;
  links: Map<string, string>;
}

/** W20 recurring issue (services/schedules.ts, simplified: no slot math, `nextRunAt` is fixed). */
export interface FakeSchedule {
  id: string;
  projectId: string;
  body: Record<string, unknown>;
  ownerId: string;
}

export interface FakeTask {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  projectId: string | null;
  teamId: string | null;
  parentId: string | null;
  assigneeId: string | null;
  /** `TaskAssignee` rows (role assignee); not part of the API's task payload. */
  assigneeIds: string[];
  creatorId: string | null;
  number: number | null;
  identifier: string | null;
  dueDate: string | null;
  model: string | null;
  agent: string | null;
  labelIds: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Comment {
  id: string;
  taskId: string;
  userId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

export interface InjectedFailure {
  method: string;
  path: RegExp;
  status: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** How many matching requests fail (default 1). */
  times?: number;
  /** Abort the socket instead of answering (network failure). */
  dropConnection?: boolean;
  /** Let this many matching requests through before failing. */
  after?: number;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function envelope(code: string, message: string, details?: unknown): Json {
  return {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    requestId: randomUUID(),
  };
}

function validation(fieldErrors: Record<string, string[]>, message = 'Validation failed'): HttpFailure {
  return new HttpFailure(400, 'VALIDATION_ERROR', message, { formErrors: [], fieldErrors });
}

/** packages/api-core/src/scopes.ts `hasRequiredScopes`. */
function hasRequiredScopes(scopes: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0 || scopes.includes('*') || scopes.includes('admin')) return true;
  const writeImpliesRead = scopes.some((s) => s === 'write' || s.endsWith(':write'));
  return required.every((need) => {
    if (scopes.includes(need)) return true;
    if (scopes.includes('write') && need !== 'admin') return true;
    if (need === 'read') return writeImpliesRead || scopes.some((s) => s.endsWith(':read'));
    if (need === 'write') return scopes.some((s) => s === 'write' || s.endsWith(':write'));
    if (need.endsWith(':read')) {
      const resource = need.slice(0, -':read'.length);
      return scopes.includes('read') || scopes.includes(`${resource}:write`);
    }
    return false;
  });
}

/** apps/api/src/registry.ts rows for the routes the worker calls (PAT scopes, binding stance). */
const ROUTE_RULES: ReadonlyArray<{ method: string; path: RegExp; scopes: string[]; boundRefused?: boolean }> = [
  { method: 'GET', path: /^\/api\/users\/me$/, scopes: ['account:read'] },
  { method: 'POST', path: /^\/api\/mcp\/log$/, scopes: ['write'], boundRefused: true },
  { method: 'GET', path: /^\/api\/workspaces$/, scopes: ['workspaces:read'] },
  { method: 'GET', path: /^\/api\/projects$/, scopes: ['projects:read'] },
  { method: 'POST', path: /^\/api\/projects$/, scopes: ['projects:write'] },
  { method: 'GET', path: /^\/api\/projects\/[^/]+$/, scopes: ['projects:read'] },
  { method: 'GET', path: /^\/api\/teams$/, scopes: ['projects:read'] },
  { method: 'POST', path: /^\/api\/teams$/, scopes: ['projects:write'] },
  { method: 'GET', path: /^\/api\/labels$/, scopes: ['projects:read'] },
  { method: 'POST', path: /^\/api\/labels$/, scopes: ['labels:write'] },
  { method: 'POST', path: /^\/api\/labels\/tasks\/[^/]+\/labels$/, scopes: ['tasks:write'] },
  { method: 'DELETE', path: /^\/api\/labels\/tasks\/[^/]+\/labels\/[^/]+$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/tasks$/, scopes: ['tasks:read'] },
  { method: 'GET', path: /^\/api\/tasks\/similar$/, scopes: ['tasks:read'] },
  { method: 'POST', path: /^\/api\/tasks$/, scopes: ['tasks:write'] },
  { method: 'POST', path: /^\/api\/tasks\/bulk$/, scopes: ['tasks:write'] },
  { method: 'PATCH', path: /^\/api\/tasks\/bulk-status$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/tasks\/[^/]+\/comments$/, scopes: ['tasks:read'] },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/comments$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/tasks\/[^/]+$/, scopes: ['tasks:read'] },
  { method: 'PATCH', path: /^\/api\/tasks\/[^/]+$/, scopes: ['tasks:write'] },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/dependencies$/, scopes: ['tasks:write'] },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/plans$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/projects\/[^/]+\/plans$/, scopes: ['tasks:read'] },
  { method: 'GET', path: /^\/api\/plans\/[^/]+$/, scopes: ['tasks:read'] },
  { method: 'POST', path: /^\/api\/plans\/[^/]+\/(?:revisions|approve)$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/projects\/[^/]+\/schedules$/, scopes: ['tasks:read'] },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/schedules$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/projects\/[^/]+\/knowledge$/, scopes: ['tasks:read'] },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/knowledge$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/(?:projects|workspaces)\/[^/]+\/insights$/, scopes: ['tasks:read'] },
  { method: 'DELETE', path: /^\/api\/tasks\/[^/]+\/dependencies\/[^/]+$/, scopes: ['tasks:write'] },
  { method: 'GET', path: /^\/api\/search$/, scopes: ['tasks:read', 'projects:read'] },
];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:~+/=-]{8,128}$/;
const STATUSES = ['todo', 'in_progress', 'done', 'cancelled'];
const SUBTASK_LIMIT = 100;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Json {
  return isJson(value) ? value : {};
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

/** schemas/tasks.ts `listParam`: repeated or comma-separated, trimmed, de-duplicated. */
function listParam(query: URLSearchParams, name: string): string[] | undefined {
  const items = query
    .getAll(name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return items.length > 0 ? [...new Set(items)] : undefined;
}

/** lib/keyset.ts: base64url JSON `{ v: 1, c: createdAt, i: id }`. */
function encodeCursor(task: FakeTask): string {
  return Buffer.from(JSON.stringify({ v: 1, c: task.createdAt, i: task.id }), 'utf8').toString('base64url');
}

function decodeCursor(token: string): { createdAt: string; id: string } {
  const invalid = new HttpFailure(400, 'INVALID_CURSOR', 'cursor is not a valid pagination token; restart from the first page');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  if (!isJson(parsed) || parsed.v !== 1 || typeof parsed.c !== 'string' || typeof parsed.i !== 'string') throw invalid;
  if (!/^[0-9a-fA-F-]{1,64}$/.test(parsed.i) || Number.isNaN(Date.parse(parsed.c))) throw invalid;
  return { createdAt: new Date(parsed.c).toISOString(), id: parsed.i };
}

/** `createdAt DESC, id DESC` (TASK_LIST_ORDER). */
function listOrder(a: FakeTask, b: FakeTask): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export class FakeOpenLinearApi {
  readonly users = new Map<string, FakeUser>();
  readonly pats = new Map<string, FakePat>();
  readonly workspaces = new Map<string, Workspace>();
  readonly projects = new Map<string, Project>();
  readonly teams = new Map<string, Team>();
  readonly labels = new Map<string, Label>();
  readonly tasks = new Map<string, FakeTask>();
  readonly comments: Comment[] = [];
  /** W17b plans: revisions (specs) and the issues approvals created, by key. */
  readonly plans = new Map<string, FakePlan>();
  /** W20 recurring issues. */
  readonly schedules = new Map<string, FakeSchedule>();
  /** W19b project knowledge (a PAT only proposes). */
  readonly knowledge = new Map<string, Json & { projectId: string }>();
  /** W17a "blocked by" edges: `taskId` waits on `dependsOnTaskId`. */
  readonly dependencies: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  /** W11a verification evidence by task id, newest first (`GET /api/executions/tasks/:id/verifications`). */
  readonly verifications = new Map<string, Json[]>();
  /** Simulate an API that predates the verification route (404). */
  verificationRouteMissing = false;
  /** Simulate an API that predates `GET /api/tasks?identifier=` (zod strips the unknown key). */
  identifierFilterMissing = false;
  /** W15b: run figures the fake insights document reports (the fake keeps no agent runs). */
  insightsRuns: { total: number; succeeded: number; failed: number; knownUsd: number; unknownCostRuns: number } = { total: 0, succeeded: 0, failed: 0, knownUsd: 0, unknownCostRuns: 0 };
  readonly requests: RecordedRequest[] = [];
  readonly mcpLog: Array<{ userId: string; toolName: string; success: boolean; error?: string }> = [];
  readonly failures: InjectedFailure[] = [];
  /** W04a records: `${credential}|${op}|${key}` → hash + stored response (kept 24 h). */
  private readonly idempotency = new Map<string, { hash: string; status: number; body: string }>();
  private clock = Date.parse('2026-10-25T00:00:00.000Z');
  private server: Server | undefined;
  url = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null | undefined = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fake API did not bind a TCP port');
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  // ─── Seeding ──────────────────────────────────────────────────────────────

  addUser(username: string): FakeUser {
    const user = { id: randomUUID(), username };
    this.users.set(user.id, user);
    return user;
  }

  addPat(userId: string, options: { scopes?: string[]; workspaceId?: string | null } = {}): string {
    const token = `ol_pat_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`;
    this.pats.set(token, {
      token,
      userId,
      scopes: options.scopes ?? ['write'],
      workspaceId: options.workspaceId ?? null,
      revoked: false,
    });
    return token;
  }

  revoke(token: string): void {
    const pat = this.pats.get(token);
    if (pat) pat.revoked = true;
  }

  addWorkspace(name: string, members: Record<string, string>): Workspace {
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      plan: 'free',
      members: new Map(Object.entries(members)),
      createdAt: this.now(),
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  /** Project with its default team (creator is owner) and default labels, like createProjectFull. */
  addProject(workspaceId: string, userId: string, name: string, key: string): { project: Project; team: Team } {
    const project = this.insertProject(workspaceId, name, key);
    const team = this.addTeam(project.id, `${name} Team`, key.slice(0, 12), userId);
    return { project, team };
  }

  private insertProject(workspaceId: string, name: string, key: string): Project {
    const at = this.now();
    const project: Project = {
      id: randomUUID(),
      workspaceId,
      key,
      name,
      description: null,
      status: 'planned',
      createdAt: at,
      updatedAt: at,
    };
    this.projects.set(project.id, project);
    for (const [labelName, color, priority] of [
      ['Bug', '#ef4444', 5],
      ['Feature', '#3b82f6', 4],
    ] as const) {
      this.addLabel(project.id, labelName, color, priority);
    }
    return project;
  }

  addTeam(projectId: string, name: string, key: string, ownerId: string): Team {
    const team: Team = {
      id: randomUUID(),
      projectId,
      name,
      key,
      description: null,
      color: '#6366f1',
      private: false,
      nextIssueNumber: 1,
      members: new Map([[ownerId, 'owner']]),
      createdAt: this.now(),
    };
    this.teams.set(team.id, team);
    return team;
  }

  addLabel(projectId: string, name: string, color: string, priority = 0): Label {
    const label = { id: randomUUID(), projectId, name, color, priority };
    this.labels.set(label.id, label);
    return label;
  }

  /**
   * A task numbered by its team: the project's default team when `projectId`
   * is given (unless `teamId` is), else `teamId` alone for a project-less
   * ("team-only") task.
   */
  addTask(input: Partial<FakeTask> & { title: string; creatorId: string }): FakeTask {
    const projectId = input.projectId ?? null;
    const team = input.teamId ? this.teams.get(input.teamId) : projectId ? this.defaultTeam(projectId) : undefined;
    if (!team) throw new Error('addTask needs a projectId or an existing teamId');
    const number = team.nextIssueNumber;
    team.nextIssueNumber += 1;
    const at = this.now();
    const task: FakeTask = {
      id: randomUUID(),
      description: null,
      priority: 'medium',
      status: 'todo',
      parentId: null,
      assigneeId: null,
      assigneeIds: [],
      number,
      identifier: `${team.key}-${number}`,
      dueDate: null,
      model: null,
      agent: null,
      labelIds: [],
      archived: false,
      createdAt: at,
      updatedAt: at,
      ...input,
      projectId,
      teamId: team.id,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  addComment(taskId: string, userId: string, body: string): Comment {
    const at = this.now();
    const comment = { id: randomUUID(), taskId, userId, body, createdAt: at, updatedAt: at };
    this.comments.push(comment);
    return comment;
  }

  /** Simulate the 24 h idempotency retention running out (`idempotency_records`). */
  expireIdempotency(): void {
    this.idempotency.clear();
  }

  /** Fail the next matching request(s) with a canned answer. */
  fail(failure: InjectedFailure): void {
    this.failures.push({ times: 1, ...failure });
  }

  callsTo(method: string, path: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && path.test(request.path));
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  private userView(userId: string | null) {
    const user = userId ? this.users.get(userId) : undefined;
    return user ? { id: user.id, username: user.username, avatarUrl: null } : null;
  }

  /** `taskInclude` + flattenTaskLabels; `compact` omits `executionLogs` (view=compact). */
  private taskView(task: FakeTask, compact = false): Json {
    const team = task.teamId ? this.teams.get(task.teamId) : undefined;
    const project = task.projectId ? this.projects.get(task.projectId) : undefined;
    const { labelIds, assigneeIds: _assignees, ...scalars } = task;
    return {
      ...scalars,
      workspaceId: project?.workspaceId ?? null,
      sessionId: null,
      ...(compact ? {} : { executionLogs: [{ type: 'log', message: 'x'.repeat(200) }] }),
      executionProgress: null,
      prUrl: null,
      outcome: null,
      agent: task.agent,
      batchId: null,
      inboxRead: false,
      labels: labelIds.flatMap((id) => {
        const label = this.labels.get(id);
        return label ? [{ ...label }] : [];
      }),
      team: team ? { id: team.id, name: team.name, key: team.key, color: team.color } : null,
      project: project ? { id: project.id, name: project.name, status: project.status, color: '#6366f1' } : null,
      assignee: this.userView(task.assigneeId),
      creator: this.userView(task.creatorId),
    };
  }

  private taskRef(task: FakeTask): Json {
    return { id: task.id, identifier: task.identifier, title: task.title, status: task.status };
  }

  private teamView(team: Team): Json {
    const project = this.projects.get(team.projectId);
    return {
      ...team,
      inviteCode: null,
      icon: null,
      updatedAt: team.createdAt,
      members: [...team.members.entries()].map(([userId, role]) => ({
        id: randomUUID(),
        teamId: team.id,
        userId,
        role,
        createdAt: team.createdAt,
        user: { ...this.userView(userId), email: `${this.users.get(userId)?.username}@example.test` },
      })),
      _count: { members: team.members.size, tasks: [...this.tasks.values()].filter((t) => t.teamId === team.id).length },
      project: project ? { id: project.id, name: project.name, status: project.status, workspaceId: project.workspaceId } : null,
    };
  }

  private projectView(project: Project): Json {
    const workspace = this.workspaces.get(project.workspaceId);
    return {
      ...project,
      color: '#6366f1',
      icon: null,
      repositoryId: null,
      repository: null,
      teams: [...this.teams.values()]
        .filter((team) => team.projectId === project.id)
        .map((team) => ({ id: team.id, name: team.name, key: team.key, projectId: team.projectId })),
      workspace: workspace ? { id: workspace.id, name: workspace.name, slug: workspace.slug, plan: workspace.plan } : null,
      _count: { tasks: [...this.tasks.values()].filter((t) => t.projectId === project.id).length },
    };
  }

  // ─── Access (W02a) ────────────────────────────────────────────────────────

  private defaultTeam(projectId: string): Team {
    const team = [...this.teams.values()].find((candidate) => candidate.projectId === projectId);
    if (!team) throw new HttpFailure(400, 'VALIDATION_ERROR', 'Project must have a team');
    return team;
  }

  private assertProject(projectId: string, pat: FakePat): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'project', resourceId: projectId });
    if (pat.workspaceId && project.workspaceId !== pat.workspaceId) {
      throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'project', resourceId: projectId });
    }
    if (!this.workspaces.get(project.workspaceId)?.members.has(pat.userId)) {
      throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'project', resourceId: projectId });
    }
    return project;
  }

  /** services/ownership.ts `assertTeamRole`. */
  private assertTeamRole(teamId: string, pat: FakePat, roles: readonly string[]): Team {
    const team = this.teams.get(teamId);
    const role = team?.members.get(pat.userId);
    if (!team || !role) throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'team', resourceId: teamId });
    if (pat.workspaceId && this.projects.get(team.projectId)?.workspaceId !== pat.workspaceId) {
      throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'team', resourceId: teamId });
    }
    if (!roles.includes(role)) {
      throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', {
        resourceType: 'team',
        resourceId: teamId,
        requiredRoles: roles,
      });
    }
    return team;
  }

  /** Project tasks follow project access; project-less tasks follow team membership. */
  private canSeeTask(task: FakeTask, pat: FakePat): boolean {
    if (task.projectId) return this.visibleProjects(pat).some((project) => project.id === task.projectId);
    const team = task.teamId ? this.teams.get(task.teamId) : undefined;
    if (!team?.members.has(pat.userId)) return false;
    return !pat.workspaceId || this.projects.get(team.projectId)?.workspaceId === pat.workspaceId;
  }

  private assertTask(taskId: string, pat: FakePat): FakeTask {
    const task = this.tasks.get(taskId);
    const notFound = new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'task', resourceId: taskId });
    if (!task) throw notFound;
    if (task.projectId) {
      this.assertProject(task.projectId, pat);
      return task;
    }
    if (!task.teamId) throw notFound;
    this.assertTeamRole(task.teamId, pat, ['owner', 'admin', 'member']);
    return task;
  }

  private visibleProjects(pat: FakePat): Project[] {
    return [...this.projects.values()].filter(
      (project) =>
        (!pat.workspaceId || project.workspaceId === pat.workspaceId) &&
        this.workspaces.get(project.workspaceId)?.members.has(pat.userId),
    );
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[name] = value;
    const method = req.method ?? 'GET';
    const recorded: RecordedRequest = { method, path: url.pathname, query: url.searchParams, headers, body, status: 0 };
    this.requests.push(recorded);

    const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      recorded.status = status;
      if (status === 204) {
        res.writeHead(204, extra).end();
        return;
      }
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(raw);
    };

    const failureIndex = this.failures.findIndex((f) => f.method === method && f.path.test(url.pathname));
    let failure = failureIndex >= 0 ? this.failures[failureIndex] : undefined;
    if (failure?.after) {
      failure.after -= 1;
      failure = undefined;
    }
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.times <= 0) this.failures.splice(failureIndex, 1);
      if (failure.dropConnection) {
        recorded.status = -1;
        req.socket.destroy();
        return;
      }
      if (failure.rawBody !== undefined) {
        recorded.status = failure.status;
        res.writeHead(failure.status, { 'content-type': 'text/html', ...failure.headers }).end(failure.rawBody);
        return;
      }
      send(failure.status, failure.body ?? envelope('INJECTED', 'Injected failure'), failure.headers);
      return;
    }

    try {
      const pat = this.authenticate(headers.authorization, method, url.pathname);
      const result = this.route(method, url, body, pat, headers);
      send(result.status, result.body, result.headers);
    } catch (error) {
      if (error instanceof HttpFailure) {
        send(error.status, envelope(error.code, error.message, error.details), error.headers);
      } else {
        send(500, envelope('INTERNAL_ERROR', 'Internal server error'));
      }
    }
  }

  /** middleware/auth.ts: token first (401), then the route's PAT scopes (403), then the binding stance. */
  private authenticate(header: string | undefined, method: string, path: string): FakePat {
    if (!header?.startsWith('Bearer ')) throw new HttpFailure(401, 'UNAUTHORIZED', 'Authentication required');
    const pat = this.pats.get(header.slice(7));
    if (!pat || pat.revoked) throw new HttpFailure(401, 'UNAUTHORIZED', 'Invalid token');
    const rule = ROUTE_RULES.find((candidate) => candidate.method === method && candidate.path.test(path));
    const required = rule?.scopes ?? [];
    if (!hasRequiredScopes(pat.scopes, required)) {
      throw new HttpFailure(403, 'INSUFFICIENT_SCOPE', 'Personal access token lacks required scope', { requiredScopes: required });
    }
    if (pat.workspaceId && rule?.boundRefused) {
      throw new HttpFailure(
        403,
        'PAT_WORKSPACE_RESTRICTED',
        'This account-level resource is not available to a workspace-bound personal access token.',
      );
    }
    return pat;
  }

  private route(
    method: string,
    url: URL,
    body: unknown,
    pat: FakePat,
    headers: Record<string, string>,
  ): { status: number; body: unknown; headers?: Record<string, string> } {
    const path = url.pathname;
    const q = url.searchParams;
    const b = record(body);

    if (method === 'GET' && path === '/api/users/me') {
      const user = this.users.get(pat.userId);
      return { status: 200, body: { ...user, displayName: null, email: `${user?.username}@example.test` } };
    }
    if (method === 'POST' && path === '/api/mcp/log') {
      this.mcpLog.push({ userId: pat.userId, toolName: String(b.toolName), success: b.success === true, ...(str(b.error) ? { error: str(b.error) } : {}) });
      return { status: 200, body: { success: true } };
    }
    const verificationsMatch = /^\/api\/executions\/tasks\/([^/]+)\/verifications$/.exec(path);
    if (method === 'GET' && verificationsMatch) {
      if (this.verificationRouteMissing) throw new HttpFailure(404, 'NOT_FOUND', 'Not found');
      const taskId = verificationsMatch[1] ?? '';
      if (!this.tasks.has(taskId)) throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Task not found', { resourceType: 'task', resourceId: taskId });
      return { status: 200, body: { items: this.verifications.get(taskId) ?? [] } };
    }
    if (method === 'GET' && path === '/api/workspaces') {
      const list = [...this.workspaces.values()]
        .filter((w) => w.members.has(pat.userId) && (!pat.workspaceId || w.id === pat.workspaceId))
        .map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          plan: w.plan,
          createdAt: w.createdAt,
          updatedAt: w.createdAt,
          _count: { members: w.members.size, projects: [...this.projects.values()].filter((p) => p.workspaceId === w.id).length },
          role: w.members.get(pat.userId),
          invitedAt: w.createdAt,
          joinedAt: w.createdAt,
        }));
      return { status: 200, body: list };
    }
    if (method === 'GET' && path === '/api/projects') {
      const workspaceId = q.get('workspaceId');
      const teamId = q.get('teamId');
      const list = this.visibleProjects(pat)
        .filter((p) => !workspaceId || p.workspaceId === workspaceId)
        .filter((p) => !teamId || this.teams.get(teamId)?.projectId === p.id)
        .sort((a, b2) => b2.createdAt.localeCompare(a.createdAt))
        .map((p) => this.projectView(p));
      return { status: 200, body: list };
    }
    if (method === 'POST' && path === '/api/projects') {
      return this.idempotent(pat, 'projects.create', headers, { body, params: { client: 'web' } }, () => this.createProject(b, pat));
    }
    const projectPlansMatch = /^\/api\/projects\/([^/]+)\/plans$/.exec(path);
    if (method === 'GET' && projectPlansMatch) {
      const projectId = projectPlansMatch[1] ?? '';
      this.assertProject(projectId, pat);
      const items = [...this.plans.values()].filter((plan) => plan.projectId === projectId).map((plan) => ({
        id: plan.id, title: plan.title, status: plan.status, latestRevision: plan.revisions.length, approvedRevision: plan.approvedRevision,
        taskCount: plan.revisions.at(-1)?.spec.tasks.length ?? 0, createdTaskCount: plan.links.size,
        doneTaskCount: [...plan.links.values()].filter((taskId) => this.tasks.get(taskId)?.status === 'done').length,
        updatedAt: new Date(this.now()).toISOString(),
      }));
      return { status: 200, body: { items } };
    }
    if (method === 'POST' && projectPlansMatch) {
      const projectId = projectPlansMatch[1] ?? '';
      return this.idempotent(pat, 'plans.create', headers, { body, params: { id: projectId } }, () => ({ status: 201, body: this.createPlan(projectId, b, pat) }));
    }
    const projectSchedulesMatch = /^\/api\/projects\/([^/]+)\/schedules$/.exec(path);
    if (projectSchedulesMatch) {
      const projectId = projectSchedulesMatch[1] ?? '';
      if (method === 'GET') {
        this.assertProject(projectId, pat);
        return { status: 200, body: { items: [...this.schedules.values()].filter((row) => row.projectId === projectId).map((row) => this.scheduleView(row)), limits: { active: 25, total: 50 } } };
      }
      if (method === 'POST') {
        return this.idempotent(pat, 'schedules.create', headers, { body, params: { id: projectId } }, () => ({ status: 201, body: this.createSchedule(projectId, b, pat) }));
      }
    }
    const projectKnowledgeMatch = /^\/api\/projects\/([^/]+)\/knowledge$/.exec(path);
    if (projectKnowledgeMatch) {
      const projectId = projectKnowledgeMatch[1] ?? '';
      if (method === 'GET') {
        this.assertProject(projectId, pat);
        return { status: 200, body: { entries: [...this.knowledge.values()].filter((row) => row.projectId === projectId) } };
      }
      if (method === 'POST') {
        return this.idempotent(pat, 'knowledge.create', headers, { body, params: { id: projectId } }, () => ({ status: 201, body: this.proposeKnowledge(projectId, b, pat) }));
      }
    }
    const insightsMatch = /^\/api\/(projects|workspaces)\/([^/]+)\/insights$/.exec(path);
    if (method === 'GET' && insightsMatch) {
      const range = q.get('range') ?? '30d';
      if (!['7d', '30d', '90d'].includes(range)) throw new HttpFailure(400, 'VALIDATION_ERROR', 'Validation failed', { fieldErrors: { range: ['Invalid enum value'] } });
      const scopeId = insightsMatch[2] ?? '';
      if (insightsMatch[1] === 'projects') this.assertProject(scopeId, pat);
      else if (!this.workspaces.get(scopeId)?.members.has(pat.userId) || (pat.workspaceId && pat.workspaceId !== scopeId)) {
        throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'workspace', resourceId: scopeId });
      }
      return { status: 200, body: this.insightsView(insightsMatch[1] === 'projects' ? 'project' : 'workspace', scopeId, range) };
    }
    const planMatch = /^\/api\/plans\/([^/]+)(?:\/(revisions|approve))?$/.exec(path);
    if (planMatch) {
      const plan = this.plans.get(planMatch[1] ?? '');
      if (!plan) throw new HttpFailure(404, 'PLAN_NOT_FOUND', 'Plan not found');
      this.assertProject(plan.projectId, pat);
      if (method === 'GET' && !planMatch[2]) return { status: 200, body: this.planView(plan, Number(q.get('revision') ?? plan.revisions.length)) };
      if (method === 'POST' && planMatch[2] === 'revisions') return this.revisePlan(plan, b);
      if (method === 'POST' && planMatch[2] === 'approve') return { status: 200, body: this.approvePlan(plan, Number(b.revision), pat) };
    }
    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (method === 'GET' && projectMatch) {
      return { status: 200, body: this.projectView(this.assertProject(projectMatch[1] ?? '', pat)) };
    }
    if (method === 'GET' && path === '/api/teams') {
      const projectId = q.get('projectId');
      const visible = new Set(this.visibleProjects(pat).map((p) => p.id));
      const list = [...this.teams.values()]
        .filter((t) => visible.has(t.projectId) && t.members.has(pat.userId))
        .filter((t) => !projectId || t.projectId === projectId)
        .map((t) => this.teamView(t));
      return { status: 200, body: list };
    }
    if (method === 'POST' && path === '/api/teams') {
      return this.idempotent(pat, 'teams.create', headers, { body }, () => this.createTeam(b, pat));
    }
    if (method === 'GET' && path === '/api/labels') {
      const projectId = q.get('projectId') ?? '';
      if (!UUID.test(projectId)) throw validation({ projectId: ['Invalid uuid'] });
      this.assertProject(projectId, pat);
      const list = [...this.labels.values()]
        .filter((l) => l.projectId === projectId)
        .sort((a, b2) => b2.priority - a.priority || a.name.localeCompare(b2.name));
      return { status: 200, body: list };
    }
    if (method === 'POST' && path === '/api/labels') {
      const projectId = str(b.projectId) ?? '';
      this.assertProject(projectId, pat);
      const name = str(b.name) ?? '';
      if (!name || !/^#[0-9A-Fa-f]{6}$/.test(str(b.color) ?? '')) throw validation({ color: ['Invalid'] });
      if ([...this.labels.values()].some((l) => l.projectId === projectId && l.name === name)) {
        throw new HttpFailure(409, 'P2002', 'Unique constraint violation', { target: ['projectId', 'name'] });
      }
      return { status: 201, body: this.addLabel(projectId, name, str(b.color) ?? '#000000', typeof b.priority === 'number' ? b.priority : 0) };
    }
    const attachMatch = /^\/api\/labels\/tasks\/([^/]+)\/labels$/.exec(path);
    if (method === 'POST' && attachMatch) return { status: 201, body: this.attachLabel(attachMatch[1] ?? '', b, pat) };
    const detachMatch = /^\/api\/labels\/tasks\/([^/]+)\/labels\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && detachMatch) {
      this.detachLabel(detachMatch[1] ?? '', detachMatch[2] ?? '', pat);
      return { status: 204, body: undefined };
    }
    if (method === 'GET' && path === '/api/tasks') return { status: 200, body: this.listTasks(q, pat) };
    if (method === 'GET' && path === '/api/tasks/similar') {
      // services/task-dependencies.ts `similarTasks`, approximated by shared words.
      const projectId = q.get('projectId') ?? '';
      this.assertProject(projectId, pat);
      const words = new Set((q.get('title') ?? '').toLowerCase().split(/\W+/).filter(Boolean));
      const items = [...this.tasks.values()]
        .filter((task) => task.projectId === projectId && !task.archived && task.status !== 'cancelled')
        .map((task) => {
          const own = task.title.toLowerCase().split(/\W+/).filter(Boolean);
          const shared = own.filter((word) => words.has(word)).length;
          return { task, score: own.length ? Math.round((shared / Math.max(own.length, words.size)) * 100) / 100 : 0 };
        })
        .filter((entry) => entry.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, Number(q.get('limit') ?? 5))
        .map(({ task, score }) => ({ id: task.id, identifier: task.identifier, title: task.title, status: task.status, score }));
      return { status: 200, body: { items } };
    }
    if (method === 'POST' && path === '/api/tasks') {
      return this.idempotent(pat, 'tasks.create', headers, { body }, () => ({ status: 201, body: this.createTask(b, pat) }));
    }
    if (method === 'POST' && path === '/api/tasks/bulk') {
      return this.idempotent(pat, 'tasks.bulk_create', headers, { body }, () => ({ status: 201, body: this.bulkCreate(b, pat) }));
    }
    if (method === 'PATCH' && path === '/api/tasks/bulk-status') return { status: 200, body: this.bulkStatus(b, pat) };
    const commentsMatch = /^\/api\/tasks\/([^/]+)\/comments$/.exec(path);
    if (commentsMatch) {
      const task = this.assertTask(commentsMatch[1] ?? '', pat);
      if (method === 'GET') {
        const page = Number(q.get('page') ?? 1);
        const pageSize = Number(q.get('pageSize') ?? 50);
        const all = this.comments.filter((c) => c.taskId === task.id);
        const comments = all.slice((page - 1) * pageSize, page * pageSize).map((c) => ({ ...c, mentions: [], user: this.userView(c.userId) }));
        return { status: 200, body: { comments, page, pageSize, total: all.length } };
      }
      if (method === 'POST') {
        const text = str(b.body) ?? '';
        if (!text) throw validation({ body: ['body is required'] });
        const comment = this.addComment(task.id, pat.userId, text);
        return { status: 201, body: { ...comment, mentions: [], user: this.userView(pat.userId) } };
      }
    }
    const dependenciesMatch = /^\/api\/tasks\/([^/]+)\/dependencies(?:\/([^/]+))?$/.exec(path);
    if (dependenciesMatch) {
      const task = this.assertTask(dependenciesMatch[1] ?? '', pat);
      if (method === 'POST' && !dependenciesMatch[2]) {
        const created = this.addDependency(task, str(b.dependsOnTaskId) ?? '', pat);
        return { status: created ? 201 : 200, body: { created, ...this.dependencyLists(task) } };
      }
      if (method === 'DELETE' && dependenciesMatch[2]) {
        const index = this.dependencies.findIndex((edge) => edge.taskId === task.id && edge.dependsOnTaskId === dependenciesMatch[2]);
        if (index >= 0) this.dependencies.splice(index, 1);
        return { status: 204, body: undefined };
      }
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch) {
      const task = this.assertTask(taskMatch[1] ?? '', pat);
      if (method === 'GET') return { status: 200, body: this.getTask(task, pat) };
      if (method === 'PATCH') return { status: 200, body: this.updateTask(task, b) };
    }
    if (method === 'GET' && path === '/api/search') return { status: 200, body: this.search(q, pat) };
    throw new HttpFailure(404, 'NOT_FOUND', `No route ${method} ${path}`);
  }

  // ─── Idempotency ──────────────────────────────────────────────────────────

  /** W04a/W04b: transactional replay / 409 conflict, keyed per credential and operation. */
  private idempotent(
    pat: FakePat,
    operation: string,
    headers: Record<string, string>,
    args: unknown,
    execute: () => { status: number; body: unknown },
  ): { status: number; body: unknown; headers?: Record<string, string> } {
    const key = headers['idempotency-key'];
    if (key === undefined) return execute();
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new HttpFailure(400, 'IDEMPOTENCY_KEY_INVALID', 'Invalid Idempotency-Key header', { header: 'Idempotency-Key' });
    }
    // outbox.md: each PAT is its own idempotency principal (`<userId>:pat:<tokenId>`).
    const scope = `${pat.userId}:pat:${pat.token}|${operation}|${key}`;
    const hash = createHash('sha256').update(canonical({ operation, args })).digest('hex');
    const stored = this.idempotency.get(scope);
    if (stored) {
      if (stored.hash !== hash) {
        throw new HttpFailure(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request', {
          operation,
          retentionSeconds: 86400,
        });
      }
      return { status: stored.status, body: JSON.parse(stored.body), headers: { 'Idempotency-Replayed': 'true' } };
    }
    // A thrown failure stores nothing (the reservation rolls back with the writes).
    const result = execute();
    this.idempotency.set(scope, { hash, status: result.status, body: JSON.stringify(result.body) });
    return result;
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  private createProject(b: Json, pat: FakePat): { status: number; body: unknown } {
    const name = str(b.name)?.trim() ?? '';
    if (!name) throw validation({ name: ['Required'] });
    const teamIds = b.teamIds === undefined ? undefined : stringArray(b.teamIds);
    if (b.teamIds !== undefined && !(teamIds?.length === 1 && teamIds.every((id) => UUID.test(id)))) {
      throw validation({ teamIds: ['Array must contain exactly 1 uuid'] });
    }
    const workspaceId =
      str(b.workspaceId) ??
      pat.workspaceId ??
      [...this.workspaces.values()].find((w) => w.members.has(pat.userId))?.id ??
      '';
    if (pat.workspaceId && workspaceId !== pat.workspaceId) {
      throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'workspace', resourceId: workspaceId });
    }
    if (!this.workspaces.get(workspaceId)?.members.has(pat.userId)) {
      throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'workspace', resourceId: workspaceId });
    }
    // authorizeTeamMoves: owner/admin of the team and full access to its current project.
    const moving = (teamIds ?? []).map((teamId) => {
      const team = this.assertTeamRole(teamId, pat, ['owner', 'admin']);
      this.assertProject(team.projectId, pat);
      return team;
    });
    const taken = (candidate: string) =>
      [...this.projects.values()].some((p) => p.workspaceId === workspaceId && p.key === candidate);
    let key = str(b.key)?.toUpperCase() ?? '';
    if (key && taken(key)) {
      throw new HttpFailure(409, 'P2002', 'Unique constraint violation', { target: ['workspaceId', 'key'] });
    }
    if (!key) {
      // generateProjectKey: name-derived base, numbered until free.
      const base = name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'PRJ';
      key = base;
      for (let suffix = 2; taken(key); suffix += 1) key = `${base.slice(0, Math.max(1, 4 - String(suffix).length))}${suffix}`;
    }

    if (moving.length === 0) {
      const { project } = this.addProject(workspaceId, pat.userId, name, key);
      project.description = str(b.description) ?? null;
      project.status = str(b.status) ?? 'planned';
      return { status: 201, body: this.projectView(project) };
    }

    // moveTeamsIntoProject: the project adopts the teams (no default team), or
    // the whole create rolls back with per-team reasons.
    const conflicts: Array<{ teamId: string; reason: string }> = [];
    const movingIds = new Set(moving.map((team) => team.id));
    for (const team of moving) {
      if (this.projects.get(team.projectId)?.workspaceId !== workspaceId) {
        conflicts.push({ teamId: team.id, reason: 'OTHER_WORKSPACE' });
        continue;
      }
      const remaining = [...this.teams.values()].filter((t) => t.projectId === team.projectId && !movingIds.has(t.id));
      if (remaining.length === 0) {
        conflicts.push({ teamId: team.id, reason: 'LAST_TEAM_OF_PROJECT' });
        continue;
      }
      if ([...this.tasks.values()].some((t) => t.teamId === team.id && t.projectId !== null)) {
        conflicts.push({ teamId: team.id, reason: 'TEAM_HAS_PROJECT_TASKS' });
        continue;
      }
      if (moving.some((other) => other.id !== team.id && other.key === team.key)) {
        conflicts.push({ teamId: team.id, reason: 'TEAM_KEY_TAKEN' });
      }
    }
    if (conflicts.length > 0) {
      throw new HttpFailure(409, 'TEAM_PROJECT_CONFLICT', 'One or more teams cannot move to this project (see details.teams)', {
        teams: conflicts,
      });
    }
    const project = this.insertProject(workspaceId, name, key);
    project.description = str(b.description) ?? null;
    project.status = str(b.status) ?? 'planned';
    for (const team of moving) team.projectId = project.id;
    return { status: 201, body: this.projectView(project) };
  }

  private createTeam(b: Json, pat: FakePat): { status: number; body: unknown } {
    const project = this.assertProject(str(b.projectId) ?? '', pat);
    const key = str(b.key) ?? '';
    if (!/^[A-Z][A-Z0-9]*$/.test(key)) {
      throw validation({ key: ['Key must be uppercase alphanumeric starting with a letter'] });
    }
    if ([...this.teams.values()].some((t) => t.projectId === project.id && t.key === key)) {
      throw new HttpFailure(409, 'P2002', 'Unique constraint violation', { target: ['projectId', 'key'] });
    }
    const team = this.addTeam(project.id, str(b.name) ?? key, key, pat.userId);
    return { status: 201, body: this.teamView(team) };
  }

  /** services/tasks.ts `assertLabelsInProject`. */
  private validLabels(labelIds: unknown, projectId: string | null): string[] {
    const ids = [...new Set(stringArray(labelIds) ?? [])];
    if (ids.length === 0) return [];
    if (!projectId) throw new HttpFailure(400, 'VALIDATION_ERROR', 'Cannot attach labels to a task with no project');
    const invalid = ids.filter((id) => this.labels.get(id)?.projectId !== projectId);
    if (invalid.length > 0) throw new HttpFailure(400, 'VALIDATION_ERROR', `Invalid labelIds: ${invalid.join(', ')}`);
    return ids;
  }

  /** authorizeCreateTask: project → its default team; team only → a project-less task. */
  private createTask(b: Json, pat: FakePat): Json {
    const title = str(b.title) ?? '';
    const projectId = str(b.projectId);
    const teamIdArg = str(b.teamId);
    const assigneeIds = b.assigneeIds === undefined ? [] : stringArray(b.assigneeIds);
    if (!title) throw validation({ title: ['Title is required'] });
    if (!projectId && !teamIdArg) throw validation({ teamId: ['Task must belong to a team or a project'] });
    if (!assigneeIds || assigneeIds.length > 50 || !assigneeIds.every((id) => UUID.test(id))) {
      throw validation({ assigneeIds: ['Expected an array of at most 50 uuids'] });
    }
    let team: Team;
    if (projectId) {
      this.assertProject(projectId, pat);
      team = this.defaultTeam(projectId);
    } else {
      team = this.assertTeamRole(teamIdArg ?? '', pat, ['owner', 'admin', 'member']);
    }
    const explicit = b.assigneeId === undefined || b.assigneeId === null ? null : (str(b.assigneeId) ?? null);
    if (explicit && !team.members.has(explicit)) {
      throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'user', resourceId: explicit });
    }
    const unique = [...new Set(assigneeIds)];
    const strangers = unique.filter((id) => !team.members.has(id));
    if (strangers.length > 0) {
      throw new HttpFailure(400, 'VALIDATION_ERROR', `Users are not members of this team: ${strangers.join(', ')}`);
    }
    const labelIds = this.validLabels(b.labelIds, projectId ?? null);
    const task = this.addTask({
      title,
      projectId: projectId ?? null,
      teamId: team.id,
      creatorId: pat.userId,
      description: str(b.description) ?? null,
      priority: str(b.priority) ?? 'medium',
      status: str(b.status) ?? 'todo',
      labelIds,
      assigneeId: explicit ?? unique[0] ?? null,
      assigneeIds: unique,
      dueDate: str(b.dueDate) ?? null,
      model: str(b.model) ?? null,
      agent: str(b.agent) ?? null,
    });
    return this.taskView(task);
  }

  private bulkCreate(b: Json, pat: FakePat): Json {
    const projectId = str(b.projectId) ?? '';
    this.assertProject(projectId, pat);
    const items = Array.isArray(b.tasks) ? b.tasks : [];
    if (items.length === 0 || items.length > 100) throw validation({ tasks: ['1-100 tasks'] });
    const created: Json[] = [];
    const failed: Array<{ index: number; error: string }> = [];
    items.forEach((raw, index) => {
      const item = record(raw);
      const labelIds = stringArray(item.labelIds) ?? [];
      const invalid = labelIds.filter((id) => this.labels.get(id)?.projectId !== projectId);
      if (invalid.length > 0) {
        failed.push({ index, error: `Invalid labelIds: ${invalid.join(', ')}` });
        return;
      }
      const task = this.addTask({
        title: str(item.title) ?? '',
        projectId,
        creatorId: pat.userId,
        description: str(item.description) ?? null,
        priority: str(item.priority) ?? 'medium',
        status: str(item.status) ?? 'todo',
        labelIds,
        parentId: str(item.parentId) ?? null,
      });
      created.push(this.taskView(task));
    });
    return { created, failed };
  }

  /** bulkUpdateTaskStatus: explicit ids first, then exactly one scope. */
  private bulkStatus(b: Json, pat: FakePat): Json {
    const status = str(b.status) ?? '';
    const taskIds = b.taskIds === undefined ? [] : stringArray(b.taskIds);
    const fieldErrors: Record<string, string[]> = {};
    if (!STATUSES.includes(status)) fieldErrors.status = ['Invalid enum value'];
    if (!taskIds || taskIds.length > 100 || !taskIds.every((id) => UUID.test(id))) fieldErrors.taskIds = ['Invalid'];
    for (const field of ['projectId', 'teamId'] as const) {
      if (b[field] !== undefined && !UUID.test(str(b[field]) ?? '')) fieldErrors[field] = ['Invalid uuid'];
    }
    if (Object.keys(fieldErrors).length > 0 || !taskIds) throw validation(fieldErrors);
    const requested = [...new Set(taskIds)];
    if (requested.length === 0) {
      throw new HttpFailure(
        400,
        'TASK_IDS_REQUIRED',
        'taskIds must list the issues to change (1-100 ids); an empty or missing selection no longer means every issue in the project',
      );
    }
    const projectId = str(b.projectId);
    const teamId = str(b.teamId);
    if (projectId && teamId) throw new HttpFailure(400, 'BULK_SCOPE_INVALID', 'Pass either projectId or teamId, not both');
    let inScope: (task: FakeTask) => boolean;
    let notFound: string;
    if (projectId) {
      this.assertProject(projectId, pat);
      inScope = (task) => task.projectId === projectId;
      notFound = 'Issue was not found in the selected project';
    } else if (teamId) {
      this.assertTeamRole(teamId, pat, ['owner', 'admin', 'member']);
      inScope = (task) => task.teamId === teamId && task.projectId === null;
      notFound = "Issue was not found among the team's issues without a project";
    } else {
      throw new HttpFailure(400, 'BULK_SCOPE_INVALID', 'projectId or teamId is required');
    }
    const scope = [...this.tasks.values()].filter((t) => inScope(t) && !t.archived && requested.includes(t.id));
    const found = new Set(scope.map((t) => t.id));
    const updated: Json[] = [];
    const already: Json[] = [];
    for (const task of scope) {
      if (task.status === status) {
        already.push({ id: task.id, identifier: task.identifier, title: task.title, status: task.status });
      } else {
        task.status = status;
        task.updatedAt = this.now();
        updated.push(this.taskView(task));
      }
    }
    const failed = requested.filter((id) => !found.has(id)).map((id) => ({ id, error: notFound }));
    return { updated, already, failed, status };
  }

  /** services/labels.ts `assignLabelToTask`. */
  private attachLabel(taskId: string, b: Json, pat: FakePat): Json {
    const labelId = str(b.labelId) ?? '';
    if (!UUID.test(labelId)) throw validation({ labelId: ['Invalid uuid'] });
    const task = this.assertTask(taskId, pat);
    const label = this.labels.get(labelId);
    if (!label) throw new HttpFailure(404, 'OWNERSHIP_REQUIRED', 'Resource not found', { resourceType: 'label', resourceId: labelId });
    if (!task.projectId || label.projectId !== task.projectId) {
      // No existence oracle: a label of an invisible project answers 403/404 first.
      this.assertProject(label.projectId, pat);
      throw new HttpFailure(
        400,
        'LABEL_NOT_IN_TASK_PROJECT',
        task.projectId
          ? "The label belongs to a different project than the task; use one of the task's project labels"
          : 'Cannot attach labels to a task with no project',
        { taskId, labelId, taskProjectId: task.projectId },
      );
    }
    if (task.labelIds.includes(labelId)) {
      throw new HttpFailure(409, 'P2002', 'Unique constraint violation', { target: ['taskId', 'labelId'] });
    }
    task.labelIds.push(labelId);
    return { taskId, labelId, label: { ...label } };
  }

  /** services/labels.ts `removeLabelFromTask`: deleting a missing link is Prisma P2025 → 404. */
  private detachLabel(taskId: string, labelId: string, pat: FakePat): void {
    const task = this.assertTask(taskId, pat);
    if (!task.labelIds.includes(labelId)) throw new HttpFailure(404, 'P2025', 'Record not found');
    task.labelIds = task.labelIds.filter((id) => id !== labelId);
  }

  private updateTask(task: FakeTask, b: Json): Json {
    if (b.labelIds !== undefined) task.labelIds = this.validLabels(b.labelIds, task.projectId);
    if (b.assigneeId !== undefined) {
      const assigneeId = b.assigneeId === null ? null : (str(b.assigneeId) ?? null);
      if (assigneeId && !this.teams.get(task.teamId ?? '')?.members.has(assigneeId)) {
        throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'user', resourceId: assigneeId });
      }
      task.assigneeId = assigneeId;
    }
    for (const field of ['title', 'description', 'priority', 'status', 'dueDate', 'model', 'agent'] as const) {
      const value = b[field];
      if (value === null && field !== 'title' && field !== 'priority' && field !== 'status') task[field] = null;
      else if (typeof value === 'string') task[field] = value;
    }
    if (typeof b.projectId === 'string') {
      task.projectId = b.projectId;
      task.teamId = this.defaultTeam(b.projectId).id;
    }
    task.updatedAt = this.now();
    return this.taskView(task);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** GET /api/tasks/:id: the task plus its visible parent and up to 100 non-archived sub-issues. */
  private getTask(task: FakeTask, pat: FakePat): Json {
    const parent = task.parentId ? this.tasks.get(task.parentId) : undefined;
    const subtasks = [...this.tasks.values()]
      .filter((t) => t.parentId === task.id && !t.archived && this.canSeeTask(t, pat))
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, SUBTASK_LIMIT);
    return {
      ...this.taskView(task),
      parent: parent && this.canSeeTask(parent, pat) ? this.taskRef(parent) : null,
      subtasks: subtasks.map((t) => this.taskRef(t)),
      ...this.dependencyLists(task),
      plan: this.planOf(task.id),
    };
  }

  // ─── W15b insights (services/insights.ts, simplified: no time window; runs from `insightsRuns`) ─

  private insightsView(kind: 'project' | 'workspace', scopeId: string, range: string): Json {
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    const projectIds = new Set(kind === 'project' ? [scopeId] : [...this.projects.values()].filter((p) => p.workspaceId === scopeId).map((p) => p.id));
    const tasks = [...this.tasks.values()].filter((task) => task.projectId !== null && projectIds.has(task.projectId));
    const open = tasks.filter((task) => !task.archived && (task.status === 'todo' || task.status === 'in_progress'));
    const blocked = open.filter((task) => this.dependencies.some((edge) => edge.taskId === task.id && this.tasks.get(edge.dependsOnTaskId)?.status !== 'done'));
    const plans = [...this.plans.values()].filter((plan) => projectIds.has(plan.projectId));
    const until = new Date(this.clock);
    const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate() - (days - 1)));
    const dates = Array.from({ length: days }, (_, i) => new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    const r = this.insightsRuns;
    const finished = r.succeeded + r.failed;
    const ratio = (n: number, d: number) => (d > 0 ? Number((n / d).toFixed(4)) : null);
    // As the API: a row's costUsd is null (unknown) when none of its finished runs recorded a price.
    const priced = finished - r.unknownCostRuns > 0;
    const completed = tasks.filter((task) => task.status === 'done').length;
    return {
      scope: { kind, id: scopeId, projects: projectIds.size },
      range: { key: range, days, since: since.toISOString(), until: until.toISOString() },
      runs: {
        total: r.total,
        outcomes: { succeeded: r.succeeded, failed: r.failed, cancelled: 0, recoveryRequired: 0, inProgress: r.total - finished },
        finished,
        successRate: ratio(r.succeeded, finished),
        verification: { passed: 0, failed: 0, skipped: 0, unverified: finished, passRate: null },
        publication: { published: 0, rate: ratio(0, finished) },
        duration: { medianMs: null, p90Ms: null, samples: 0 },
        cost: { knownUsd: r.knownUsd, runsWithCost: finished - r.unknownCostRuns, unknownCostRuns: r.unknownCostRuns, coverage: r.unknownCostRuns === 0 ? (finished > 0 ? 'complete' : 'none') : finished > r.unknownCostRuns ? 'partial' : 'none' },
        tokens: { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0, runsWithTokens: 0 },
        byRunner: r.total > 0 ? [{ key: 'opencode', runs: r.total, succeeded: r.succeeded, failed: r.failed, cancelled: 0, recoveryRequired: 0, inProgress: r.total - finished, successRate: ratio(r.succeeded, finished), medianMs: null, p90Ms: null, costUsd: priced ? r.knownUsd : null, unknownCostRuns: r.unknownCostRuns, inputTokens: 0, outputTokens: 0 }] : [],
        byModel: [],
        daily: dates.map((date, i) => ({ date, runs: i === days - 1 ? r.total : 0, succeeded: i === days - 1 ? r.succeeded : 0, failed: i === days - 1 ? r.failed : 0, cancelled: 0, recoveryRequired: 0, costUsd: i === days - 1 && priced ? r.knownUsd : null, unknownCostRuns: i === days - 1 ? r.unknownCostRuns : 0 })),
      },
      delivery: {
        created: tasks.length,
        completed,
        completedUntracked: 0,
        cycleTime: { medianMs: null, p90Ms: null, samples: completed },
        openNow: open.length,
        blockedNow: blocked.length,
        plans: { approvals: plans.filter((plan) => plan.approvedRevision !== null).length, plansApproved: plans.filter((plan) => plan.approvedRevision !== null).length, awaitingReview: plans.filter((plan) => plan.status === 'draft').length },
        daily: dates.map((date, i) => ({ date, created: i === days - 1 ? tasks.length : 0, completed: i === days - 1 ? completed : 0 })),
      },
      notes: { unknownCostRuns: 'Finished runs with no recorded cost. Never counted as $0.' },
    };
  }

  // ─── W19b knowledge (services/knowledge.ts, simplified: a PAT only proposes) ─

  private proposeKnowledge(projectId: string, b: Record<string, unknown>, pat: FakePat): Json {
    this.assertProject(projectId, pat);
    const title = str(b.title) ?? '';
    const text = str(b.body) ?? '';
    if (!title || title.length > 120 || !text || text.length > 4000) throw new HttpFailure(400, 'VALIDATION_ERROR', 'Validation failed');
    const now = this.now();
    const row = {
      id: randomUUID(), projectId, kind: str(b.kind) ?? 'note', title, body: text, status: 'proposed', source: 'agent', sourceRef: null,
      version: 1, expiresAt: null, expired: false, createdById: pat.userId, updatedById: pat.userId, approvedById: null, approvedAt: null,
      retractedById: null, retractedAt: null, retractReason: null, createdAt: now, updatedAt: now,
    };
    this.knowledge.set(row.id, row);
    return row;
  }

  // ─── W20 schedules (services/schedules.ts, simplified) ─────────────────────

  private createSchedule(projectId: string, b: Record<string, unknown>, pat: FakePat): Json {
    this.assertProject(projectId, pat);
    const cadence = str(b.cadence) ?? '';
    if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(cadence)) throw new HttpFailure(400, 'VALIDATION_ERROR', 'Validation failed');
    if ((cadence === 'weekly') !== (typeof b.weekday === 'number')) throw new HttpFailure(400, 'VALIDATION_ERROR', 'A weekly schedule needs a weekday (0 = Sunday … 6 = Saturday)', { field: 'weekday' });
    if ((cadence === 'monthly') !== (typeof b.dayOfMonth === 'number')) throw new HttpFailure(400, 'VALIDATION_ERROR', 'A monthly schedule needs a dayOfMonth (1-28)', { field: 'dayOfMonth' });
    const timezone = str(b.timezone) ?? '';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new HttpFailure(400, 'VALIDATION_ERROR', `Unknown time zone "${timezone}"; use an IANA name such as Europe/Berlin`, { field: 'timezone' });
    }
    if ([...this.schedules.values()].filter((row) => row.projectId === projectId).length >= 25) {
      throw new HttpFailure(409, 'SCHEDULE_QUOTA_EXCEEDED', 'A project can have 25 active schedules; pause or delete one first', { limit: 25, kind: 'active' });
    }
    const row: FakeSchedule = { id: randomUUID(), projectId, body: b, ownerId: pat.userId };
    this.schedules.set(row.id, row);
    return this.scheduleView(row);
  }

  private scheduleView(row: FakeSchedule): Json {
    const b = row.body;
    const hour = typeof b.hour === 'number' ? b.hour : 0;
    const minute = typeof b.minute === 'number' ? b.minute : 0;
    return {
      id: row.id, projectId: row.projectId, title: str(b.title) ?? '', description: str(b.description) ?? null, priority: str(b.priority) ?? 'medium',
      labelIds: stringArray(b.labelIds) ?? [], assigneeId: str(b.assigneeId) ?? null, cadence: str(b.cadence) ?? 'daily',
      weekday: typeof b.weekday === 'number' ? b.weekday : null, dayOfMonth: typeof b.dayOfMonth === 'number' ? b.dayOfMonth : null,
      hour, minute, timezone: str(b.timezone) ?? 'UTC',
      cadenceText: `${str(b.cadence) ?? 'daily'} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${str(b.timezone) ?? 'UTC'})`,
      nextRunAt: new Date(Date.parse(this.now()) + 86_400_000).toISOString(), lastRunAt: null, pausedAt: null, pauseReason: null,
      ownerId: row.ownerId, createdById: row.ownerId, createdAt: this.now(), updatedAt: this.now(),
    };
  }

  // ─── W17b plans (services/plans.ts, simplified) ───────────────────────────

  private planSpec(value: unknown): { summary?: string; tasks: FakePlanTask[] } {
    const spec = value as { summary?: string; tasks?: FakePlanTask[] } | undefined;
    const tasks = Array.isArray(spec?.tasks) ? spec.tasks : [];
    const keys = new Set<string>();
    const issues: Json[] = [];
    for (const task of tasks) {
      if (keys.has(task.key)) issues.push({ code: 'DUPLICATE_KEY', message: `Task keys must be unique: ${task.key}`, keys: [task.key] });
      keys.add(task.key);
    }
    for (const task of tasks) {
      for (const blocker of task.blockedBy ?? []) {
        if (blocker === task.key) issues.push({ code: 'SELF_BLOCK', message: `A task cannot block itself: ${task.key}`, keys: [task.key] });
        else if (!keys.has(blocker)) issues.push({ code: 'UNKNOWN_BLOCKER', message: `Blocked by tasks that are not in the plan: ${task.key} → ${blocker}`, keys: [task.key] });
      }
    }
    if (issues.length === 0 && this.planOrder(tasks).length < tasks.length) {
      const order = this.planOrder(tasks);
      const looped = tasks.map((task) => task.key).filter((key) => !order.includes(key));
      issues.push({ code: 'CYCLE', message: `These tasks block each other in a loop: ${looped.join(', ')}`, keys: looped });
    }
    if (issues.length > 0) throw new HttpFailure(400, 'PLAN_INVALID', 'The plan has problems', { issues });
    return { ...(spec?.summary ? { summary: spec.summary } : {}), tasks };
  }

  private planOrder(tasks: FakePlanTask[]): string[] {
    const order: string[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const task of tasks) {
        if (order.includes(task.key) || !(task.blockedBy ?? []).every((key) => order.includes(key))) continue;
        order.push(task.key);
        progressed = true;
      }
    }
    return order;
  }

  private createPlan(projectId: string, b: Record<string, unknown>, pat: FakePat): Json {
    this.assertProject(projectId, pat);
    const spec = this.planSpec(b.spec);
    const plan: FakePlan = { id: randomUUID(), projectId, title: str(b.title) ?? 'Plan', status: 'draft', revisions: [{ number: 1, spec, approvedAt: null }], approvedRevision: null, links: new Map() };
    this.plans.set(plan.id, plan);
    return this.planView(plan, 1);
  }

  private revisePlan(plan: FakePlan, b: Record<string, unknown>): { status: number; body: unknown } {
    if (plan.status === 'archived') throw new HttpFailure(409, 'PLAN_ARCHIVED', 'This plan is archived');
    if (Number(b.baseRevision) !== plan.revisions.length) {
      throw new HttpFailure(409, 'PLAN_REVISION_CONFLICT', `Revision ${plan.revisions.length} is the latest; revise from it`, { latestRevision: plan.revisions.length });
    }
    const spec = this.planSpec(b.spec);
    const latest = plan.revisions.at(-1);
    if (latest && JSON.stringify(latest.spec) === JSON.stringify(spec)) return { status: 200, body: { unchanged: true, plan: this.planView(plan, plan.revisions.length) } };
    plan.revisions.push({ number: plan.revisions.length + 1, spec, approvedAt: null });
    if (str(b.title)) plan.title = str(b.title) ?? plan.title;
    return { status: 201, body: { unchanged: false, plan: this.planView(plan, plan.revisions.length) } };
  }

  private approvePlan(plan: FakePlan, revision: number, pat: FakePat): Json {
    if (revision !== plan.revisions.length) throw new HttpFailure(409, 'PLAN_REVISION_STALE', 'Not the latest revision', { latestRevision: plan.revisions.length });
    const empty = { alreadyApproved: true, created: [], updated: [], removed: [], skipped: [], dependencies: { added: 0, removed: 0 } };
    if (plan.approvedRevision === revision) return { approval: empty, plan: this.planView(plan, revision) };
    const spec = plan.revisions[revision - 1]?.spec ?? { tasks: [] };
    const created: Json[] = [];
    for (const task of spec.tasks) {
      if (plan.links.has(task.key)) continue;
      const row = this.addTask({ title: task.title, projectId: plan.projectId, creatorId: pat.userId, priority: task.priority ?? 'medium' });
      plan.links.set(task.key, row.id);
      created.push({ key: task.key, taskId: row.id, identifier: row.identifier });
    }
    let added = 0;
    for (const task of spec.tasks) {
      for (const blocker of task.blockedBy ?? []) {
        const edge = { taskId: plan.links.get(task.key) ?? '', dependsOnTaskId: plan.links.get(blocker) ?? '' };
        if (!this.dependencies.some((e) => e.taskId === edge.taskId && e.dependsOnTaskId === edge.dependsOnTaskId)) {
          this.dependencies.push(edge);
          added += 1;
        }
      }
    }
    const target = plan.revisions[revision - 1];
    if (target) target.approvedAt = new Date(this.now()).toISOString();
    plan.approvedRevision = revision;
    plan.status = 'approved';
    return { approval: { ...empty, alreadyApproved: false, created, dependencies: { added, removed: 0 } }, plan: this.planView(plan, revision) };
  }

  private planView(plan: FakePlan, number: number): Json {
    const revision = plan.revisions[number - 1];
    if (!revision) throw new HttpFailure(404, 'PLAN_REVISION_NOT_FOUND', `Revision ${number} does not exist`);
    const previous = plan.revisions[number - 2];
    const untestable = revision.spec.tasks.filter((task) => !task.acceptance?.length).map((task) => task.key);
    const keysOf = (tasks: FakePlanTask[]) => tasks.map((task) => task.key);
    return {
      id: plan.id,
      projectId: plan.projectId,
      title: plan.title,
      status: plan.status,
      latestRevision: plan.revisions.length,
      approvedRevision: plan.approvedRevision,
      revision: {
        number,
        spec: revision.spec,
        order: this.planOrder(revision.spec.tasks),
        errors: [],
        warnings: untestable.length ? [{ code: 'NO_ACCEPTANCE', message: `No acceptance checks: ${untestable.join(', ')}`, keys: untestable }] : [],
        approvedAt: revision.approvedAt,
        diff: previous
          ? {
              added: keysOf(revision.spec.tasks).filter((key) => !keysOf(previous.spec.tasks).includes(key)),
              removed: keysOf(previous.spec.tasks).filter((key) => !keysOf(revision.spec.tasks).includes(key)),
              changed: revision.spec.tasks
                .filter((task) => { const old = previous.spec.tasks.find((p) => p.key === task.key); return old && JSON.stringify(old) !== JSON.stringify(task); })
                .map((task) => ({ key: task.key, fields: ['changed'] })),
            }
          : null,
      },
      tasks: [...plan.links].flatMap(([key, taskId]) => {
        const task = this.tasks.get(taskId);
        return task ? [{ key, id: task.id, identifier: task.identifier, title: task.title, status: task.status }] : [];
      }),
    };
  }

  private planOf(taskId: string): Json | null {
    for (const plan of this.plans.values()) {
      for (const [key, id] of plan.links) if (id === taskId) return { id: plan.id, key, title: plan.title, status: plan.status };
    }
    return null;
  }

  /** services/task-dependencies.ts `readTaskDependencies`. */
  private dependencyLists(task: FakeTask): { blockedBy: Json[]; blocking: Json[] } {
    const ref = (id: string) => {
      const other = this.tasks.get(id);
      return other ? { ...this.taskRef(other), archived: other.archived, resolved: other.status === 'done' } : null;
    };
    return {
      blockedBy: this.dependencies.filter((edge) => edge.taskId === task.id).flatMap((edge) => ref(edge.dependsOnTaskId) ?? []),
      blocking: this.dependencies.filter((edge) => edge.dependsOnTaskId === task.id).flatMap((edge) => ref(edge.taskId) ?? []),
    };
  }

  /** services/task-dependencies.ts `addTaskDependency`: same scope, no self-edge, acyclic, idempotent. */
  private addDependency(task: FakeTask, dependsOnTaskId: string, pat: FakePat): boolean {
    if (!UUID.test(dependsOnTaskId)) throw validation({ dependsOnTaskId: ['Invalid uuid'] });
    if (dependsOnTaskId === task.id) throw new HttpFailure(400, 'DEPENDENCY_SELF', 'A task cannot block itself');
    const blocker = this.assertTask(dependsOnTaskId, pat);
    const scope = (t: FakeTask) => (t.projectId ? `p:${t.projectId}` : t.teamId ? `t:${t.teamId}` : null);
    if (!scope(task) || scope(task) !== scope(blocker)) {
      throw new HttpFailure(400, 'DEPENDENCY_SCOPE', 'A task can only be blocked by a task in the same project');
    }
    if (this.dependencies.some((edge) => edge.taskId === task.id && edge.dependsOnTaskId === dependsOnTaskId)) return false;
    const upstream = new Set<string>();
    const queue = [dependsOnTaskId];
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      for (const edge of this.dependencies) {
        if (edge.taskId === current && !upstream.has(edge.dependsOnTaskId)) {
          upstream.add(edge.dependsOnTaskId);
          queue.push(edge.dependsOnTaskId);
        }
      }
    }
    if (upstream.has(task.id)) {
      throw new HttpFailure(409, 'DEPENDENCY_CYCLE', `${blocker.identifier ?? blocker.title} already waits on ${task.identifier ?? task.title}, so ${task.identifier ?? task.title} cannot also wait on it`);
    }
    this.dependencies.push({ taskId: task.id, dependsOnTaskId });
    return true;
  }

  /** GET /api/tasks: listTasksQuerySchema, then buildTaskListWhere, then offset or keyset paging. */
  private listTasks(q: URLSearchParams, pat: FakePat): Json {
    const fieldErrors: Record<string, string[]> = {};
    const one = (name: string) => q.get(name) ?? undefined;
    const check = (name: string, valid: (value: string) => boolean, message = 'Invalid input') => {
      const value = one(name);
      if (value !== undefined && !valid(value)) fieldErrors[name] = [message];
      return value;
    };
    const teamId = check('teamId', (v) => UUID.test(v), 'Invalid uuid');
    const projectId = check('projectId', (v) => UUID.test(v), 'Invalid uuid');
    const assignee = check('assignee', (v) => v === 'me' || v === 'none' || UUID.test(v));
    const creator = check('creator', (v) => v === 'me' || UUID.test(v));
    const status = listParam(q, 'status');
    if (status && (status.length > 4 || !status.every((s) => STATUSES.includes(s)))) fieldErrors.status = ['Invalid enum value'];
    const labelIds = listParam(q, 'labelId');
    if (labelIds && (labelIds.length > 20 || !labelIds.every((id) => UUID.test(id)))) fieldErrors.labelId = ['Invalid uuid'];
    const rawText = one('q');
    const text = rawText?.trim();
    if (rawText !== undefined && (!text || text.length > 200)) fieldErrors.q = ['String must contain 1-200 character(s)'];
    const identifier = this.identifierFilterMissing
      ? undefined
      : check('identifier', (v) => /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/.test(v.trim()), 'Invalid')?.trim().toLowerCase();
    const parentId = check('parentId', (v) => v === 'none' || UUID.test(v));
    const pagination = check('pagination', (v) => v === 'offset' || v === 'cursor', 'Invalid enum value');
    const cursor = check('cursor', (v) => v.length >= 1 && v.length <= 512);
    const includeTotal = check('includeTotal', (v) => v === 'true' || v === 'false', 'Invalid enum value');
    const view = check('view', (v) => v === 'full' || v === 'compact', 'Invalid enum value');
    const page = Number(one('page') ?? 1);
    if (!Number.isInteger(page) || page < 1) fieldErrors.page = ['Number must be greater than or equal to 1'];
    const pageSize = Number(one('pageSize') ?? 50);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) fieldErrors.pageSize = ['Number must be between 1 and 200'];
    if (Object.keys(fieldErrors).length > 0) throw validation(fieldErrors);

    const cursorMode = cursor !== undefined || pagination === 'cursor';
    if (cursorMode && pagination === 'offset') {
      throw new HttpFailure(400, 'PAGINATION_CONFLICT', 'cursor cannot be combined with pagination=offset');
    }
    if (cursorMode && q.has('page')) {
      throw new HttpFailure(400, 'PAGINATION_CONFLICT', 'page cannot be combined with cursor pagination; follow nextCursor instead');
    }
    const position = cursorMode && cursor ? decodeCursor(cursor) : null;

    const userTeams = [...this.teams.values()].filter((team) => team.members.has(pat.userId));
    if (teamId && !userTeams.some((team) => team.id === teamId)) {
      throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'team', resourceId: teamId });
    }
    if (projectId) this.assertProject(projectId, pat);
    const resolveUser = (value: string): string => {
      if (value === 'me') return pat.userId;
      if (!userTeams.some((team) => team.members.has(value))) {
        throw new HttpFailure(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'user', resourceId: value });
      }
      return value;
    };
    const assigneeId = assignee === undefined || assignee === 'none' ? undefined : resolveUser(assignee);
    const assigneeMatch =
      assignee === undefined ? undefined : (task: FakeTask) => task.assigneeId === (assignee === 'none' ? null : assigneeId);
    const creatorId = creator === undefined ? undefined : resolveUser(creator);
    const needle = text?.toLowerCase();

    const matching = [...this.tasks.values()]
      .filter((t) => !t.archived && this.canSeeTask(t, pat))
      .filter((t) => !teamId || t.teamId === teamId)
      .filter((t) => !projectId || t.projectId === projectId)
      .filter((t) => {
        // The API ORs assignee and creator when both are given.
        if (assigneeMatch && creatorId) return assigneeMatch(t) || t.creatorId === creatorId;
        if (assigneeMatch) return assigneeMatch(t);
        if (creatorId) return t.creatorId === creatorId;
        return true;
      })
      .filter((t) => !status || status.includes(t.status))
      .filter((t) => !labelIds || t.labelIds.some((id) => labelIds.includes(id)))
      .filter((t) => !parentId || t.parentId === (parentId === 'none' ? null : parentId))
      .filter((t) => !needle || [t.title, t.description, t.identifier].some((value) => value?.toLowerCase().includes(needle)))
      .filter((t) => !identifier || t.identifier?.toLowerCase() === identifier)
      .sort(listOrder);
    const compact = view === 'compact';

    if (!cursorMode) {
      const items = matching.slice((page - 1) * pageSize, page * pageSize);
      const hasMore = page * pageSize < matching.length;
      const last = items.at(-1);
      return {
        items: items.map((t) => this.taskView(t, compact)),
        total: matching.length,
        page,
        pageSize,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last) : null,
      };
    }
    const after = position
      ? matching.filter((t) => t.createdAt < position.createdAt || (t.createdAt === position.createdAt && t.id < position.id))
      : matching;
    const rows = after.slice(0, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items.at(-1);
    return {
      items: items.map((t) => this.taskView(t, compact)),
      pageSize,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      ...(includeTotal === 'true' ? { total: matching.length } : {}),
    };
  }

  private search(q: URLSearchParams, pat: FakePat): Json {
    const term = (q.get('q') ?? '').toLowerCase();
    if (term.length < 2) throw validation({ q: ['Query must be at least 2 characters'] });
    const types = (q.get('types') ?? 'tasks,projects,teams').split(',');
    const limit = Number(q.get('limit') ?? 20);
    const perType = Math.max(1, Math.ceil(limit / types.length));
    const projects = this.visibleProjects(pat);
    const visible = new Set(projects.map((p) => p.id));
    const has = (...values: Array<string | null>) => values.some((value) => value?.toLowerCase().includes(term));
    return {
      tasks: types.includes('tasks')
        ? [...this.tasks.values()]
            .filter((t) => !t.archived && this.canSeeTask(t, pat) && has(t.title, t.description, t.identifier))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, perType)
            .map((t) => ({
              id: t.id,
              title: t.title,
              identifier: t.identifier,
              status: t.status,
              priority: t.priority,
              projectId: t.projectId,
              teamId: t.teamId,
              type: 'task',
            }))
        : [],
      projects: types.includes('projects')
        ? projects
            .filter((p) => has(p.name, p.key))
            .slice(0, perType)
            .map((p) => ({ id: p.id, key: p.key, name: p.name, status: p.status, workspaceId: p.workspaceId, type: 'project' }))
        : [],
      teams: types.includes('teams')
        ? [...this.teams.values()]
            .filter((t) => visible.has(t.projectId) && has(t.name, t.key))
            .slice(0, perType)
            .map((t) => ({ id: t.id, name: t.name, key: t.key, projectId: t.projectId, type: 'team' }))
        : [],
    };
  }
}
