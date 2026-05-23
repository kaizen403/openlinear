"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react"
import { fetchProjects, Project } from "@/lib/api"
import { useWorkspace } from "@/hooks/use-workspace"
import { useSSESubscription, type SSEEventData, type SSEEventType } from "@/providers/sse-provider"

interface ProjectContextType {
  activeProject: Project | null
  projects: Project[]
  isLoading: boolean
  setActiveProject: (project: Project) => void
  refreshProjects: () => Promise<void>
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined)

const STORAGE_KEY = "openlinear:activeProjectId"
const SHARED_PROJECT_FIELDS = [
  'id',
  'workspaceId',
  'key',
  'name',
  'description',
  'status',
  'color',
  'icon',
  'repositoryId',
  'localPath',
  'repoUrl',
  'repository',
  'teams',
] as const

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace, isLoading: workspaceLoading } = useWorkspace()
  const activeWorkspaceId = activeWorkspace?.id
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProjectState] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadProjects = useCallback(async () => {
    if (!activeWorkspaceId) {
      setProjects([])
      return [] as Project[]
    }
    try {
      const data = await fetchProjects({
        workspaceId: activeWorkspaceId,
        fields: [...SHARED_PROJECT_FIELDS],
      })
      setProjects(data)
      return data
    } catch {
      setProjects([])
      return [] as Project[]
    }
  }, [activeWorkspaceId])

  const setActiveProject = useCallback((project: Project) => {
    setActiveProjectState(project)
    localStorage.setItem(STORAGE_KEY, project.id)
  }, [])

  const refreshProjects = useCallback(async () => {
    await loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (workspaceLoading) return
    if (!activeWorkspaceId) {
      setProjects([])
      setActiveProjectState(null)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    ;(async () => {
      const data = await loadProjects()
      const savedId = localStorage.getItem(STORAGE_KEY)
      if (savedId) {
        const found = data.find((p) => p.id === savedId)
        if (found) {
          setActiveProjectState(found)
        } else if (data.length > 0) {
          setActiveProjectState(data[0])
          localStorage.setItem(STORAGE_KEY, data[0].id)
        } else {
          setActiveProjectState(null)
        }
      } else if (data.length > 0) {
        setActiveProjectState(data[0])
        localStorage.setItem(STORAGE_KEY, data[0].id)
      } else {
        setActiveProjectState(null)
      }
      setIsLoading(false)
    })()
  }, [activeWorkspaceId, workspaceLoading, loadProjects])

  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData) => {
    if (!activeWorkspaceId) return
    if (eventType === 'project:created') {
      const p = data as unknown as Project
      if (!p?.id || p.workspaceId !== activeWorkspaceId) return
      setProjects((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]))
      return
    }
    if (eventType === 'project:updated') {
      const p = data as unknown as Project
      if (!p?.id) return
      setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...p } : x)))
      setActiveProjectState((prev) => (prev?.id === p.id ? { ...prev, ...p } : prev))
      return
    }
    if (eventType === 'project:deleted') {
      const id = (data as { id?: string; projectId?: string }).id ?? (data as { projectId?: string }).projectId
      if (!id) return
      setProjects((prev) => prev.filter((x) => x.id !== id))
      setActiveProjectState((prev) => (prev?.id === id ? null : prev))
    }
  }, [activeWorkspaceId]))

  return (
    <ProjectContext.Provider value={{ activeProject, projects, isLoading, setActiveProject, refreshProjects }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error("useProject must be used within a ProjectProvider")
  }
  return context
}
