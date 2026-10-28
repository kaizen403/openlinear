"use client"

import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Team } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { useWorkspace } from "@/hooks/use-workspace"
import { useSSESubscription, type SSEEventData, type SSEEventMeta, type SSEEventType } from "@/providers/sse-provider"
import { teamsQuery } from "@/lib/query/resources"
import { applySseEventToCache } from "@/lib/query/sse-bridge"
import { hasSseBridge, useAppQueryClient, useStandaloneBridgeState } from "@/lib/query/use-app-query-client"

interface TeamsContextType {
  teams: Team[]
  isLoading: boolean
  reload: () => Promise<void>
}

const TeamsContext = createContext<TeamsContextType | undefined>(undefined)
const NO_TEAMS: Team[] = []

/**
 * The active workspace's teams, from the query cache. `team:*` events
 * invalidate the list (bridge) instead of every provider refetching on its own;
 * sign-out clears the cache (QuerySseBridge), which replaces the old
 * `auth:expired` reset.
 */
export function TeamsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const { activeWorkspace, isLoading: isWorkspaceLoading } = useWorkspace()
  const activeWorkspaceId = activeWorkspace?.id
  const client = useAppQueryClient()
  const enabled = isAuthenticated && !isWorkspaceLoading && Boolean(activeWorkspaceId)
  const { data, isLoading: isFirstLoad } = useQuery({ ...teamsQuery(activeWorkspaceId ?? ""), enabled }, client)
  const teams = (enabled ? data : undefined) ?? NO_TEAMS
  // First load only: background refetches no longer flip every consumer (nothing reads it today).
  const isLoading = enabled && isFirstLoad

  const reload = useCallback(async () => {
    if (!enabled || !activeWorkspaceId) return
    await client.refetchQueries({ queryKey: teamsQuery(activeWorkspaceId).queryKey, exact: true })
  }, [activeWorkspaceId, client, enabled])

  const bridgeState = useStandaloneBridgeState(client)
  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => {
    if (!hasSseBridge(client)) applySseEventToCache(client, eventType, data, meta, bridgeState())
  }, [client, bridgeState]))

  const value = useMemo(() => ({ teams, isLoading, reload }), [teams, isLoading, reload])

  return (
    <TeamsContext.Provider value={value}>
      {children}
    </TeamsContext.Provider>
  )
}

export function useTeams() {
  const ctx = useContext(TeamsContext)
  if (!ctx) {
    throw new Error("useTeams must be used within a TeamsProvider")
  }
  return ctx
}
