"use client"

import { useCallback, useContext, useEffect, useState } from "react"
import { QueryClientContext, type QueryClient } from "@tanstack/react-query"
import { createAppQueryClient } from "./client"
import { createBridgeState, type BridgeState } from "./sse-bridge"

/**
 * The app QueryClient from `QueryProvider`, or — when a hook renders outside
 * the provider (unit tests, isolated renders) — a private client owned by the
 * calling component. Hooks never crash without the provider; they just lose
 * cross-component sharing, exactly like the `useState` they replaced.
 */
export function useAppQueryClient(): QueryClient {
  const contextClient = useContext(QueryClientContext)
  const [fallback] = useState<QueryClient | null>(() => (contextClient ? null : createAppQueryClient()))
  useEffect(() => () => fallback?.clear(), [fallback])
  const client = contextClient ?? fallback
  if (!client) throw new Error("QueryClient unavailable")
  return client
}

/*
 * Clients whose cache is fed by a mounted SSE bridge (`QuerySseBridge`).
 * Data hooks that used to apply SSE events themselves keep their
 * subscription and apply events only when nothing else does, so a hook
 * rendered without the bridge keeps its live updates and a bridged app never
 * applies an event twice.
 */
const bridgedClients = new WeakMap<QueryClient, number>()

export function registerSseBridge(client: QueryClient): () => void {
  bridgedClients.set(client, (bridgedClients.get(client) ?? 0) + 1)
  return () => {
    const count = (bridgedClients.get(client) ?? 1) - 1
    if (count <= 0) bridgedClients.delete(client)
    else bridgedClients.set(client, count)
  }
}

export function hasSseBridge(client: QueryClient): boolean {
  return (bridgedClients.get(client) ?? 0) > 0
}

/**
 * Bridge state for a hook that applies SSE events itself because no
 * `QuerySseBridge` feeds its client (see `hasSseBridge`). Created on first use.
 */
export function useStandaloneBridgeState(client: QueryClient): () => BridgeState {
  const [holder] = useState<{ state: BridgeState | null }>(() => ({ state: null }))
  useEffect(() => () => holder.state?.invalidator.dispose(), [holder])
  return useCallback(() => {
    if (!holder.state) holder.state = createBridgeState(client)
    return holder.state
  }, [client, holder])
}
