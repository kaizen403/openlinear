/**
 * Query-key factory for the desktop/web client data layer (TanStack Query).
 *
 * Hierarchy: `ol` → workspace → project/team → resource. Every key starts
 * with `ol`, so `['ol']` matches the whole cache (resync, sign-out).
 *
 * - Workspace-owned lists (projects, teams, members, chat sessions) live under
 *   `['ol', 'ws', workspaceId, …]`, so switching or leaving a workspace can
 *   invalidate exactly that subtree.
 * - Project- and team-owned resources (labels, team members) live under
 *   `['ol', 'project', id, …]` / `['ol', 'team', id, …]`: their SSE events
 *   carry the project/team id but not the workspace id.
 * - Tasks live under `['ol', 'tasks', …]`, keyed by their list scope: task
 *   events carry `projectId`/`teamId`, never a workspace id, and the same task
 *   can sit in several lists (board, "my issues", project issues).
 *
 * Keys only ever contain JSON-serialisable values with stable field order;
 * the param objects below are built by these helpers, never by callers.
 */

export type TaskListFilter = 'assigned' | 'created' | 'all'

/** The board's list: `GET /api/tasks?pageSize=200[&projectId][&teamId]`. */
export interface BoardTaskScope {
  kind: 'board'
  projectId: string | null
  teamId: string | null
  /**
   * Cursor-pagination seam (API keyset pagination is landing additively):
   * when the board pages, the cursor goes into the page fetch, NOT into this
   * key — one board list per scope, pages appended in place (see
   * `fetchBoardTasks` in lib/query/task-queries.ts).
   */
  pageSize: number
}

/** "My issues": `GET /api/tasks[?assignee=me|?creator=me]`. */
export interface MyIssuesScope {
  kind: 'mine'
  filter: TaskListFilter
}

/** Project issues list: `GET /api/tasks?projectId=…`. */
export interface ProjectIssuesScope {
  kind: 'project-issues'
  projectId: string
}

export type TaskListScope = BoardTaskScope | MyIssuesScope | ProjectIssuesScope

export const BOARD_PAGE_SIZE = 200

export function boardTaskScope(projectId?: string | null, teamId?: string | null): BoardTaskScope {
  return { kind: 'board', projectId: projectId ?? null, teamId: teamId ?? null, pageSize: BOARD_PAGE_SIZE }
}

/** Field selections are part of the key: two field sets are two cache entries. */
function fieldsParam(fields: readonly string[] | undefined): string | null {
  return fields && fields.length > 0 ? [...fields].sort().join(',') : null
}

export const queryKeys = {
  all: ['ol'] as const,

  workspaces: {
    list: () => ['ol', 'workspaces'] as const,
    /** Everything owned by one workspace. */
    scope: (workspaceId: string) => ['ol', 'ws', workspaceId] as const,
    members: (workspaceId: string) => ['ol', 'ws', workspaceId, 'members'] as const,
    chatSessions: (workspaceId: string) => ['ol', 'ws', workspaceId, 'chat-sessions'] as const,
    /** `GET /api/workspaces/:id/structure?view=summary` (Settings → Workspaces). */
    structureSummary: (workspaceId: string) => ['ol', 'ws', workspaceId, 'structure', 'summary'] as const,
  },

  /** `GET /api/runners` on the sidecar (FE-02 runner picker). */
  runners: () => ['ol', 'runners'] as const,
  /** `GET /api/sandbox/grants` on the sidecar (FE-03 project trust grants). */
  sandboxGrants: () => ['ol', 'sandbox', 'grants'] as const,
  projects: {
    /** Prefix of every project list in one workspace. */
    lists: (workspaceId: string) => ['ol', 'ws', workspaceId, 'projects'] as const,
    list: (workspaceId: string, params: { teamId?: string | null; fields?: readonly string[] }) =>
      ['ol', 'ws', workspaceId, 'projects', { teamId: params.teamId ?? null, fields: fieldsParam(params.fields) }] as const,
    scope: (projectId: string) => ['ol', 'project', projectId] as const,
    labels: (projectId: string) => ['ol', 'project', projectId, 'labels'] as const,
    /** `GET /api/projects/:id` (project settings). */
    detail: (projectId: string) => ['ol', 'project', projectId, 'detail'] as const,
    /** `GET /api/projects/:id/access` (project settings). */
    access: (projectId: string) => ['ol', 'project', projectId, 'access'] as const,
    /** `GET /api/projects/:id/verification-settings` (W11a). */
    verification: (projectId: string) => ['ol', 'project', projectId, 'verification'] as const,
    /** `GET /api/github-app/projects/:id/installation` (W10a). */
    githubApp: (projectId: string) => ['ol', 'project', projectId, 'github-app'] as const,
    /**
     * Every project the user can see, across workspaces, as `{ id, name }`
     * (`GET /api/projects?fields=id,name`): the Teams page's create dialog.
     */
    directory: () => ['ol', 'projects', 'directory'] as const,
  },

  teams: {
    lists: (workspaceId: string) => ['ol', 'ws', workspaceId, 'teams'] as const,
    list: (workspaceId: string, params: { projectId?: string | null; fields?: readonly string[] }) =>
      ['ol', 'ws', workspaceId, 'teams', { projectId: params.projectId ?? null, fields: fieldsParam(params.fields) }] as const,
    scope: (teamId: string) => ['ol', 'team', teamId] as const,
    members: (teamId: string) => ['ol', 'team', teamId, 'members'] as const,
    /** `GET /api/teams/:id`: the full team with members (team settings, Settings → Members). */
    detail: (teamId: string) => ['ol', 'team', teamId, 'detail'] as const,
    /** Prefix of every team directory list. */
    directories: () => ['ol', 'teams', 'directory'] as const,
    /**
     * The Teams page: every team the user can see across workspaces, full
     * rows (`GET /api/teams[?projectId=…]`). Not workspace-scoped, because the
     * page lists all of them (the command palette opens it unfiltered).
     */
    directory: (projectId?: string | null) => ['ol', 'teams', 'directory', { projectId: projectId ?? null }] as const,
  },

  notifications: {
    all: () => ['ol', 'notifications'] as const,
    /** The inbox list (`GET /api/notifications?pageSize=…`). */
    list: (pageSize: number) => ['ol', 'notifications', 'list', { pageSize }] as const,
    /** The unread badge (sidebar) and the inbox header count. */
    unreadCount: () => ['ol', 'notifications', 'unread-count'] as const,
  },

  /**
   * Archived tasks (`GET /api/tasks/archived`). Outside `['ol','tasks']` on
   * purpose: the first stream `connected` resyncs task lists, and the archive
   * page never refetched on connect.
   */
  archivedTasks: () => ['ol', 'archived-tasks'] as const,

  tasks: {
    all: () => ['ol', 'tasks'] as const,
    lists: () => ['ol', 'tasks', 'list'] as const,
    list: (scope: TaskListScope) => ['ol', 'tasks', 'list', scope] as const,
    details: () => ['ol', 'tasks', 'detail'] as const,
    detail: (taskId: string) => ['ol', 'tasks', 'detail', taskId] as const,
    comments: (taskId: string) => ['ol', 'tasks', 'detail', taskId, 'comments'] as const,
    /**
     * The agent's local diff for the task's latest attempt (sidecar). Each
     * response carries `head.sha` + a content `revision`; the review hook keeps
     * the cached object when a refetch returns the same revision.
     */
    diffs: (taskId: string) => ['ol', 'tasks', 'detail', taskId, 'diff'] as const,
    diff: (taskId: string, base: string | null) => ['ol', 'tasks', 'detail', taskId, 'diff', { base }] as const,
    /** v2 run state (sidecar `GET /api/tasks/:id/run`). */
    runState: (taskId: string) => ['ol', 'tasks', 'detail', taskId, 'run'] as const,
    /** W17a "blocked by" / "blocking" (`GET /api/tasks/:id/dependencies`). */
    dependencies: (taskId: string) => ['ol', 'tasks', 'detail', taskId, 'dependencies'] as const,
  },

  /** W17b plans: `GET /api/projects/:id/plans` and `GET /api/plans/:id[?revision]`. */
  /** FE-14 webhooks: prefixes for invalidation (the full keys live in `lib/api/webhooks.ts` `webhookKeys`). */
  webhooks: {
    project: (projectId: string) => ['ol', 'project', projectId, 'webhooks'] as const,
    endpoint: (webhookId: string) => ['ol', 'webhooks', webhookId] as const,
    workspace: (workspaceId: string) => ['ol', 'workspace', workspaceId, 'webhooks'] as const,
  },
  /** W19b project knowledge: `GET /api/projects/:id/knowledge` and `GET /api/knowledge/:id` (with revisions). */
  knowledge: {
    list: (projectId: string) => ['ol', 'project', projectId, 'knowledge'] as const,
    detail: (entryId: string) => ['ol', 'knowledge', entryId] as const,
  },
  /** W20 recurring issues: `GET /api/projects/:id/schedules` and `GET /api/schedules/:id` (same shapes as `scheduleKeys`). */
  schedules: {
    list: (projectId: string) => ['ol', 'project', projectId, 'schedules', 'list'] as const,
    detail: (scheduleId: string) => ['ol', 'schedules', scheduleId] as const,
  },
  plans: {
    all: (projectId: string) => ['ol', 'project', projectId, 'plans'] as const,
    list: (projectId: string) => ['ol', 'project', projectId, 'plans', 'list'] as const,
    details: (planId: string) => ['ol', 'plans', planId] as const,
    /** `revision` null = the latest. */
    detail: (planId: string, revision: number | null) => ['ol', 'plans', planId, { revision }] as const,
  },

  /** The signed-in user's settings (`GET /api/settings`). */
  settings: () => ['ol', 'settings'] as const,
} as const

/** Read the list scope back out of a `queryKeys.tasks.list(...)` key. */
export function taskListScopeFromKey(queryKey: readonly unknown[]): TaskListScope | null {
  if (queryKey[0] !== 'ol' || queryKey[1] !== 'tasks' || queryKey[2] !== 'list') return null
  const scope = queryKey[3]
  if (typeof scope !== 'object' || scope === null || !('kind' in scope)) return null
  const kind = (scope as { kind: unknown }).kind
  return kind === 'board' || kind === 'mine' || kind === 'project-issues' ? (scope as TaskListScope) : null
}

/** `['ol','ws',id,'projects',…]` → id. */
export function workspaceIdFromKey(queryKey: readonly unknown[]): string | null {
  return queryKey[0] === 'ol' && queryKey[1] === 'ws' && typeof queryKey[2] === 'string' ? queryKey[2] : null
}

/** The `{teamId, fields}` params of a project list key. */
export function projectListParamsFromKey(queryKey: readonly unknown[]): { teamId: string | null } | null {
  if (queryKey[0] !== 'ol' || queryKey[1] !== 'ws' || queryKey[3] !== 'projects') return null
  const params = queryKey[4]
  if (typeof params !== 'object' || params === null) return { teamId: null }
  const teamId = (params as { teamId?: unknown }).teamId
  return { teamId: typeof teamId === 'string' ? teamId : null }
}
