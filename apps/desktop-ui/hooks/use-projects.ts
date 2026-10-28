"use client"

import { useEffect, useCallback } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  createProject,
  updateProject,
  deleteProject,
  ApiError,
  type Project,
} from "@/lib/api"
import { useWorkspace } from "@/hooks/use-workspace"
import { toast } from "sonner"
import { queryKeys } from "@/lib/query/keys"
import { projectsQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_PROJECTS: Project[] = []

export function mapErrorToForm(
  err: unknown,
  fallbackMessage: string,
): { toastMessage: string; formErrors: Record<string, string> } {
  if (err instanceof ApiError) {
    const formErrors: Record<string, string> = {}
    const details = err.details as
      | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
      | undefined
    if (details?.fieldErrors && typeof details.fieldErrors === "object") {
      for (const [field, msgs] of Object.entries(details.fieldErrors)) {
        if (Array.isArray(msgs) && msgs.length > 0 && typeof msgs[0] === "string") {
          formErrors[field] = msgs[0]
        }
      }
    }
    if (err.code === "OWNERSHIP_REQUIRED") {
      const message =
        err.status === 404
          ? "You don't have access to this resource."
          : "You don't have permission to perform this action."
      formErrors._root = message
      return { toastMessage: message, formErrors }
    }
    formErrors._root = err.message
    return { toastMessage: err.message, formErrors }
  }
  return {
    toastMessage: fallbackMessage,
    formErrors: { _root: fallbackMessage },
  }
}

export type StatusType = 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled'

export const statusConfig: Record<StatusType, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  planned: { label: "Planned", variant: "outline" },
  in_progress: { label: "In Progress", variant: "default" },
  paused: { label: "Paused", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  cancelled: { label: "Cancelled", variant: "destructive" }
}

export const statusOptions = [
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const

export interface ProjectFormData {
  name: string
  description: string
  status: string
  targetDate: string
  sourceType: "none" | "repo" | "local"
  repoUrl: string
  localPath: string
}

export const emptyFormData: ProjectFormData = {
  name: "",
  description: "",
  status: "planned",
  targetDate: "",
  sourceType: "none",
  repoUrl: "",
  localPath: "",
}

export function projectToFormData(project: Project): ProjectFormData {
  return {
    name: project.name,
    description: project.description || "",
    status: project.status,
    targetDate: project.targetDate ? project.targetDate.split('T')[0] : "",
    sourceType: project.repoUrl ? "repo" : project.localPath ? "local" : "none",
    repoUrl: project.repoUrl || "",
    localPath: project.localPath || "",
  }
}

export function useProjects(filterTeamId?: string) {
  const { activeWorkspace, isLoading: isWorkspaceLoading } = useWorkspace()
  const activeWorkspaceId = activeWorkspace?.id
  const client = useAppQueryClient()
  const enabled = !isWorkspaceLoading && Boolean(activeWorkspaceId)
  // Unfiltered, this is the same cache entry as ProjectProvider's list, so the
  // Projects page renders from cache. SSE `project:*` events patch it (bridge).
  const query = useQuery({ ...projectsQuery(activeWorkspaceId ?? "", filterTeamId), enabled }, client)
  const projects = (enabled ? query.data : undefined) ?? NO_PROJECTS
  const isLoading = isWorkspaceLoading || (enabled && query.isPending)

  // One toast per failed load, as before.
  const { error, errorUpdatedAt } = query
  useEffect(() => {
    if (!error) return
    const { toastMessage } = mapErrorToForm(
      error,
      "Could not reach OpenLinear server. Check your connection and try again.",
    )
    toast.error(`Failed to load projects: ${toastMessage}`)
  }, [error, errorUpdatedAt])

  const loadProjects = useCallback(async () => {
    if (!activeWorkspaceId || isWorkspaceLoading) return
    await client.refetchQueries({ queryKey: projectsQuery(activeWorkspaceId, filterTeamId).queryKey, exact: true })
  }, [activeWorkspaceId, client, filterTeamId, isWorkspaceLoading])

  /** Apply the server's copy at once, then refetch for server-computed fields (`_count`, `teams`). */
  const reconcile = useCallback((apply: (list: Project[], teamFiltered: boolean) => Project[]) => {
    if (!activeWorkspaceId) return
    const prefix = queryKeys.projects.lists(activeWorkspaceId)
    for (const cached of client.getQueryCache().findAll({ queryKey: prefix })) {
      const list = cached.state.data
      if (!Array.isArray(list)) continue
      const filter = cached.queryKey[4]
      const teamFiltered = typeof filter === "object" && filter !== null && typeof (filter as { teamId?: unknown }).teamId === "string"
      const next = apply(list as Project[], teamFiltered)
      if (next !== list) client.setQueryData(cached.queryKey, next)
    }
    void client.invalidateQueries({ queryKey: prefix })
  }, [activeWorkspaceId, client])

  const createMutation = useMutation({
    mutationFn: ({ formData, isDesktopApp }: { formData: ProjectFormData; isDesktopApp: boolean }) =>
      createProject({
        name: formData.name.trim(),
        workspaceId: activeWorkspaceId,
        description: formData.description.trim() || undefined,
        status: formData.status,
        targetDate: formData.targetDate ? new Date(formData.targetDate).toISOString() : undefined,
        color: "#10b981",
        repoUrl: formData.sourceType === "repo" ? formData.repoUrl.trim() : undefined,
        localPath: formData.sourceType === "local" && isDesktopApp ? formData.localPath.trim() : undefined,
      }),
    onSuccess: (created) => reconcile((list, teamFiltered) => (
      !teamFiltered && created?.id && !list.some((p) => p.id === created.id) ? [created, ...list] : list
    )),
  }, client)

  const updateMutation = useMutation({
    mutationFn: ({ projectId, formData, isDesktopApp, existingLocalPath }: {
      projectId: string
      formData: ProjectFormData
      isDesktopApp: boolean
      existingLocalPath?: string | null
    }) =>
      updateProject(projectId, {
        name: formData.name.trim(),
        description: formData.description.trim() || null,
        status: formData.status,
        targetDate: formData.targetDate ? new Date(formData.targetDate).toISOString() : null,
        repoUrl: formData.sourceType === "repo" ? formData.repoUrl.trim() : null,
        localPath:
          formData.sourceType === "local"
            ? (isDesktopApp || !!existingLocalPath ? formData.localPath.trim() : null)
            : null,
      }),
    onSuccess: (updated, { projectId }) => reconcile((list) => (
      updated?.id && list.some((p) => p.id === projectId)
        ? list.map((p) => (p.id === projectId ? { ...p, ...updated } : p))
        : list
    )),
  }, client)

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: (_result, projectId) => reconcile((list) => (
      list.some((p) => p.id === projectId) ? list.filter((p) => p.id !== projectId) : list
    )),
  }, client)

  const handleCreateProject = async (formData: ProjectFormData, isDesktopApp: boolean) => {
    await createMutation.mutateAsync({ formData, isDesktopApp })
  }

  const handleUpdateProject = async (projectId: string, formData: ProjectFormData, isDesktopApp: boolean, existingLocalPath?: string | null) => {
    await updateMutation.mutateAsync({ projectId, formData, isDesktopApp, existingLocalPath })
  }

  const handleDeleteProject = async (projectId: string) => {
    await deleteMutation.mutateAsync(projectId)
  }

  return {
    projects,
    isLoading,
    isWorkspaceLoading,
    activeWorkspaceId,
    loadProjects,
    handleCreateProject,
    handleUpdateProject,
    handleDeleteProject,
  }
}
