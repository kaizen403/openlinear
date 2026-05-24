"use client"

import { useState, useEffect, useCallback } from "react"
import {
  fetchProjects,
  createProject,
  updateProject,
  deleteProject,
  ApiError,
  type Project,
} from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"
import { useWorkspace } from "@/hooks/use-workspace"
import { toast } from "sonner"

const PROJECT_LIST_FIELDS = [
  'id',
  'workspaceId',
  'key',
  'name',
  'description',
  'status',
  'color',
  'icon',
  'targetDate',
  'repoUrl',
  'localPath',
  'repositoryId',
  'teams',
  '_count',
] as const

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
  const [projects, setProjects] = useState<Project[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadProjects = useCallback(async () => {
    if (isWorkspaceLoading) return
    if (!activeWorkspaceId) {
      setProjects([])
      return
    }
    try {
      const data = await fetchProjects({
        teamId: filterTeamId,
        workspaceId: activeWorkspaceId,
        fields: [...PROJECT_LIST_FIELDS],
      })
      setProjects(data)
    } catch (error) {
      const { toastMessage } = mapErrorToForm(
        error,
        "Could not reach OpenLinear server. Check your connection and try again.",
      )
      toast.error(`Failed to load projects: ${toastMessage}`)
    }
  }, [activeWorkspaceId, filterTeamId, isWorkspaceLoading])

  useEffect(() => {
    if (isWorkspaceLoading) return
    setIsLoading(true)
    Promise.all([loadProjects()]).finally(() => {
      setIsLoading(false)
    })
  }, [isWorkspaceLoading, loadProjects])

  useSSESubscription((eventType) => {
    if (['project:created', 'project:updated', 'project:deleted'].includes(eventType)) {
      loadProjects()
    }
  })

  const handleCreateProject = async (formData: ProjectFormData, isDesktopApp: boolean) => {
    await createProject({
      name: formData.name.trim(),
      workspaceId: activeWorkspaceId,
      description: formData.description.trim() || undefined,
      status: formData.status,
      targetDate: formData.targetDate ? new Date(formData.targetDate).toISOString() : undefined,
      color: "#10b981",
      repoUrl: formData.sourceType === "repo" ? formData.repoUrl.trim() : undefined,
      localPath: formData.sourceType === "local" && isDesktopApp ? formData.localPath.trim() : undefined,
    })
    loadProjects()
  }

  const handleUpdateProject = async (projectId: string, formData: ProjectFormData, isDesktopApp: boolean, existingLocalPath?: string | null) => {
    await updateProject(projectId, {
      name: formData.name.trim(),
      description: formData.description.trim() || null,
      status: formData.status,
      targetDate: formData.targetDate ? new Date(formData.targetDate).toISOString() : null,
      repoUrl: formData.sourceType === "repo" ? formData.repoUrl.trim() : null,
      localPath:
        formData.sourceType === "local"
          ? (isDesktopApp || !!existingLocalPath ? formData.localPath.trim() : null)
          : null,
    })
    loadProjects()
  }

  const handleDeleteProject = async (projectId: string) => {
    await deleteProject(projectId)
    loadProjects()
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
