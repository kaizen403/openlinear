"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { QueryClientProvider, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useAuth } from "@/hooks/use-auth"
import { setAppQueryClient } from "@/lib/query/app-client"
import { createAppQueryClient } from "@/lib/query/client"
import { applySseEventToCache, createBridgeState, type BridgeState } from "@/lib/query/sse-bridge"
import { registerSseBridge } from "@/lib/query/use-app-query-client"
import { useSSESubscription, type SSEEventData, type SSEEventMeta, type SSEEventType } from "@/providers/sse-provider"

/**
 * The app's single QueryClient. Client-only (the app is a static export and a
 * Tauri webview): the cache lives for the page's lifetime.
 */
export function QueryProvider({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createAppQueryClient())
  useEffect(() => {
    setAppQueryClient(queryClient)
    return () => setAppQueryClient(null)
  }, [queryClient])
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

/**
 * Feeds the cache from the event streams (lib/query/sse-bridge.ts). Mount once,
 * inside both `SSEProvider` and `AuthProvider`. Also drops the whole cache
 * when the signed-in user changes or signs out.
 */
export function QuerySseBridge({ windowMs }: { windowMs?: number } = {}) {
  const client = useQueryClient()
  const { user, isAuthenticated } = useAuth()
  const userId = user?.id ?? null

  const stateRef = useRef<BridgeState | null>(null)
  if (stateRef.current === null) stateRef.current = createBridgeState(client, { windowMs })
  const state = stateRef.current
  state.currentUserId = userId

  useEffect(() => registerSseBridge(client), [client])
  useEffect(() => () => state.invalidator.dispose(), [state])

  // A different user (or none) must never see the previous user's data.
  const previousUserRef = useRef<string | null>(userId)
  useEffect(() => {
    const previous = previousUserRef.current
    previousUserRef.current = userId
    if (previous !== null && previous !== userId) {
      state.invalidator.dispose()
      client.clear()
    }
  }, [client, state, userId])

  // The streams restart with the session: the next `connected` is a first one.
  useEffect(() => {
    if (!isAuthenticated) state.connectedStreams.clear()
  }, [isAuthenticated, state])

  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => {
    applySseEventToCache(client, eventType, data, meta, state)
  }, [client, state]))

  return null
}
