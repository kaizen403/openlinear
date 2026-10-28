import { fetchWorkspaces, fetchWorkspaceMembers } from "@/lib/api/workspaces"
// Through the package index: hooks and their tests import these from "@/lib/api".
import { fetchProjects, fetchTeams } from "@/lib/api"
import { fetchChatSessions, type ChatSession } from "@/lib/api/chat"
import { fetchComments, fetchTaskTeamId, fetchTeamMembers, type Comment, type TaskWithTeam } from "@/lib/api/comments"
import { apiFetch } from "@/lib/api/fetch"
import type { Project, Team, TeamMember, Workspace, WorkspaceMember } from "@/lib/api/types"
import type { Label } from "@/types/task"
import { STALE_TIME } from "./client"
import { queryKeys } from "./keys"

/**
 * Query definitions (key + fetcher + freshness) for the read-mostly
 * resources. Hooks spread these into `useQuery`, and imperative callers use
 * them with `client.query(...)`, so a key always maps to
 * exactly one fetcher.
 */

/** Project fields the app reads anywhere (sidebar, chat scope, board, projects page). */
export const PROJECT_FIELDS = [
  "id", "workspaceId", "key", "name", "description", "status", "color", "icon",
  "targetDate", "repositoryId", "localPath", "repoUrl", "repository", "teams", "_count",
] as const

export const TEAM_FIELDS = ["id", "name", "color", "projectId"] as const

export function workspacesQuery() {
  return {
    queryKey: queryKeys.workspaces.list(),
    queryFn: (): Promise<Workspace[]> => fetchWorkspaces(),
    staleTime: STALE_TIME.workspaces,
  }
}

export function workspaceMembersQuery(workspaceId: string) {
  return {
    queryKey: queryKeys.workspaces.members(workspaceId),
    queryFn: (): Promise<WorkspaceMember[]> => fetchWorkspaceMembers(workspaceId),
    staleTime: STALE_TIME.members,
  }
}

export function projectsQuery(workspaceId: string, teamId?: string | null) {
  return {
    queryKey: queryKeys.projects.list(workspaceId, { teamId, fields: PROJECT_FIELDS }),
    queryFn: (): Promise<Project[]> =>
      fetchProjects({ workspaceId, ...(teamId ? { teamId } : {}), fields: [...PROJECT_FIELDS] }),
    staleTime: STALE_TIME.projects,
  }
}

export function teamsQuery(workspaceId: string) {
  return {
    queryKey: queryKeys.teams.list(workspaceId, { fields: TEAM_FIELDS }),
    queryFn: (): Promise<Team[]> => fetchTeams({ workspaceId, fields: [...TEAM_FIELDS] }),
    staleTime: STALE_TIME.teams,
  }
}

export function teamMembersQuery(teamId: string) {
  return {
    queryKey: queryKeys.teams.members(teamId),
    queryFn: (): Promise<TeamMember[]> => fetchTeamMembers(teamId),
    staleTime: STALE_TIME.members,
  }
}

export function chatSessionsQuery(workspaceId: string) {
  return {
    queryKey: queryKeys.workspaces.chatSessions(workspaceId),
    queryFn: async (): Promise<ChatSession[]> => (await fetchChatSessions(workspaceId)).data,
    staleTime: STALE_TIME.chatSessions,
  }
}

/** The task row as the comments thread needs it (team for @-mentions). */
export function taskDetailQuery(taskId: string) {
  return {
    queryKey: queryKeys.tasks.detail(taskId),
    queryFn: (): Promise<TaskWithTeam> => fetchTaskTeamId(taskId),
    staleTime: STALE_TIME.taskDetail,
  }
}

export function taskCommentsQuery(taskId: string) {
  return {
    queryKey: queryKeys.tasks.comments(taskId),
    queryFn: async (): Promise<Comment[]> => (await fetchComments(taskId)).comments,
    staleTime: STALE_TIME.taskDetail,
  }
}

export function projectLabelsQuery(projectId: string) {
  return {
    queryKey: queryKeys.projects.labels(projectId),
    queryFn: async (): Promise<Label[]> => {
      const labels = await apiFetch<Label[]>(`/api/labels?projectId=${projectId}`)
      return [...labels].sort((a, b) => a.priority - b.priority)
    },
    staleTime: STALE_TIME.labels,
  }
}

export interface UserSettings {
  taskDeletionMode?: unknown
  [key: string]: unknown
}

/** The engine's hard cap on one batch (sidecar MAX_BATCH_TASKS). */
const ENGINE_MAX_BATCH = 20;
/** The API's default `maxBatchSize` when the user never set one. */
const DEFAULT_MAX_BATCH = 3;

/** How many tasks one batch may hold for this user (Settings → AI Execution). */
export function maxBatchSizeOf(settings: UserSettings | undefined): number {
  const value = settings?.maxBatchSize
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, ENGINE_MAX_BATCH) : DEFAULT_MAX_BATCH
}

export function settingsQuery() {
  return {
    queryKey: queryKeys.settings(),
    queryFn: (): Promise<UserSettings> => apiFetch<UserSettings>("/api/settings"),
    staleTime: STALE_TIME.settings,
  }
}
