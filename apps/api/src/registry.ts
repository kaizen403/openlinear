/**
 * API route inventory and PAT policy (W02a inventory, W02b enforcement).
 *
 * One row per route actually registered by `createApp()`. This table is the
 * single source of truth for what a personal access token may do: the auth
 * middleware looks up the matched route here on every PAT request and
 * enforces the row (`resolvePatPolicy` / `findRouteDeclaration`):
 *   - a route missing from this table refuses every PAT (default deny);
 *   - `auth: 'session'` (and `stream`/`public`) rows refuse PATs;
 *   - the PAT must satisfy every scope in `patScopes` (plus any scope the
 *     route passes to `requireAuth([...])`);
 *   - a workspace-bound PAT is refused on `workspaceBinding: 'refused'` rows.
 *
 * It is machine-checked by `__tests__/route-inventory.test.ts` (parity with
 * the live router, HTTP probes of every row) and `__tests__/pat-policy.test.ts`
 * (default deny, binding stances, per-module read/write scope matrix).
 */

/**
 * - `session`: interactive session only; PATs get 403 SESSION_REQUIRED.
 * - `session_or_pat`: session JWT or PAT holding `patScopes`.
 * - `optional`: anonymous allowed; credentials, if sent, are validated.
 * - `stream`: `/api/events` authenticates itself (SSE ticket or session JWT;
 *   PATs refused).
 * - `capability`: W03a attempt callbacks; only the attempt's run-scoped
 *   execution capability (`olx_…`) is accepted. Session JWTs and PATs get 401.
 * - `public`: no principal.
 */
export type AuthMode = 'session' | 'session_or_pat' | 'public' | 'optional' | 'stream' | 'capability';

/** Where the resource decision is made, all fed by the request principal. */
export type EnforcementPoint =
  | 'none' // public route, no principal
  | 'self' // the caller's own rows (userId predicate)
  | 'task' // assertTaskAccess / assertTaskOwned
  | 'project' // assertProjectAccess
  | 'team' // assertTeamRole
  | 'workspace' // assertWorkspaceRole (or membership check + principal workspace)
  | 'comment' // assertCommentAccess
  | 'chat-session' // owner + assertWorkspaceRole + assertProjectAccess / scopedProjectWhere
  | 'scoped-list' // scopedTaskWhere / scopedProjectWhere / scopedTeamWhere / scopedActivityWhere
  | 'repository' // repository.userId === caller (account-level)
  | 'stream' // SSE principal + canReceiveEvent per live/replayed event
  | 'membership-entry' // invite code / invitation / new workspace + assertPrincipalMayEnterWorkspace
  | 'attempt'; // W03a capability bound to one attempt + attempt state + recorded task fences

/**
 * What a workspace-bound PAT (`PersonalAccessToken.workspaceId`) may do on a
 * route. Default deny: account-level data is `refused` unless the row is an
 * explicitly justified, non-sensitive read.
 *
 * - `enforced`: the resource is workspace-scoped and the policy helpers
 *   confine a bound PAT to its workspace.
 * - `account-read`: a GET of account-level data that a bound PAT may read;
 *   requires `bindingJustification`.
 * - `refused`: account-level data; the middleware answers a bound PAT with
 *   403 PAT_WORKSPACE_RESTRICTED before the handler runs.
 * - `not-applicable`: PATs cannot call the route at all.
 */
export type WorkspaceBinding = 'enforced' | 'account-read' | 'refused' | 'not-applicable';

/** Tenant resource named by a path parameter (drives cross-tenant probes). */
export type ResourceParam =
  | 'task'
  | 'project'
  | 'team'
  | 'workspace'
  | 'comment'
  | 'label'
  | 'chatSession'
  | 'agentRun'
  | 'repository'
  | 'notification'
  | 'invitation'
  | 'session'
  | 'pat'
  | 'user'
  | 'upload'
  | 'plan'
  | 'schedule'
  | 'knowledge'
  | 'webhook'
  | 'webhookDelivery';

export interface RouteDeclaration {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  auth: AuthMode;
  /** Permission name. `none` only for public routes. */
  scope: string;
  /**
   * PAT scopes the middleware requires (all of them). Families:
   *   tasks:read / tasks:write   — tasks, comments, task labels, agent runs,
   *                                inbox, notifications, activity, usage
   *   projects:read / projects:write — projects, teams, labels (read)
   *   labels:write               — label create/update/delete
   *   workspaces:read            — workspaces, members, own invitations
   *   admin                      — membership, access grants, invitations,
   *                                workspace lifecycle, audit log, SCM token
   *   account:read / account:write — the caller's own account data
   *                                (settings, repositories, uploads, MCP
   *                                usage, notification preferences)
   *   chat:read / chat:write     — chat sessions and messages
   * `account:*` and `chat:*` are requirement names, not mintable scopes: only
   * the generic `read`/`write`/`admin` scopes satisfy them (narrow scopes
   * such as `tasks:write` do not). Generic `read`/`write` requirements, which
   * any narrow scope satisfies, need a `scopeJustification`.
   */
  patScopes: string[];
  enforcement: EnforcementPoint;
  /** Function(s) making the decision, for reviewers. */
  enforcedBy: string;
  workspaceBinding: WorkspaceBinding;
  params?: Readonly<Record<string, ResourceParam>>;
  /** Why a workspace-bound PAT may read this account-level route. */
  bindingJustification?: string;
  /** Why a generic `read`/`write` requirement is acceptable here. */
  scopeJustification?: string;
}

type Method = RouteDeclaration['method'];

interface RouteOptions {
  params?: Readonly<Record<string, ResourceParam>>;
  bindingJustification?: string;
  scopeJustification?: string;
}

function route(
  method: Method,
  path: string,
  auth: AuthMode,
  scope: string,
  patScopes: string[],
  enforcement: EnforcementPoint,
  enforcedBy: string,
  workspaceBinding: WorkspaceBinding,
  options: RouteOptions = {},
): RouteDeclaration {
  return {
    method,
    path,
    auth,
    scope,
    patScopes,
    enforcement,
    enforcedBy,
    workspaceBinding,
    ...(options.params ? { params: options.params } : {}),
    ...(options.bindingJustification ? { bindingJustification: options.bindingJustification } : {}),
    ...(options.scopeJustification ? { scopeJustification: options.scopeJustification } : {}),
  };
}

const TR = ['tasks:read'];
const TW = ['tasks:write'];
const PR = ['projects:read'];
const PW = ['projects:write'];
const LW = ['labels:write'];
const WR = ['workspaces:read'];
const ADMIN = ['admin'];
const AR = ['account:read'];
const AW = ['account:write'];
const CR = ['chat:read'];
const CW = ['chat:write'];

const IDENTITY_JUSTIFICATION =
  'Identity of the token owner (id, names, email, avatar, security flags). Clients need it to show who they act as; it carries no data from any workspace and no secret.';

function pub(method: Method, path: string): RouteDeclaration {
  return route(method, path, 'public', 'none', [], 'none', 'public', 'not-applicable');
}

function sessionOnly(
  method: Method,
  path: string,
  scope: string,
  enforcement: EnforcementPoint,
  enforcedBy: string,
  params?: Readonly<Record<string, ResourceParam>>,
): RouteDeclaration {
  return route(method, path, 'session', scope, [], enforcement, enforcedBy, 'not-applicable', params ? { params } : {});
}

/** W03a attempt callback: run-scoped capability only (`execution:<scope>`). */
function attemptCallback(path: string, capabilityScope: string, enforcedBy: string): RouteDeclaration {
  return route('POST', path, 'capability', capabilityScope, [], 'attempt', enforcedBy, 'not-applicable');
}

export const ROUTE_REGISTRY: RouteDeclaration[] = [
  pub('GET', '/livez'),
  pub('GET', '/readyz'),
  pub('GET', '/health'),

  // Auth
  pub('GET', '/api/auth/providers'),
  pub('GET', '/api/auth/github'),
  pub('GET', '/api/auth/github/callback'),
  pub('POST', '/api/auth/desktop/authorize'),
  pub('POST', '/api/auth/desktop/token'),
  pub('POST', '/api/auth/refresh'),
  route('GET', '/api/auth/me', 'session_or_pat', 'self', AR, 'self', 'req.userId', 'account-read', { bindingJustification: IDENTITY_JUSTIFICATION }),
  route('PATCH', '/api/auth/me', 'session_or_pat', 'self', AW, 'self', 'disabled (501)', 'refused'),
  // A PAT has no session to end; logout is a session operation.
  sessionOnly('POST', '/api/auth/logout', 'self', 'self', 'revokeSessionByTokenHash'),
  sessionOnly('POST', '/api/auth/2fa/setup', 'self', 'self', 'requireInteractiveSession'),
  sessionOnly('POST', '/api/auth/2fa/verify', 'self', 'self', 'requireInteractiveSession + consumeTotpCode'),
  sessionOnly('POST', '/api/auth/2fa/disable', 'self', 'self', 'requireInteractiveSession + consumeTotpCode'),
  pub('POST', '/api/auth/2fa/validate'),
  pub('GET', '/api/auth/sso/check'),
  pub('GET', '/api/auth/sso/callback'),

  // Credentials (interactive session only)
  sessionOnly('GET', '/api/sessions', 'self', 'self', 'listActiveSessions(userId)'),
  sessionOnly('DELETE', '/api/sessions/:id', 'self', 'self', 'revokeSession(id, userId)', { id: 'session' }),
  sessionOnly('POST', '/api/sessions/revoke-others', 'self', 'self', 'revokeAllOtherSessions(userId, req.sessionId)'),
  sessionOnly('GET', '/api/pats', 'self', 'self', 'personalAccessToken.userId'),
  sessionOnly('POST', '/api/pats', 'self', 'self', 'workspace membership for workspaceId'),
  sessionOnly('DELETE', '/api/pats/:id', 'self', 'self', 'personalAccessToken.userId', { id: 'pat' }),
  sessionOnly('POST', '/api/events/ticket', 'self', 'self', 'requireInteractiveSession; ticket bound to req.sessionId'),

  // Realtime
  route('GET', '/api/events', 'stream', 'sse', [], 'stream', 'ticket/session + resolveTenancyContext + canReceiveEvent + replayVisibleSince(principal)', 'not-applicable'),

  // Users
  route('GET', '/api/users/me', 'session_or_pat', 'self', AR, 'self', 'req.userId', 'account-read', { bindingJustification: IDENTITY_JUSTIFICATION }),
  sessionOnly('PATCH', '/api/users/me', 'self', 'self', 'requireInteractiveSession'),
  sessionOnly('POST', '/api/users/me/email-change', 'self', 'self', 'requireInteractiveSession'),
  sessionOnly('POST', '/api/users/me/email-change/confirm', 'self', 'self', 'requireInteractiveSession'),
  route('GET', '/api/users/me/scm-token', 'session_or_pat', 'self', ADMIN, 'self', 'req.userId', 'refused'),

  // Repositories (account-level; GET /:id is workspace-scoped through project linkage for bound PATs)
  route('POST', '/api/repos/url', 'session_or_pat', 'repo:write', AW, 'repository', 'addRepositoryByUrl(userId)', 'refused'),
  route('GET', '/api/repos/active/public', 'session_or_pat', 'repo:read', AR, 'repository', 'repository.userId', 'refused'),
  route('GET', '/api/repos/public', 'session_or_pat', 'repo:list', AR, 'repository', 'repository.userId', 'refused'),
  route('POST', '/api/repos/:id/activate/public', 'session_or_pat', 'repo:write', AW, 'repository', 'repository.userId', 'refused', { params: { id: 'repository' } }),
  route('GET', '/api/repos', 'session_or_pat', 'repo:list', AR, 'repository', 'repository.userId', 'refused'),
  route('GET', '/api/repos/github', 'session_or_pat', 'repo:github', AR, 'repository', "caller's GitHub token", 'refused'),
  route('GET', '/api/repos/github/:owner/:repo/branches', 'session_or_pat', 'repo:github', AR, 'repository', "caller's GitHub token", 'refused'),
  route('POST', '/api/repos/import', 'session_or_pat', 'repo:write', AW, 'repository', 'repository.userId', 'refused'),
  route('POST', '/api/repos/:id/activate', 'session_or_pat', 'repo:write', AW, 'repository', 'repository.userId', 'refused', { params: { id: 'repository' } }),
  route('GET', '/api/repos/active', 'session_or_pat', 'repo:read', AR, 'repository', 'repository.userId', 'refused'),
  route('PATCH', '/api/repos/active/base-branch', 'session_or_pat', 'repo:write', AW, 'repository', 'repository.userId', 'refused'),
  route('GET', '/api/repos/:id', 'session_or_pat', 'repo:read', PR, 'repository', 'repository.userId; bound PAT: linked to a viewable project in its workspace', 'enforced', { params: { id: 'repository' } }),

  // Labels
  route('GET', '/api/labels', 'session_or_pat', 'label:list', PR, 'project', 'assertProjectMember(projectId)', 'enforced'),
  route('POST', '/api/labels', 'session_or_pat', 'label:write', LW, 'project', 'assertProjectOwned(projectId)', 'enforced'),
  route('PATCH', '/api/labels/:id', 'session_or_pat', 'label:write', LW, 'project', 'assertLabelWrite -> assertProjectOwned', 'enforced', { params: { id: 'label' } }),
  route('DELETE', '/api/labels/:id', 'session_or_pat', 'label:write', LW, 'project', 'assertLabelWrite -> assertProjectOwned', 'enforced', { params: { id: 'label' } }),
  route('POST', '/api/labels/tasks/:id/labels', 'session_or_pat', 'task:write', TW, 'task', 'assertTaskOwned + label.projectId === task.projectId (assertProjectMember before LABEL_NOT_IN_TASK_PROJECT)', 'enforced', { params: { id: 'task' } }),
  route('DELETE', '/api/labels/tasks/:id/labels/:labelId', 'session_or_pat', 'task:write', TW, 'task', 'assertTaskOwned', 'enforced', { params: { id: 'task', labelId: 'label' } }),

  // Tasks
  route('GET', '/api/tasks/archived', 'session_or_pat', 'task:list', TR, 'scoped-list', 'scopedTaskWhere(principal)', 'enforced'),
  route('DELETE', '/api/tasks/archived', 'session_or_pat', 'task:delete', TW, 'scoped-list', "scopedTaskWhere(principal, 'full')", 'enforced'),
  route('DELETE', '/api/tasks/archived/:id', 'session_or_pat', 'task:delete', TW, 'task', 'assertTaskOwned', 'enforced', { params: { id: 'task' } }),
  route('GET', '/api/tasks', 'session_or_pat', 'task:list', TR, 'scoped-list', 'task visibility as scopedProjectWhere/scopedTeamWhere id sets (scopedTaskWhere above 500) + assertProjectAccess(projectId) + team membership(teamId)', 'enforced'),
  route('POST', '/api/tasks', 'session_or_pat', 'task:create', TW, 'project', 'assertProjectOwned / assertTeamRole; assignees must be team members, labels in the task project', 'enforced'),
  route('POST', '/api/tasks/bulk', 'session_or_pat', 'task:create', TW, 'project', "assertProjectAccess('full') + assertTeamRole", 'enforced'),
  route('PATCH', '/api/tasks/bulk-status', 'session_or_pat', 'task:write', TW, 'project', "assertProjectAccess('full') (projectId) or assertTeamRole (teamId, project-less tasks) + assertTeamRole per task team", 'enforced'),
  route('POST', '/api/tasks/bulk-archive', 'session_or_pat', 'task:write', TW, 'project', "assertProjectAccess('full') (projectId) or assertTeamRole (teamId, project-less tasks) + assertTeamRole per task team", 'enforced'),
  route('POST', '/api/tasks/bulk-delete', 'session_or_pat', 'task:delete', TW, 'project', "assertProjectAccess('full') (projectId) or assertTeamRole (teamId, project-less tasks) + assertTeamRole per task team", 'enforced'),
  route('GET', '/api/tasks/similar', 'session_or_pat', 'task:list', TR, 'project', "assertProjectAccess('view'); read-only pg_trgm title similarity in that project", 'enforced'),
  route('GET', '/api/tasks/dependencies', 'session_or_pat', 'task:read', TR, 'task', "assertTaskAccess('view') per listed task; edges among them only", 'enforced'),
  route('GET', '/api/tasks/:id/dependencies/closure', 'session_or_pat', 'task:read', TR, 'task', "assertTaskAccess('view'); walk stays in the task's project/team (every edge does)", 'enforced', { params: { id: 'task' } }),
  route('GET', '/api/tasks/:id/dependencies', 'session_or_pat', 'task:read', TR, 'task', "assertTaskAccess('view'); edges stay inside the task's project/team", 'enforced', { params: { id: 'task' } }),
  route('POST', '/api/tasks/:id/dependencies', 'session_or_pat', 'task:write', TW, 'task', "assertTaskOwned + blocker assertTaskAccess('view') + same project/team + acyclic under advisory lock", 'enforced', { params: { id: 'task' } }),
  route('DELETE', '/api/tasks/:id/dependencies/:dependsOnTaskId', 'session_or_pat', 'task:write', TW, 'task', 'assertTaskOwned', 'enforced', { params: { id: 'task', dependsOnTaskId: 'task' } }),
  route('GET', '/api/tasks/:id', 'session_or_pat', 'task:read', TR, 'task', "assertTaskAccess('view')", 'enforced', { params: { id: 'task' } }),
  route('PATCH', '/api/tasks/:id', 'session_or_pat', 'task:write', TW, 'task', 'assertTaskOwned', 'enforced', { params: { id: 'task' } }),
  route('PATCH', '/api/tasks/:id/execution', 'session_or_pat', 'task:write', TW, 'task', "assertTaskAccess('full')", 'enforced', { params: { id: 'task' } }),
  route('DELETE', '/api/tasks/:id', 'session_or_pat', 'task:delete', TW, 'task', 'assertTaskOwned', 'enforced', { params: { id: 'task' } }),

  // Comments
  route('GET', '/api/tasks/:taskId/comments', 'session_or_pat', 'comment:list', TR, 'task', "assertTaskAccess('view')", 'enforced', { params: { taskId: 'task' } }),
  route('POST', '/api/tasks/:taskId/comments', 'session_or_pat', 'comment:create', TW, 'task', 'assertTaskOwned + filterUsersWithTaskAccess(mentions)', 'enforced', { params: { taskId: 'task' } }),
  route('PATCH', '/api/comments/:id', 'session_or_pat', 'comment:write', TW, 'comment', "assertCommentAccess('update')", 'enforced', { params: { id: 'comment' } }),
  route('DELETE', '/api/comments/:id', 'session_or_pat', 'comment:delete', TW, 'comment', "assertCommentAccess('delete')", 'enforced', { params: { id: 'comment' } }),

  // Settings (account-level)
  route('GET', '/api/settings', 'session_or_pat', 'settings', AR, 'self', 'req.userId', 'refused'),
  route('PATCH', '/api/settings', 'session_or_pat', 'settings', AW, 'self', 'req.userId', 'refused'),

  // Teams (belong to projects; membership is administration)
  route('GET', '/api/teams', 'optional', 'team:list', PR, 'scoped-list', 'scopedTeamWhere(principal)', 'enforced'),
  route('POST', '/api/teams', 'session_or_pat', 'team:create', PW, 'project', "assertProjectAccess('full')", 'enforced'),
  route('POST', '/api/teams/join', 'session_or_pat', 'team:join', ADMIN, 'membership-entry', 'invite code + assertPrincipalMayEnterWorkspace', 'enforced'),
  route('PATCH', '/api/teams/:id', 'session_or_pat', 'team:write', PW, 'team', 'assertTeamRole(owner|admin)', 'enforced', { params: { id: 'team' } }),
  route('DELETE', '/api/teams/:id', 'session_or_pat', 'team:delete', PW, 'team', 'assertTeamRole(owner)', 'enforced', { params: { id: 'team' } }),
  route('GET', '/api/teams/:id', 'session_or_pat', 'team:read', PR, 'team', 'assertTeamRole(member)', 'enforced', { params: { id: 'team' } }),
  route('GET', '/api/teams/:id/members', 'session_or_pat', 'team:read', PR, 'team', 'assertTeamRole(member)', 'enforced', { params: { id: 'team' } }),
  route('POST', '/api/teams/:id/members', 'session_or_pat', 'team:members', ADMIN, 'team', 'assertTeamRole(owner|admin)', 'enforced', { params: { id: 'team' } }),
  route('PATCH', '/api/teams/:id/members/:userId', 'session_or_pat', 'team:members', ADMIN, 'team', 'assertTeamRole(owner|admin)', 'enforced', { params: { id: 'team', userId: 'user' } }),
  route('DELETE', '/api/teams/:id/members/:userId', 'session_or_pat', 'team:members', ADMIN, 'team', 'assertTeamRole', 'enforced', { params: { id: 'team', userId: 'user' } }),

  // Projects
  route('GET', '/api/projects', 'optional', 'project:list', PR, 'scoped-list', 'projectAccessWhere / principalProjectScope', 'enforced'),
  route('POST', '/api/projects', 'session_or_pat', 'project:create', PW, 'workspace', 'assertWorkspaceRole(owner|admin|member); teamIds: assertTeamRole(owner|admin) + assertProjectAccess(full) on the team project; localPath needs an interactive session', 'enforced'),
  // Mounted with optionalAuth, but the handler answers 401 without a principal.
  route('GET', '/api/projects/:id', 'session_or_pat', 'project:read', PR, 'project', "optionalAuth + handler 401 + assertProjectAccess('view')", 'enforced', { params: { id: 'project' } }),
  route('PATCH', '/api/projects/:id', 'session_or_pat', 'project:write', PW, 'project', "assertProjectAccess('full'); teamIds: assertTeamRole(owner|admin) + assertProjectAccess(full) on the team project; localPath needs an interactive session", 'enforced', { params: { id: 'project' } }),
  route('DELETE', '/api/projects/:id', 'session_or_pat', 'project:delete', PW, 'project', "assertProjectAccess('full')", 'enforced', { params: { id: 'project' } }),
  // W17b reviewable plans.
  route('GET', '/api/projects/:id/plans', 'session_or_pat', 'plan:list', TR, 'project', "assertProjectAccess('view')", 'enforced', { params: { id: 'project' } }),
  route('POST', '/api/projects/:id/plans', 'session_or_pat', 'plan:create', TW, 'project', "assertProjectAccess('full'); spec validated (keys, blockers, loops) before storing", 'enforced', { params: { id: 'project' } }),
  route('GET', '/api/plans/:planId', 'session_or_pat', 'plan:read', TR, 'project', "assertProjectAccess('view') on the plan's project", 'enforced', { params: { planId: 'plan' } }),
  route('POST', '/api/plans/:planId/revisions', 'session_or_pat', 'plan:write', TW, 'project', "assertProjectAccess('full') on the plan's project; based on the latest revision (row lock)", 'enforced', { params: { planId: 'plan' } }),
  route('POST', '/api/plans/:planId/approve', 'session_or_pat', 'plan:approve', TW, 'project', "assertProjectAccess('full') + assertTeamRole(member) on the plan's project; latest revision only; one transaction under the project dependency lock", 'enforced', { params: { planId: 'plan' } }),
  route('POST', '/api/plans/:planId/archive', 'session_or_pat', 'plan:write', TW, 'project', "assertProjectAccess('full') on the plan's project", 'enforced', { params: { planId: 'plan' } }),
  // W20 / FE-14 recurring issues: schedules create issues (never run them).
  route('GET', '/api/projects/:id/schedules', 'session_or_pat', 'schedule:list', TR, 'project', "assertProjectAccess('view')", 'enforced', { params: { id: 'project' } }),
  route('POST', '/api/projects/:id/schedules', 'session_or_pat', 'schedule:create', TW, 'project', "assertProjectAccess('full') + assertTeamRole(member); labels in the project, assignee in its team; per-project quota under an advisory lock", 'enforced', { params: { id: 'project' } }),
  route('GET', '/api/schedules/:scheduleId', 'session_or_pat', 'schedule:read', TR, 'project', "assertProjectAccess('view') on the schedule's project", 'enforced', { params: { scheduleId: 'schedule' } }),
  route('PATCH', '/api/schedules/:scheduleId', 'session_or_pat', 'schedule:write', TW, 'project', "assertProjectAccess('full') + assertTeamRole(member) on the schedule's project (the caller becomes the owner)", 'enforced', { params: { scheduleId: 'schedule' } }),
  route('DELETE', '/api/schedules/:scheduleId', 'session_or_pat', 'schedule:delete', TW, 'project', "assertProjectAccess('full') on the schedule's project; created issues are kept", 'enforced', { params: { scheduleId: 'schedule' } }),
  route('POST', '/api/schedules/:scheduleId/pause', 'session_or_pat', 'schedule:write', TW, 'project', "assertProjectAccess('full') on the schedule's project", 'enforced', { params: { scheduleId: 'schedule' } }),
  route('POST', '/api/schedules/:scheduleId/resume', 'session_or_pat', 'schedule:write', TW, 'project', "assertProjectAccess('full') + assertTeamRole(member) on the schedule's project; active quota under an advisory lock", 'enforced', { params: { scheduleId: 'schedule' } }),
  // W19b / FE-13 project knowledge: people write or approve, agents (PATs) only propose.
  route('GET', '/api/projects/:id/knowledge', 'session_or_pat', 'knowledge:list', TR, 'project', "assertProjectAccess('view')", 'enforced', { params: { id: 'project' } }),
  route('POST', '/api/projects/:id/knowledge', 'session_or_pat', 'knowledge:create', TW, 'project', "assertProjectAccess('full'); a PAT creates a proposal, a session an active entry; source task in the project and not sealed; per-project quota under an advisory lock", 'enforced', { params: { id: 'project' } }),
  route('GET', '/api/knowledge/:entryId', 'session_or_pat', 'knowledge:read', TR, 'project', "assertProjectAccess('view') on the entry's project", 'enforced', { params: { entryId: 'knowledge' } }),
  route('PATCH', '/api/knowledge/:entryId', 'session_or_pat', 'knowledge:write', TW, 'project', "assertProjectAccess('full') on the entry's project; latest revision only (row lock); a PAT may edit only proposals", 'enforced', { params: { entryId: 'knowledge' } }),
  route('POST', '/api/knowledge/:entryId/approve', 'session_or_pat', 'knowledge:approve', TW, 'project', "session only (KNOWLEDGE_PEOPLE_ONLY for PATs) + assertProjectAccess('full'); latest revision of a proposal", 'enforced', { params: { entryId: 'knowledge' } }),
  route('POST', '/api/knowledge/:entryId/retract', 'session_or_pat', 'knowledge:write', TW, 'project', "session only + assertProjectAccess('full') on the entry's project; history kept", 'enforced', { params: { entryId: 'knowledge' } }),
  route('POST', '/api/knowledge/:entryId/restore', 'session_or_pat', 'knowledge:write', TW, 'project', "session only + assertProjectAccess('full'); per-project quota under an advisory lock", 'enforced', { params: { entryId: 'knowledge' } }),
  route('POST', '/api/schedules/:scheduleId/run-now', 'session_or_pat', 'schedule:run', TW, 'project', "assertProjectAccess('full') + assertTeamRole(member) on the schedule's project; one issue per schedule per minute (row lock + unique slot)", 'enforced', { params: { scheduleId: 'schedule' } }),
  // The bundle carries every task, comment and run of the project: a PAT needs the task family too.
  route('GET', '/api/projects/:id/export', 'session_or_pat', 'project:read', [...TR, ...PR], 'project', "assertProjectAccess('view'); this project only; credentials, logs and audit excluded; free text redacted; bounded; 2 per minute per person", 'enforced', { params: { id: 'project' } }),
  // W15b insights: aggregates only (runs, cost, delivery); no titles, logs or free text.
  route('GET', '/api/projects/:id/insights', 'session_or_pat', 'insights:read', TR, 'project', "assertProjectAccess('view'); this project's issues only", 'enforced', { params: { id: 'project' } }),
  route('GET', '/api/projects/:id/verification-settings', 'session_or_pat', 'project:read', PR, 'project', "assertProjectAccess('view')", 'enforced', { params: { id: 'project' } }),
  route('PUT', '/api/projects/:id/verification-settings', 'session_or_pat', 'project:write', PW, 'project', "assertProjectAccess('full') + assertWorkspaceRole(owner|admin); strict execution-core parseProjectVerificationSettings; audited", 'enforced', { params: { id: 'project' } }),
  route('GET', '/api/projects/:id/access', 'session_or_pat', 'project:access', PR, 'project', 'assertProjectAccess', 'enforced', { params: { id: 'project' } }),
  // W10a: GitHub App installation discovery for a project's repository (workspace admins).
  route('GET', '/api/github-app/projects/:projectId/installation', 'session_or_pat', 'project:github-app', PR, 'project', "assertProjectAccess('view') + assertWorkspaceRole(owner|admin) (no workspace: assertProjectAccess('full'))", 'enforced', { params: { projectId: 'project' } }),
  route('POST', '/api/projects/:id/access', 'session_or_pat', 'project:access', ADMIN, 'project', 'assertProjectAccess + workspace role', 'enforced', { params: { id: 'project' } }),
  route('POST', '/api/projects/:id/access/bulk', 'session_or_pat', 'project:access', ADMIN, 'project', 'assertProjectAccess + workspace role', 'enforced', { params: { id: 'project' } }),
  route('DELETE', '/api/projects/:id/access/:userId', 'session_or_pat', 'project:access', ADMIN, 'project', 'assertProjectAccess + workspace role', 'enforced', { params: { id: 'project', userId: 'user' } }),

  // Workspaces (every mutation is administration)
  route('GET', '/api/workspaces', 'session_or_pat', 'workspace:list', WR, 'scoped-list', 'listWorkspacesForUser (principal workspace)', 'enforced'),
  route('POST', '/api/workspaces', 'session_or_pat', 'workspace:create', ADMIN, 'membership-entry', 'assertPrincipalMayEnterWorkspace(null)', 'enforced'),
  route('GET', '/api/workspaces/:id/structure', 'session_or_pat', 'workspace:read', WR, 'workspace', 'assertWorkspaceRole', 'enforced', { params: { id: 'workspace' } }),
  route('GET', '/api/workspaces/:id/insights', 'session_or_pat', 'insights:read', TR, 'workspace', 'assertWorkspaceRole(any role); the workspace projects that do not deny the caller', 'enforced', { params: { id: 'workspace' } }),
  route('GET', '/api/workspaces/:id/members', 'session_or_pat', 'workspace:read', WR, 'workspace', 'assertWorkspaceRole', 'enforced', { params: { id: 'workspace' } }),
  route('POST', '/api/workspaces/:id/members', 'session_or_pat', 'workspace:members', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin)', 'enforced', { params: { id: 'workspace' } }),
  route('POST', '/api/workspaces/:id/members/bulk', 'session_or_pat', 'workspace:members', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin)', 'enforced', { params: { id: 'workspace' } }),
  route('PATCH', '/api/workspaces/:id/members/:userId', 'session_or_pat', 'workspace:members', ADMIN, 'workspace', 'assertWorkspaceRole(owner)', 'enforced', { params: { id: 'workspace', userId: 'user' } }),
  route('DELETE', '/api/workspaces/:id/members/:userId', 'session_or_pat', 'workspace:members', ADMIN, 'workspace', 'assertWorkspaceRole', 'enforced', { params: { id: 'workspace', userId: 'user' } }),
  route('GET', '/api/workspaces/:id', 'session_or_pat', 'workspace:read', WR, 'workspace', 'assertWorkspaceRole', 'enforced', { params: { id: 'workspace' } }),
  route('PATCH', '/api/workspaces/:id', 'session_or_pat', 'workspace:write', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin)', 'enforced', { params: { id: 'workspace' } }),
  route('DELETE', '/api/workspaces/:id', 'session_or_pat', 'workspace:delete', ADMIN, 'workspace', 'assertWorkspaceRole(owner); revokes bound PATs (route + DB trigger)', 'enforced', { params: { id: 'workspace' } }),
  route('GET', '/api/workspaces/:workspaceId/audit-log', 'session_or_pat', 'workspace:audit', ADMIN, 'workspace', 'membership(owner|admin) + principal workspace', 'enforced', { params: { workspaceId: 'workspace' } }),
  sessionOnly('POST', '/api/workspaces/:workspaceId/sso', 'sso:write', 'workspace', 'requireInteractiveSession + workspace role', { workspaceId: 'workspace' }),
  sessionOnly('GET', '/api/workspaces/:workspaceId/sso', 'sso:read', 'workspace', 'requireInteractiveSession + workspace role', { workspaceId: 'workspace' }),
  sessionOnly('DELETE', '/api/workspaces/:workspaceId/sso', 'sso:write', 'workspace', 'requireInteractiveSession + workspace role', { workspaceId: 'workspace' }),
  sessionOnly('POST', '/api/workspaces/:workspaceId/sso/verify-domain', 'sso:write', 'workspace', 'requireInteractiveSession + workspace role', { workspaceId: 'workspace' }),

  // FE-14 outbound webhooks. Creating, changing (the URL decides where signed events go) and
  // rotating reveal or redirect the signing secret: interactive session only.
  route('GET', '/api/projects/:id/webhooks', 'session_or_pat', 'webhook:list', PR, 'project', "assertProjectAccess('view'); URL reduced to its origin unless a session that may manage", 'enforced', { params: { id: 'project' } }),
  sessionOnly('POST', '/api/projects/:id/webhooks', 'webhook:create', 'project', "requireInteractiveSession + assertProjectAccess('full') + assertWorkspaceRole(owner|admin); https URL with a public host; per-project quota under an advisory lock; secret returned once", { id: 'project' }),
  route('GET', '/api/workspaces/:id/webhooks', 'session_or_pat', 'webhook:list', WR, 'workspace', 'assertWorkspaceRole(any role); URL reduced to its origin unless an owner|admin session', 'enforced', { params: { id: 'workspace' } }),
  sessionOnly('POST', '/api/workspaces/:id/webhooks', 'webhook:create', 'workspace', 'requireInteractiveSession + assertWorkspaceRole(owner|admin); per-workspace quota under an advisory lock; secret returned once', { id: 'workspace' }),
  route('GET', '/api/webhooks/:webhookId', 'session_or_pat', 'webhook:read', PR, 'project', "assertProjectAccess('view') on the endpoint's project (workspace endpoints: PAT also needs workspaces:read + assertWorkspaceRole(any role)); full URL only to a managing session", 'enforced', { params: { webhookId: 'webhook' } }),
  sessionOnly('PATCH', '/api/webhooks/:webhookId', 'webhook:write', 'project', "requireInteractiveSession + assertProjectAccess('full') + assertWorkspaceRole(owner|admin) on the endpoint's project (workspace endpoints: assertWorkspaceRole(owner|admin)); the caller becomes the owner", { webhookId: 'webhook' }),
  route('DELETE', '/api/webhooks/:webhookId', 'session_or_pat', 'webhook:delete', PW, 'project', "assertProjectAccess('full') + assertWorkspaceRole(owner|admin) on the endpoint's project (workspace endpoints: PAT also needs admin + assertWorkspaceRole(owner|admin))", 'enforced', { params: { webhookId: 'webhook' } }),
  sessionOnly('POST', '/api/webhooks/:webhookId/rotate-secret', 'webhook:write', 'project', 'requireInteractiveSession + manage rights on the endpoint; new secret returned once, the previous one signs for 24 h', { webhookId: 'webhook' }),
  route('POST', '/api/webhooks/:webhookId/ping', 'session_or_pat', 'webhook:write', PW, 'project', 'manage rights on the endpoint (workspace endpoints: PAT also needs admin); one SSRF-guarded attempt', 'enforced', { params: { webhookId: 'webhook' } }),
  route('GET', '/api/webhooks/:webhookId/deliveries', 'session_or_pat', 'webhook:read', PR, 'project', 'read rights on the endpoint (workspace endpoints: PAT also needs workspaces:read); keyset paging', 'enforced', { params: { webhookId: 'webhook' } }),
  route('GET', '/api/webhooks/:webhookId/deliveries/:deliveryId', 'session_or_pat', 'webhook:read', PR, 'project', 'read rights on the endpoint (workspace endpoints: PAT also needs workspaces:read) + delivery.endpointId', 'enforced', { params: { webhookId: 'webhook', deliveryId: 'webhookDelivery' } }),
  route('POST', '/api/webhooks/:webhookId/deliveries/:deliveryId/redeliver', 'session_or_pat', 'webhook:write', PW, 'project', 'manage rights on the endpoint (workspace endpoints: PAT also needs admin) + delivery.endpointId; same delivery id; refused in flight or while the endpoint is off', 'enforced', { params: { webhookId: 'webhook', deliveryId: 'webhookDelivery' } }),

  // Invitations and members
  route('GET', '/api/invitations/pending', 'session_or_pat', 'invitation:read', WR, 'self', "caller's email; filtered to principal workspace", 'enforced'),
  route('GET', '/api/invitations', 'session_or_pat', 'invitation:list', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin)', 'enforced'),
  route('POST', '/api/invitations', 'session_or_pat', 'invitation:create', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin)', 'enforced'),
  route('POST', '/api/invitations/:id/accept', 'session_or_pat', 'invitation:accept', ADMIN, 'membership-entry', 'invitation token/email + assertPrincipalMayEnterWorkspace', 'enforced', { params: { id: 'invitation' } }),
  route('POST', '/api/invitations/:id/revoke', 'session_or_pat', 'invitation:revoke', ADMIN, 'workspace', 'inviter or assertWorkspaceRole + principal workspace', 'enforced', { params: { id: 'invitation' } }),
  route('GET', '/api/members/search', 'session_or_pat', 'workspace:read', WR, 'workspace', 'membership + principal workspace', 'enforced'),

  // Inbox, notifications, activity, dashboard, search, usage
  route('GET', '/api/inbox/count', 'optional', 'inbox', TR, 'scoped-list', 'scopedTaskWhere(principal)', 'enforced'),
  route('GET', '/api/inbox', 'optional', 'inbox', TR, 'scoped-list', 'scopedTaskWhere(principal)', 'enforced'),
  route('PATCH', '/api/inbox/read/:id', 'session_or_pat', 'inbox', TW, 'task', 'assertTaskOwned', 'enforced', { params: { id: 'task' } }),
  route('PATCH', '/api/inbox/read-all', 'optional', 'inbox', TW, 'scoped-list', 'scopedTaskWhere(principal)', 'enforced'),
  route('GET', '/api/notifications', 'session_or_pat', 'notifications', TR, 'scoped-list', 'userId + scopedTaskWhere(principal) on task', 'enforced'),
  route('PATCH', '/api/notifications/:id/read', 'session_or_pat', 'notifications', TW, 'scoped-list', 'userId + scopedTaskWhere(principal) on task', 'enforced', { params: { id: 'notification' } }),
  route('POST', '/api/notifications/read-all', 'session_or_pat', 'notifications', AW, 'self', 'userId (every workspace)', 'refused'),
  route('GET', '/api/notifications/preferences', 'session_or_pat', 'notifications', AR, 'self', 'userId', 'refused'),
  route('PUT', '/api/notifications/preferences', 'session_or_pat', 'notifications', AW, 'self', 'userId', 'refused'),
  route('GET', '/api/activity', 'session_or_pat', 'activity', TR, 'scoped-list', 'scopedActivityWhere(principal) / assert* filters', 'enforced'),
  route('GET', '/api/dashboard/tasks', 'session_or_pat', 'dashboard', TR, 'scoped-list', 'scopedTaskWhere(principal)', 'enforced'),
  route('GET', '/api/dashboard/projects', 'session_or_pat', 'dashboard', PR, 'scoped-list', 'scopedProjectWhere(principal)', 'enforced'),
  route('GET', '/api/search', 'session_or_pat', 'search', ['tasks:read', 'projects:read'], 'scoped-list', 'scoped{Task,Project,Team}Where(principal)', 'enforced'),
  route('GET', '/api/usage/summary', 'session_or_pat', 'usage', TR, 'scoped-list', 'own/team runs AND scopedTaskWhere(principal)', 'enforced'),
  route('GET', '/api/usage/by-task', 'session_or_pat', 'usage', TR, 'scoped-list', 'own/team runs AND scopedTaskWhere(principal)', 'enforced'),
  route('GET', '/api/usage/models', 'session_or_pat', 'usage', CR, 'self', 'modelUsage.userId, scoped to the PAT workspace binding or an asserted workspaceId', 'enforced'),

  // Agent runs
  route('GET', '/api/agent-runs', 'session_or_pat', 'agent-run:list', TR, 'task', "assertTaskAccess('view') / scopedTaskWhere(principal)", 'enforced'),
  route('POST', '/api/agent-runs', 'session_or_pat', 'agent-run:write', TW, 'task', "assertTaskAccess('full')", 'enforced'),
  route('PATCH', '/api/agent-runs/:id', 'session_or_pat', 'agent-run:write', TW, 'task', "assertTaskAccess('full') + the run's own user only (AGENT_RUN_NOT_OWNER); runs recorded by the execution service are refused (AGENT_RUN_MANAGED); costUsd > 0", 'enforced', { params: { id: 'agentRun' } }),
  route('POST', '/api/agent-runs/progress', 'session_or_pat', 'agent-run:write', TW, 'task', "assertTaskAccess('full') + event resource binding", 'enforced'),

  // W03a execution control (API-only sidecar). User-authenticated half:
  route('GET', '/api/executions/principal', 'session_or_pat', 'self', ['read'], 'self', 'req.userId (sidecar principal validation)', 'account-read', {
    bindingJustification: IDENTITY_JUSTIFICATION,
    scopeJustification:
      'The local sidecar resolves who a bearer token belongs to before any execution decision. Any token that may read or execute (including a tasks:write-only execution token) must be able to identify itself; the response is the token owner identity, scopes and workspace binding only. Execution itself is gated by tasks:write on /api/executions/attempts.',
  }),
  route('GET', '/api/executions/tasks/:taskId/access', 'session_or_pat', 'execution:read', TR, 'task', "assertTaskAccess('view') + full probe + PAT tasks:write", 'enforced', { params: { taskId: 'task' } }),
  route('GET', '/api/executions/tasks/:taskId/verifications', 'session_or_pat', 'execution:read', TR, 'task', "assertTaskAccess('view')", 'enforced', { params: { taskId: 'task' } }),
  route('GET', '/api/executions/tasks/:taskId/logs', 'session_or_pat', 'execution:read', TR, 'task', "assertTaskAccess('full')", 'enforced', { params: { taskId: 'task' } }),
  route('POST', '/api/executions/tasks/:taskId/cancellation', 'session_or_pat', 'execution:write', TW, 'task', "assertTaskAccess('full') + active attempt", 'enforced', { params: { taskId: 'task' } }),
  route('POST', '/api/executions/tasks/:taskId/refresh-pr', 'session_or_pat', 'execution:write', TW, 'task', "assertTaskAccess('full') + scopedTaskWhere(principal,'full') for batch siblings; refuses workspace-bound PATs for the GitHub token", 'enforced', { params: { taskId: 'task' } }),
  route('POST', '/api/executions/attempts', 'session_or_pat', 'execution:start', TW, 'task', "assertTaskAccess('full') + admission checks; mints the attempt capability", 'enforced'),
  // Capability half: one attempt, state-checked, fenced on the attempt's recorded bindings.
  attemptCallback('/api/executions/attempts/:attemptId/claim', 'execution:status', 'capability + reauthorize initiator + conditional in_progress claim'),
  attemptCallback('/api/executions/attempts/:attemptId/events', 'execution:progress', 'capability + (attempt, seq) high-water + task resource binding'),
  attemptCallback('/api/executions/attempts/:attemptId/heartbeat', 'execution:status', 'capability + active attempt'),
  attemptCallback('/api/executions/attempts/:attemptId/logs', 'execution:logs', 'capability + session/terminal + project/team/creator fence'),
  attemptCallback('/api/executions/attempts/:attemptId/terminal', 'execution:terminal', 'capability + session/status/project/team/creator fence; done needs a confirmed PR'),
  attemptCallback('/api/executions/attempts/:attemptId/run', 'execution:terminal', 'capability + run still running; success needs done; cancelled needs stop receipt'),
  attemptCallback('/api/executions/attempts/:attemptId/cancellation', 'execution:status', 'capability + positive stop receipt'),
  attemptCallback('/api/executions/attempts/:attemptId/git-credential', 'execution:git-credential', 'capability + reauthorize initiator (+ bound task for push/pull_request); W10a per-effect broker: repo-scoped GitHub App installation token, user-OAuth fallback only under OPENLINEAR_GIT_CREDENTIAL_FALLBACK and never for workspace-bound PAT attempts'),
  attemptCallback('/api/executions/attempts/:attemptId/verification', 'execution:verification', 'capability + running/finishing attempt; W11a evidence keyed (attempt, commit, checks hash), replay by body hash; policy must equal the sealed snapshot policy, project-defined checks must hash to the sealed checks, publication must match the policy decision'),
  attemptCallback('/api/executions/attempts/:attemptId/close', 'execution:terminal', 'capability; revokes every capability of the attempt'),
  attemptCallback('/api/executions/attempts/:attemptId/renew', 'execution:status', 'capability + active attempt + fresh lease + reauthorize initiator; rotates the capability (previous one kept for a 5 min grace)'),

  // Chat
  route('POST', '/api/chat/attachments', 'session_or_pat', 'chat:write', CW, 'self', 'attachment.userId (account-level storage)', 'refused'),
  route('GET', '/api/chat/sessions', 'session_or_pat', 'chat:read', CR, 'chat-session', 'assertWorkspaceRole + owner + scopedProjectWhere(principal)', 'enforced'),
  route('POST', '/api/chat/sessions', 'session_or_pat', 'chat:write', CW, 'chat-session', 'assertWorkspaceRole + assertProjectAccess', 'enforced'),
  route('GET', '/api/chat/sessions/:id', 'session_or_pat', 'chat:read', CR, 'chat-session', 'owner + assertWorkspaceRole + assertProjectAccess', 'enforced', { params: { id: 'chatSession' } }),
  route('PATCH', '/api/chat/sessions/:id', 'session_or_pat', 'chat:write', CW, 'chat-session', 'owner + assertWorkspaceRole + assertProjectAccess', 'enforced', { params: { id: 'chatSession' } }),
  route('DELETE', '/api/chat/sessions/:id', 'session_or_pat', 'chat:write', CW, 'chat-session', 'owner + assertWorkspaceRole + assertProjectAccess', 'enforced', { params: { id: 'chatSession' } }),
  route('POST', '/api/chat/sessions/:id/messages', 'session_or_pat', 'chat:write', CW, 'chat-session', 'owner + workspace + project; tools inherit principal scopes', 'enforced', { params: { id: 'chatSession' } }),
  route('POST', '/api/chat/sessions/:id/confirmations/revoke', 'session_or_pat', 'chat:write', CW, 'chat-session', 'owner + assertWorkspaceRole + assertProjectAccess; code bound to session + user', 'enforced', { params: { id: 'chatSession' } }),
  route('GET', '/api/chat/budgets/:workspaceId', 'session_or_pat', 'chat:budget:read', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin)', 'enforced', { params: { workspaceId: 'workspace' } }),
  route('PUT', '/api/chat/budgets/:workspaceId', 'session_or_pat', 'chat:budget:write', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin); audit chat.budget_updated', 'enforced', { params: { workspaceId: 'workspace' } }),
  route('PUT', '/api/chat/budgets/:workspaceId/members/:userId', 'session_or_pat', 'chat:budget:write', ADMIN, 'workspace', 'assertWorkspaceRole(owner|admin) + target membership; audit chat.member_budget_updated', 'enforced', { params: { workspaceId: 'workspace', userId: 'user' } }),

  // Misc account-level
  route('GET', '/api/models', 'session_or_pat', 'models', ['read'], 'self', 'global catalogue', 'account-read', {
    bindingJustification: 'Public model catalogue (models.dev) and runner capabilities; contains no user or workspace data.',
    scopeJustification: 'Public catalogue: any valid PAT may read it.',
  }),
  route('POST', '/api/mcp/log', 'session_or_pat', 'mcp', ['write'], 'self', 'mcpToolCall.userId (account-level telemetry)', 'refused', {
    scopeJustification: 'Append-only telemetry about the calling token\'s own MCP tool calls: any write-capable PAT may record it (the MCP worker logs every call with the PAT it was given).',
  }),
  route('GET', '/api/mcp/usage', 'session_or_pat', 'mcp', AR, 'self', 'mcpToolCall.userId', 'refused'),
  route('GET', '/uploads/:filename', 'session_or_pat', 'upload:read', AR, 'self', 'chatAttachment.userId', 'refused', { params: { filename: 'upload' } }),
];

export function routeKey(route: Pick<RouteDeclaration, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

const WORKSPACE_BINDINGS: readonly WorkspaceBinding[] = ['enforced', 'account-read', 'refused', 'not-applicable'];
const GENERIC_SCOPES = new Set(['read', 'write']);

export function isPatCallable(entry: Pick<RouteDeclaration, 'auth'>): boolean {
  return entry.auth === 'session_or_pat' || entry.auth === 'optional';
}

/** Static consistency of the inventory itself; HTTP behaviour is tested separately. */
export function assertRegistryComplete(routes: RouteDeclaration[]): void {
  const seen = new Set<string>();
  for (const entry of routes) {
    const key = routeKey(entry);
    if (!entry.scope) {
      throw new Error(`${key} is missing scope`);
    }
    if (!entry.enforcedBy) {
      throw new Error(`${key} is missing enforcedBy`);
    }
    if (!WORKSPACE_BINDINGS.includes(entry.workspaceBinding)) {
      throw new Error(`${key} has unknown workspaceBinding ${String(entry.workspaceBinding)}`);
    }
    if (isPatCallable(entry) && entry.patScopes.length === 0) {
      throw new Error(`${key} allows PATs but declares no patScopes`);
    }
    if (!isPatCallable(entry) && entry.patScopes.length > 0) {
      throw new Error(`${key} refuses PATs but declares patScopes`);
    }
    if ((entry.auth === 'capability') !== (entry.enforcement === 'attempt')) {
      throw new Error(`${key}: capability routes and only capability routes use enforcement 'attempt'`);
    }
    if ((entry.auth === 'public') !== (entry.enforcement === 'none')) {
      throw new Error(`${key}: only public routes may have enforcement 'none'`);
    }
    if (isPatCallable(entry) === (entry.workspaceBinding === 'not-applicable')) {
      throw new Error(`${key}: PAT-callable routes need a binding stance; other routes must use 'not-applicable'`);
    }
    if (entry.workspaceBinding === 'account-read') {
      if (entry.method !== 'GET') {
        throw new Error(`${key}: only GET routes may be readable by workspace-bound PATs as account data`);
      }
      if (!entry.bindingJustification) {
        throw new Error(`${key}: 'account-read' needs a bindingJustification`);
      }
    }
    if (entry.patScopes.some((scope) => GENERIC_SCOPES.has(scope)) && !entry.scopeJustification) {
      throw new Error(`${key}: generic read/write PAT scopes need a scopeJustification`);
    }
    for (const param of Object.keys(entry.params ?? {})) {
      if (!entry.path.includes(`:${param}`)) {
        throw new Error(`${key} declares param ${param} that is not in its path`);
      }
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate registry entry ${key}`);
    }
    seen.add(key);
  }
}

// ─── Lookup used by the auth middleware ─────────────────────────────────────

interface CompiledRoute {
  declaration: RouteDeclaration;
  pattern: RegExp;
  staticSegments: number;
}

const declarationsByKey = new Map<string, RouteDeclaration>();
const compiledByMethod = new Map<string, CompiledRoute[]>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed === '' ? '/' : trimmed;
}

function index(declaration: RouteDeclaration): void {
  const key = routeKey(declaration);
  if (declarationsByKey.has(key)) {
    throw new Error(`Duplicate route declaration ${key}`);
  }
  declarationsByKey.set(key, declaration);
  const segments = declaration.path.split('/');
  const compiled: CompiledRoute = {
    declaration,
    pattern: new RegExp(
      `^${segments.map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment))).join('/')}/?$`,
      'i',
    ),
    staticSegments: segments.filter((segment) => segment !== '' && !segment.startsWith(':')).length,
  };
  const list = compiledByMethod.get(declaration.method) ?? [];
  list.push(compiled);
  compiledByMethod.set(declaration.method, list);
}

for (const declaration of ROUTE_REGISTRY) index(declaration);

/**
 * Declare routes served by another app that reuses this middleware (the
 * sidecar). Until a route is declared, PATs are refused on it.
 */
export function registerRouteDeclarations(routes: readonly RouteDeclaration[]): void {
  assertRegistryComplete([...routes]);
  for (const declaration of routes) index(declaration);
}

function methodOf(method: string): string {
  const upper = method.toUpperCase();
  return upper === 'HEAD' ? 'GET' : upper;
}

/** Exact lookup by route pattern, e.g. `('GET', '/api/tasks/:id')`. */
export function findRouteDeclaration(method: string, routePath: string): RouteDeclaration | undefined {
  return declarationsByKey.get(`${methodOf(method)} ${normalizePath(routePath)}`);
}

/** Lookup by a concrete request path, e.g. `('GET', '/api/tasks/123')`. Most specific match wins. */
export function matchRouteDeclaration(method: string, requestPath: string): RouteDeclaration | undefined {
  const candidates = compiledByMethod.get(methodOf(method)) ?? [];
  const path = normalizePath(requestPath);
  let best: CompiledRoute | undefined;
  for (const candidate of candidates) {
    if (!candidate.pattern.test(path)) continue;
    if (!best || candidate.staticSegments > best.staticSegments) best = candidate;
  }
  return best?.declaration;
}

export interface RoutableRequest {
  method: string;
  baseUrl: string;
  originalUrl: string;
  route?: { path?: unknown };
}

/**
 * The declaration of the route a request is being served by.
 *
 * Route-level middleware sees the matched Express route (`req.route`), so the
 * declaration is found by pattern. Router-level middleware (mounted with
 * `app.use(prefix, requireAuth, router)`) runs before route matching and
 * falls back to matching the concrete path. `undefined` means undeclared,
 * which the middleware treats as "no PAT access".
 */
export function resolveRequestDeclaration(req: RoutableRequest): RouteDeclaration | undefined {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return findRouteDeclaration(req.method, `${req.baseUrl.toLowerCase()}${routePath}`);
  }
  const [path] = req.originalUrl.split('?');
  return matchRouteDeclaration(req.method, path ?? '/');
}
