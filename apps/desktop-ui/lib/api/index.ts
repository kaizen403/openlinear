export type {
  User,
  Repository,
  GitHubRepo,
  GitHubBranch,
  GitHubBranchesResponse,
  GitHubRepoFilter,
  GitHubReposResponse,
  GitHubRepoSort,
  PublicRepository,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  Team,
  TeamMember,
  Project,
  ProjectAccess,
  ProjectPermission,
  InboxCount,
  InboxTask,
  MyIssueTask,
} from './types';

export { apiFetch, apiFetchRaw, ApiError, AuthExpiredError, NetworkError } from './fetch';
export type { ApiFetchInit } from './fetch';

export {
  completeDesktopLogin,
  completeTwoFactorLogin,
  DesktopLoginError,
  fetchAuthProviders,
  fetchCurrentUser,
  getLoginUrl,
  GITHUB_OAUTH_UNAVAILABLE_MESSAGE,
  parseDesktopCallbackUrl,
  startDesktopLogin,
  startLogin,
  logout,
  updateEmail,
  verifyCallbackToken,
} from './auth';
export type { AuthProviders, DesktopCallback, DesktopLoginFailure, DesktopLoginResult } from './auth';

export { getCloudApiUrl, getSidecarApiUrl, isDesktopRuntime } from './client';
export { resolveApiTarget, SIDECAR_ROUTES } from './routes';
export type { ApiTarget } from './routes';

export { fetchUserRepositories, fetchGitHubRepos, fetchGitHubBranches, importRepo, activateRepository, getActiveRepository, setActiveRepositoryBaseBranch, addRepoByUrl, getActivePublicRepository, activatePublicRepository } from './repos';

export { fetchTeams, fetchTeam, createTeam, updateTeam, deleteTeam, addTeamMember, removeTeamMember, updateTeamMember, joinTeam } from './teams';

export { fetchProjects, createProject, updateProject, deleteProject, fetchProjectAccess, grantProjectAccess, revokeProjectAccess } from './projects';

export { fetchWorkspaces, fetchWorkspace, fetchWorkspaceStructure, fetchWorkspaceMembers, createWorkspace, updateWorkspace, deleteWorkspace, inviteWorkspaceMember, updateWorkspaceMember, removeWorkspaceMember } from './workspaces';
export type { WorkspaceStructure, WorkspaceStructureProject, WorkspaceStructureTeam } from './workspaces';

export { fetchMyIssues, fetchProjectIssues, createTask, executeTaskPublic, refreshTaskPr, fetchInboxTasks, fetchInboxCount, markInboxRead, markAllInboxRead } from './tasks';

export { fetchPersonalAccessTokens, createPersonalAccessToken, revokePersonalAccessToken } from './pats';
export type { PersonalAccessToken, CreatedPersonalAccessToken } from './pats';

export { fetchChatSessions, createChatSession, fetchChatSession, updateChatSession, archiveChatSession, sendChatMessage } from './chat';
export type { ChatSession, ChatMessage, ChatChunk, ChatChunkType, ChatMessageRole, ToolCall, SendMessageOptions } from './chat';
