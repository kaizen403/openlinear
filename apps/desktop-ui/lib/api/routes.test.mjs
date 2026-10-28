/**
 * Routing contract: every lib/api function that hits an execution route lands
 * on the local sidecar, everything else on the cloud API — in the desktop
 * (Tauri) runtime and in the web runtime. Each function is called for real
 * against a stubbed `fetch`; the assertion is on the URL actually requested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const { resolveApiTarget, SIDECAR_ROUTES } = await import('./routes.ts')
const client = await import('./client.ts')
const tokenStore = await import('./token-store.ts')
const desktopAuth = await import('./desktop-auth.ts')

const modules = {
  agentReviews: await import('./agent-reviews.ts'),
  approvals: await import('./approvals.ts'),
  auth: await import('./auth.ts'),
  chat: await import('./chat.ts'),
  comments: await import('./comments.ts'),
  opencode: await import('./opencode.ts'),
  pats: await import('./pats.ts'),
  projects: await import('./projects.ts'),
  repoContext: await import('./repo-context.ts'),
  repos: await import('./repos.ts'),
  review: await import('./review.ts'),
  runners: await import('./runners.ts'),
  sandboxGrants: await import('./sandbox-grants.ts'),
  schedules: await import('./schedules.ts'),
  tasks: await import('./tasks.ts'),
  taskCommands: await import('./task-commands.ts'),
  teams: await import('./teams.ts'),
  workspaces: await import('./workspaces.ts'),
}

const CLOUD = 'https://cloud.example.test'
const WEB_SIDECAR = 'http://127.0.0.1:4199'
const DESKTOP_SIDECAR_PORT = 4150
const DESKTOP_SIDECAR = `http://127.0.0.1:${DESKTOP_SIDECAR_PORT}`
const PENDING_STATE = 'state-0123456789abcdef'

const GENERIC_BODY = {
  items: [],
  data: [],
  comments: [],
  total: 0,
  page: 1,
  pageSize: 100,
  logs: [],
  repos: [],
  providers: [],
  github: { enabled: true },
  ticket: 'ol_sse_ticket',
  authorizeUrl: 'https://github.com/login/oauth/authorize?state=s',
  token: 'access-token',
  refreshToken: 'refresh-token',
  id: 'x',
}

function okResponse() {
  return new Response(JSON.stringify(GENERIC_BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const sidecar = 'sidecar'
const cloud = 'cloud'

/**
 * name, how to call it, method, path (or per-runtime paths), owning backend.
 * Execution routes (sidecar): task execute/cancel/logs/refresh-pr, batches,
 * opencode/*, transcribe. Everything else: cloud.
 */
const CASES = [
  // auth
  { name: 'auth.fetchCurrentUser', call: (m) => m.auth.fetchCurrentUser(), method: 'GET', path: '/api/auth/me', target: cloud },
  { name: 'auth.verifyCallbackToken', call: (m) => m.auth.verifyCallbackToken('verify-me'), method: 'GET', path: '/api/auth/me', target: cloud },
  { name: 'auth.fetchAuthProviders', call: (m) => m.auth.fetchAuthProviders(), method: 'GET', path: '/api/auth/providers', target: cloud },
  { name: 'auth.startDesktopLogin', call: (m) => m.auth.startDesktopLogin(), method: 'POST', path: '/api/auth/desktop/authorize', target: cloud },
  {
    name: 'auth.completeDesktopLogin',
    call: (m) => {
      desktopAuth.rememberPendingLogin({ state: PENDING_STATE, verifier: 'v'.repeat(43), createdAt: Date.now() })
      return m.auth.completeDesktopLogin({ kind: 'code', code: 'code-0123456789abcdef', state: PENDING_STATE })
    },
    method: 'POST',
    path: '/api/auth/desktop/token',
    target: cloud,
  },
  { name: 'auth.completeTwoFactorLogin', call: (m) => m.auth.completeTwoFactorLogin('temp-token', '123456'), method: 'POST', path: '/api/auth/2fa/validate', target: cloud },
  {
    name: 'auth.startLogin',
    call: (m) => m.auth.startLogin(),
    method: { web: 'GET', desktop: 'POST' },
    path: { web: '/api/auth/providers', desktop: '/api/auth/desktop/authorize' },
    target: cloud,
  },
  { name: 'auth.updateEmail', call: (m) => m.auth.updateEmail('a@example.com'), method: 'PATCH', path: '/api/auth/me', target: cloud },
  { name: 'auth.logout', call: (m) => m.auth.logout(), method: 'POST', path: '/api/auth/logout', target: cloud },

  // chat
  { name: 'chat.fetchChatSessions', call: (m) => m.chat.fetchChatSessions('ws1'), method: 'GET', path: '/api/chat/sessions?workspaceId=ws1', target: cloud },
  { name: 'chat.createChatSession', call: (m) => m.chat.createChatSession('ws1'), method: 'POST', path: '/api/chat/sessions', target: cloud },
  { name: 'chat.fetchChatSession', call: (m) => m.chat.fetchChatSession('s1'), method: 'GET', path: '/api/chat/sessions/s1', target: cloud },
  { name: 'chat.updateChatSession', call: (m) => m.chat.updateChatSession('s1', { title: 't' }), method: 'PATCH', path: '/api/chat/sessions/s1', target: cloud },
  { name: 'chat.archiveChatSession', call: (m) => m.chat.archiveChatSession('s1'), method: 'DELETE', path: '/api/chat/sessions/s1', target: cloud },
  { name: 'chat.transcribeChatAudio', call: (m) => m.chat.transcribeChatAudio(new Blob(['x'], { type: 'audio/webm' })), method: 'POST', path: '/api/transcribe', target: sidecar },
  { name: 'chat.uploadChatAttachment', call: (m) => m.chat.uploadChatAttachment(new File(['x'], 'a.txt')), method: 'POST', path: '/api/chat/attachments', target: cloud },
  {
    name: 'chat.sendChatMessage',
    call: (m) => m.chat.sendChatMessage({ sessionId: 's1', content: 'hi', onChunk: () => {}, onError: () => {} }),
    method: 'POST',
    path: '/api/chat/sessions/s1/messages',
    target: cloud,
  },
  { name: 'chat.fetchModelUsage', call: (m) => m.chat.fetchModelUsage({ days: 30 }), method: 'GET', path: '/api/usage/models?days=30', target: cloud },
  { name: 'chat.revokeChatConfirmation', call: (m) => m.chat.revokeChatConfirmation('s1', 'CONFIRM-7KQ2MX9P'), method: 'POST', path: '/api/chat/sessions/s1/confirmations/revoke', target: cloud },

  // comments
  { name: 'comments.fetchComments', call: (m) => m.comments.fetchComments('t1'), method: 'GET', path: '/api/tasks/t1/comments?page=1&pageSize=100', target: cloud },
  { name: 'comments.createComment', call: (m) => m.comments.createComment('t1', 'b'), method: 'POST', path: '/api/tasks/t1/comments', target: cloud },
  { name: 'comments.updateComment', call: (m) => m.comments.updateComment('c1', 'b'), method: 'PATCH', path: '/api/comments/c1', target: cloud },
  { name: 'comments.deleteComment', call: (m) => m.comments.deleteComment('c1'), method: 'DELETE', path: '/api/comments/c1', target: cloud },
  { name: 'comments.fetchTaskTeamId', call: (m) => m.comments.fetchTaskTeamId('t1'), method: 'GET', path: '/api/tasks/t1', target: cloud },
  { name: 'comments.fetchTeamMembers', call: (m) => m.comments.fetchTeamMembers('team1'), method: 'GET', path: '/api/teams/team1/members', target: cloud },

  // opencode (all local)
  { name: 'opencode.getSetupStatus', call: (m) => m.opencode.getSetupStatus(), method: 'GET', path: '/api/opencode/setup-status', target: sidecar },
  { name: 'opencode.setProviderApiKey', call: (m) => m.opencode.setProviderApiKey('openai', 'key'), method: 'POST', path: '/api/opencode/auth', target: sidecar },
  { name: 'opencode.getProviderAuthMethods', call: (m) => m.opencode.getProviderAuthMethods(), method: 'GET', path: '/api/opencode/providers/auth', target: sidecar },
  { name: 'opencode.oauthAuthorize', call: (m) => m.opencode.oauthAuthorize('openai'), method: 'POST', path: '/api/opencode/auth/oauth/authorize', target: sidecar },
  { name: 'opencode.getModels', call: (m) => m.opencode.getModels(), method: 'GET', path: '/api/opencode/models', target: sidecar },
  { name: 'opencode.getModelConfig', call: (m) => m.opencode.getModelConfig(), method: 'GET', path: '/api/opencode/config', target: sidecar },
  { name: 'opencode.setModel', call: (m) => m.opencode.setModel('m'), method: 'POST', path: '/api/opencode/config/model', target: sidecar },
  { name: 'opencode.removeProviderAuth', call: (m) => m.opencode.removeProviderAuth('openai'), method: 'POST', path: '/api/opencode/auth/remove', target: sidecar },
  { name: 'opencode.oauthCallback', call: (m) => m.opencode.oauthCallback('openai', 'code'), method: 'POST', path: '/api/opencode/auth/oauth/callback', target: sidecar },

  // pats
  { name: 'pats.fetchPersonalAccessTokens', call: (m) => m.pats.fetchPersonalAccessTokens(), method: 'GET', path: '/api/pats', target: cloud },
  { name: 'pats.createPersonalAccessToken', call: (m) => m.pats.createPersonalAccessToken({ name: 'n' }), method: 'POST', path: '/api/pats', target: cloud },
  { name: 'pats.revokePersonalAccessToken', call: (m) => m.pats.revokePersonalAccessToken('p1'), method: 'DELETE', path: '/api/pats/p1', target: cloud },

  // projects
  { name: 'projects.fetchProjects', call: (m) => m.projects.fetchProjects(), method: 'GET', path: '/api/projects', target: cloud },
  { name: 'projects.createProject', call: (m) => m.projects.createProject({ name: 'p' }), method: 'POST', path: '/api/projects', target: cloud },
  { name: 'projects.updateProject', call: (m) => m.projects.updateProject('p1', { name: 'p' }), method: 'PATCH', path: '/api/projects/p1', target: cloud },
  { name: 'projects.deleteProject', call: (m) => m.projects.deleteProject('p1'), method: 'DELETE', path: '/api/projects/p1', target: cloud },
  { name: 'projects.fetchProjectAccess', call: (m) => m.projects.fetchProjectAccess('p1'), method: 'GET', path: '/api/projects/p1/access', target: cloud },
  { name: 'projects.grantProjectAccess', call: (m) => m.projects.grantProjectAccess('p1', 'u1', 'view'), method: 'POST', path: '/api/projects/p1/access', target: cloud },
  { name: 'projects.revokeProjectAccess', call: (m) => m.projects.revokeProjectAccess('p1', 'u1'), method: 'DELETE', path: '/api/projects/p1/access/u1', target: cloud },

  // repos
  { name: 'repos.fetchUserRepositories', call: (m) => m.repos.fetchUserRepositories(), method: 'GET', path: '/api/repos', target: cloud },
  {
    name: 'repos.fetchGitHubRepos',
    call: (m, runtime) => m.repos.fetchGitHubRepos({ q: runtime }),
    method: 'GET',
    path: { web: '/api/repos/github?page=1&per_page=30&q=web', desktop: '/api/repos/github?page=1&per_page=30&q=desktop' },
    target: cloud,
  },
  { name: 'repos.importRepo', call: (m) => m.repos.importRepo({ id: 1, name: 'r', full_name: 'o/r' }), method: 'POST', path: '/api/repos/import', target: cloud },
  {
    name: 'repos.fetchGitHubBranches',
    call: (m, runtime) => m.repos.fetchGitHubBranches('o', `r-${runtime}`),
    method: 'GET',
    path: { web: '/api/repos/github/o/r-web/branches', desktop: '/api/repos/github/o/r-desktop/branches' },
    target: cloud,
  },
  { name: 'repos.activateRepository', call: (m) => m.repos.activateRepository('p1'), method: 'POST', path: '/api/repos/p1/activate', target: cloud },
  { name: 'repos.getActiveRepository', call: (m) => m.repos.getActiveRepository(), method: 'GET', path: '/api/repos/active', target: cloud },
  { name: 'repos.setActiveRepositoryBaseBranch', call: (m) => m.repos.setActiveRepositoryBaseBranch('main'), method: 'PATCH', path: '/api/repos/active/base-branch', target: cloud },
  { name: 'repos.addRepoByUrl', call: (m) => m.repos.addRepoByUrl('https://github.com/o/r'), method: 'POST', path: '/api/repos/url', target: cloud },
  { name: 'repos.getActivePublicRepository', call: (m) => m.repos.getActivePublicRepository(), method: 'GET', path: '/api/repos/active/public', target: cloud },
  { name: 'repos.activatePublicRepository', call: (m) => m.repos.activatePublicRepository('p1'), method: 'POST', path: '/api/repos/p1/activate/public', target: cloud },

  // review loop (all local)
  { name: 'review.fetchTaskDiff', call: (m) => m.review.fetchTaskDiff('t1'), method: 'GET', path: '/api/tasks/t1/diff', target: sidecar },
  {
    name: 'review.fetchTaskDiff (base)',
    call: (m) => m.review.fetchTaskDiff('t1', { base: 'origin/main' }),
    method: 'GET',
    path: '/api/tasks/t1/diff?base=origin%2Fmain',
    target: sidecar,
  },
  {
    name: 'review.sendTaskFollowUp',
    call: (m) => m.review.sendTaskFollowUp('t1', { message: 'm', comments: [{ path: 'a.ts', line: 1, side: 'new', body: 'b' }] }),
    method: 'POST',
    path: '/api/tasks/t1/follow-up',
    target: sidecar,
  },
  { name: 'review.redirectTask', call: (m) => m.review.redirectTask('t1', 'Only fix the null check'), method: 'POST', path: '/api/tasks/t1/redirect', target: sidecar },
  { name: 'review.fetchTaskRunState', call: (m) => m.review.fetchTaskRunState('t1'), method: 'GET', path: '/api/tasks/t1/run', target: sidecar },

  // Settings → Agents (all local): runner catalogue (FE-02), project trust grants (FE-03)
  { name: 'runners.fetchRunnerCatalogue', call: (m) => m.runners.fetchRunnerCatalogue(), method: 'GET', path: '/api/runners', target: sidecar },
  { name: 'runners.fetchRunnerCatalogue (refresh)', call: (m) => m.runners.fetchRunnerCatalogue({ refresh: true }), method: 'GET', path: '/api/runners?refresh=1', target: sidecar },
  { name: 'sandboxGrants.fetchSandboxGrants', call: (m) => m.sandboxGrants.fetchSandboxGrants(), method: 'GET', path: '/api/sandbox/grants', target: sidecar },
  {
    name: 'sandboxGrants.createSandboxGrant',
    call: (m) => m.sandboxGrants.createSandboxGrant({ projectId: 'p1', reason: 'sandbox is broken here', hours: 1 }),
    method: 'POST',
    path: '/api/sandbox/grants',
    target: sidecar,
  },
  { name: 'sandboxGrants.revokeSandboxGrant', call: (m) => m.sandboxGrants.revokeSandboxGrant('tg_0123456789abcdef'), method: 'POST', path: '/api/sandbox/grants/tg_0123456789abcdef/revoke', target: sidecar },

  // Related files (FE-11 / W16b, local repository)
  { name: 'repoContext.fetchRelatedFiles', call: (m) => m.repoContext.fetchRelatedFiles('t1'), method: 'GET', path: '/api/tasks/t1/related-files', target: sidecar },

  // Agent reviews (W19a, local)
  { name: 'agentReviews.fetchAgentReviews', call: (m) => m.agentReviews.fetchAgentReviews('t1'), method: 'GET', path: '/api/tasks/t1/reviews', target: sidecar },
  { name: 'agentReviews.startAgentReview', call: (m) => m.agentReviews.startAgentReview('t1'), method: 'POST', path: '/api/tasks/t1/reviews', target: sidecar },
  { name: 'agentReviews.cancelAgentReview', call: (m) => m.agentReviews.cancelAgentReview('t1', 'r1'), method: 'POST', path: '/api/tasks/t1/reviews/r1/cancel', target: sidecar },

  // Approvals (FE-04, local): what the agent is waiting on
  { name: 'approvals.fetchApprovals', call: (m) => m.approvals.fetchApprovals('t1'), method: 'GET', path: '/api/tasks/t1/approvals', target: sidecar },
  { name: 'approvals.fetchMyApprovals', call: (m) => m.approvals.fetchMyApprovals(), method: 'GET', path: '/api/approvals', target: sidecar },
  {
    name: 'approvals.decideApproval',
    call: (m) => m.approvals.decideApproval('t1', 'a1', { decision: 'allow', digest: 'd'.repeat(64) }),
    method: 'POST',
    path: '/api/tasks/t1/approvals/a1',
    target: sidecar,
  },

  // tasks
  { name: 'tasks.fetchMyIssues', call: (m) => m.tasks.fetchMyIssues(), method: 'GET', path: '/api/tasks?assignee=me', target: cloud },
  { name: 'tasks.fetchProjectIssues', call: (m) => m.tasks.fetchProjectIssues('p1'), method: 'GET', path: '/api/tasks?projectId=p1', target: cloud },
  { name: 'tasks.createTask', call: (m) => m.tasks.createTask({ title: 't' }), method: 'POST', path: '/api/tasks', target: cloud },
  { name: 'tasks.executeTaskPublic', call: (m) => m.tasks.executeTaskPublic('t1'), method: 'POST', path: '/api/tasks/t1/execute', target: sidecar },
  { name: 'tasks.fetchInboxTasks', call: (m) => m.tasks.fetchInboxTasks(), method: 'GET', path: '/api/inbox', target: cloud },
  { name: 'tasks.fetchInboxCount', call: (m) => m.tasks.fetchInboxCount(), method: 'GET', path: '/api/inbox/count', target: cloud },
  { name: 'tasks.markInboxRead', call: (m) => m.tasks.markInboxRead('t1'), method: 'PATCH', path: '/api/inbox/read/t1', target: cloud },
  { name: 'tasks.markAllInboxRead', call: (m) => m.tasks.markAllInboxRead(), method: 'PATCH', path: '/api/inbox/read-all', target: cloud },
  { name: 'tasks.refreshTaskPr', call: (m) => m.tasks.refreshTaskPr('t1'), method: 'POST', path: '/api/tasks/t1/refresh-pr', target: sidecar },
  { name: 'tasks.fetchExecutionLogs', call: (m) => m.tasks.fetchExecutionLogs('t1'), method: 'GET', path: '/api/tasks/t1/logs', target: sidecar },

  // schedules (W20 recurring issues): cloud API
  { name: 'schedules.fetchProjectSchedules', call: (m) => m.schedules.fetchProjectSchedules('p1'), method: 'GET', path: '/api/projects/p1/schedules', target: cloud },
  { name: 'schedules.fetchSchedule', call: (m) => m.schedules.fetchSchedule('s1'), method: 'GET', path: '/api/schedules/s1', target: cloud },
  { name: 'schedules.createSchedule', call: (m) => m.schedules.createSchedule('p1', { title: 't', description: null, priority: 'medium', labelIds: [], assigneeId: null, cadence: 'daily', hour: 9, minute: 0, timezone: 'UTC' }, 'key-0123456789'), method: 'POST', path: '/api/projects/p1/schedules', target: cloud },
  { name: 'schedules.updateSchedule', call: (m) => m.schedules.updateSchedule('s1', { title: 't', description: null, priority: 'medium', labelIds: [], assigneeId: null, cadence: 'daily', hour: 9, minute: 0, timezone: 'UTC' }), method: 'PATCH', path: '/api/schedules/s1', target: cloud },
  { name: 'schedules.pauseSchedule', call: (m) => m.schedules.pauseSchedule('s1'), method: 'POST', path: '/api/schedules/s1/pause', target: cloud },
  { name: 'schedules.resumeSchedule', call: (m) => m.schedules.resumeSchedule('s1'), method: 'POST', path: '/api/schedules/s1/resume', target: cloud },
  { name: 'schedules.runScheduleNow', call: (m) => m.schedules.runScheduleNow('s1'), method: 'POST', path: '/api/schedules/s1/run-now', target: cloud },
  { name: 'schedules.deleteSchedule', call: (m) => m.schedules.deleteSchedule('s1'), method: 'DELETE', path: '/api/schedules/s1', target: cloud },

  // teams
  { name: 'teams.fetchTeams', call: (m) => m.teams.fetchTeams(), method: 'GET', path: '/api/teams', target: cloud },
  { name: 'teams.fetchTeam', call: (m) => m.teams.fetchTeam('team1'), method: 'GET', path: '/api/teams/team1', target: cloud },
  { name: 'teams.createTeam', call: (m) => m.teams.createTeam({ name: 't', key: 'T' }), method: 'POST', path: '/api/teams', target: cloud },
  { name: 'teams.updateTeam', call: (m) => m.teams.updateTeam('team1', { name: 't' }), method: 'PATCH', path: '/api/teams/team1', target: cloud },
  { name: 'teams.deleteTeam', call: (m) => m.teams.deleteTeam('team1'), method: 'DELETE', path: '/api/teams/team1', target: cloud },
  { name: 'teams.addTeamMember', call: (m) => m.teams.addTeamMember('team1', { userId: 'u1' }), method: 'POST', path: '/api/teams/team1/members', target: cloud },
  { name: 'teams.removeTeamMember', call: (m) => m.teams.removeTeamMember('team1', 'u1'), method: 'DELETE', path: '/api/teams/team1/members/u1', target: cloud },
  { name: 'teams.updateTeamMember', call: (m) => m.teams.updateTeamMember('team1', 'u1', { role: 'member' }), method: 'PATCH', path: '/api/teams/team1/members/u1', target: cloud },
  { name: 'teams.joinTeam', call: (m) => m.teams.joinTeam('invite'), method: 'POST', path: '/api/teams/join', target: cloud },

  // workspaces
  { name: 'workspaces.fetchWorkspaces', call: (m) => m.workspaces.fetchWorkspaces(), method: 'GET', path: '/api/workspaces', target: cloud },
  { name: 'workspaces.fetchWorkspace', call: (m) => m.workspaces.fetchWorkspace('w1'), method: 'GET', path: '/api/workspaces/w1', target: cloud },
  { name: 'workspaces.fetchWorkspaceStructure', call: (m) => m.workspaces.fetchWorkspaceStructure('w1'), method: 'GET', path: '/api/workspaces/w1/structure', target: cloud },
  { name: 'workspaces.fetchWorkspaceStructureSummary', call: (m) => m.workspaces.fetchWorkspaceStructureSummary('w1'), method: 'GET', path: '/api/workspaces/w1/structure?view=summary', target: cloud },
  { name: 'workspaces.fetchWorkspaceMembers', call: (m) => m.workspaces.fetchWorkspaceMembers('w1'), method: 'GET', path: '/api/workspaces/w1/members?limit=200', target: cloud },
  { name: 'workspaces.createWorkspace', call: (m) => m.workspaces.createWorkspace({ name: 'w' }), method: 'POST', path: '/api/workspaces', target: cloud },
  { name: 'workspaces.updateWorkspace', call: (m) => m.workspaces.updateWorkspace('w1', { name: 'w' }), method: 'PATCH', path: '/api/workspaces/w1', target: cloud },
  { name: 'workspaces.deleteWorkspace', call: (m) => m.workspaces.deleteWorkspace('w1'), method: 'DELETE', path: '/api/workspaces/w1', target: cloud },
  { name: 'workspaces.inviteWorkspaceMember', call: (m) => m.workspaces.inviteWorkspaceMember('w1', { email: 'a@example.com' }), method: 'POST', path: '/api/workspaces/w1/members', target: cloud },
  { name: 'workspaces.updateWorkspaceMember', call: (m) => m.workspaces.updateWorkspaceMember('w1', 'u1', { role: 'member' }), method: 'PATCH', path: '/api/workspaces/w1/members/u1', target: cloud },
  { name: 'workspaces.removeWorkspaceMember', call: (m) => m.workspaces.removeWorkspaceMember('w1', 'u1'), method: 'DELETE', path: '/api/workspaces/w1/members/u1', target: cloud },
  // task commands (board bulk actions + idempotent creates) — cloud only
  { name: 'taskCommands.createTaskWithKey', call: (m) => m.taskCommands.createTaskWithKey({ title: 'T', projectId: 'p1' }, 'idem-key-1'), method: 'POST', path: '/api/tasks', target: cloud },
  { name: 'taskCommands.bulkCreateTasks', call: (m) => m.taskCommands.bulkCreateTasks({ projectId: 'p1', tasks: [{ title: 'T' }] }, 'idem-key-2'), method: 'POST', path: '/api/tasks/bulk', target: cloud },
  { name: 'taskCommands.bulkUpdateTaskStatus', call: (m) => m.taskCommands.bulkUpdateTaskStatus({ projectId: 'p1', status: 'done', taskIds: ['t1'] }), method: 'PATCH', path: '/api/tasks/bulk-status', target: cloud },
  { name: 'taskCommands.bulkArchiveTasks', call: (m) => m.taskCommands.bulkArchiveTasks({ projectId: 'p1', taskIds: ['t1'] }), method: 'POST', path: '/api/tasks/bulk-archive', target: cloud },
  { name: 'taskCommands.bulkDeleteTasks', call: (m) => m.taskCommands.bulkDeleteTasks({ projectId: 'p1', taskIds: ['t1'] }), method: 'POST', path: '/api/tasks/bulk-delete', target: cloud },
]

/** Exported functions that never make a request. */
const NOT_REQUESTS = new Set([
  'approvals.expiresIn',
  'auth.getLoginUrl',
  'auth.parseDesktopCallbackUrl',
  'opencode.isModelNotConfiguredError',
  'runners.isRunnerId',
  'schedules.scheduleBody',
  'schedules.localTimeZone',
  'schedules.describeCadence',
  'schedules.formatLocalDateTime',
  'schedules.nextRunText',
  'schedules.pauseReasonText',
  'schedules.timeZoneOptions',
  'workspaces.structureMemberCount',
])

function isClass(value) {
  return typeof value === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(value))
}

function forRuntime(value, runtime) {
  return typeof value === 'object' ? value[runtime] : value
}

describe('route table', () => {
  it.each([
    ['/api/tasks/t1/execute', 'sidecar'],
    ['/api/tasks/t1/cancel', 'sidecar'],
    ['/api/tasks/t1/logs', 'sidecar'],
    ['/api/tasks/t1/running', 'sidecar'],
    ['/api/tasks/t1/refresh-pr', 'sidecar'],
    ['/api/tasks/t1/diff', 'sidecar'],
    ['/api/tasks/t1/diff?base=main', 'sidecar'],
    ['/api/tasks/t1/follow-up', 'sidecar'],
    ['/api/tasks/t1/run', 'sidecar'],
    ['/api/tasks/t1/related-files', 'sidecar'],
    ['/api/tasks/t1/related-files/x', 'cloud'],
    ['/api/batches', 'sidecar'],
    ['/api/batches/b1/tasks/t1/cancel', 'sidecar'],
    ['/api/opencode/models?x=1', 'sidecar'],
    ['/api/transcribe', 'sidecar'],
    ['/api/runners', 'sidecar'],
    ['/api/runners?refresh=1', 'sidecar'],
    ['/api/sandbox/grants', 'sidecar'],
    ['/api/sandbox/grants/tg_1/revoke', 'sidecar'],
    ['/api/runnersx', 'cloud'],
    ['/api/sandbox', 'cloud'],
    ['/api/sandbox/grantsx', 'cloud'],
    ['/api/tasks', 'cloud'],
    ['/api/tasks/t1', 'cloud'],
    ['/api/tasks/t1/comments?page=1', 'cloud'],
    ['/api/tasks/t1/execution', 'cloud'],
    ['/api/tasks/t1/diffs', 'cloud'],
    ['/api/tasks/t1/run/x', 'cloud'],
    ['/api/tasks/t1/follow-ups', 'cloud'],
    ['/api/tasks/bulk', 'cloud'],
    ['/api/tasks/archived', 'cloud'],
    ['/api/batchesx', 'cloud'],
    ['/api/opencodex', 'cloud'],
    ['/api/auth/refresh', 'cloud'],
    ['/api/events/ticket', 'cloud'],
    ['/api/chat/sessions/s1/messages', 'cloud'],
    ['/api/projects?execute=1', 'cloud'],
  ])('%s → %s', (path, target) => {
    expect(resolveApiTarget(path)).toBe(target)
  })

  it('documents every sidecar route it matches', () => {
    expect(SIDECAR_ROUTES.map((route) => route.route)).toEqual([
      'POST /api/tasks/:id/execute',
      'POST /api/tasks/:id/cancel',
      'GET /api/tasks/:id/logs',
      'GET /api/tasks/:id/running',
      'POST /api/tasks/:id/refresh-pr',
      'GET /api/tasks/:id/diff',
      'POST /api/tasks/:id/follow-up',
      'POST /api/tasks/:id/redirect',
      'GET /api/tasks/:id/run',
      'GET /api/tasks/:id/related-files',
      '/api/batches/**',
      '/api/opencode/**',
      'POST /api/transcribe',
      'GET /api/runners',
      '/api/sandbox/grants/**',
      'GET /api/approvals',
      'GET|POST /api/tasks/:id/approvals[/:approvalId]',
      'GET|POST /api/tasks/:id/reviews[/:reviewId/cancel]',
    ])
  })
})

describe('every lib/api request function is classified', () => {
  it('has a routing case for each exported function', () => {
    const classified = new Set([...CASES.map((c) => c.name), ...NOT_REQUESTS])
    const unclassified = Object.entries(modules).flatMap(([moduleName, mod]) =>
      Object.entries(mod)
        .filter(([, value]) => typeof value === 'function' && !isClass(value))
        .map(([name]) => `${moduleName}.${name}`)
        .filter((name) => !classified.has(name)),
    )
    // Add a row to CASES (and, for a new sidecar route, to routes.ts).
    expect(unclassified).toEqual([])
  })
})

describe.each([['web'], ['desktop']])('%s runtime', (runtime) => {
  const savedEnv = {}
  const ENV_KEYS = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_CLOUD_API_URL', 'NEXT_PUBLIC_SIDECAR_URL']
  let fetchMock

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    if (runtime === 'desktop') {
      window.__TAURI_INTERNALS__ = {}
      process.env.NEXT_PUBLIC_CLOUD_API_URL = CLOUD
      delete process.env.NEXT_PUBLIC_API_URL
      delete process.env.NEXT_PUBLIC_SIDECAR_URL
    } else {
      window.__TAURI_INTERNALS__ = undefined
      process.env.NEXT_PUBLIC_API_URL = CLOUD
      process.env.NEXT_PUBLIC_SIDECAR_URL = WEB_SIDECAR
      delete process.env.NEXT_PUBLIC_CLOUD_API_URL
    }
    invoke.mockReset()
    invoke.mockImplementation(async (command) =>
      command === 'get_api_server_port' || command === 'start_api_server' ? DESKTOP_SIDECAR_PORT : null,
    )
    client.resetSidecarUrlCacheForTests()
    tokenStore.resetTokenStoreForTests()
    desktopAuth.resetPendingLoginsForTests()
    localStorage.clear()
    tokenStore.setToken('stored-access-token')
    fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.__TAURI_INTERNALS__ = undefined
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it.each(CASES)('$name → $target', async ({ call, method, path, target }) => {
    await Promise.resolve(call(modules, runtime)).catch(() => undefined)
    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    const base = target === 'sidecar' ? (runtime === 'desktop' ? DESKTOP_SIDECAR : WEB_SIDECAR) : CLOUD
    expect(String(url)).toBe(`${base}${forRuntime(path, runtime)}`)
    expect((init?.method ?? 'GET').toUpperCase()).toBe(forRuntime(method, runtime))
  })
})
