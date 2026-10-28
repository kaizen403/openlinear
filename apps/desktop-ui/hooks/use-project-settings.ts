"use client"

import { useMemo } from "react"
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query"
import {
  deleteProject,
  grantProjectAccess,
  revokeProjectAccess,
  updateProject,
  type Project,
  type ProjectAccess,
  type ProjectPermission,
} from "@/lib/api"
import { apiFetch } from "@/lib/api/fetch"
import type { Label } from "@/types/task"
import { queryKeys } from "@/lib/query/keys"
import { projectAccessQuery, projectDetailQuery, setAccessPermission, upsertAccess } from "@/lib/query/project-settings"
import { projectLabelsQuery, workspaceMembersQuery } from "@/lib/query/resources"
import { forgetDeleted } from "@/lib/query/teams"
import { isNotFound } from "@/hooks/use-team-directory"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import type { WorkspaceMember } from "@/lib/api/types"

const NO_ACCESS: ProjectAccess[] = []
const NO_MEMBERS: WorkspaceMember[] = []
const NO_LABELS: Label[] = []

function isProjectList(query: { queryKey: readonly unknown[] }): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "ws" && query.queryKey[3] === "projects"
}

/** The server's copy of a project into its detail entry and every cached project list. */
function writeProject(client: QueryClient, project: Project): void {
  const detailKey = queryKeys.projects.detail(project.id)
  const detail = client.getQueryData<Project>(detailKey)
  client.setQueryData<Project>(detailKey, detail ? { ...detail, ...project } : project)
  for (const query of client.getQueryCache().findAll({ predicate: isProjectList })) {
    const list = query.state.data
    if (!Array.isArray(list) || !(list as Project[]).some((p) => p.id === project.id)) continue
    client.setQueryData<Project[]>(query.queryKey, (list as Project[]).map((p) => (p.id === project.id ? { ...p, ...project } : p)))
  }
  const directory = client.getQueryData<Array<{ id: string; name: string }>>(queryKeys.projects.directory())
  if (directory?.some((p) => p.id === project.id && p.name !== project.name)) {
    client.setQueryData(queryKeys.projects.directory(), directory.map((p) => (p.id === project.id ? { ...p, name: project.name } : p)))
  }
}

function dropProject(client: QueryClient, projectId: string): void {
  for (const query of client.getQueryCache().findAll({ predicate: isProjectList })) {
    const list = query.state.data
    if (Array.isArray(list) && (list as Project[]).some((p) => p.id === projectId)) {
      client.setQueryData<Project[]>(query.queryKey, (list as Project[]).filter((p) => p.id !== projectId))
    }
  }
  const directory = client.getQueryData<Array<{ id: string; name: string }>>(queryKeys.projects.directory())
  if (directory?.some((p) => p.id === projectId)) {
    client.setQueryData(queryKeys.projects.directory(), directory.filter((p) => p.id !== projectId))
  }
}

function sortLabels(labels: Label[]): Label[] {
  return [...labels].sort((a, b) => a.priority - b.priority)
}

function updateLabels(client: QueryClient, projectId: string, update: (labels: Label[]) => Label[]): void {
  const key = queryKeys.projects.labels(projectId)
  const labels = client.getQueryData<Label[]>(key)
  if (!labels) return
  const next = update(labels)
  if (next !== labels) client.setQueryData(key, sortLabels(next))
}

/**
 * Project settings from the query cache: the project, its access rules, the
 * workspace members (shared with the board's assignee options) and the labels
 * (shared with the label picker, so edits here show up there at once and the
 * page no longer keeps its own copy).
 */
export function useProjectSettings(projectId: string, fallbackWorkspaceId: string | null | undefined) {
  const client = useAppQueryClient()
  const enabled = Boolean(projectId)
  const detail = useQuery({ ...projectDetailQuery(projectId), enabled }, client)
  const access = useQuery({ ...projectAccessQuery(projectId), enabled }, client)
  // As before, members wait for the project (its workspace), falling back to the active one.
  const workspaceId = detail.data ? detail.data.workspaceId ?? fallbackWorkspaceId ?? null : null
  const members = useQuery({ ...workspaceMembersQuery(workspaceId ?? ""), enabled: Boolean(workspaceId) }, client)
  const labels = useQuery({ ...projectLabelsQuery(projectId), enabled }, client)
  // The page lists labels highest priority first (the shared entry is ascending).
  const labelsByPriority = useMemo(
    () => (labels.data ? [...labels.data].sort((a, b) => b.priority - a.priority) : NO_LABELS),
    [labels.data],
  )

  const save = useMutation({
    mutationFn: (input: { name?: string; description?: string | null; defaultAgent?: string | null }) => updateProject(projectId, input),
    onSuccess: (updated) => {
      if (updated?.id) writeProject(client, updated)
    },
  }, client)

  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      dropProject(client, projectId)
      forgetDeleted(client, queryKeys.projects.scope(projectId))
    },
  }, client)

  const grant = useMutation({
    mutationFn: ({ userId, permission }: { userId: string; permission: ProjectPermission }) =>
      grantProjectAccess(projectId, userId, permission),
    onSuccess: (granted) => upsertAccess(client, projectId, [granted]),
  }, client)

  // Optimistic with rollback, as the page did before.
  const changePermission = useMutation({
    mutationFn: ({ userId, permission }: { userId: string; permission: ProjectPermission }) =>
      grantProjectAccess(projectId, userId, permission),
    onMutate: async ({ userId, permission }) => {
      await client.cancelQueries({ queryKey: queryKeys.projects.access(projectId), exact: true })
      const previous = client.getQueryData<ProjectAccess[]>(queryKeys.projects.access(projectId))?.find((entry) => entry.userId === userId)?.permission
      setAccessPermission(client, projectId, userId, permission)
      return { previous }
    },
    onSuccess: (updated) => upsertAccess(client, projectId, [updated]),
    onError: (_error, { userId, permission }, context) => {
      const previous = context?.previous
      const current = client.getQueryData<ProjectAccess[]>(queryKeys.projects.access(projectId))?.find((entry) => entry.userId === userId)
      if (previous && current?.permission === permission) setAccessPermission(client, projectId, userId, previous)
    },
  }, client)

  const revoke = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onSuccess: (_result, userId) => { setAccessPermission(client, projectId, userId, "deny") },
  }, client)

  const createLabel = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      apiFetch<Label>("/api/labels", { method: "POST", body: JSON.stringify({ ...input, projectId }) }),
    onSuccess: (label) => updateLabels(client, projectId, (list) => (list.some((l) => l.id === label.id) ? list : [...list, label])),
  }, client)

  const updateLabel = useMutation({
    mutationFn: ({ labelId, name, color }: { labelId: string; name: string; color: string }) =>
      apiFetch<Label>(`/api/labels/${labelId}`, { method: "PATCH", body: JSON.stringify({ name, color }) }),
    onSuccess: (label, { labelId }) => updateLabels(client, projectId, (list) => list.map((l) => (l.id === labelId ? { ...l, ...label } : l))),
  }, client)

  const deleteLabel = useMutation({
    mutationFn: (labelId: string) => apiFetch(`/api/labels/${labelId}`, { method: "DELETE" }),
    onSuccess: (_result, labelId) => updateLabels(client, projectId, (list) => (list.some((l) => l.id === labelId) ? list.filter((l) => l.id !== labelId) : list)),
  }, client)

  return {
    // A 404 means it is gone, even if an older copy is still cached.
    project: enabled && !isNotFound(detail.error) ? detail.data ?? null : null,
    /** First load of the project and its access rules (the page's skeleton). */
    isLoading: !enabled || detail.isPending || access.isPending,
    loadError: detail.error ?? access.error ?? members.error ?? null,
    loadErrorAt: Math.max(detail.errorUpdatedAt, access.errorUpdatedAt, members.errorUpdatedAt),
    labelsError: labels.error,
    labelsErrorAt: labels.errorUpdatedAt,
    access: access.data ?? NO_ACCESS,
    isLoadingAccess: access.isPending,
    workspaceMembers: (workspaceId ? members.data : undefined) ?? NO_MEMBERS,
    labels: labelsByPriority,
    isLoadingLabels: enabled && labels.isPending,
    save,
    remove,
    grant,
    changePermission,
    revoke,
    createLabel,
    updateLabel,
    deleteLabel,
  }
}
