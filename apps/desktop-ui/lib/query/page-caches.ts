import type { Query, QueryClient, QueryKey } from "@tanstack/react-query"
import type { Project, WorkspaceMember } from "@/lib/api/types"
import type { Task } from "@/types/task"
import { queryKeys } from "./keys"
import { applyNotificationCreated } from "./notifications"
import { applyAccessChanged } from "./project-settings"
import {
  forgetDeleted,
  isTeam,
  isTeamDetailQuery,
  isTeamDirectoryQuery,
  isTeamMember,
  removeTeamFromCaches,
  updateTeamMembers,
  upsertTeamMember,
  writeTeamToCaches,
  type ProjectOption,
} from "./teams"
import { isWorkspaceStructureQuery } from "./workspace-structure"

/**
 * SSE → cache rules for the page-level entries (Teams, team settings,
 * Settings → Members/Workspaces, project settings, Inbox + badge, Archived).
 * Called by the bridge (sse-bridge.ts) for every event, before its own rules.
 *
 * Where the payload carries the full row (team, member, project, access rule,
 * notification) the entry is patched in place, so a user's own write is not
 * followed by a refetch of the page that made it. Where it doesn't (a member
 * removal names only the user, an archive names only the task) the entry is
 * marked stale through the bridge's coalescing invalidator: refetched once if
 * a page shows it, on the next visit otherwise.
 */

type Invalidate = (queryKey: QueryKey) => void

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function queueAll(client: QueryClient, invalidate: Invalidate, predicate: (query: Query) => boolean): void {
  for (const query of client.getQueryCache().findAll({ predicate })) invalidate(query.queryKey)
}

function isProjectDirectoryQuery(query: Query): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "projects" && query.queryKey[2] === "directory"
}

function teamsWithMember(query: Query, userId: string): boolean {
  const data = query.state.data
  const teams = Array.isArray(data) ? data : data ? [data] : []
  return teams.some((team: { members?: Array<{ userId?: string }> }) => team.members?.some((m) => m.userId === userId))
}

function isWorkspaceMember(value: unknown): value is WorkspaceMember {
  return typeof value === "object" && value !== null &&
    typeof (value as { workspaceId?: unknown }).workspaceId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { role?: unknown }).role === "string"
}

/**
 * Workspace member lists (assignee options, Settings → Members). `added` and
 * `updated` carry the full member row: patch it in. `removed` carries only
 * `{ userId }`: refetch the lists that still contain that user (after the
 * user's own removal the cache no longer does, so the echo is free).
 */
function applyWorkspaceMemberEvent(
  client: QueryClient,
  eventType: string,
  data: Record<string, unknown>,
  workspaceId: string | null,
  invalidate: Invalidate,
): void {
  const lists = client.getQueryCache().findAll({
    predicate: (q) => q.queryKey[0] === "ol" && q.queryKey[1] === "ws" && q.queryKey[3] === "members" &&
      (workspaceId === null || q.queryKey[2] === workspaceId),
  })
  for (const query of lists) {
    const members = Array.isArray(query.state.data) ? (query.state.data as WorkspaceMember[]) : null
    if (!members) continue
    if (eventType === "workspace:member-removed") {
      const userId = stringField(data, "userId")
      if (!userId || members.some((m) => m.userId === userId)) invalidate(query.queryKey)
      continue
    }
    if (!isWorkspaceMember(data)) {
      invalidate(query.queryKey)
      continue
    }
    const index = members.findIndex((m) => m.userId === data.userId)
    if (index < 0) {
      if (data.user) client.setQueryData<WorkspaceMember[]>(query.queryKey, [...members, data])
      else invalidate(query.queryKey)
      continue
    }
    const existing = members[index]!
    if (existing.role === data.role && existing.id === data.id) continue
    client.setQueryData<WorkspaceMember[]>(query.queryKey, members.map((m, i) => (i === index ? { ...m, ...data, user: data.user ?? m.user } : m)))
  }
}

export function applyPageCacheEvent(
  client: QueryClient,
  eventType: string,
  data: Record<string, unknown>,
  invalidate: Invalidate,
): void {
  switch (eventType) {
    // --- notifications -----------------------------------------------------------
    case "notification:created":
      applyNotificationCreated(client, data)
      return

    // --- teams -----------------------------------------------------------------------
    case "team:created":
    case "team:updated":
      // Full team rows (with members, _count, project): patch, insert where it now belongs.
      if (isTeam(data)) writeTeamToCaches(client, data, { insert: true })
      queueAll(client, invalidate, isWorkspaceStructureQuery)
      return
    case "team:deleted": {
      const id = stringField(data, "id") ?? stringField(data, "teamId")
      if (id) {
        removeTeamFromCaches(client, id)
        forgetDeleted(client, queryKeys.teams.detail(id))
      }
      queueAll(client, invalidate, isWorkspaceStructureQuery)
      return
    }
    case "team:member-added":
    case "team:member-updated":
      if (isTeamMember(data)) upsertTeamMember(client, data)
      else queueAll(client, invalidate, (q) => isTeamDirectoryQuery(q) || isTeamDetailQuery(q))
      if (eventType === "team:member-added") queueAll(client, invalidate, isWorkspaceStructureQuery)
      return
    case "team:member-removed": {
      // Only `{ userId }`: refetch the full teams that still list that user
      // (after the user's own removal the cache no longer does).
      const userId = stringField(data, "userId")
      const teamId = stringField(data, "teamId")
      if (userId && teamId) {
        updateTeamMembers(client, teamId, (members) => (members.some((m) => m.userId === userId) ? members.filter((m) => m.userId !== userId) : members))
      } else if (userId) {
        queueAll(client, invalidate, (q) => (isTeamDirectoryQuery(q) || isTeamDetailQuery(q)) && teamsWithMember(q, userId))
      }
      queueAll(client, invalidate, isWorkspaceStructureQuery)
      return
    }
    case "team:joined":
    case "team:left":
      // `{ teamId }` for the user who joined or left: the directory gains or loses a team.
      queueAll(client, invalidate, isTeamDirectoryQuery)
      return

    // --- projects --------------------------------------------------------------------
    case "project:created": {
      const project = data as Partial<Project>
      if (typeof project.id === "string" && typeof project.name === "string") {
        const created: ProjectOption = { id: project.id, name: project.name }
        const key = queryKeys.projects.directory()
        const list = client.getQueryData<ProjectOption[]>(key)
        if (list && !list.some((p) => p.id === created.id)) client.setQueryData(key, [...list, created])
      }
      queueAll(client, invalidate, isWorkspaceStructureQuery)
      return
    }
    case "project:updated": {
      const project = data as Partial<Project>
      if (typeof project.id !== "string") return
      const id = project.id
      const detailKey = queryKeys.projects.detail(id)
      const detail = client.getQueryData<Project>(detailKey)
      if (detail) client.setQueryData<Project>(detailKey, { ...detail, ...project })
      const directoryKey = queryKeys.projects.directory()
      const list = client.getQueryData<ProjectOption[]>(directoryKey)
      if (typeof project.name === "string" && list?.some((p) => p.id === id && p.name !== project.name)) {
        client.setQueryData(directoryKey, list.map((p) => (p.id === id ? { ...p, name: project.name as string } : p)))
      }
      queueAll(client, invalidate, isWorkspaceStructureQuery)
      return
    }
    case "project:deleted": {
      const id = stringField(data, "id") ?? stringField(data, "projectId")
      if (!id) return
      const directoryKey = queryKeys.projects.directory()
      const list = client.getQueryData<ProjectOption[]>(directoryKey)
      if (list?.some((p) => p.id === id)) client.setQueryData(directoryKey, list.filter((p) => p.id !== id))
      // The project's own entries (settings row, access, labels).
      forgetDeleted(client, queryKeys.projects.scope(id))
      queueAll(client, invalidate, (q) => isWorkspaceStructureQuery(q) || isTeamDirectoryQuery(q))
      return
    }
    case "project:access-changed":
      if (!applyAccessChanged(client, data)) {
        const projectId = stringField(data, "projectId")
        if (projectId) invalidate(queryKeys.projects.access(projectId))
      }
      // Visibility may have changed: the cross-workspace directories follow.
      queueAll(client, invalidate, (q) => isTeamDirectoryQuery(q) || isProjectDirectoryQuery(q))
      return

    // --- workspaces --------------------------------------------------------------------
    case "workspace:member-added":
    case "workspace:member-updated":
    case "workspace:member-removed": {
      const workspaceId = stringField(data, "workspaceId")
      applyWorkspaceMemberEvent(client, eventType, data, workspaceId, invalidate)
      queueAll(client, invalidate, (q) => isWorkspaceStructureQuery(q) && (workspaceId === null || q.queryKey[2] === workspaceId))
      return
    }
    case "workspace:left":
    case "workspace:deleted":
      queueAll(client, invalidate, (q) => isTeamDirectoryQuery(q) || isProjectDirectoryQuery(q))
      return

    // --- archived tasks ------------------------------------------------------------------
    case "task:deleted":
    case "tasks:bulk-deleted":
      // Archiving emits these (the card leaves the boards): the archive gained rows.
      if (client.getQueryState(queryKeys.archivedTasks())) invalidate(queryKeys.archivedTasks())
      return
    case "task:updated": {
      // A task restored from the archive.
      const id = stringField(data, "id")
      const archived = client.getQueryData<Task[]>(queryKeys.archivedTasks())
      if (id && data.archived === false && archived?.some((task) => task.id === id)) invalidate(queryKeys.archivedTasks())
      return
    }

    default:
      return
  }
}
