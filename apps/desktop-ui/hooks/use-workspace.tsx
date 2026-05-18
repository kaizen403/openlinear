"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react"
import { fetchWorkspaces } from "@/lib/api/workspaces"
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
  }, [loadWorkspaces])

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
