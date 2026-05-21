"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react"
import { fetchWorkspaces } from "@/lib/api/workspaces"
import { useSSESubscription, type SSEEventData, type SSEEventType } from "@/providers/sse-provider"
import { useAuth } from "@/hooks/use-auth"
import type { Workspace } from "@/lib/api/types"

interface WorkspaceContextType {
  activeWorkspace: Workspace | null
  workspaces: Workspace[]
  isLoading: boolean
  setActiveWorkspace: (workspace: Workspace) => void
  refreshWorkspaces: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined)

const STORAGE_KEY = "openlinear:activeWorkspaceId"

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadWorkspaces = useCallback(async () => {
    try {
      const data = await fetchWorkspaces()
      setWorkspaces(data)
      return data
    } catch {
      setWorkspaces([])
      return []
    }
  }, [])

  const setActiveWorkspace = useCallback((workspace: Workspace) => {
    setActiveWorkspaceState(workspace)
    localStorage.setItem(STORAGE_KEY, workspace.id)
  }, [])

  const refreshWorkspaces = useCallback(async () => {
    await loadWorkspaces()
  }, [loadWorkspaces])

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      setIsLoading(!authLoading)
      return
    }
    (async () => {
      const data = await loadWorkspaces()
      const savedId = localStorage.getItem(STORAGE_KEY)
      if (savedId) {
        const found = data.find((w) => w.id === savedId)
        if (found) {
          setActiveWorkspaceState(found)
        } else if (data.length > 0) {
          setActiveWorkspaceState(data[0])
          localStorage.setItem(STORAGE_KEY, data[0].id)
        }
      } else if (data.length > 0) {
        setActiveWorkspaceState(data[0])
        localStorage.setItem(STORAGE_KEY, data[0].id)
      }
      setIsLoading(false)
    })()
  }, [authLoading, isAuthenticated, loadWorkspaces])

  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData) => {
    if (eventType === 'workspace:joined') {
      const ws = data as unknown as Workspace
      if (!ws?.id) return
      setWorkspaces((prev) => (prev.some((w) => w.id === ws.id) ? prev.map((w) => (w.id === ws.id ? ws : w)) : [...prev, ws]))
      return
    }
    if (eventType === 'workspace:updated') {
      const ws = data as unknown as Workspace
      if (!ws?.id) return
      setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? { ...w, ...ws } : w)))
      setActiveWorkspaceState((prev) => (prev?.id === ws.id ? { ...prev, ...ws } : prev))
      return
    }
    if (eventType === 'workspace:left' || eventType === 'workspace:deleted') {
      const id = (data as { workspaceId?: string; id?: string }).workspaceId ?? (data as { id?: string }).id
      if (!id) return
      setWorkspaces((prev) => prev.filter((w) => w.id !== id))
      setActiveWorkspaceState((prev) => {
        if (prev?.id !== id) return prev
        try { localStorage.removeItem(STORAGE_KEY) } catch {}
        return null
      })
    }
  }, []))

  return (
    <WorkspaceContext.Provider value={{ activeWorkspace, workspaces, isLoading, setActiveWorkspace, refreshWorkspaces }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider")
  }
  return context
}
