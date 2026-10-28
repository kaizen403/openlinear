"use client"

import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Project } from "@/lib/api"
import { useWorkspace } from "@/hooks/use-workspace"
import { useSSESubscription, type SSEEventData, type SSEEventMeta, type SSEEventType } from "@/providers/sse-provider"
import { projectsQuery, type PROJECT_FIELDS } from "@/lib/query/resources"
import { applySseEventToCache } from "@/lib/query/sse-bridge"
import { hasSseBridge, useAppQueryClient, useStandaloneBridgeState } from "@/lib/query/use-app-query-client"

interface ProjectContextType {
  activeProject: Project | null
  projects: Project[]
  isLoading: boolean
  setActiveProject: (project: Project) => void
  refreshProjects: () => Promise<void>
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined)

const STORAGE_KEY = "openlinear:activeProjectId"
const NO_PROJECTS: Project[] = []
// The home page routes teamless projects to /projects, so the shared project
// list must carry `teams`; this fails to compile if PROJECT_FIELDS drops it.
export const REQUIRED_PROJECT_FIELDS = ['teams'] as const satisfies ReadonlyArray<(typeof PROJECT_FIELDS)[number]>

type Selection = { kind: 'auto' } | { kind: 'project'; project: Project } | { kind: 'none' }
const AUTO: Selection = { kind: 'auto' }
const NONE: Selection = { kind: 'none' }

function pickSavedOrFirst(projects: Project[]): Project | null {
  const savedId = typeof window === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  return (savedId ? projects.find((p) => p.id === savedId) : undefined) ?? projects[0] ?? null
}

/**
 * The active workspace's projects come from the shared projects query (the
 * same cache entry the Projects page reads); the SSE bridge patches it on
 * `project:*` events. This provider keeps only the active-project selection.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace, isLoading: workspaceLoading } = useWorkspace()
  const activeWorkspaceId = activeWorkspace?.id
  const client = useAppQueryClient()
  const { data, status } = useQuery({ ...projectsQuery(activeWorkspaceId ?? ""), enabled: Boolean(activeWorkspaceId) }, client)
  const projects = (activeWorkspaceId ? data : undefined) ?? NO_PROJECTS
  const settled = Boolean(activeWorkspaceId) && status !== 'pending'

  // `auto` = the saved or first project of the active workspace, derived during
  // render so the list, the selection and `isLoading` land in one commit. A
  // workspace switch goes back to `auto`, as the old provider re-picked.
  const [selection, setSelection] = useState<Selection>(AUTO)
  const [selectionWorkspaceId, setSelectionWorkspaceId] = useState(activeWorkspaceId)
  if (selectionWorkspaceId !== activeWorkspaceId) {
    setSelectionWorkspaceId(activeWorkspaceId)
    setSelection(AUTO)
  }
  const activeProject = useMemo(() => {
    if (selection.kind === 'project') return projects.find((p) => p.id === selection.project.id) ?? selection.project
    if (selection.kind === 'none' || !settled) return null
    return pickSavedOrFirst(projects)
  }, [projects, selection, settled])
  const isLoading = workspaceLoading ? true : !activeWorkspaceId ? false : !settled

  // Persist an automatic choice, as the old provider did.
  const autoProjectId = selection.kind === 'auto' ? activeProject?.id ?? null : null
  useEffect(() => {
    if (autoProjectId && localStorage.getItem(STORAGE_KEY) !== autoProjectId) localStorage.setItem(STORAGE_KEY, autoProjectId)
  }, [autoProjectId])

  const setActiveProject = useCallback((project: Project) => {
    setSelection({ kind: 'project', project })
    localStorage.setItem(STORAGE_KEY, project.id)
  }, [])

  const refreshProjects = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      await client.query({ ...projectsQuery(activeWorkspaceId), staleTime: 0 })
    } catch {
      // Keep the cached list; callers only use this to pick up their own write.
    }
  }, [activeWorkspaceId, client])

  const activeIdRef = useRef(activeProject?.id ?? null)
  activeIdRef.current = activeProject?.id ?? null
  const bridgeState = useStandaloneBridgeState(client)
  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => {
    if (!hasSseBridge(client)) applySseEventToCache(client, eventType, data, meta, bridgeState())
    if (eventType === 'project:deleted') {
      const id = (data as { id?: string }).id ?? (data as { projectId?: string }).projectId
      if (id && activeIdRef.current === id) setSelection(NONE)
    }
  }, [client, bridgeState]))

  const value = useMemo(
    () => ({ activeProject, projects, isLoading, setActiveProject, refreshProjects }),
    [activeProject, projects, isLoading, setActiveProject, refreshProjects],
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject() {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error("useProject must be used within a ProjectProvider")
  }
  return context
}
