"use client"

import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSSESubscription, type SSEEventData, type SSEEventMeta, type SSEEventType } from "@/providers/sse-provider"
import { useAuth } from "@/hooks/use-auth"
import type { Workspace } from "@/lib/api/types"
import { workspacesQuery } from "@/lib/query/resources"
import { applySseEventToCache } from "@/lib/query/sse-bridge"
import { hasSseBridge, useAppQueryClient, useStandaloneBridgeState } from "@/lib/query/use-app-query-client"

interface WorkspaceContextType {
  activeWorkspace: Workspace | null
  workspaces: Workspace[]
  isLoading: boolean
  setActiveWorkspace: (workspace: Workspace) => void
  refreshWorkspaces: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined)

const STORAGE_KEY = "openlinear:activeWorkspaceId"
const NO_WORKSPACES: Workspace[] = []

type Selection = { kind: 'auto' } | { kind: 'id'; id: string } | { kind: 'none' }
const AUTO: Selection = { kind: 'auto' }
const NONE: Selection = { kind: 'none' }

function pickSavedOrFirst(workspaces: Workspace[]): string | null {
  const savedId = typeof window === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  return (savedId && workspaces.some((w) => w.id === savedId) ? savedId : workspaces[0]?.id) ?? null
}

/**
 * Workspaces come from the query cache (`queryKeys.workspaces.list()`); the
 * SSE bridge patches that list on `workspace:*` events. This provider keeps
 * only the selection (persisted in localStorage) and its loading gate.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const client = useAppQueryClient()
  const enabled = isAuthenticated && !authLoading
  const { data, status } = useQuery({ ...workspacesQuery(), enabled }, client)
  const workspaces = (enabled ? data : undefined) ?? NO_WORKSPACES
  // Settled = loaded or failed. A failed load leaves no workspaces, as before.
  const settled = enabled && status !== 'pending'
  // `auto` follows the saved/first workspace once the list is in; it is derived
  // during render so the list, the selection and `isLoading` land in one commit.
  const [selection, setSelection] = useState<Selection>(AUTO)
  const activeWorkspaceId =
    selection.kind === 'id' ? selection.id
      : selection.kind === 'none' || !settled ? null
        : pickSavedOrFirst(workspaces)
  const isLoading = authLoading ? false : !isAuthenticated ? true : !settled

  // Persist an automatic choice, as the old provider did.
  useEffect(() => {
    if (selection.kind !== 'auto' || !activeWorkspaceId) return
    if (localStorage.getItem(STORAGE_KEY) !== activeWorkspaceId) localStorage.setItem(STORAGE_KEY, activeWorkspaceId)
  }, [activeWorkspaceId, selection.kind])

  const setActiveWorkspace = useCallback((workspace: Workspace) => {
    setSelection({ kind: 'id', id: workspace.id })
    localStorage.setItem(STORAGE_KEY, workspace.id)
  }, [])

  const refreshWorkspaces = useCallback(async () => {
    try {
      await client.query({ ...workspacesQuery(), staleTime: 0 })
    } catch {
      // Keep what we have; the old provider swallowed refresh failures too.
    }
  }, [client])

  const activeIdRef = useRef(activeWorkspaceId)
  activeIdRef.current = activeWorkspaceId
  const bridgeRef = useStandaloneBridgeState(client)
  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => {
    // The app's QuerySseBridge applies the event to the cache; a provider
    // rendered without it (tests, isolated trees) applies it here.
    if (!hasSseBridge(client)) applySseEventToCache(client, eventType, data, meta, bridgeRef())
    if (eventType === 'workspace:left' || eventType === 'workspace:deleted') {
      const id = (data as { workspaceId?: string }).workspaceId ?? (data as { id?: string }).id
      if (!id) return
      if (activeIdRef.current !== id) return
      setSelection(NONE)
      try { localStorage.removeItem(STORAGE_KEY) } catch {}
    }
  }, [client, bridgeRef]))

  const activeWorkspace = useMemo(
    () => (activeWorkspaceId ? workspaces.find((w) => w.id === activeWorkspaceId) ?? null : null),
    [activeWorkspaceId, workspaces],
  )

  const value = useMemo(
    () => ({ activeWorkspace, workspaces, isLoading, setActiveWorkspace, refreshWorkspaces }),
    [activeWorkspace, workspaces, isLoading, setActiveWorkspace, refreshWorkspaces],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider")
  }
  return context
}
