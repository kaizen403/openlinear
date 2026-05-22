"use client"

import { createContext, useContext, useEffect, useRef, useCallback, useState, type ReactNode } from "react"
import { useAuth } from "@/hooks/use-auth"
import { getApiUrl, getSidecarApiUrl } from "@/lib/api/client"

const SSE_MAX_BACKOFF_MS = 30_000

export interface SSEEventData {
  type?: string
  clientId?: string
  id?: string
  title?: string
  description?: string | null
  priority?: 'low' | 'medium' | 'high'
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled'
  sessionId?: string | null
  createdAt?: string
  updatedAt?: string
  labels?: Array<{
    id: string
    name: string
    color: string
    priority: number
  }>
  executionStartedAt?: string | null
  executionPausedAt?: string | null
  executionElapsedMs?: number
  executionProgress?: number | null
  prUrl?: string | null
  outcome?: string | null
  batchId?: string | null
  inboxRead?: boolean
  identifier?: string | null
  number?: number | null
  dueDate?: string | null
  teamId?: string | null
  projectId?: string | null
  assigneeId?: string | null
  creatorId?: string | null
  assignee?: { id: string; username: string; avatarUrl: string | null } | null
  creator?: { id: string; username: string; avatarUrl: string | null } | null
  model?: string | null
  archived?: boolean
  taskId?: string
  mode?: string
  tasks?: Array<{
    taskId: string
    title: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  }>
  /** Catch-all for workspace, project, team, member, access payloads. */
  [key: string]: unknown
}

export type SSEEventType =
  | 'connected'
  | 'task:created'
  | 'task:updated'
  | 'task:deleted'
  | 'tasks:bulk-created'
  | 'label:created'
  | 'label:updated'
  | 'label:deleted'
  | 'settings:updated'
  | 'execution:progress'
  | 'execution:log'
  | 'batch:created'
  | 'batch:started'
  | 'batch:task:started'
  | 'batch:task:completed'
  | 'batch:task:failed'
  | 'batch:task:skipped'
  | 'batch:task:cancelled'
  | 'batch:merging'
  | 'batch:completed'
  | 'batch:failed'
  | 'batch:cancelled'
  | 'team:created'
  | 'team:updated'
  | 'team:deleted'
  | 'team:joined'
  | 'team:left'
  | 'team:member-added'
  | 'team:member-updated'
  | 'team:member-removed'
  | 'project:created'
  | 'project:updated'
  | 'project:deleted'
  | 'project:access-changed'
  | 'workspace:joined'
  | 'workspace:left'
  | 'workspace:updated'
  | 'workspace:deleted'
  | 'workspace:member-added'
  | 'workspace:member-updated'
  | 'workspace:member-removed'

type SSEListener = (eventType: SSEEventType, data: SSEEventData) => void

interface SSEContextType {
  subscribe: (listener: SSEListener) => () => void
  isConnected: boolean
  isReconnecting: boolean
}

const SSEContext = createContext<SSEContextType | null>(null)

const ALL_EVENT_TYPES: SSEEventType[] = [
  'task:created',
  'task:updated',
  'task:deleted',
  'tasks:bulk-created',
  'label:created',
  'label:updated',
  'label:deleted',
  'settings:updated',
  'execution:progress',
  'execution:log',
  'batch:created',
  'batch:started',
  'batch:task:started',
  'batch:task:completed',
  'batch:task:failed',
  'batch:task:skipped',
  'batch:task:cancelled',
  'batch:merging',
  'batch:completed',
  'batch:failed',
  'batch:cancelled',
  'team:created',
  'team:updated',
  'team:deleted',
  'team:joined',
  'team:left',
  'team:member-added',
  'team:member-updated',
  'team:member-removed',
  'project:created',
  'project:updated',
  'project:deleted',
  'project:access-changed',
  'workspace:joined',
  'workspace:left',
  'workspace:updated',
  'workspace:deleted',
  'workspace:member-added',
  'workspace:member-updated',
  'workspace:member-removed',
]

interface SSEStream {
  source: EventSource
  retries: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnecting: boolean
}

function buildEventsUrl(baseUrl: string, token: string | null): string {
  const url = new URL(`${baseUrl}/api/events`)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem('token')
  } catch {
    return null
  }
}

export function SSEProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const listenersRef = useRef<Set<SSEListener>>(new Set())
  const streamsRef = useRef<Map<string, SSEStream>>(new Map())
  const [connectedCount, setConnectedCount] = useState(0)
  const [reconnectingCount, setReconnectingCount] = useState(0)

  const broadcast = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    listenersRef.current.forEach((listener) => {
      try {
        listener(eventType, data)
      } catch (err) {
        console.error("[SSE Provider] Listener error:", err)
      }
    })
  }, [])

  const recomputeConnectedCount = useCallback(() => {
    let connected = 0
    let reconnecting = 0
    streamsRef.current.forEach((s) => {
      if (s.reconnecting) reconnecting++
      else if (s.source.readyState === EventSource.OPEN) connected++
    })
    setConnectedCount(connected)
    setReconnectingCount(reconnecting)
  }, [])

  const closeStream = useCallback((baseUrl: string) => {
    const stream = streamsRef.current.get(baseUrl)
    if (!stream) return
    stream.source.close()
    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer)
    streamsRef.current.delete(baseUrl)
    recomputeConnectedCount()
  }, [recomputeConnectedCount])

  const connectStream = useCallback((baseUrl: string) => {
    if (typeof window === 'undefined') return
    closeStream(baseUrl)

    const token = readToken()
    const url = buildEventsUrl(baseUrl, token)
    const source = new EventSource(url)
    const stream: SSEStream = { source, retries: 0, reconnectTimer: null, reconnecting: false }
    streamsRef.current.set(baseUrl, stream)

    source.onopen = () => {
      stream.retries = 0
      stream.reconnecting = false
      recomputeConnectedCount()
    }

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEventData
        if (data.type === 'connected') {
          broadcast('connected', data)
        }
      } catch (err) {
        console.error("[SSE Provider] Failed to parse message:", err)
      }
    }

    for (const eventType of ALL_EVENT_TYPES) {
      source.addEventListener(eventType, (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data)
          broadcast(eventType, data)
        } catch (err) {
          console.error(`[SSE Provider] Failed to parse ${eventType}:`, err)
        }
      })
    }

    source.onerror = () => {
      source.close()
      stream.reconnecting = true
      recomputeConnectedCount()

      const attempt = stream.retries + 1
      stream.retries = attempt
      const exp = 1000 * Math.pow(2, Math.min(attempt - 1, 5))
      const jitter = Math.random() * 1000
      const delay = Math.min(SSE_MAX_BACKOFF_MS, exp + jitter)
      console.log(`[SSE Provider] ${baseUrl} retry ${attempt} in ${Math.round(delay)}ms`)
      stream.reconnectTimer = setTimeout(() => connectStream(baseUrl), delay)
    }
  }, [broadcast, closeStream, recomputeConnectedCount])

  useEffect(() => {
    if (!isAuthenticated) return

    const cloud = getApiUrl()
    const sidecar = getSidecarApiUrl()
    const baseUrls = new Set<string>([cloud, sidecar])

    baseUrls.forEach((u) => connectStream(u))

    return () => {
      baseUrls.forEach((u) => closeStream(u))
    }
  }, [isAuthenticated, connectStream, closeStream])

  const subscribe = useCallback((listener: SSEListener) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  return (
    <SSEContext.Provider
      value={{
        subscribe,
        isConnected: connectedCount > 0,
        isReconnecting: connectedCount === 0 && reconnectingCount > 0,
      }}
    >
      {children}
    </SSEContext.Provider>
  )
}

export function useSSESubscription(
  onEvent: (eventType: SSEEventType, data: SSEEventData) => void
) {
  const context = useContext(SSEContext)
  if (!context) {
    throw new Error("useSSESubscription must be used within an SSEProvider")
  }
  const { subscribe } = context
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    return subscribe((eventType, data) => onEventRef.current(eventType, data))
  }, [subscribe])
}

export function useSSEStatus() {
  const context = useContext(SSEContext)
  if (!context) {
    throw new Error("useSSEStatus must be used within an SSEProvider")
  }
  return { isConnected: context.isConnected, isReconnecting: context.isReconnecting }
}
